import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel, LlmService } from '../../src/index.ts'
import { AttemptAdmission, LogicalRequest, classifyTransport, runAttempt } from '../../src/harness/llm/request-lifecycle.ts'
import { ProviderError, type StreamEvent, type StreamOptions } from '../../src/harness/llm/types.ts'
import { resolveLimits, DEFAULT_LIMITS } from '../../src/harness/limits.ts'

const request = { messages: [] }
const completion: StreamEvent = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
const collect = async (stream: AsyncIterable<StreamEvent>) => { const result = []; for await (const e of stream) result.push(e); return result }
afterEach(() => vi.useRealTimers())
describe('aggregate request lifecycle', () => {
  it('fences a retained session across reload even with spare provider capacity', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    let settle!: (value: IteratorResult<StreamEvent>) => void
    let starts = 0
    kernel.ctx.llm.register({ name: 'shared', stream: () => {
      starts++
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(resolve => { settle = resolve }) }) }
    } })
    const stop = new AbortController()
    const running = collect(kernel.ctx.llm.stream(request, { signal: stop.signal, attribution: { sessionId: 'session', turnId: 'turn', stepId: 'step' } }))
    const assertion = expect(running).rejects.toThrow()
    await vi.waitFor(() => expect(starts).toBe(1))
    stop.abort()
    await assertion
    expect(kernel.ctx.llm.sessionUncertain('session')).toBe(true)
    const reload = collect(kernel.ctx.llm.stream(request, { attribution: { sessionId: 'session', turnId: 'new-turn', stepId: 'new-step' } }))
    await expect(reload).rejects.toMatchObject({ transportSettled: false })
    expect(starts).toBe(1)
    settle({ done: true, value: undefined })
    await vi.waitFor(() => expect(kernel.ctx.llm.sessionUncertain('session')).toBe(false))
    await kernel.stop()
  })
  it('releases cooperative cancellation ownership before a same-session successor', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let calls = 0
    kernel.ctx.llm.register({ name: 'cooperative', async *stream(_request, options) {
      if (++calls === 1) {
        started()
        await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      } else yield completion
    } })
    const stop = new AbortController()
    const attribution = { sessionId: 'session', turnId: 'turn', stepId: 'step' }
    const running = collect(kernel.ctx.llm.stream(request, { signal: stop.signal, attribution }))
    const assertion = expect(running).rejects.toThrow()
    await ready
    stop.abort()
    await assertion
    expect(kernel.ctx.llm.sessionUncertain('session')).toBe(false)
    expect(kernel.ctx.llm.admission('cooperative').active).toBe(0)
    expect(await collect(kernel.ctx.llm.stream(request, { attribution }))).toEqual([completion])
    await kernel.stop()
  })
  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT'])('classifies known %s without echoing causes', code => {
    const error = classifyTransport(new Error('SECRET', { cause: { code, message: 'SECRET' } }), 'connect')
    expect(error.retryable).toBe(true)
    expect(error.message).not.toContain('SECRET')
  })
  it.each(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_URL', 'UNKNOWN'])('does not retry %s', code => {
    expect(classifyTransport({ code }, 'connect').retryable).toBe(false)
  })
  it('shares four attempts including squeeze and rejects further starts', () => {
    const owner = new LogicalRequest()
    for (let i = 0; i < 4; i++) owner.consume()
    expect(() => owner.consume()).toThrow('attempt budget')
    owner.dispose()
  })
  it('cancelled queued admission makes zero starts and releases once', async () => {
    const admission = new AttemptAdmission(1)
    const ticket = await admission.acquire(new AbortController().signal)
    const controller = new AbortController()
    const queued = admission.acquire(controller.signal)
    controller.abort()
    await expect(queued).rejects.toThrow()
    ticket.release(); ticket.release()
    expect(admission.active).toBe(0)
  })
  it('observer exceptions do not change success or leak admission', async () => {
    const admission = new AttemptAdmission(1)
    const owner = new LogicalRequest()
    expect(await collect(runAttempt({ async *stream() { yield completion } }, request, { owner, admission, observer() { throw new Error('SECRET') } }))).toEqual([completion])
    expect(admission.active).toBe(0)
    owner.dispose()
  })
  it('first-progress timeout retains abort-ignoring ownership across new owners', async () => {
    vi.useFakeTimers()
    const admission = new AttemptAdmission(1)
    const owner = new LogicalRequest({ firstProgressMs: 10 })
    let settle!: (value: IteratorResult<StreamEvent>) => void
    const provider = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(resolve => { settle = resolve }), return: async () => ({ done: true as const, value: undefined }) }) }) }
    const result = collect(runAttempt(provider, request, { owner, admission }))
    const assertion = expect(result).rejects.toMatchObject({ reason: 'first_progress_timeout', transportSettled: false })
    await vi.advanceTimersByTimeAsync(10_011)
    await assertion
    expect(admission.active).toBe(1)
    expect(admission.uncertain.size).toBe(1)
    const reload = new LogicalRequest()
    const stop = new AbortController()
    const queued = collect(runAttempt({ async *stream() { yield completion } }, request, { owner: reload, admission, signal: stop.signal }))
    stop.abort()
    await expect(queued).rejects.toThrow()
    settle({ done: true, value: undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(admission.active).toBe(0)
    expect(admission.uncertain.size).toBe(0)
    owner.dispose(); reload.dispose()
  })
  it('idle timeout ignores usage heartbeats', async () => {
    vi.useFakeTimers()
    const owner = new LogicalRequest({ idleMs: 10 })
    const admission = new AttemptAdmission(1)
    const provider = { async *stream() { yield { type: 'toolCallProgress' } as const; yield { type: 'usage', usage: { inputTokens: 1 } } as const; await new Promise(() => {}) } }
    const result = collect(runAttempt(provider, request, { owner, admission }))
    const assertion = expect(result).rejects.toMatchObject({ reason: 'idle_timeout' })
    await vi.advanceTimersByTimeAsync(10_011)
    await assertion
    owner.dispose()
  })
  it('total deadline includes admission queue and is never retryable', async () => {
    vi.useFakeTimers()
    const admission = new AttemptAdmission(1)
    const ticket = await admission.acquire(new AbortController().signal)
    const owner = new LogicalRequest({ totalMs: 10 })
    const result = collect(runAttempt({ async *stream() { yield completion } }, request, { owner, admission }))
    const assertion = expect(result).rejects.toMatchObject({ reason: 'total_timeout', retryable: false })
    await vi.advanceTimersByTimeAsync(10_011)
    await assertion
    expect(owner.attempts).toBe(0)
    ticket.release(); owner.dispose()
  })
  it('one configured connection serializes root/child/summary dispatch and backoff holds no permit', async () => {
    vi.useFakeTimers()
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    const admission = new AttemptAdmission(1)
    kernel.ctx.llm.configureAdmission('shared', admission)
    let active = 0
    let peak = 0
    const finish: (() => void)[] = []
    kernel.ctx.llm.register({ name: 'shared', async *stream() {
      active++; peak = Math.max(peak, active)
      await new Promise<void>(resolve => finish.push(resolve))
      active--; yield completion
    } })
    const tasks = ['root', 'child', 'summary'].map(() => collect(kernel.ctx.llm.stream({ ...request, providerName: 'shared' })))
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 3; i++) { finish.shift()!(); await vi.advanceTimersByTimeAsync(0) }
    await Promise.all(tasks)
    expect(peak).toBe(1)
    const owner = new LogicalRequest({ retryBaseMs: 10 })
    await expect(collect(runAttempt({ async *stream() { throw new ProviderError('safe', { transient: true }) } }, request, { owner, admission }))).rejects.toThrow()
    const sleeping = owner.backoff()
    expect(admission.active).toBe(0)
    await vi.advanceTimersByTimeAsync(11); await sleeping
    owner.dispose(); await kernel.stop()
  })
  it('accepts structural admission and tracks middleware short circuits exactly once', async () => {
    const kernel = new Kernel(); kernel.ctx.plugin(LlmService)
    let acquired = 0; let released = 0; let fetched = 0
    kernel.ctx.llm.configureAdmission('custom', { async acquire() { acquired++; return { release() { released++ } } } })
    kernel.ctx.llm.register({ name: 'custom', async *stream() { fetched++; yield completion } })
    const off = kernel.ctx.on('llm/stream', () => (async function* () { yield completion })())
    const owner = new LogicalRequest()
    await collect(kernel.ctx.llm.stream(request, { requestOwner: owner }))
    expect([acquired, released, fetched, owner.attempts]).toEqual([1, 1, 0, 1])
    off()
    await collect(kernel.ctx.llm.stream(request, { requestOwner: owner }))
    expect([acquired, released, fetched, owner.attempts]).toEqual([2, 2, 1, 2])
    owner.dispose(); await kernel.stop()
  })
  it('settled consumer return without a pending read releases ownership', async () => {
    const admission = new AttemptAdmission(1); const owner = new LogicalRequest()
    const stream = runAttempt({ async *stream() { yield completion } }, request, { owner, admission })[Symbol.asyncIterator]()
    await stream.next(); await stream.return?.()
    await Promise.resolve(); await Promise.resolve()
    expect(admission.active).toBe(0)
    expect(admission.uncertain.size).toBe(0)
    owner.dispose()
  })
  it('timeout retries only after a settlement callback during grace; late callbacks reconcile', async () => {
    vi.useFakeTimers()
    const admission = new AttemptAdmission(1); const owner = new LogicalRequest({ firstProgressMs: 10 })
    let settled!: () => void
    const provider = { stream(_request: typeof request, options?: StreamOptions) {
      settled = () => options?.onTransportSettled?.()
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(() => {}) }) }
    } }
    const result = collect(runAttempt(provider, request, { owner, admission }))
    const assertion = expect(result).rejects.toMatchObject({ reason: 'first_progress_timeout', transportSettled: true })
    await vi.advanceTimersByTimeAsync(11)
    expect(admission.active).toBe(1)
    settled(); await vi.advanceTimersByTimeAsync(0); await assertion
    expect(admission.active).toBe(0)
    owner.dispose()
  })
  it('typed unresolved cleanup requires a late transport callback, not return alone', async () => {
    const admission = new AttemptAdmission(1); const owner = new LogicalRequest()
    let callback!: () => void
    const failure = new ProviderError('safe'); failure.transportSettled = false
    const provider = { stream(_request: typeof request, options?: StreamOptions) {
      callback = () => options?.onTransportSettled?.()
      return { [Symbol.asyncIterator]: () => ({ next: async () => { throw failure }, return: async () => ({ done: true as const, value: undefined }) }) }
    } }
    await expect(collect(runAttempt(provider, request, { owner, admission }))).rejects.toMatchObject({ transportSettled: false })
    expect(admission.active).toBe(1)
    callback(); callback()
    expect(admission.active).toBe(0); expect(admission.uncertain.size).toBe(0)
    owner.dispose()
  })
  it('Retry-After overrides jitter but remains cancellable and permit-free', async () => {
    vi.useFakeTimers()
    const owner = new LogicalRequest({ retryBaseMs: 1 }); let finished = false
    const sleep = owner.backoff(undefined, 100).then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(99); expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await sleep; expect(finished).toBe(true)
    owner.dispose()
  })
  it('rejects fractional request limits centrally using documented defaults', () => {
    expect(resolveLimits({ streamIdleMs: 1.5, logicalRequestMs: 2.5, stepRetries: 1.5, stepRetryBaseMs: 1.5 })).toMatchObject({ streamIdleMs: DEFAULT_LIMITS.streamIdleMs, logicalRequestMs: DEFAULT_LIMITS.logicalRequestMs, stepRetries: DEFAULT_LIMITS.stepRetries, stepRetryBaseMs: DEFAULT_LIMITS.stepRetryBaseMs })
  })
  it('commitment prohibits retry and stop wins transport races', () => {
    const owner = new LogicalRequest()
    const error = new ProviderError('read', { reason: 'read', transient: true })
    expect(owner.canRetry(error, false)).toBe(true)
    expect(owner.canRetry(error, true)).toBe(false)
    owner.cancel()
    expect(owner.canRetry(error, false)).toBe(false)
    owner.dispose()
  })
})
