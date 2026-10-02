import { Service, type Context } from '../../kernel/index.ts'
import type { LlmProvider, ModelRequest, StreamEvent, StreamOptions } from './types.ts'

declare module 'dnt-harness' {
  interface Context {
    llm: LlmService
  }
  interface Events {
    /**
     * Around-middleware over the active provider's stream call: listeners
     * may replace the request downstream or short-circuit with their own
     * iterable. Dispatched by `ctx.llm.stream()`; the default delegates to
     * the selected provider.
     */
    'llm/stream'(
      request: ModelRequest,
      next: (replacement?: ModelRequest) => AsyncIterable<StreamEvent>,
    ): AsyncIterable<StreamEvent>
  }
}

/**
 * The LLM capability seam: a provider registry plus the streaming entry
 * point. Consumers call `ctx.llm.stream(request)`; providers register
 * themselves as effects and can be swapped without touching callers.
 */
export class LlmService extends Service {
  private providers = new Map<string, LlmProvider>()
  private selected: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * Register a provider. The registration is an effect: it unwinds when the
   * owning fiber unloads.
   *
   * @returns a disposer removing the provider.
   */
  register(provider: LlmProvider): () => void {
    this.providers.set(provider.name, provider)
    if (this.selected === undefined) this.selected = provider.name
    const dispose = this.ctx.effect(() => () => {
      this.providers.delete(provider.name)
      if (this.selected === provider.name) this.selected = undefined
    }, `llm.register(${provider.name})`)
    return () => {
      void dispose()
    }
  }

  /**
   * Select the active provider by name. Fails loud on an unknown name so a
   * misconfigured composition never silently streams from the wrong one.
   */
  use(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`llm: no provider named '${name}' (registered: ${[...this.providers.keys()].join(', ') || 'none'})`)
    }
    this.selected = name
  }

  /** The active provider; throws when none is registered. */
  active(): LlmProvider {
    const provider = this.selected === undefined ? undefined : this.providers.get(this.selected)
    if (provider === undefined) {
      throw new Error('llm: no provider registered')
    }
    return provider
  }

  /**
   * Stream a completion through the `llm/stream` waterfall, whose default
   * delegates to the active provider. Model-visible input must come from
   * `Session.deriveMessages()` — anything else breaks the logged-context
   * invariant. The abort signal rides the whole provider chain.
   *
   * When the request carries a trusted `providerName` stamp, the default
   * dispatches to THAT provider instead of the global pointer — execution
   * scoping (per workspace) must not depend on process-global selection.
   *
   * An `async` listener returns a promise of the iterable rather than the
   * iterable itself; the chain result is normalized either way so consumers
   * always receive an `AsyncIterable`.
   */
  stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<StreamEvent> {
    const chained = this.ctx.waterfall('llm/stream', request, (replacement) => {
      const target = replacement ?? request
      // Trusted explicit scope fails closed: a stamped provider that is no
      // longer registered is an error, never a silent fallback to the
      // process-global selection (that would cross workspaces).
      if (target.providerName !== undefined) {
        const provider = this.providers.get(target.providerName)
        if (provider === undefined) {
          throw new Error(`llm: requested provider '${target.providerName}' is not registered`)
        }
        return provider.stream(target, options)
      }
      return this.active().stream(target, options)
    })
    if (isAsyncIterable(chained)) return chained
    return (async function* resolve(awaited: Promise<AsyncIterable<StreamEvent>>) {
      yield* await awaited
    })(chained as Promise<AsyncIterable<StreamEvent>>)
  }

  /** The registered provider's model list, resolved by id (no global pointer). */
  providerModels(providerName: string): readonly string[] {
    return this.providers.get(providerName)?.models ?? []
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamEvent> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value
}
