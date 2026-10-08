import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel, LlmService } from '../../src/index.ts'
import { OpenAiCompletionsProvider, isContextExceeded } from '../../src/harness/llm/openai.ts'
import { AttemptAdmission, LogicalRequest, runAttempt } from '../../src/harness/llm/request-lifecycle.ts'
import { ProviderError, type StreamEvent } from '../../src/harness/llm/types.ts'

const request = { messages: [] }
const delta: StreamEvent = { type: 'delta', delta: 'hello' }
const record = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const provider = () => new OpenAiCompletionsProvider({ name: 'review', apiKey: '', baseUrl: 'http://unused', retryBaseMs: 1 })
const collect = async (stream: AsyncIterable<StreamEvent>) => { const events = []; for await (const event of stream) events.push(event); return events }
const stubWire = (wire: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(wire)))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('LLM review: uncertain notification and transport cleanup', () => {
  it('a poisoned uncertain record still schedules return and clears the session fence', async () => {
    const kernel = new Kernel(); kernel.ctx.plugin(LlmService)
    const closed = vi.fn(async () => ({ done: true as const, value: undefined }))
    kernel.ctx.llm.register({ name: 'review', stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: delta }), return: closed }) }) })
    const poison = new Error('canonical store poisoned')
    const iterator = kernel.ctx.llm.stream(request, {
      attribution: { sessionId: 'poisoned', turnId: 'turn', stepId: 'step' },
      recordAttempt: async fact => { if (fact.state === 'uncertain' || fact.state === 'reconciled') throw poison },
    })[Symbol.asyncIterator]()
    try {
      await iterator.next()
      await expect(iterator.return?.()).rejects.toBe(poison)
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(kernel.ctx.llm.sessionUncertain('poisoned')).toBe(false))
      expect(kernel.ctx.llm.admission('review').active).toBe(0)
    } finally { await kernel.stop() }
  })

  it('rechecks settlement when abort settles before reconciliation is installed and recording rejects', async () => {
    const owner = new LogicalRequest(); const admission = new AttemptAdmission(1)
    const poison = new Error('uncertain record poisoned')
    const iterator = runAttempt({ stream(_request, options) {
      options?.signal?.addEventListener('abort', () => options.onTransportSettled?.(), { once: true })
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: delta }) }) }
    } }, request, {
      owner, admission,
      recordAttempt: async fact => { if (fact.state === 'uncertain') throw poison },
    })[Symbol.asyncIterator]()
    try {
      await iterator.next()
      await expect(iterator.return?.()).rejects.toBe(poison)
      expect(admission.active).toBe(0); expect(admission.uncertain.size).toBe(0)
    } finally { owner.dispose() }
  })

  it('does not mask cancellation with a failed uncertain record; late reads reconcile', async () => {
    const owner = new LogicalRequest(); const admission = new AttemptAdmission(1)
    const stop = new AbortController()
    let finish!: (value: IteratorResult<StreamEvent>) => void
    const started = vi.fn()
    const poison = new Error('uncertain record poisoned')
    const stream = runAttempt({ stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(resolve => { finish = resolve; started() }) }) }) }, request, {
      owner, admission, signal: stop.signal,
      recordAttempt: async fact => { if (fact.state === 'uncertain') throw poison },
    })
    try {
      const result = collect(stream)
      const assertion = expect(result).rejects.toMatchObject({ reason: 'cancelled', transportSettled: false })
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
      stop.abort(); await assertion
      expect(admission.uncertain.size).toBe(1)
      finish({ done: true, value: undefined })
      await vi.waitFor(() => expect(admission.active).toBe(0))
      expect(admission.uncertain.size).toBe(0)
    } finally { owner.dispose() }
  })

  it('preserves the canonical end-record failure if uncertain recording also fails', async () => {
    const owner = new LogicalRequest(); const admission = new AttemptAdmission(1)
    const stop = new AbortController()
    let finish!: (value: IteratorResult<StreamEvent>) => void
    const started = vi.fn()
    const endFailure = new Error('end record poisoned')
    const result = collect(runAttempt({ stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamEvent>>(resolve => { finish = resolve; started() }) }) }) }, request, {
      owner, admission, signal: stop.signal,
      recordAttempt: async fact => {
        if (fact.state === 'end') throw endFailure
        if (fact.state === 'uncertain') throw new Error('uncertain record poisoned')
      },
    }))
    try {
      const assertion = expect(result).rejects.toBe(endFailure)
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
      stop.abort(); await assertion
      finish({ done: true, value: undefined })
      await vi.waitFor(() => expect(admission.active).toBe(0))
    } finally { owner.dispose() }
  })

  it('OpenAI return rejects unresolved cancellation instead of claiming done', async () => {
    const cancel = vi.fn(async () => { throw new Error('underlying cleanup failed') })
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(record({ choices: [{ delta: { content: 'hello' } }] }))) }, cancel,
    })))
    const settled = vi.fn()
    const iterator = provider().stream(request, { onTransportSettled: settled })[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: delta })
    await expect(iterator.return?.()).rejects.toMatchObject({ phase: 'cleanup', transportSettled: false })
    expect(cancel).toHaveBeenCalledOnce(); expect(settled).not.toHaveBeenCalled()
  })

  it('a timed-out OpenAI return retains admission until the late cancel callback', async () => {
    vi.useFakeTimers()
    let finishCancel!: () => void
    const cancel = vi.fn(() => new Promise<void>(resolve => { finishCancel = resolve }))
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(record({ choices: [{ delta: { content: 'hello' } }] }))) }, cancel,
    })))
    const kernel = new Kernel(); kernel.ctx.plugin(LlmService); kernel.ctx.llm.register(provider())
    const iterator = kernel.ctx.llm.stream(request, { attribution: { sessionId: 'late', turnId: 'turn', stepId: 'step' } })[Symbol.asyncIterator]()
    try {
      await iterator.next(); await iterator.return?.()
      await vi.advanceTimersByTimeAsync(10_001)
      expect(cancel).toHaveBeenCalledOnce()
      expect(kernel.ctx.llm.sessionUncertain('late')).toBe(true)
      expect(kernel.ctx.llm.admission('review').active).toBe(1)
      finishCancel(); await vi.advanceTimersByTimeAsync(0)
      expect(kernel.ctx.llm.sessionUncertain('late')).toBe(false)
      expect(kernel.ctx.llm.admission('review').active).toBe(0)
    } finally { await kernel.stop() }
  })
})

