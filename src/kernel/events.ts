/**
 * The typed event bus: one of the five dispatch modes is part of each event's
 * contract, decided by the producer and matched by the dispatch method.
 *
 * Plugins declare event signatures through TypeScript declaration merging
 * against the package entry, then dispatch and listen fully typed:
 *
 * ```ts
 * declare module 'dnt-harness' {
 *   interface Events {
 *     'stats/report'(name: string, count: number): void
 *   }
 * }
 * ```
 *
 * Every method also carries an untyped string-key overload for code that
 * dispatches dynamically (loaders, bridges), mirroring Cordis.
 */
export interface Events {}

/** Event dispatch strategy; see each method for its exact semantics. */
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

/** Options accepted by {@link EventBus.on} and {@link EventBus.once}. */
export interface EventOptions {
  /** Register the listener before existing listeners for the same event. */
  prepend?: boolean
}

/**
 * Listener callback at the dispatch boundary: arguments are whatever the
 * producer dispatches, checked statically against `Events` at call sites.
 */
type AnyListener = (...args: any[]) => any

interface ListenerRecord {
  listener: AnyListener
  disposed: boolean
}

/** Returns true for the values that stop a `serial`/`bail` chain. */
function isBail(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false
}

function wantsPrepend(options?: boolean | EventOptions): boolean {
  return options === true || (typeof options === 'object' && options.prepend === true)
}

export class EventBus {
  private records = new Map<string, ListenerRecord[]>()

  /**
   * Register a listener for `name`.
   *
   * @param options — `true` is shorthand for `{ prepend: true }`.
   * @returns a disposer; `true` when it removed a still-registered listener.
   */
  on<K extends string & keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  on(name: string, listener: AnyListener, options?: boolean | EventOptions): () => boolean
  on(name: string, listener: AnyListener, options?: boolean | EventOptions): () => boolean {
    const record: ListenerRecord = { listener, disposed: false }
    const list = this.records.get(name) ?? []
    if (wantsPrepend(options)) {
      list.unshift(record)
    } else {
      list.push(record)
    }
    this.records.set(name, list)
    return () => {
      if (record.disposed) return false
      record.disposed = true
      const current = this.records.get(name)
      const index = current?.indexOf(record) ?? -1
      if (index >= 0) current?.splice(index, 1)
      return true
    }
  }

  /**
   * Same as {@link on}, but the listener disposes itself after its first call.
   *
   * @param options — `true` is shorthand for `{ prepend: true }`.
   * @returns a disposer; `true` when it removed a still-registered listener.
   */
  once<K extends string & keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  once(name: string, listener: AnyListener, options?: boolean | EventOptions): () => boolean
  once(name: string, listener: AnyListener, options?: boolean | EventOptions): () => boolean {
    const dispose = this.on(
      name,
      (...args: never[]) => {
        dispose()
        return listener(...args)
      },
      options,
    )
    return dispose
  }

  /** Dispatch synchronously, in registration order; return values are ignored. */
  emit<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): void
  emit(name: string, ...args: unknown[]): void
  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.snapshot(name)) {
      listener(...args)
    }
  }

  /** Dispatch concurrently; resolves once every listener has settled. Observer failures are contained. */
  parallel<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
  parallel(name: string, ...args: unknown[]): Promise<void>
  async parallel(name: string, ...args: unknown[]): Promise<void> {
    await Promise.allSettled(this.snapshot(name).map((listener) => listener(...args)))
  }

  /**
   * Dispatch awaiting listeners in registration order; the first bail value
   * (non-`null`, non-`false`, non-`undefined`) wins and stops the rest.
   */
  serial<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<Awaited<ReturnType<Events[K]>>>
  serial(name: string, ...args: unknown[]): Promise<unknown>
  async serial(name: string, ...args: unknown[]): Promise<unknown> {
    for (const listener of this.snapshot(name)) {
      const result = await listener(...args)
      if (isBail(result)) return result
    }
    return undefined
  }

  /** Synchronous version of {@link serial}: first bail value wins. */
  bail<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  bail(name: string, ...args: unknown[]): unknown
  bail(name: string, ...args: unknown[]): unknown {
    for (const listener of this.snapshot(name)) {
      const result = listener(...args)
      if (isBail(result)) return result
    }
    return undefined
  }

  /**
   * Around-middleware dispatch: the final dispatch argument is the innermost
   * `next`. Each listener wraps the rest of the chain — calling `next()`
   * delegates (forwarding its arguments, or the original arguments when called
   * with none); returning without calling `next()` vetoes the rest.
   *
   * @returns the outermost listener's return value.
   */
  waterfall<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  waterfall(name: string, ...dispatchArgs: unknown[]): unknown
  waterfall(name: string, ...dispatchArgs: unknown[]): unknown {
    const listeners = this.snapshot(name)
    const defaultNext = dispatchArgs[dispatchArgs.length - 1] as AnyListener
    const eventArgs = dispatchArgs.slice(0, -1)

    const invoke = (index: number, args: unknown[]): unknown => {
      const listener = listeners[index]
      if (listener === undefined) return defaultNext(...args)
      const next = (...nextArgs: unknown[]): unknown =>
        invoke(index + 1, nextArgs.length > 0 ? nextArgs : args)
      return listener(...args, next)
    }

    return invoke(0, eventArgs)
  }

  /** Copy of the currently registered, undisposed listeners for `name`. */
  private snapshot(name: string): AnyListener[] {
    const list = this.records.get(name)
    if (!list) return []
    return list.filter((record) => !record.disposed).map((record) => record.listener)
  }
}
