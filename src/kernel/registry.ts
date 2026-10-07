import { createContext, type Context } from './context.ts'
import { EventBus, type PluginFailedDetail, type PluginFailedPhase } from './events.ts'
import { Fiber } from './fiber.ts'
import { Service } from './service.ts'
import { ServiceStore, type ServiceChange } from './store.ts'

/** Everything a plugin can be: a function, an `{ apply }` object, or a {@link Service} subclass. */
export type PluginTarget =
  | ((ctx: Context) => void | Promise<void>)
  | { name?: string; inject?: string[]; apply: (ctx: Context) => void | Promise<void> }
  | (new (ctx: Context) => unknown)

/** Normalized plugin description the kernel mounts. */
export interface ResolvedPlugin {
  /** Display name used in diagnostics. */
  name: string
  /** Required service names; the plugin stays `pending` until all exist. */
  inject: string[]
  /** The plugin body, run once its requirements are satisfied. */
  apply: (ctx: Context) => void | Promise<void>
}

/**
 * One retained startup observation, returned as a fresh copy by
 * {@link Kernel.inspect}. A failed entry stays listed here after its cleanup,
 * until kernel stop; its `error` is the original startup error.
 */
export interface PluginDiagnostic {
  /** Plugin display name, as mounted. */
  readonly name: string
  /** The fiber running (or having run) this plugin. */
  readonly fiber: Fiber
  /**
   * uid of the fiber whose unload disposes this logical entry — across
   * dependency-driven replacement — or `null` when the entry is root-owned
   * (only a kernel stop disposes it).
   */
  readonly parentUid: number | null
  /** The original startup error; absent when the plugin did not fail to start. */
  readonly error?: unknown
}

/** One mounted plugin: its definition plus the fiber/context pair running its
 * CURRENT generation. The entry itself is the logical identity: it survives
 * dependency-driven replacement, so ownership, diagnostics, and explicit
 * disposal stay attached to one stable record while `fiber` moves forward.
 */
interface PluginEntry {
  definition: ResolvedPlugin
  /** The current generation's fiber; replaced by a dependency-driven restart. */
  fiber: Fiber
  ctx: Context
  /**
   * The fiber whose unload disposes this logical entry, or `null` when
   * root-owned (only a kernel stop disposes it). Kept across dependency-driven
   * replacement: a restart re-mounts under the SAME owner, never root-owned.
   */
  owner: Fiber | null
  /** {@link owner}'s uid, as reported by {@link Kernel.inspect}. */
  ownerUid: number | null
  /**
   * Every generation fiber this logical entry created, current one last.
   * Teardown disposes them all — current generation last — so a replacement
   * never orphans an older generation still holding effects. Retired
   * generations STAY in the set so a stale handle keeps resolving to this
   * entry; their disposal promises stay cached in {@link Kernel.closings},
   * keyed by the fiber handle itself.
   */
  readonly generations: Set<Fiber>
  /**
   * Admission to this entry is closed: explicit disposal — through ANY
   * generation's returned Fiber handle — arrived. A closed entry never starts,
   * never wakes, and never remounts; it stays in the registry until kernel
   * stop so it remains inspectable.
   */
  closed: boolean
  /**
   * The one coalesced teardown transition in flight, if any. A second
   * dependency removal while a cleanup is still running joins it instead of
   * queueing another teardown+remount; the slot reopens when the body settles.
   */
  transition: Promise<void> | undefined
  /**
   * Stop generation this entry was mounted in: `0` until the first stop, then
   * one more per stop. A completion from an older generation is stale history
   * and never reactivates its entry.
   */
  generation: number
  /** The original startup error, retained until kernel stop. */
  error?: unknown
  /**
   * Nothing is left to dispose or report for this entry: its startup
   * settlement fully finished (cleanup ran, the failure was published once),
   * or the restart or explicit disposal that cleaned it already published its
   * teardown failure. `stop()` skips retired entries, so a failure is
   * published exactly once.
   */
  retired: boolean
}

