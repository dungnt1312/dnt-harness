import { randomUUID } from 'node:crypto'
import { ProviderError, type ModelRequest, type ProviderErrorPhase, type StreamEvent, type TokenUsage } from './types.ts'
import { isValidContextId, isValidTokenUsage } from '../context/context-metrics.ts'

export interface AttemptTicket { release(): void }
/**
 * `priority: 'low'` marks speculative background work (a compaction candidate).
 * It may use spare capacity but never the last free slot, and queued foreground
 * requests are always admitted first. Omitted means ordinary admission.
 */
export interface AdmissionOptions { readonly priority?: 'low' }
export interface PhysicalAdmission { acquire(signal: AbortSignal, options?: AdmissionOptions): Promise<AttemptTicket> }
export interface AttemptAttribution { readonly sessionId: string; readonly turnId: string; readonly stepId: string }
export interface AttemptFact {
  readonly contextId?: string
  /** Final valid cumulative report; only on terminal attempt facts. */
  readonly usage?: TokenUsage
  readonly attribution?: AttemptAttribution
  readonly provider?: string
  readonly model?: string
  readonly queuedAt?: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly firstProgressAt?: number
  readonly lastProgressAt?: number
  readonly finish?: import('./types.ts').ModelFinishReason
  readonly requestId: string
  readonly attemptId: string
  readonly attempt: number
  readonly state: 'start' | 'end' | 'uncertain' | 'reconciled'
  readonly committed: boolean
  readonly reason?: ProviderError['reason']
  readonly transportSettled: boolean
}
export type AttemptObserver = (fact: AttemptFact) => void
const failure = (reason: ProviderError['reason'], retryable = false): ProviderError => new ProviderError(`provider request: ${reason}`, { reason, transient: retryable })

/** Host lifetime, not session lifetime. Capacity also bounds unresolved ownership. */
export class AttemptAdmission implements PhysicalAdmission {
  active = 0
  readonly uncertain = new Map<string, AttemptFact>()
  private waiters: { readonly admit: () => boolean }[] = []
  constructor(readonly capacity = 4, private readonly delegate?: PhysicalAdmission) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('invalid provider capacity')
  }
  /**
   * Offer free capacity to the queue in arrival order. No separate foreground-first
   * pass is needed: a foreground request only queues when every slot is taken, and
   * a low-priority one cannot take the last slot, so they are never both admissible.
   */
  private pump(): void {
    for (const waiter of [...this.waiters]) waiter.admit()
  }
  acquire(signal: AbortSignal, options?: AdmissionOptions): Promise<AttemptTicket> {
    if (this.delegate) return this.delegate.acquire(signal, options).then(ticket => {
      if (signal.aborted) { ticket.release(); throw signal.reason }
      this.active++
      let released = false
      return { release: () => { if (released) return; released = true; this.active--; ticket.release() } }
    })
    const low = options?.priority === 'low'
    return new Promise((resolve, reject) => {
      const remove = (): void => { this.waiters = this.waiters.filter(w => w !== waiter); signal.removeEventListener('abort', abort) }
      const abort = (): void => { remove(); reject(signal.reason instanceof ProviderError ? signal.reason : failure('cancelled')) }
      const admit = (): boolean => {
        if (signal.aborted) { abort(); return false }
        // A low-priority request leaves one slot for the foreground, so with a single slot it never runs.
        if (this.active >= (low ? this.capacity - 1 : this.capacity)) return false
        remove(); this.active++
        let released = false
        resolve({ release: () => {
          if (released) return
          released = true; this.active--
          this.pump()
        } })
        return true
      }
      const waiter = { admit }
      if (signal.aborted) { abort(); return }
      this.waiters.push(waiter)
      signal.addEventListener('abort', abort, { once: true })
      admit()
    })
  }
}
export interface RequestPolicy { firstProgressMs?: number; idleMs?: number; totalMs?: number; maxAttempts?: number; retryBaseMs?: number }
/** One owner spans reassembly, squeezing, queueing and all physical attempts. */
export class LogicalRequest {
  readonly id = randomUUID()
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  attempts = 0
  readonly policy: Required<RequestPolicy>
  private timer: ReturnType<typeof setTimeout>
  constructor(policy: RequestPolicy = {}) {
    this.policy = { firstProgressMs: 600_000, idleMs: 300_000, totalMs: 1_800_000, maxAttempts: 4, retryBaseMs: 1_000, ...policy }
    for (const value of Object.values(this.policy)) if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('invalid request policy')
    if (this.policy.maxAttempts > 4) throw new Error('physical attempt budget exceeds four')
    this.timer = setTimeout(() => this.controller.abort(failure('total_timeout')), this.policy.totalMs)
    this.timer.unref?.()
  }
  consume(): number {
    this.assertLive()
    if (this.attempts >= this.policy.maxAttempts) throw new ProviderError('provider attempt budget exhausted')
    return ++this.attempts
  }
  assertLive(): void { if (this.signal.aborted) throw this.signal.reason }
  cancel(): void { this.controller.abort(failure('cancelled')) }
  dispose(): void { clearTimeout(this.timer) }
  canRetry(error: ProviderError, committed: boolean): boolean {
    return !this.signal.aborted && !committed && error.transportSettled && this.attempts < this.policy.maxAttempts && (error.retryable || error.contextExceeded)
  }
  async wait<T>(promise: Promise<T>): Promise<T> { return raceSignal(promise, this.signal) }
  async backoff(signal?: AbortSignal, retryAfterMs?: number): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.aborted ? failure('cancelled') : this.signal.reason)
    this.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true })
    if (this.signal.aborted || signal?.aborted) abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await raceSignal(new Promise<void>(resolve => { timer = setTimeout(resolve, retryAfterMs !== undefined ? Math.min(30_000, Math.max(0, retryAfterMs)) : Math.min(30_000, this.policy.retryBaseMs * 2 ** Math.max(0, this.attempts - 1)) * (0.5 + Math.random() / 2)) }), controller.signal)
    } finally { if (timer) clearTimeout(timer); this.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort) }
  }
}

