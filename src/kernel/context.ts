import type { EventBus, Events, EventOptions } from './events.ts'
import { Fiber, type Effect } from './fiber.ts'
import type { Kernel, PluginTarget } from './registry.ts'

/**
 * The runtime half of the context. Instances are created through
 * {@link createContext}, which returns a proxy resolving unknown string
 * properties against the kernel's service store — so `ctx.tools` reads the
 * `tools` service without importing its provider.
 *
 * Known members (methods, `events`, `fiber`) shadow services of the same
 * name; service names share one flat namespace with them.
 */
export class Context {
  constructor(
    private readonly kernel: Kernel,
    /** The fiber (plugin runtime instance) that owns this context. */
    readonly fiber: Fiber,
  ) {}

  /** The shared event bus. */
  get events(): EventBus {
    return this.kernel.events
  }

  /**
   * Register an event listener owned by the current fiber: the listener is
   * removed when the fiber unloads, so plugins never bookkeep removals.
   *
   * @param options — `true` is shorthand for `{ prepend: true }`.
   * @returns a disposer removing the listener early.
   */
  on<K extends string & keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  on(name: string, listener: (...args: never[]) => unknown, options?: boolean | EventOptions): () => boolean
  on(name: string, listener: (...args: never[]) => unknown, options?: boolean | EventOptions): () => boolean {
    const dispose = this.events.on(name, listener, options)
    void this.fiber.effect(() => dispose, `ctx.on(${name})`)
    return dispose
  }

  /**
   * Register a one-shot listener owned by the current fiber.
   *
   * @param options — `true` is shorthand for `{ prepend: true }`.
   * @returns a disposer removing the listener before it ever fires.
   */
  once<K extends string & keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  once(name: string, listener: (...args: never[]) => unknown, options?: boolean | EventOptions): () => boolean
  once(name: string, listener: (...args: never[]) => unknown, options?: boolean | EventOptions): () => boolean {
    const dispose = this.events.once(name, listener, options)
    void this.fiber.effect(() => dispose, `ctx.once(${name})`)
    return dispose
  }

  /** Dispatch synchronously, in registration order; return values are ignored. */
  emit<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): void
  emit(name: string, ...args: unknown[]): void
  emit(name: string, ...args: unknown[]): void {
    this.events.emit(name, ...args)
  }

  /** Dispatch concurrently; resolves once every listener has settled. */
  parallel<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
  parallel(name: string, ...args: unknown[]): Promise<void>
  async parallel(name: string, ...args: unknown[]): Promise<void> {
    await this.events.parallel(name, ...args)
  }

  /**
   * Dispatch awaiting listeners in registration order; the first bail value
   * (non-`null`, non-`false`, non-`undefined`) wins and stops the rest.
   */
  serial<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<Awaited<ReturnType<Events[K]>>>
  serial(name: string, ...args: unknown[]): Promise<unknown>
  async serial(name: string, ...args: unknown[]): Promise<unknown> {
    return this.events.serial(name, ...args)
  }

  /** Synchronous version of {@link serial}: first bail value wins. */
  bail<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  bail(name: string, ...args: unknown[]): unknown
  bail(name: string, ...args: unknown[]): unknown {
    return this.events.bail(name, ...args)
  }

  /**
   * Around-middleware dispatch: the final dispatch argument is the innermost
   * `next`. Each listener wraps the rest of the chain — calling `next()`
   * delegates; returning without calling it vetoes the rest of the chain.
   *
   * @returns the outermost listener's return value.
   */
  waterfall<K extends string & keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  waterfall(name: string, ...args: unknown[]): unknown
  waterfall(name: string, ...args: unknown[]): unknown {
    return this.events.waterfall(name, ...args)
  }

  /**
   * Register a cleanup-aware effect on the current fiber. See
   * {@link Fiber.effect} for ordering and failure semantics.
   *
   * @returns a disposer that tears this one effect down and settles once done.
   */
  effect(execute: () => Effect, label?: string): () => Promise<void> {
    return this.fiber.effect(execute, label)
  }

  /**
   * Register a service implementation owned by the current fiber. The value
   * becomes visible as `ctx.<name>` to consumers; it is unregistered when the
   * returned disposer runs or the fiber unloads. Throws when the name is
   * already provided.
   *
   * @returns a disposer that unregisters the service.
   */
  provide(name: string, value: unknown): () => Promise<void> {
    this.kernel.services.set(name, value)
    return this.fiber.effect(() => () => this.kernel.services.delete(name), `ctx.provide(${name})`)
  }

  /**
   * Read a service without declaring an inject requirement: `undefined` when
   * no provider is loaded. Use for optional capabilities only.
   */
  get(name: string): unknown {
    return this.kernel.services.get(name)
  }

  /**
   * Mount a plugin as a child of the current fiber. The child is disposed
   * when this fiber unloads. When a dependency change later restarts the
   * child, the fresh fiber mounts root-owned — parent linkage is not
   * re-established across dependency-driven restarts.
   *
   * @returns the child fiber.
   */
  plugin(target: PluginTarget): Fiber {
    const definition = this.kernel.resolvePlugin(target)
    const child = this.kernel.plugin(definition)
    // The effect body must return a disposer, not the teardown promise
    // itself: returning `child.dispose()` here would be mistaken for a
    // promise *of* a disposer and crash at unload.
    void this.fiber.effect(() => () => child.dispose(), `ctx.plugin(${definition.name})`)
    return child
  }
}

/**
 * Service properties, merged by plugins through declaration merging:
 *
 * ```ts
 * declare module 'dnt-harness' {
 *   interface Context {
 *     greeter: GreeterService
 *   }
 * }
 * ```
 *
 * The runtime resolution goes through the proxy created by
 * {@link createContext}; this interface only carries the static types.
 */
export interface Context {}

/**
 * Create a fiber-owned context proxy. Reads of properties the runtime class
 * does not define resolve against the kernel service store; reads of unknown
 * names return `undefined` (an optional service), never throw.
 */
export function createContext(kernel: Kernel, fiber: Fiber): Context {
  const target = new Context(kernel, fiber)
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string' && property in object) {
        return Reflect.get(object, property, receiver)
      }
      if (typeof property === 'string') {
        return kernel.services.get(property)
      }
      return undefined
    },
  }) as Context
}
