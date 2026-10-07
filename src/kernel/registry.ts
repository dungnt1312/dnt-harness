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
  name: string
  /** The fiber running (or having run) this plugin. */
  fiber: Fiber
  /** uid of the fiber whose unload disposes this entry; the root's uid when root-owned. */
  parentUid: number
  /** The original startup error; absent when the plugin did not fail to start. */
  error?: unknown
}

/** One mounted plugin: its definition plus the fiber/context pair running it. */
interface PluginEntry {
  definition: ResolvedPlugin
  fiber: Fiber
  ctx: Context
  /** uid of the fiber whose unload disposes this entry (the root when root-owned). */
  parentUid: number
  /** Registry generation at mount; an entry from an older generation never reactivates after stop. */
  generation: number
  /** The original startup error, retained until kernel stop. */
  error?: unknown
  /**
   * The startup settlement is fully done — cleanup ran, the failure was
   * published once — so `stop()` has nothing left to replay for this entry.
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
  /** Bumped on every dependency-driven remount and on stop. */
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
   * Prefer {@link Context.plugin}, which also ties the child to a parent.
   *
   * @param parent — the fiber whose unload disposes this entry; the root when omitted.
   */
  plugin(definition: ResolvedPlugin, parent?: Fiber): Fiber {
    return this.mount(definition, parent ?? this.rootFiber, true)
  }

  /**
   * Snapshot every mounted plugin — live, pending, failed, or unloaded — as
   * fresh copies. Mutating a snapshot never changes what the kernel reports.
   */
  inspect(): PluginDiagnostic[] {
    const diagnostics: PluginDiagnostic[] = []
    for (const entry of this.entries) {
      const diagnostic: PluginDiagnostic = {
        name: entry.definition.name,
        fiber: entry.fiber,
        parentUid: entry.parentUid,
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
        await entry.fiber.dispose()
      } catch (error) {
        this.publishFailure(entry, 'teardown', error)
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
  private mount(definition: ResolvedPlugin, parent: Fiber, direct: boolean): Fiber {
    const fiber = new Fiber(definition.name)
    const entry: PluginEntry = {
      definition,
      fiber,
      ctx: createContext(this, fiber),
      parentUid: parent.uid,
      generation: this.generation,
      retired: false,
    }
    this.entries.add(entry)
    this.start(entry, direct)
    return fiber
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
    const missing = entry.definition.inject.filter((name) => !this.services.has(name))
    if (missing.length > 0) {
      entry.fiber.state = 'pending'
      return
    }

    entry.fiber.state = 'loading'
    let result: void | Promise<void>
    try {
      result = entry.definition.apply(entry.ctx)
    } catch (error) {
      // The unwind and the report are owned even when the caller also gets
      // the synchronous throw.
      this.track(this.failStartup(entry, error))
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
          () => this.activated(entry),
          (error: unknown) => this.failStartup(entry, error),
        ),
      )
    } else {
      this.activated(entry)
    }
  }

  /**
   * Settle a failed startup: run the acquired-effect cleanup exactly once,
   * retain the original error as the diagnostic, and publish one startup
   * failure. Cleanup errors accompany the original inside an `AggregateError`
   * (original first) in the published payload — never replacing it — and end
   * the fiber `failed`; a clean unwind ends it `disposed`.
   */
  private async failStartup(entry: PluginEntry, error: unknown): Promise<void> {
    let cleanupError: unknown
    try {
      // Once-only teardown: on a live fiber this unwinds the acquired
      // effects; on an already-unloaded one it re-observes the cached
      // completion and cleans nothing twice.
      await entry.fiber.dispose()
    } catch (disposed) {
      cleanupError = disposed
    }
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
  private publishFailure(entry: PluginEntry, phase: PluginFailedPhase, error: unknown): void {
    const detail: PluginFailedDetail = {
      name: entry.definition.name,
      fiber: entry.fiber,
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

  private activated(entry: PluginEntry): void {
    // A late completion after unload or a dependency-driven restart is
    // history: never reactivate a stale entry.
    if (entry.generation !== this.generation) return
    if (entry.fiber.state !== 'loading') return
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
   * Service additions wake pending plugins; removals dispose every loaded
   * dependent and re-mount it, so it pends until the service returns. Failed
   * and unloaded entries are not candidates: a settled failure never
   * restarts. The removal of a service during kernel teardown is not
   * observed: `stop()` detaches the listener first.
   */
  private onServiceChange(change: ServiceChange): void {
    if (this.stopped) return
    if (change.kind === 'added') {
      this.flushPending()
      return
    }
    for (const entry of [...this.entries]) {
      if (!isLiveEntry(entry)) continue
      if (!entry.definition.inject.includes(change.name)) continue
      this.track(this.restartEntry(entry))
    }
  }

  private async restartEntry(entry: PluginEntry): Promise<void> {
    try {
      await entry.fiber.dispose()
    } catch (error) {
      this.publishFailure(entry, 'teardown', error)
    }
    this.entries.delete(entry)
    // A stop that raced this restart must not see a fresh mount afterwards.
    if (this.stopped) return
    // The re-mount is kernel-internal, never a direct caller: its startup is
    // wake-contained.
    this.mount(entry.definition, this.rootFiber, false)
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
}
