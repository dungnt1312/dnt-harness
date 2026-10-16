import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel, LlmService } from '../../src/index.ts'
import { AttemptAdmission, GATEWAY_IDLE_CUT_MS, LogicalRequest, classifyTransport, gatewayIdleCut, runAttempt } from '../../src/harness/llm/request-lifecycle.ts'
import { ProviderError, type StreamEvent, type StreamOptions } from '../../src/harness/llm/types.ts'
import { resolveLimits, DEFAULT_LIMITS } from '../../src/harness/limits.ts'

const request = { messages: [] }
const completion: StreamEvent = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
const collect = async (stream: AsyncIterable<StreamEvent>) => { const result = []; for await (const e of stream) result.push(e); return result }
afterEach(() => vi.useRealTimers())
describe('gateway idle cutoff', () => {
  const reset = (): ProviderError => classifyTransport({ code: 'ECONNRESET' }, 'stream')
  it('names a reset after long silence as a likely gateway idle cutoff, keeping reason and retryability', () => {
    const annotated = gatewayIdleCut(reset(), 0, 125_000)
    expect(annotated.message).toBe('provider transport interrupted after 125s without output (likely a gateway idle cutoff)')
    expect(annotated).toMatchObject({ reason: 'reset', retryable: true, phase: 'stream' })
  })
  it('leaves a quick reset and non-reset failures untouched', () => {
    const quick = reset()
    expect(gatewayIdleCut(quick, 0, GATEWAY_IDLE_CUT_MS - 1)).toBe(quick)
    const other = new ProviderError('x', { reason: 'server_error' })
    expect(gatewayIdleCut(other, 0, 10 * GATEWAY_IDLE_CUT_MS)).toBe(other)
  })
})
describe('context accounting attempt usage', () => {
  it('records only the last valid cumulative report on the terminal fact', async () => {
    const facts: import('../../src/harness/llm/request-lifecycle.ts').AttemptFact[] = []
    const owner = new LogicalRequest()
    const usage = { inputTokens: 120_000, cachedInputTokens: 110_000, outputTokens: 2 }
    try {
      await collect(runAttempt({ async *stream() {
        yield { type: 'usage', usage: { inputTokens: 100_000, cachedInputTokens: 50_000 } } as const
        yield { type: 'usage', usage } as const
        yield completion
      } }, { messages: [], contextId: 'ctx-1' }, {
        owner, admission: new AttemptAdmission(),
        attribution: { sessionId: 's', turnId: 't', stepId: 'step' },
        recordAttempt: async fact => { facts.push(fact) },
      }))
      expect(facts.find(f => f.state === 'end')).toMatchObject({ contextId: 'ctx-1', usage })
      expect(facts.find(f => f.state === 'start')).not.toHaveProperty('usage')
    } finally { owner.dispose() }
  })

  it('keeps a valid report when the provider fails after malformed accounting', async () => {
    const facts: import('../../src/harness/llm/request-lifecycle.ts').AttemptFact[] = []
    const owner = new LogicalRequest()
    const usage = { inputTokens: 10, cachedInputTokens: 5 }
    try {
      await expect(collect(runAttempt({ async *stream() {
        yield { type: 'usage', usage } as const
        yield { type: 'usage', usage: { inputTokens: -1 } } as const
        throw new Error('transport stopped')
      } }, { messages: [], contextId: 'ctx-failed' }, {
        owner, admission: new AttemptAdmission(), recordAttempt: async fact => { facts.push(fact) },
      }))).rejects.toThrow()
      expect(facts.find(f => f.state === 'end')).toMatchObject({ contextId: 'ctx-failed', usage, reason: 'unknown' })
    } finally { owner.dispose() }
  })

  it('retains usage through consumer return and reconciles the same physical attempt', async () => {
    const facts: import('../../src/harness/llm/request-lifecycle.ts').AttemptFact[] = []
    const owner = new LogicalRequest()
    const admission = new AttemptAdmission(1)
    const usage = { inputTokens: 12, cachedInputTokens: 0 }
    const iterator = runAttempt({ async *stream() {
      yield { type: 'usage', usage } as const
      yield completion
    } }, { messages: [], contextId: 'ctx-return' }, {
      owner, admission, recordAttempt: async fact => { facts.push(fact) },
    })[Symbol.asyncIterator]()
    try {
      await iterator.next()
      await iterator.return?.()
      await vi.waitFor(() => expect(admission.active).toBe(0))
      const terminal = facts.filter(f => f.state !== 'start')
      expect(terminal.map(f => f.state)).toEqual(['uncertain', 'reconciled'])
      expect(new Set(terminal.map(f => f.attemptId)).size).toBe(1)
      for (const fact of terminal) expect(fact).toMatchObject({ contextId: 'ctx-return', usage })
    } finally { owner.dispose() }
  })

  it('records one terminal fact with usage when the consumer returns after transport settled', async () => {
    const facts: import('../../src/harness/llm/request-lifecycle.ts').AttemptFact[] = []
    const owner = new LogicalRequest()
    const admission = new AttemptAdmission(1)
    const usage = { inputTokens: 10, cachedInputTokens: 4 }
    const iterator = runAttempt({ async *stream(_request: unknown, options?: StreamOptions) {
      options?.onTransportSettled?.()
      yield { type: 'usage', usage } as const
      yield completion
    } }, { messages: [], contextId: 'ctx-settled' }, {
      owner, admission, recordAttempt: async fact => { facts.push(fact) },
    })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toMatchObject({ type: 'usage' })
      await iterator.return?.()
      expect(admission.active).toBe(0)
      const terminal = facts.filter(f => f.state !== 'start')
      expect(terminal).toHaveLength(1)
      expect(terminal[0]).toMatchObject({ state: 'end', contextId: 'ctx-settled', usage, transportSettled: true })
      expect(facts.some(f => f.state === 'uncertain')).toBe(false)
    } finally { owner.dispose() }
  })
})

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
  describe('low-priority admission (background compaction candidates)', () => {
    const signal = (): AbortSignal => new AbortController().signal

    it('never takes the last free slot, so a foreground request is never blocked behind it', async () => {
      const admission = new AttemptAdmission(2)
      const low = await admission.acquire(signal(), { priority: 'low' })
      expect(admission.active).toBe(1)
      // The last slot stays free for the foreground.
      const foreground = await admission.acquire(signal())
      expect(admission.active).toBe(2)
      low.release(); foreground.release()
      expect(admission.active).toBe(0)
    })

    it('a low request that would take the last slot waits, and is admitted once a slot frees', async () => {
      const admission = new AttemptAdmission(2)
      const a = await admission.acquire(signal())
      let admitted = false
      const low = admission.acquire(signal(), { priority: 'low' }).then((ticket) => { admitted = true; return ticket })
      await Promise.resolve(); await Promise.resolve()
      expect(admitted).toBe(false)
      expect(admission.active).toBe(1)
      a.release()
      const ticket = await low
      expect(admitted).toBe(true)
      ticket.release()
    })

    it('a queued foreground request is admitted before an earlier queued low one', async () => {
      const admission = new AttemptAdmission(2)
      const a = await admission.acquire(signal())
      const b = await admission.acquire(signal())
      const order: string[] = []
      const low = admission.acquire(signal(), { priority: 'low' }).then((t) => { order.push('low'); return t })
      const foreground = admission.acquire(signal()).then((t) => { order.push('foreground'); return t })
      a.release()
      const first = await foreground
      expect(order).toEqual(['foreground'])
      first.release(); b.release()
      ;(await low).release()
      expect(order).toEqual(['foreground', 'low'])
      expect(admission.active).toBe(0)
    })

    it('with a single slot a low request never runs: the only slot is the foreground one', async () => {
      const admission = new AttemptAdmission(1)
      const controller = new AbortController()
      const low = admission.acquire(controller.signal, { priority: 'low' })
      let settled = false
      void low.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve(); await Promise.resolve()
      expect(settled).toBe(false)
      expect(admission.active).toBe(0)
      const foreground = await admission.acquire(signal())
      expect(admission.active).toBe(1)
      foreground.release()
      controller.abort()
      await expect(low).rejects.toThrow()
    })

    it('a cancelled queued low request leaves the queue without holding a slot', async () => {
      const admission = new AttemptAdmission(2)
      const a = await admission.acquire(signal())
      const controller = new AbortController()
      const low = admission.acquire(controller.signal, { priority: 'low' })
      controller.abort()
      await expect(low).rejects.toThrow()
      a.release()
      expect(admission.active).toBe(0)
      const next = await admission.acquire(signal(), { priority: 'low' })
      expect(admission.active).toBe(1)
      next.release()
    })

    it('ordinary admission is unchanged: it can use every slot', async () => {
      const admission = new AttemptAdmission(2)
      const a = await admission.acquire(signal())
      const b = await admission.acquire(signal())
      expect(admission.active).toBe(2)
      a.release(); b.release()
    })

    it('LlmService forwards the stream option to the provider admission; an ordinary stream stays ordinary', async () => {
      const kernel = new Kernel()
      kernel.ctx.plugin(LlmService)
      const seen: unknown[] = []
      kernel.ctx.llm.configureAdmission('p', { async acquire(_signal: AbortSignal, options?: unknown) { seen.push(options); return { release() {} } } })
      kernel.ctx.llm.register({ name: 'p', models: ['m'], async *stream() { yield completion } })
      await collect(kernel.ctx.llm.stream({ messages: [], providerName: 'p' }, { admissionPriority: 'low' }))
      await collect(kernel.ctx.llm.stream({ messages: [], providerName: 'p' }))
      expect(seen).toEqual([{ priority: 'low' }, undefined])
    })

    it('a delegate admission still owns the decision: low priority is forwarded, not interpreted', async () => {
      const seen: unknown[] = []
      const delegate = { async acquire(_signal: AbortSignal, options?: unknown) { seen.push(options); return { release() {} } } }
      const admission = new AttemptAdmission(4, delegate)
      ;(await admission.acquire(signal(), { priority: 'low' })).release()
      expect(seen).toEqual([{ priority: 'low' }])
    })
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
  it('refuses to replace an admission that still holds an unresolved attempt', async () => {
    const kernel = new Kernel(); kernel.ctx.plugin(LlmService)
    const admission = new AttemptAdmission(1)
    kernel.ctx.llm.configureAdmission('p', admission)
    admission.uncertain.set('a1', { attribution: { sessionId: 's1' } } as never)
    expect(() => kernel.ctx.llm.configureAdmission('p', new AttemptAdmission(1))).toThrow(/live provider admission/)
    expect(kernel.ctx.llm.sessionUncertain('s1')).toBe(true)
    admission.uncertain.clear()
    expect(() => kernel.ctx.llm.configureAdmission('p', new AttemptAdmission(1))).not.toThrow()
    await kernel.stop()
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
  it('ships effective compaction off by default with the approved precompute numbers', () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      compactionEffectiveEnabled: false,
      compactionPrecomputeEnabled: false,
      compactionPrecomputePressure: 0.65,
      compactionDeadlineMs: 180_000,
      compactionOutputTokens: 8_000,
      compactionCandidateWaitMs: 15_000,
    })
  })
  it('validates the compaction rollout limits instead of trusting any value', () => {
    expect(resolveLimits({ compactionEffectiveEnabled: true, compactionPrecomputeEnabled: true })).toMatchObject({ compactionEffectiveEnabled: true, compactionPrecomputeEnabled: true })
    // Booleans must be booleans; numbers must be positive integers within range.
    expect(resolveLimits({ compactionEffectiveEnabled: 'yes' as unknown as boolean }).compactionEffectiveEnabled).toBe(false)
    expect(resolveLimits({ compactionPrecomputePressure: 0 }).compactionPrecomputePressure).toBe(DEFAULT_LIMITS.compactionPrecomputePressure)
    expect(resolveLimits({ compactionPrecomputePressure: 1.5 }).compactionPrecomputePressure).toBe(DEFAULT_LIMITS.compactionPrecomputePressure)
    expect(resolveLimits({ compactionPrecomputePressure: 0.5 }).compactionPrecomputePressure).toBe(0.5)
    expect(resolveLimits({ compactionDeadlineMs: 1.5 }).compactionDeadlineMs).toBe(DEFAULT_LIMITS.compactionDeadlineMs)
    expect(resolveLimits({ compactionDeadlineMs: -1 }).compactionDeadlineMs).toBe(DEFAULT_LIMITS.compactionDeadlineMs)
    expect(resolveLimits({ compactionOutputTokens: 4_000 }).compactionOutputTokens).toBe(4_000)
    expect(resolveLimits({ compactionCandidateWaitMs: 0 }).compactionCandidateWaitMs).toBe(0)
    expect(resolveLimits({ approvalExpiryMs: 0 }).approvalExpiryMs).toBe(0)
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