/**
 * Normalize any {@link PluginTarget} into a {@link ResolvedPlugin}.
 *
 * A {@link Service} subclass is mounted by instantiating it (its constructor
 * claims the service name); a function runs directly; an object delegates to
 * its `apply`. Function targets may carry an `inject` static property.
 */
export function resolvePlugin(target: PluginTarget): ResolvedPlugin {
  if (typeof target === 'function') {
    const inject = (target as { inject?: string[] }).inject ?? []
    if (target.prototype instanceof Service) {
      const Constructor = target as new (ctx: Context) => unknown
      return {
        name: target.name || 'anonymous-service',
        inject,
        apply: (ctx: Context) => {
          new Constructor(ctx)
        },
      }
    }
    const fn = target as (ctx: Context) => void | Promise<void>
    return { name: target.name || 'anonymous', inject, apply: fn }
  }
  if (target && typeof target === 'object' && typeof target.apply === 'function') {
    return {
      name: target.name ?? 'anonymous',
      inject: target.inject ?? [],
      apply: target.apply,
    }
  }
  throw new TypeError(`not a plugin: expected function, Service subclass, or { apply } object`)
}

/**
 * Flatten nested aggregates so one published error carries each cause once.
 */
function flattenErrors(error: unknown, into: unknown[] = []): unknown[] {
  if (error instanceof AggregateError) {
    for (const inner of error.errors) flattenErrors(inner, into)
  } else {
    into.push(error)
  }
  return into
}

/**
 * Entries that can still (re)start. A `pending` entry waits for services; a
 * `failed` startup and an unloaded fiber are retired history — never wake or
 * restart candidates, but kept in the registry until kernel stop so they stay
 * inspectable.
 */
function isLiveEntry(entry: PluginEntry): boolean {
  return entry.fiber.state === 'active' || entry.fiber.state === 'loading'
}

/**
 * Whether an owner fiber can still own effects: `pending`, `loading`, and
 * `active` owners live; an `unloading`, `disposed`, or `failed` owner has
 * lost (or is losing) ownership, so a replacement generation must not attach
 * to it.
 */
function ownerAlive(owner: Fiber): boolean {
  switch (owner.state) {
    case 'pending':
    case 'loading':
    case 'active':
      return true
    case 'unloading':
    case 'disposed':
    case 'failed':
      return false
    default:
      return false
  }
}

/**
 * The kernel runtime: one event bus, one service store, and the set of
 * mounted plugins with dependency-driven lifecycle.
 *
 * Boot order comes from `inject`, never from mount order: a plugin whose
 * requirements are missing stays `pending`, and mounting a provider wakes it.
 * When a required service disappears, every loaded dependent is disposed and
 * re-mounted — it pends again until the service returns.
 *
 * Every startup and dependency-driven restart is a kernel-owned, tracked
 * transition: `settle()` drains them all, `inspect()` reports settled
 * outcomes, and each failure publishes exactly one typed
 * `kernel/plugin-failed` event whose listener exceptions are contained at the
 * producer.
 *
 * A mounted plugin has a stable LOGICAL entry: when a dependency disappears,
 * the current generation fiber is disposed and a fresh one is mounted under
 * the SAME owner on the SAME entry — it pends again until the service
 * returns. Multiple dependency removals landing while one teardown is still
 * in flight coalesce into a single cleanup + reevaluation. Disposal through
 * ANY generation's returned Fiber handle closes the whole logical entry;
 * kernel-initiated generation cleanup uses a distinct internal path that
 * leaves admission open.
 */
export class Kernel {
  /** The shared event bus. */
  readonly events = new EventBus()

  /** The flat service store backing `ctx.<name>` reads. */
  readonly services = new ServiceStore()

  /** The root fiber's context, for mounting plugins outside any plugin. */
  readonly ctx: Context