/** Never copies arbitrary exception messages, URLs, headers or nested causes. */
export function classifyTransport(error: unknown, phase: ProviderErrorPhase): ProviderError {
  let current = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const record = current as { code?: unknown; cause?: unknown }
    const code = typeof record.code === 'string' ? record.code : ''
    if (/CERT|TLS|INVALID_URL/.test(code)) return new ProviderError('provider transport configuration failure', { reason: 'auth_configuration', phase })
    if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return new ProviderError('provider transport interrupted', { reason: code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'reset' : phase === 'connect' ? 'connect' : 'read', phase, transient: true })
    current = record.cause
  }
  return new ProviderError('provider transport failure', { reason: 'unknown', phase })
}
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** Silence after which a dropped connection reads as a gateway idle cutoff. */
export const GATEWAY_IDLE_CUT_MS = 60_000

/**
 * A reset after a long silence is almost always a proxy or CDN in front of
 * the provider dropping an idle connection, typically while the model writes
 * one large tool call the gateway buffers whole. Say so in the message: a
 * bare "transport interrupted" sends diagnosis down the wrong path.
 */
export function gatewayIdleCut(error: ProviderError, lastActivityAt: number | undefined, now = Date.now()): ProviderError {
  if (error.reason !== 'reset' || lastActivityAt === undefined) return error
  const silentMs = now - lastActivityAt
  if (silentMs < GATEWAY_IDLE_CUT_MS) return error
  const annotated = new ProviderError(`provider transport interrupted after ${Math.round(silentMs / 1000)}s without output (likely a gateway idle cutoff)`, { reason: 'reset', phase: error.phase, transient: error.retryable })
  annotated.transportSettled = error.transportSettled
  return annotated
}

