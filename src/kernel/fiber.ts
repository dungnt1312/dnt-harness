/**
 * Effect body result accepted by {@link Fiber.effect}: a single disposer, a
 * promise of one, or a (possibly async) iterable yielding several.
 */
export type Effect = (() => unknown) | Promise<() => unknown> | Iterable<() => unknown>

/** Lifecycle states of one loaded plugin instance. */
export type FiberState = 'pending' | 'loading' | 'active' | 'unloading' | 'disposed' | 'failed'

/** Tree node exposed by {@link Fiber.getEffects} for diagnostics. */
export interface EffectMeta {
  /** Human-readable effect label. */
  label: string
  /** Metadata of nested effects registered while this effect ran. */
  children: EffectMeta[]
}

/**
 * Exhaustiveness check for closed unions: end every discriminated switch in
 * `default`/`else` position with a call so adding a variant breaks the build.
 */
export function assertNever(value: never, message = 'unreachable variant'): never {
  throw new Error(`${message}: ${String(value)}`)
}

/** Normalize every accepted {@link Effect} shape into one awaitable disposer. */
function normalizeDisposer(result: Effect): () => void | Promise<void> {
  if (typeof result === 'function') {
    const disposer: () => unknown = result
    return async () => {
      await disposer()
    }
  }
  if (result instanceof Promise) {
    return async () => {
      const disposer = await result
      await disposer()
    }
  }
  if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
    const disposers = [...(result as Iterable<() => unknown>)]
    return async () => {
      // Every disposer runs even when an earlier one throws: failures are
      // collected and rethrown as one AggregateError after the loop unwinds.
      const errors: unknown[] = []
      for (const disposer of disposers.reverse()) {
        try {
          await disposer()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'effect cleanup failed')
    }
  }
  throw new TypeError(`invalid effect result: expected disposer, promise, or iterable; got ${typeof result}`)
}

/**
 * One registered effect: a once-only teardown starter. Whatever starts the
 * teardown — the returned early disposer or the whole-fiber unload — awaits
 * the same cached promise, so cleanup runs exactly once however many callers
 * race it.
 */
interface EffectRecord {
  /**
   * Starts the cleanup exactly once and returns its shared promise, which
   * rejects with whatever cleanup threw.
   */
  start: () => Promise<void>
}

/** Create the once-only teardown starter for one registered effect. */
function createEffectRecord(disposer: () => void | Promise<void>): EffectRecord {
  let run: Promise<void> | undefined
  return {
    start: () => {
      if (run === undefined) {
        run = (async () => {
          await disposer()
        })()
        // A dropped early-disposer promise must not surface as an unhandled
        // rejection. Attaching this handler only silences the default
        // report: every caller who awaits `start()` — the early disposer and
        // the whole-fiber teardown — still observes the rejection and
        // decides what to do with it.
        run.catch(() => {})
      }
      return run
    },
  }
}

/** Flatten nested aggregates so the fiber's error carries each cause once. */
function flattenErrors(errors: readonly unknown[]): unknown[] {
  const flat: unknown[] = []
  for (const error of errors) {
    if (error instanceof AggregateError) flat.push(...flattenErrors(error.errors))
    else flat.push(error)
  }
  return flat
}

/** Short description used to summarize cleanup failures in one message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let nextUid = 1

/**
 * One loaded plugin instance: its lifecycle state and registered effects.
 *
 * The fiber owns every registration the plugin makes through `ctx.effect()`,
 * `ctx.on()`, and `ctx.provide()`; disposal runs those cleanups in reverse
 * registration order, awaiting each one, so teardown unwinds predictably.
 */
export class Fiber {
  /** Unique id within the kernel; monotonically increasing. */
  readonly uid: number = nextUid++

  /** Current lifecycle state; `pending` while required services are absent. */
  state: FiberState = 'pending'

  private disposers: Array<EffectRecord> = []
  private effectMetas: EffectMeta[] = []
  /** Whole-fiber teardown completion; cached so every caller shares it. */
  private teardown: Promise<void> | undefined
  /** Started-but-running early disposals; whole-fiber teardown awaits them. */
  private readonly runningDisposals: Set<Promise<void>> = new Set()