  private readonly rootFiber = new Fiber('root')
  private readonly entries = new Set<PluginEntry>()
  /** Tracked startup/restart settlements; drained by {@link settle}. */
  private readonly transitions = new Set<Promise<void>>()
  private readonly observeServices: () => void
  /** Latest logical-entry disposal requested through a Fiber handle. */
  private readonly closings = new WeakMap<Fiber, Promise<void>>()
  /**
   * Bumped on every stop only. It fences late completions: an entry mounted
   * before a stop carries the older generation, so a body resolving after
   * `stop()` began can never flip it back to `active`. Restart fencing is
   * handled separately by {@link coordinate}, which refuses to attach a fresh
   * generation after `stopped`.
   */
  private generation = 0
  private stopped = false

  constructor() {
    this.ctx = createContext(this, this.rootFiber)
    this.observeServices = this.services.onChange((change) => this.onServiceChange(change))
  }

  /** Resolve a {@link PluginTarget} into its normalized form. */
  resolvePlugin(target: PluginTarget): ResolvedPlugin {
    return resolvePlugin(target)
  }

  /**
   * Mount a resolved plugin. Returns its fiber; when requirements are
   * missing the fiber stays `pending` and the plugin body has not run.
   *
   * A synchronous failure of a directly mounted plugin still throws to the
   * caller; its unwind is nevertheless owned and tracked (see
   * {@link settle}), and the failure is published once.
   *
   * The returned handle stays valid for the entry's whole life: disposing it
   * — before or after a dependency-driven replacement replaced the fiber —
   * closes the logical entry and disposes its current generation.
   *
   * Prefer {@link Context.plugin}, which also ties the child to an owner.
   *
   * @param owner — the fiber whose unload disposes this logical entry;
   * `null`/omitted means root-owned.
   */
  plugin(definition: ResolvedPlugin, owner?: Fiber): Fiber {
    return this.mount(definition, owner ?? null, true)
  }

  /**
   * Dispose a kernel-issued plugin Fiber: resolves the handle to its logical
   * entry — any generation's handle works, even after a restart — closes the
   * entry's admission and disposes its current generation. The returned
   * promise rejects when the underlying cleanup throws. A Fiber the kernel
   * never issued keeps plain per-fiber disposal.
   */
  disposeFiber(fiber: Fiber): Promise<void> {
    return this.disposeOf(fiber)
  }

  /**
   * Snapshot every mounted plugin — live, pending, failed, or unloaded — as
   * fresh copies. Mutating a snapshot never changes what the kernel reports.
   */
  inspect(): readonly PluginDiagnostic[] {
    const diagnostics: PluginDiagnostic[] = []
    for (const entry of this.entries) {
      // Built as a mutable local, then handed out through the read-only
      // interface: fresh object per call, no aliasing of registry internals.
      const diagnostic: Omit<
        { -readonly [K in keyof PluginDiagnostic]-?: PluginDiagnostic[K] },
        'error'
      > & { error?: unknown } = {
        name: entry.definition.name,
        fiber: entry.fiber,
        parentUid: entry.ownerUid,
      }
      if (entry.error !== undefined) diagnostic.error = entry.error
      diagnostics.push(diagnostic)
    }
    return diagnostics
  }

  /**
   * Drain every tracked transition — startup settlements, dependency-driven
   * restarts, and the cleanups they run — until none remain. Pending plugins
   * wait for services, not for the kernel: they are not tasks and never stall
   * a settle.
   */
  async settle(): Promise<void> {
    while (this.transitions.size > 0) {
      const pending = [...this.transitions]
      this.transitions.clear()
      // Every tracked task contains its own failures, so this cannot reject.
      await Promise.all(pending)
    }
  }