export async function* runAttempt(provider: { stream(request: ModelRequest, options?: import('./types.ts').StreamOptions): AsyncIterable<StreamEvent> }, request: ModelRequest, options: { owner: LogicalRequest; admission: AttemptAdmission; priority?: 'low'; signal?: AbortSignal; observer?: AttemptObserver; attribution?: AttemptAttribution; provider?: string; recordAttempt?: (fact: AttemptFact) => Promise<void> }): AsyncIterable<StreamEvent> {
  const { owner, admission, observer } = options
  const controller = new AbortController()
  const abort = (): void => controller.abort(options.signal?.aborted ? failure('cancelled') : owner.signal.reason)
  owner.signal.addEventListener('abort', abort, { once: true }); options.signal?.addEventListener('abort', abort, { once: true })
  if (owner.signal.aborted || options.signal?.aborted) abort()
  let ticket: AttemptTicket | undefined
  let iterator: AsyncIterator<StreamEvent> | undefined
  let pending: Promise<IteratorResult<StreamEvent>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let cleanupUnknown = false
  let attemptFailed = false
  let reconcile: (() => void) | undefined
  let resolveSettlement!: () => void
  const settlement = new Promise<void>(resolve => { resolveSettlement = resolve })
  const onTransportSettled = (): void => { settled = true; resolveSettlement(); reconcile?.() }
  let committed = false
  let fact: AttemptFact | undefined
  const queuedAt = Date.now()
  let firstProgressAt: number | undefined
  let lastProgressAt: number | undefined
  let finish: AttemptFact['finish']
  let usage: TokenUsage | undefined
  const notify = async (state: AttemptFact['state'], reason?: ProviderError['reason']): Promise<void> => {
    if (!fact) return
    const next: AttemptFact = { ...fact, state, committed, transportSettled: settled, ...(state !== 'start' ? { endedAt: Date.now(), ...(usage !== undefined ? { usage } : {}) } : {}), ...(firstProgressAt !== undefined ? { firstProgressAt } : {}), ...(lastProgressAt !== undefined ? { lastProgressAt } : {}), ...(finish ? { finish } : {}), ...(reason ? { reason } : {}) }
    try { observer?.(next) } catch { /* optional telemetry cannot change execution */ }
    await options.recordAttempt?.(next)
  }
  try {
    ticket = await admission.acquire(controller.signal, options.priority !== undefined ? { priority: options.priority } : undefined)
    const attempt = owner.consume()
    fact = { ...(isValidContextId(request.contextId) ? { contextId: request.contextId } : {}), requestId: owner.id, attemptId: randomUUID(), attempt, state: 'start', committed, transportSettled: false, queuedAt, startedAt: Date.now(), ...(options.attribution ? { attribution: options.attribution } : {}), ...(options.provider ? { provider: options.provider.slice(0, 128) } : {}), ...(request.model ? { model: request.model.slice(0, 128) } : {}) }
    await notify('start')
    const arm = (ms: number, reason: 'first_progress_timeout' | 'idle_timeout'): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => controller.abort(failure(reason, true)), ms); timer.unref?.()
    }
    arm(owner.policy.firstProgressMs, 'first_progress_timeout')
    iterator = provider.stream(request, { signal: controller.signal, requestOwner: owner, onTransportSettled })[Symbol.asyncIterator]()
    for (;;) {
      pending = Promise.resolve(iterator.next())
      const result = await raceSignal(pending, controller.signal)
      pending = undefined
      if (result.done) { settled = true; break }
      const event = result.value
      if (event.type === 'usage') {
        if (isValidTokenUsage(event.usage)) usage = { ...event.usage }
        else console.warn('invalid provider token usage')
      }
      if (event.type === 'completion') finish = event.finishReason
      if ((event.type === 'delta' && event.delta !== '') || event.type === 'toolCallProgress' || (event.type === 'toolCalls' && event.calls.length > 0)) {
        lastProgressAt = Date.now(); firstProgressAt ??= lastProgressAt
        arm(owner.policy.idleMs, 'idle_timeout')
      }
      if ((event.type === 'delta' && event.delta !== '') || (event.type === 'toolCalls' && event.calls.length > 0)) committed = true
      yield event
    }
    await notify('end')
  } catch (caught) {
    attemptFailed = true
    const error = gatewayIdleCut(controller.signal.aborted ? controller.signal.reason as ProviderError : caught instanceof ProviderError ? caught : classifyTransport(caught, 'stream'), lastProgressAt ?? fact?.startedAt)
    cleanupUnknown = caught instanceof ProviderError && !caught.transportSettled
    // A timed-out read is not settled merely because return() resolves.
    if (!controller.signal.aborted && error.transportSettled) onTransportSettled()
    if (pending) {
      const cleanup = pending.then(async result => {
        if (result.done) onTransportSettled()
        else if (iterator?.return && (await iterator.return()).done && !cleanupUnknown) onTransportSettled()
      }, async late => {
        if (late instanceof ProviderError) {
          if (late.transportSettled) onTransportSettled()
        } else if (iterator?.return && (await iterator.return()).done && !cleanupUnknown) {
          // A rejected read followed by verified iterator closure is local
          // settlement, even when the abort race won before the rejection.
          onTransportSettled()
        }
      }).catch(() => {})
      if (error.reason === 'cancelled') {
        // Give cooperative abort/return bookkeeping one bounded event-loop
        // checkpoint before publishing uncertainty or opening a successor.
        let checkpoint: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([cleanup, new Promise<void>(resolve => { checkpoint = setTimeout(resolve, 0) })]) }
        finally { if (checkpoint) clearTimeout(checkpoint) }
      }
    }
    if (!settled && (error.reason === 'first_progress_timeout' || error.reason === 'idle_timeout')) {
      let grace: ReturnType<typeof setTimeout> | undefined
      try {
        const waiting = owner.wait(Promise.race([settlement, new Promise<void>(resolve => { grace = setTimeout(resolve, 10_000); grace.unref?.() })]))
        await (options.signal ? raceSignal(waiting, options.signal) : waiting)
      } catch { /* total deadline or Stop still prohibits retry */ }
      finally { if (grace) clearTimeout(grace) }
    }
    error.transportSettled = settled
    await notify('end', error.reason)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    owner.signal.removeEventListener('abort', abort); options.signal?.removeEventListener('abort', abort)
    if (settled || !iterator) ticket?.release()
    else if (fact && ticket) {
      controller.abort(failure('cancelled'))
      const retained = { ...fact, ...(usage !== undefined ? { usage } : {}), state: 'uncertain' as const, committed, transportSettled: false }
      admission.uncertain.set(fact.attemptId, retained)
      // Callback ownership survives the driver and may reconcile exactly once.
      const id = fact.attemptId
      const ownedTicket = ticket
      let released = false
      reconcile = () => {
        if (released) return
        released = true; admission.uncertain.delete(id); ownedTicket.release()
        void notify('reconciled').catch(() => { /* canonical store surfaces poisoning; local settlement remains verified */ })
      }
      try {
        await notify('uncertain')
      } catch (error) {
        // Do not replace the attempt (or canonical end-record) failure already
        // propagating. A consumer return still surfaces a canonical sink failure.
        if (!attemptFailed) throw error
      } finally {
        if (settled) reconcile()
        if (!pending && !cleanupUnknown && iterator.return) {
          try {
            void Promise.resolve(iterator.return()).then(result => { if (result.done) onTransportSettled() }, () => {})
          } catch { /* failed cleanup is not settlement and must not mask the attempt failure */ }
        }
      }
    }
  }
}