describe('LLM review: error classification and nullable deltas', () => {
  it.each([503, 'server_error', 'service_unavailable'])('permanent gateway text wins over transient code %s', async code => {
    stubWire(record({ error: { code, message: 'Invalid API key provided' } }))
    await expect(collect(provider().stream(request))).rejects.toMatchObject({ contextExceeded: false, retryable: false })
  })

  it.each([400, 413, 422, 502, 503, 504])('HTTP %s context diagnostics are squeeze-only, not transient retries', async status => {
    const fetch = vi.fn(async () => new Response('maximum context length exceeded', { status }))
    vi.stubGlobal('fetch', fetch)
    const error = await collect(provider().stream(request)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ contextExceeded: true, reason: 'context_exceeded', retryable: false, transportSettled: true })
    expect(fetch).toHaveBeenCalledOnce()
    const owner = new LogicalRequest()
    try { owner.consume(); expect(owner.canRetry(error as ProviderError, false)).toBe(true) }
    finally { owner.dispose() }
  })

  it.each(['maximum context length exceeded', 'reduce the length', 'too many tokens'])('gateway context error "%s" never has the transient replay flag', async message => {
    stubWire(record({ error: { code: 503, message } }))
    await expect(collect(provider().stream(request))).rejects.toMatchObject({ contextExceeded: true, retryable: false })
  })

  it('keeps vague legacy 4xx size diagnostics without treating generic 5xx size errors as context', () => {
    for (const status of [400, 413, 422]) expect(isContextExceeded(status, 'request too large')).toBe(true)
    expect(isContextExceeded(502, 'request too large')).toBe(false)
  })

  it('auth, rate-limit and origin 500 errors never read as context overflow, whatever the wording', () => {
    for (const status of [401, 403, 429, 500]) expect(isContextExceeded(status, 'maximum context length exceeded'), String(status)).toBe(false)
  })

  it.each([
    { content: 'answer', reasoning_content: null },
    { content: 'answer', tool_calls: null },
    { content: null, reasoning_content: null, tool_calls: null },
  ])('accepts null optional delta fields as absent: %j', async delta => {
    stubWire(record({ choices: [{ delta }] }) + record({ choices: [{ finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')
    const events = await collect(provider().stream(request))
    expect(events.filter(event => event.type === 'delta')).toEqual(delta.content === 'answer' ? [{ type: 'delta', delta: 'answer' }] : [])
    expect(events.at(-1)).toMatchObject({ type: 'completion', transportSettled: true })
  })

  it('accepts null reasoning alongside real tool calls', async () => {
    stubWire(record({ choices: [{ delta: { content: null, reasoning_content: null, tool_calls: [{ index: 0, id: 'call', function: { name: 'Glob', arguments: '{}' } }] } }] }) + record({ choices: [{ finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')
    expect(await collect(provider().stream(request))).toContainEqual({ type: 'toolCalls', calls: [{ id: 'call', name: 'Glob', args: {} }] })
  })

  it.each([{ reasoning_content: 42 }, { tool_calls: {} }, { content: false }])('still rejects non-null malformed fields: %j', async delta => {
    stubWire(record({ choices: [{ delta }] }))
    await expect(collect(provider().stream(request))).rejects.toMatchObject({ reason: 'malformed_protocol', retryable: false })
  })
})