  /**
   * Tear the kernel down: stop observing the store, dispose every mounted
   * plugin, then dispose the root fiber. Safe to call once per kernel.
   *
   * A startup failure that already settled has been cleaned and reported
   * exactly once; stop does not dispose its fiber again, so the original
   * error is never replayed. A cleanup failure during stop is published as a
   * `teardown` failure instead of rejecting the stop itself (minimal support:
   * the full shutdown rewrite is a later task).
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    this.observeServices()
    for (const entry of [...this.entries]) {
      if (entry.retired) continue
      try {
        // Every generation this logical entry created unwinds here — current
        // first, then already-retired ones re-observing their cached
        // teardowns — so no effect or service outlives the stop.
        // Kernel-internal path: plain generation teardown, not the handle
        // override that closes a logical entry.
        for (const fiber of [...entry.generations].reverse()) {
          await this.disposeGeneration(fiber)
        }
      } catch (error) {
        // Same ownership rule as the coordinated teardown: whoever reports
        // this entry's teardown failure retires it first, so a restart or an
        // explicit disposal already in flight over the same cached teardown
        // publishes it exactly once.
        if (!entry.retired) {
          entry.retired = true
          this.publishFailure(entry, 'teardown', error)
        }
      }
    }
    this.entries.clear()
    // A failing child cleanup also fails its parent's disposal (the parent's
    // own `ctx.plugin` disposer re-observes the child's cached outcome). The
    // child's failure was already published; the parent aggregate is the same
    // errors propagating outward — contain it instead of rejecting stop.
    await this.rootFiber.dispose().catch(() => {})
  }

  /** Create and register an entry, then try to start it. */
  private mount(definition: ResolvedPlugin, owner: Fiber | null, direct: boolean): Fiber {
    const fiber = new Fiber(definition.name)
    const entry: PluginEntry = {
      definition,
      fiber,
      ctx: createContext(this, fiber),
      // `null` means root-owned: mounted by the kernel or through the root
      // context, so no plugin owner's unload disposes it — only a stop does.
      owner: owner === null || owner === this.rootFiber ? null : owner,
      ownerUid: owner === null || owner === this.rootFiber ? null : owner.uid,
      generations: new Set([fiber]),
      closed: false,
      transition: undefined,
      generation: this.generation,
      retired: false,
    }
    // Register the disposal with the owner once, binding the LOGICAL entry:
    // every later generation remounts under the same owner without touching
    // the owner's effect list again.
    if (entry.owner !== null) {
      entry.owner.effect(() => () => this.closeEntry(entry), `kernel-entry(${definition.name})`)
    }
    this.entries.add(entry)
    // A kernel-issued Fiber handle stays valid across dependency-driven
    // replacement: disposing ANY generation's handle closes the logical entry
    // (K4), so `dispose()` routes through the entry instead of tearing down
    // only this fiber. Kernel-internal teardown never calls this override —
    // it goes through {@link disposeGeneration}, the plain fiber unload.
    fiber.dispose = (): Promise<void> => this.disposeOf(fiber)
    this.start(entry, direct)
    return fiber
  }

  /**
   * Kernel-internal generation teardown: the plain once-only fiber unload,
   * deliberately bypassing the `dispose` override mounted fibers carry. This
   * is the distinct internal cleanup path — it must not close the logical
   * entry nor recurse through the public dispose.
   */
  private disposeGeneration(fiber: Fiber): Promise<void> {
    return Fiber.prototype.dispose.call(fiber)
  }

  /**
   * Resolve a Fiber handle to its logical entry. Any generation's handle —
   * including one retired by a restart — resolves to the SAME entry, which is
   * what keeps "dispose the initial handle after a restart" meaningful.
   * Handles the kernel never issued resolve to `undefined`, so unowned Fiber
   * instances keep their plain teardown behavior.
   */
  private entryOf(fiber: Fiber): PluginEntry | undefined {
    return [...this.entries].find((entry) => entry.generations.has(fiber))
  }

  /**
   * Explicit disposal through ANY generation's Fiber handle: closes the
   * logical entry's admission and disposes its current generation through the
   * coordinated path. `closed` makes the entry invisible to starts, wakes,
   * and restarts; a racing restart joins the same transition (one cleanup)
   * or has already finished.
   */
  private disposeEntry(entry: PluginEntry): Promise<void> {
    entry.closed = true
    return this.runCoordinated(entry, () => false)
  }

