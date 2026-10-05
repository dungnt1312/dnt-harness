import { Service, type Context } from '../../kernel/index.ts'
import { AttemptAdmission, LogicalRequest, runAttempt, type AttemptObserver, type PhysicalAdmission } from './request-lifecycle.ts'
import { ProviderError, type LlmProvider, type ModelRequest, type StreamEvent, type StreamOptions } from './types.ts'

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
  /** Shared host registry survives Agent/session residency changes. */
  private readonly admissions = new Map<string, AttemptAdmission>()
  observer: AttemptObserver | undefined

  configureAdmission(providerName: string, admission: PhysicalAdmission): void {
    const previous = this.admissions.get(providerName)
    if (previous && previous.active > 0) throw new Error('cannot replace live provider admission')
    this.admissions.set(providerName, admission instanceof AttemptAdmission ? admission : new AttemptAdmission(4, admission))
  }

  admission(providerName: string): AttemptAdmission {
    let admission = this.admissions.get(providerName)
    if (!admission) { admission = new AttemptAdmission(); this.admissions.set(providerName, admission) }
    return admission
  }

  private readonly sessionsInFlight = new Set<string>()

  sessionUncertain(sessionId: string): boolean {
    return [...this.admissions.values()].some(admission => [...admission.uncertain.values()].some(fact => fact.attribution?.sessionId === sessionId))
  }

  private async *admitted(provider: LlmProvider, request: ModelRequest, options?: StreamOptions): AsyncIterable<StreamEvent> {
    const sessionId = options?.attribution?.sessionId
    if (sessionId && (this.sessionsInFlight.has(sessionId) || this.sessionUncertain(sessionId))) {
      const error = new ProviderError('session retains provider request ownership')
      error.transportSettled = false
      throw error
    }
    if (sessionId) this.sessionsInFlight.add(sessionId)
    const owner = options?.requestOwner ?? new LogicalRequest()
    try {
      yield* runAttempt(provider, request, { owner, admission: this.admission(provider.name), provider: provider.name, ...(options?.attribution ? { attribution: options.attribution } : {}), ...(options?.recordAttempt ? { recordAttempt: options.recordAttempt } : {}), ...(options?.signal ? { signal: options.signal } : {}), ...(this.observer ? { observer: this.observer } : {}) })
    } finally {
      if (sessionId) this.sessionsInFlight.delete(sessionId)
      if (!options?.requestOwner) owner.dispose()
    }
  }

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
    const selected = request.providerName === undefined ? this.active() : this.providers.get(request.providerName)
    if (!selected) throw new Error(`llm: requested provider '${request.providerName}' is not registered`)
    // Admission surrounds middleware as well as default dispatch: a short circuit
    // cannot evade the owner's attempt budget or host uncertainty accounting.
    const dispatch: LlmProvider = { name: selected.name, stream: (_request, attemptOptions) => {
      let dispatched = false
      const chained = this.ctx.waterfall('llm/stream', request, (replacement) => {
        if (dispatched) throw new Error('llm middleware default dispatch is single-use')
        dispatched = true
        const target = replacement ?? request
        // Admission is for the already selected connection; fail closed on rerouting.
        if (target.providerName !== undefined) {
          const provider = this.providers.get(target.providerName)
          if (provider === undefined) {
            throw new Error(`llm: requested provider '${target.providerName}' is not registered`)
          }
          if (provider.name !== selected.name) throw new Error('llm middleware cannot change admitted provider connection')
          return provider.stream(target, attemptOptions)
        }
        return selected.stream(target, attemptOptions)
      })
      if (isAsyncIterable(chained)) return chained
      return (async function* resolve(awaited: Promise<AsyncIterable<StreamEvent>>) {
        yield* await awaited
      })(chained as Promise<AsyncIterable<StreamEvent>>)
    } }
    return this.admitted(dispatch, request, options)
  }

  /** The registered provider's model list, resolved by id (no global pointer). */
  providerModels(providerName: string): readonly string[] {
    return this.providers.get(providerName)?.models ?? []
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamEvent> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value
}