  /**
   * @param name — display name used in diagnostics, inherited from the plugin.
   */
  constructor(readonly name: string) {}

  /**
   * Register a cleanup-aware effect on this fiber.
   *
   * `execute` runs immediately; the disposer it produces is collected and run
   * in reverse registration order either when the returned disposer is called
   * or when the fiber unloads, whichever comes first. Calling the returned
   * disposer twice is a no-op. Throws when the fiber is already unloading,
   * disposed, or failed.
   *
   * @param label — effect label shown in {@link getEffects} diagnostics.
   * @returns a disposer that tears this one effect down and settles once done.
   */
  effect(execute: () => Effect, label = 'anonymous effect'): () => Promise<void> {
    switch (this.state) {
      case 'pending':
      case 'loading':
      case 'active':
        break
      case 'unloading':
      case 'disposed':
      case 'failed':
        throw new Error(`cannot create effect on fiber '${this.name}' in state '${this.state}'`)
      default:
        assertNever(this.state)
    }

    const record = createEffectRecord(normalizeDisposer(execute()))
    this.disposers.push(record)
    this.effectMetas.push({ label, children: [] })

    const index = () => this.disposers.indexOf(record)
    return () => this.runEarlyDisposal(record, index)
  }

  /**
   * Run one effect's cleanup outside the fiber list, once, and track the run
   * so a racing {@link dispose} awaits it instead of skipping it. The returned
   * promise rejects when this cleanup throws — for `ctx.on`/`ctx.provide`
   * fire-and-forget callers that rejection is a drop-on-the-floor detail, not
   * the teardown verdict.
   */
  private runEarlyDisposal(record: EffectRecord, locate: () => number): Promise<void> {
    const index = locate()
    // Only a disposer still in the list can start here: once unload claimed
    // it, it is either running already (awaited below) or finished, and the
    // shared `start()` promise keeps the second call a no-op either way.
    if (index >= 0) {
      this.disposers.splice(index, 1)
      const run = record.start()
      this.runningDisposals.add(run)
      void run.finally(() => {
        this.runningDisposals.delete(run)
      })
    }
    return record.start()
  }

  /** Copy of the currently registered effect labels, for diagnostics. */
  getEffects(): EffectMeta[] {
    return this.effectMetas.map((meta) => ({ label: meta.label, children: [...meta.children] }))
  }

  /**
   * Unload this fiber: run every remaining disposer in reverse registration
   * order, awaiting each one, together with any early disposal still running,
   * then settle. All callers share one teardown: concurrent calls await the
   * same completion, and callers arriving after it observe its cached outcome.
   *
   * Successful teardown ends the fiber `disposed`; a cleanup failure ends it
   * `failed` and every caller — current or late — sees an `AggregateError`
   * carrying each cleanup error. `getEffects()` is empty afterwards either
   * way: every disposer was attempted.
   */
  async dispose(): Promise<void> {
    this.teardown ??= this.runTeardown()
    await this.teardown
  }

  /**
   * Whole-fiber teardown body, started at most once per fiber. Unwinds the
   * remaining effects newest-first, awaits early disposals that are still
   * running, collects every cleanup error, and settles: `disposed` when every
   * cleanup succeeded, `failed` with an `AggregateError` otherwise.
   */
  private async runTeardown(): Promise<void> {
    this.state = 'unloading'
    const errors: unknown[] = []
    // Not-yet-started effects unwind newest-first. `start()` hands every
    // caller the same run, and each disposer runs exactly once; a failing
    // cleanup is collected and the remaining effects still run.
    while (this.disposers.length > 0) {
      const record = this.disposers.pop()
      if (!record) continue
      try {
        await record.start()
      } catch (error) {
        errors.push(error)
      }
    }
    // An early disposer may have started its cleanup before unload; its
    // failure counts too, and unload settles only after it finishes.
    for (const run of [...this.runningDisposals]) {
      try {
        await run
      } catch (error) {
        errors.push(error)
      }
    }
    this.effectMetas = []
    if (errors.length > 0) {
      this.state = 'failed'
      const flat = flattenErrors(errors)
      throw new AggregateError(flat, `fiber '${this.name}' cleanup failed: ${flat.map(describeError).join('; ')}`)
    }
    this.state = 'disposed'
  }
}