  /**
   * The owner-registered disposer: closes the logical entry and disposes its
   * current generation. When a coordinated transition is ALREADY in flight it
   * is disposing this entry's generations anyway — this disposer closes
   * admission and returns WITHOUT awaiting that transition, so an owner
   * unloading during a racing dependency restart never blocks on the child's
   * held cleanup; the transition completes the disposal (closed bars the
   * remount) and reports its own failure.
   */
  private closeEntry(entry: PluginEntry): Promise<void> | undefined {
    entry.closed = true
    if (entry.transition !== undefined) return undefined
    return this.runCoordinated(entry, () => false)
  }

  /**
   * Public dispose facade on a kernel-issued Fiber handle. Shared per handle
   * through {@link closings} so every concurrent caller awaits the same
   * logical-entry disposal; a failure propagates to every caller, and the
   * coordinated teardown failure itself is published once.
   */
  private disposeOf(fiber: Fiber): Promise<void> {
    const cached = this.closings.get(fiber)
    if (cached !== undefined) return cached
    const entry = this.entryOf(fiber)
    // A Fiber the kernel never issued keeps its plain per-fiber disposal.
    if (entry === undefined) return this.disposeGeneration(fiber)
    const closing = this.disposeEntry(entry)
    this.closings.set(fiber, closing)
    return closing
  }

  /**
   * Try to run `entry`: pend while requirements are missing, run the body,
   * and on failure unwind it as a tracked transition. Only a directly mounted
   * plugin propagates a synchronous failure to its caller — a plugin woken by
   * a dependency publication is contained, so one consumer's exception never
   * travels through another provider's `apply`.
   */
  private start(entry: PluginEntry, direct: boolean): void {
    // A stop clears the registry; a pending flush already in flight must not
    // start anything new afterwards.
    if (this.stopped) return
    // Admission closed (explicit disposal through any generation handle), or
    // the coordinated transition already owns this entry's fate: a coalesced
    // reevaluation — not a stale flush pass — decides what runs next.
    if (entry.closed || entry.transition !== undefined) return
    // Barrier against a stale flush: a `flushPending` snapshot taken before a
    // nested wake (or before a coordinated restart's remount) still lists this
    // entry, but a fiber that already ran its body — or is running it — must
    // not run it again. Only a fresh `pending` fiber may start here.
    if (entry.fiber.state !== 'pending') return
    const missing = entry.definition.inject.filter((name) => !this.services.has(name))
    if (missing.length > 0) {
      entry.fiber.state = 'pending'
      return
    }

    entry.fiber.state = 'loading'
    // The generation this startup runs. Its settlement handlers are bound to
    // THIS fiber, not to the entry: a coordinated restart may swap
    // `entry.fiber` while the body is still in flight, and a superseded
    // generation's late resolution or rejection must never act on the
    // replacement generation.
    const fiber = entry.fiber
    let result: void | Promise<void>
    try {
      result = entry.definition.apply(entry.ctx)
    } catch (error) {
      // The unwind and the report are owned even when the caller also gets
      // the synchronous throw.
      this.track(this.failStartup(entry, error, fiber))
      if (direct) throw error
      return
    }
    if (result instanceof Promise) {
      // Track the settlement immediately, with the rejection handler attached
      // in the same stroke: an async startup failure has no caller to throw
      // to anymore, is never an unhandled rejection, and is already a
      // `settle()` task the moment the body returned — even before the
      // rejection itself lands.
      this.track(
        result.then(
          () => this.activated(entry, fiber),
          (error: unknown) => this.failStartup(entry, error, fiber),
        ),
      )
    } else {
      this.activated(entry, fiber)
    }
  }

  /**
   * Settle a failed startup: run the acquired-effect cleanup exactly once,
   * retain the original error as the diagnostic, and publish one startup
   * failure. Cleanup errors accompany the original inside an `AggregateError`
   * (original first) in the published payload — never replacing it — and end
   * the fiber `failed`; a clean unwind ends it `disposed`.
   */
  private async failStartup(entry: PluginEntry, error: unknown, fiber: Fiber): Promise<void> {
    let cleanupError: unknown
    try {
      // Once-only teardown, kernel-internal, bound to the GENERATION that
      // failed: on a live fiber this unwinds the acquired effects; on an
      // already-unloaded one it re-observes the cached completion and cleans
      // nothing twice. It must not route through the public dispose override.
      await this.disposeGeneration(fiber)
    } catch (disposed) {
      cleanupError = disposed
    }
    // The generation was superseded while its body was in flight: the entry
    // already belongs to a replacement that owns its own fate. Disposing the
    // captured generation above is all this settlement may do — no retire, no
    // diagnostic overwrite, no startup failure published against the
    // replacement.
    if (entry.fiber !== fiber) return
    entry.retired = true
    if (this.stopped) return
    entry.error = error
    const published =
      cleanupError === undefined
        ? error
        : new AggregateError(
            [error, ...flattenErrors(cleanupError)],
            `plugin '${entry.definition.name}' failed to start; its cleanup also failed`,
          )
    this.publishFailure(entry, 'startup', published)
  }

  /**
   * Publish one failure event on the kernel bus. Listener exceptions are
   * contained here at the producer — a broken failure observer must not mask
   * the original failure it reports — while ordinary `emit` stays fail-fast.
   */
  private publishFailure(
    entry: PluginEntry,
    phase: PluginFailedPhase,
    fiberOrError: Fiber | unknown,
    maybeError?: unknown,
  ): void {
    // New signature carries the reporting generation explicitly: teardown
    // failures surface on the generation whose cleanup failed, while the
    // logical entry may already have moved to a replacement.
    const fiber = maybeError !== undefined ? (fiberOrError as Fiber) : entry.fiber
    const error = maybeError !== undefined ? maybeError : fiberOrError
    const detail: PluginFailedDetail = {
      name: entry.definition.name,
      fiber,
      phase,
      error,
    }
    const observed = this.events.emitContained('kernel/plugin-failed', detail)
    if (observed.length > 0) {
      console.error(
        `plugin '${entry.definition.name}': ${observed.length} 'kernel/plugin-failed' observer(s) threw`,
        ...observed,
      )
    }
  }

  private activated(entry: PluginEntry, fiber: Fiber): void {
    // A late completion after unload or a dependency-driven restart is
    // history: never reactivate a stale entry.
    if (entry.generation !== this.generation) return
    // Explicit disposal through a stale generation handle while this body was
    // in flight must not reactivate the closed entry.
    if (entry.closed) return
    // Generation fence: this completion belongs to the fiber captured at
    // start. The entry must still be running THAT generation, and only a
    // body still in flight (loading) may settle it — a superseded or already
    // settled generation never reactivates the entry nor fires the flush.
    if (entry.fiber !== fiber || fiber.state !== 'loading') return
    entry.fiber.state = 'active'
    this.flushPending()
  }

  /** Re-try every `pending` entry — a new provider may satisfy it now. */
  private flushPending(): void {
    for (const entry of this.pendingEntries()) {
      this.start(entry, false)
    }
  }

  private pendingEntries(): PluginEntry[] {
    return [...this.entries].filter((entry) => entry.fiber.state === 'pending')
  }

  /**
   * Service additions wake pending plugins; removals coordinate the teardown
   * and remount of every loaded dependent through its stable logical entry.
   * Failed, unloaded, closed, and mid-transition entries are not candidates:
   * a settled failure never restarts, and a transition already in flight
   * reevaluates the new state itself.
   */
  private onServiceChange(change: ServiceChange): void {
    if (this.stopped) return
    if (change.kind === 'added') {
      this.flushPending()
      return
    }
    for (const entry of [...this.entries]) {
      if (entry.closed || entry.retired || entry.transition !== undefined) continue
      if (!isLiveEntry(entry)) continue
      if (!entry.definition.inject.includes(change.name)) continue
      this.track(this.coordinate(entry))
    }
  }

  /**
   * The kernel-internal replacement path. Disposes the entry's generations
   * through {@link runCoordinated} and attaches a fresh generation on the SAME
   * entry under the SAME owner when the owner reevaluates alive — the fresh
   * generation then pends until its dependencies return. This is not the
   * public dispose: it never closes the logical entry, and it never delegates
   * through a public Fiber handle.
   *
   * A failed teardown blocks the replacement: the cleanup that failed cannot
   * prove the plugin unwound safely, so the entry stays retired with its
   * teardown failure published.
   */
  private async coordinate(entry: PluginEntry): Promise<void> {
    await this.runCoordinated(entry, () => {
      // An explicitly closed entry never remounts — even through a transition
      // that started as a dependency restart.
      if (entry.closed) return false
      // Owner liveness reevaluated after cleanup: an owner that unloaded (or
      // is unloading) while the cleanup ran must not own a replacement. The
      // DEPENDENCIES are reevaluated by `start()` on the fresh generation — a
      // missing service simply leaves it `pending`.
      return entry.owner === null || ownerAlive(entry.owner)
    })
  }

  /**
   * Shared coordinated body: open the entry's single transition slot (a
   * concurrent request joins the in-flight run instead of queueing a second
   * teardown), dispose every generation the entry created, then either attach
   * a fresh generation under the same owner or leave the entry with none. A
   * teardown failure retires the entry with one published `teardown` failure
   * and blocks any replacement.
   */
  private async runCoordinated(entry: PluginEntry, shouldAttach: () => boolean): Promise<void> {
    // Coalescing: a request landing while this entry's transition is in
    // flight joins it — one cleanup, one reevaluation — instead of queueing
    // another teardown+remount.
    if (entry.transition !== undefined) return entry.transition
    const run = (async () => {
      let teardownError: unknown
      try {
        for (const fiber of [...entry.generations].reverse()) {
          await this.disposeGeneration(fiber)
        }
      } catch (error) {
        teardownError = error
      }

      // A failed teardown blocks the replacement. Whoever reports the entry's
      // teardown failure retires it first, so a racing explicit disposal or
      // stop over the same cached teardown publishes it exactly once.
      if (teardownError !== undefined) {
        if (!entry.retired) {
          entry.retired = true
          this.publishFailure(entry, 'teardown', entry.fiber, teardownError)
        }
        return
      }

      // Restart path: attach a fresh generation to the SAME logical entry
      // (parent-preserving remount). Retired generations STAY in the set —
      // a stale handle must still resolve to this entry — and a disposed
      // fiber is never mutated back into circulation.
      if (this.stopped) return
      if (!shouldAttach()) return
      const fiber = new Fiber(entry.definition.name)
      entry.fiber = fiber
      entry.ctx = createContext(this, fiber)
      entry.generations.add(fiber)
      // The teardown this slot was coalescing is finished; reopen the start
      // gate so the fresh generation may run (or pend) right now. From here
      // to `start()` there is no await, so no other request can interleave.
      entry.transition = undefined
      this.start(entry, false)
    })()
    entry.transition = run
    try {
      await run
    } finally {
      // The slot reopens exactly when the body settles, so a request arriving
      // DURING the body has joined the in-flight run instead.
      if (entry.transition === run) entry.transition = undefined
    }
  }

  /**
   * Own one transition: `settle()` drains it, and neither its resolution nor
   * its (already contained) rejection is ever dropped on the floor.
   */
  private track(task: Promise<void>): void {
    this.transitions.add(task)
    void task.then(
      () => {
        this.transitions.delete(task)
      },
      () => {
        this.transitions.delete(task)
      },
    )
  }

  /**
   * Track an externally started teardown — the undo of a `ctx.plugin` mount
   * whose ownership registration just failed — so {@link settle} awaits it.
   * Cleanup failures are reported once as `teardown` failures and retire the
   * entry, so stop does not dispose the fiber again or report it twice.
   */
  trackUndo(disposal: Promise<void>, fiber: Fiber): void {
    const entry = this.entryOf(fiber)
    this.track(
      disposal.then(
        () => {
          if (entry) entry.retired = true
        },
        (error: unknown) => {
          if (entry) {
            entry.retired = true
            this.publishFailure(entry, 'teardown', fiber, error)
          }
        },
      ),
    )
  }
}
