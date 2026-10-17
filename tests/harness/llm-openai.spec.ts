/**
 * The OpenAI-completions adapter's wire format: thinking overrides are
 * translated into documented request fields (never a raw passthrough), and
 * the tools key disappears entirely when a mode exposes no tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompletionsProvider, ProviderError } from 'dnt-harness'
import { detectMaxTokensField, detectSupportsPromptCacheKey, detectSupportsStore, outputLimitFromError, outputTokenCap, promptCacheKey } from '../../src/harness/llm/openai.ts'
import { getModelInfo } from '../../src/harness/llm/model-catalog.ts'
import { LogicalRequest } from '../../src/harness/llm/request-lifecycle.ts'
import { buildContext, wrapUntrusted } from '../../src/harness/context/builder.ts'
import { resolveModelBudget } from '../../src/harness/context/budget.ts'
import { BUNDLED_MODES, DEFAULT_MODE_ID } from '../../src/harness/modes/bundled.ts'

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

/** Stub global fetch with an SSE chat-completions responder. */
function stubFetch(chunks: readonly string[] = ['{"choices":[{"delta":{"content":"ok"}}]}']): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  const fake = vi.fn(async (input: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
    captured.push({ url: String(input), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>, headers: init?.headers ?? {} })
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
        if (chunks.length > 0) controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fake)
  return captured
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function provider(): OpenAiCompletionsProvider {
  return new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['gpt-5.6'] })
}

async function run(request: Parameters<OpenAiCompletionsProvider['stream']>[0]): Promise<void> {
  for await (const _ of provider().stream(request)) void _
}

describe('openai completions adapter: thinking + wire shape', () => {
  it('caps gateway max_tokens at the remaining calibrated context window', async () => {
    const captured = stubFetch()
    const budget = resolveModelBudget({ model: 'claude-haiku-4.5' })
    for (const ratio of [1, 1.5]) {
      const assembled = buildContext({
        events: [{ type: 'user/message', turnId: 't', content: 'x'.repeat(350_000), seq: 1, timestamp: 1 }] as never,
        mode: { definition: BUNDLED_MODES.find(mode => mode.id === DEFAULT_MODE_ID)!, source: 'bundled' },
        modeRevision: 1, model: 'claude-haiku-4.5', providerName: 'test', schemas: [], activeSkills: [], pinnedMemory: [], budget,
        calibration: { contextId: 'prior', estimatedTokens: 100_000, reportedInputTokens: ratio * 100_000 },
      })
      await run({ model: 'claude-haiku-4.5', messages: assembled.messages, outputCeilingTokens: assembled.maxOutputTokens })
      const remaining = budget.contextLimitTokens - assembled.manifest.budget.measured!.tokens - budget.marginTokens
      expect(captured.at(-1)!.body['max_tokens']).toBe(Math.min(65_536, remaining))
    }
  })
  it('falls back to 32,000 output tokens and clamps it to the remaining window', async () => {
    const captured = stubFetch()
    await run({ model: 'some-other-model', messages: [], outputCeilingTokens: 120_000 })
    await run({ model: 'some-unknown-model', messages: [], outputCeilingTokens: 200_000 })
    await run({ model: 'some-unknown-model', messages: [], outputCeilingTokens: 12_000 })
    await run({ model: 'some-unknown-model', messages: [], maxOutputTokens: 64_000 })
    await run({ model: 'some-unknown-model', messages: [], maxOutputTokens: 8_000, outputCeilingTokens: 5_000 }) // an explicit request cap is still clamped
    expect(captured.map(c => c.body['max_tokens'])).toEqual([32_000, 32_000, 12_000, 32_000, 5_000])
    expect(captured.every(c => !('outputCeilingTokens' in c.body))).toBe(true)
  })
  it('bounds the cap by the window without a floor, and never above 256,000', () => {
    // Intended change (plans/261017-runtime-provider-hardening phase-04, spec
    // §8 PH2-D): the window ceiling is an upper bound and the former 1,024
    // floor that raised the cap above the remaining room is gone. A
    // non-positive room is refused before the network (see below).
    expect(outputTokenCap('some-unknown-model', undefined, undefined, 1)).toBe(1)
    expect(outputTokenCap('some-unknown-model', undefined, undefined, 500)).toBe(500)
    // An explicit request cap is still honored under the room.
    expect(outputTokenCap('some-unknown-model', undefined, 256, 500)).toBe(256)
    // Operator and catalog caps above 256k are clamped.
    expect(outputTokenCap('m', { m: 1_000_000 })).toBe(256_000)
    expect(outputTokenCap('deepseek-flash')).toBe(256_000)
  })
  it('uses documented output limits for common families instead of the 32k fallback', () => {
    expect(outputTokenCap('gpt-4o')).toBe(16_384)
    expect(outputTokenCap('openai/gpt-4o-mini-2024-07-18')).toBe(16_384)
    expect(outputTokenCap('gpt-4.1-mini')).toBe(32_768)
    expect(outputTokenCap('gpt-4o-2024-05-13')).toBe(4_096)
    expect(outputTokenCap('deepseek-v4.1-flash-free', undefined, undefined, 120_000)).toBe(120_000)
    // The operator override still wins over the documented value.
    expect(outputTokenCap('gpt-4o', { 'gpt-4o': 4_096 })).toBe(4_096)
    // The table claims only the output limit: the UI's catalog view is unchanged.
    expect(getModelInfo('gpt-4o')?.maxOutputTokens).toBeUndefined()
  })
  it('keeps the Claude thinking budget below a window-clamped max_tokens, or drops thinking when it cannot fit', async () => {
    const captured = stubFetch()
    await run({ model: 'claude-haiku-4.5', thinkingLevel: 'max', messages: [], outputCeilingTokens: 48_000 })
    await run({ model: 'claude-haiku-4.5', thinkingLevel: 'low', messages: [], outputCeilingTokens: 1_024 })
    await run({ model: 'claude-haiku-4.5', thinkingLevel: 'high', messages: [] })
    expect(captured.map(c => [c.body['max_tokens'], c.body['thinking']])).toEqual([
      [48_000, { type: 'enabled', budget_tokens: 47_999 }],
      [1_024, undefined],
      [65_536, { type: 'enabled', budget_tokens: 16_000 }],
    ])
  })
  it('preserves base system and wrapped compaction system blocks in order on the local wire', async () => {
    const captured = stubFetch()
    const baseSystem = 'Base system instructions. This is the same conversation continuing after compaction, not a new session.'
    const compactionSystem = wrapUntrusted('compacted-history', { 'through-seq': '42' }, 'Synthetic summary: 44f6ada; browser audio acceptance pending.')
    await run({
      messages: [
        { role: 'system', content: baseSystem },
        { role: 'system', content: compactionSystem },
        { role: 'user', content: 'Còn vấn đề gì không' },
      ],
    })
    // stubFetch parses the outgoing JSON body; this asserts local serialization,
    // not whether an external gateway preserves or interprets either block.
    expect(captured).toHaveLength(1)
    const messages = captured[0]!.body['messages'] as { role: string; content: string }[]
    expect(messages.map((message) => message.role)).toEqual(['system', 'system', 'user'])
    expect(messages).toEqual([
      { role: 'system', content: baseSystem },
      { role: 'system', content: compactionSystem },
      { role: 'user', content: 'Còn vấn đề gì không' },
    ])
  })

  it('sends the catalog output cap as max_tokens, an operator override wins, unknown models use 32,000', async () => {
    const captured = stubFetch()
    await run({ model: 'claude-opus-5-5', messages: [] })
    await run({ model: 'gpt-5.6-sol', messages: [] })
    await run({ model: 'some-unknown-model', messages: [] })
    for await (const _ of new OpenAiCompletionsProvider({ name: 't', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', maxOutputTokens: { 'claude-opus-5-5': 32_000 } }).stream({ model: 'claude-opus-5-5', messages: [] })) void _
    expect(captured.map(c => c.body['max_tokens'])).toEqual([128_000, 131_072, 32_000, 32_000])
  })

  it('a request maxOutputTokens only LOWERS the cap; it never raises it above the catalog or operator value, and is never serialized as a field of its own', async () => {
    const captured = stubFetch()
    await run({ model: 'claude-opus-5-5', messages: [], maxOutputTokens: 8_000 }) // lowers the 128k catalog cap
    await run({ model: 'claude-opus-5-5', messages: [], maxOutputTokens: 500_000 }) // cannot exceed the catalog
    await run({ model: 'some-unknown-model', messages: [], maxOutputTokens: 8_000 }) // lowers the 32k fallback
    for await (const _ of new OpenAiCompletionsProvider({ name: 't', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', maxOutputTokens: { 'claude-opus-5-5': 4_000 } }).stream({ model: 'claude-opus-5-5', messages: [], maxOutputTokens: 8_000 })) void _ // operator cap is lower
    for (const bad of [0, -1, 1.5, Number.NaN]) await run({ model: 'claude-opus-5-5', messages: [], maxOutputTokens: bad }) // invalid: ignored
    expect(captured.map(c => c.body['max_tokens'])).toEqual([8_000, 128_000, 8_000, 4_000, 128_000, 128_000, 128_000, 128_000])
    expect(captured.every(c => !('maxOutputTokens' in c.body))).toBe(true)
  })

  it('carries bounded Retry-After and safe HTTP metadata to the harness coordinator', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('SECRET', { status: 503, headers: { 'retry-after': '99' } })))
    const owner = new LogicalRequest()
    const result = (async () => { for await (const _ of provider().stream({ messages: [] }, { requestOwner: owner })) void _ })()
    await expect(result).rejects.toMatchObject({ retryAfterMs: 30_000, status: 503, reason: 'server_error' })
    owner.dispose()
  })
  it('classifies a numeric gateway 503 without text heuristics', async () => {
    stubFetch(['{"error":{"code":503,"message":"SECRET"}}'])
    await expect(run({ messages: [] })).rejects.toMatchObject({ reason: 'server_error', retryable: true })
  })
  it('translates thinkingLevel into documented fields for the model', async () => {
    const captured = stubFetch()
    await run({ model: 'gpt-5.6', thinkingLevel: 'max', messages: [{ role: 'user', content: 'hi' }] })
    expect(captured[0]?.body['reasoning_effort']).toBe('max')
    expect(captured[0]?.body['thinkingLevel']).toBeUndefined()
  })

  it('glm off becomes thinking disabled, not an effort guess', async () => {
    const captured = stubFetch()
    await run({ model: 'glm-4.7', thinkingLevel: 'off', messages: [{ role: 'user', content: 'hi' }] })
    expect(captured[0]?.body['thinking']).toEqual({ type: 'disabled' })
    expect(captured[0]?.body['reasoning_effort']).toBeUndefined()
  })

  it('no thinkingLevel leaves the body untouched', async () => {
    const captured = stubFetch()
    await run({ model: 'unknown-model', messages: [{ role: 'user', content: 'hi' }] })
    expect(captured[0]?.body['reasoning_effort']).toBeUndefined()
    expect(captured[0]?.body['thinking']).toBeUndefined()
    expect(captured[0]?.body['enable_thinking']).toBeUndefined()
  })

  it('omits the tools key when the request carries no tools', async () => {
    const captured = stubFetch()
    await run({ messages: [{ role: 'user', content: 'hi' }] })
    expect('tools' in (captured[0]?.body ?? {})).toBe(false)
  })

  it('serializes assistant tool calls and tool results to the wire shape', async () => {
    const captured = stubFetch()
    await run({
      messages: [
        { role: 'user', content: 'list' },
        { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'Glob', args: { pattern: '*' } }] },
        { role: 'tool', content: 'a.txt', toolCallId: 'c1' },
      ],
      tools: [{ name: 'Glob', description: 'list files', parameters: { type: 'object', properties: {}, required: [] } }],
    })
    const messages = captured[0]?.body['messages'] as { role: string; tool_calls?: unknown[]; tool_call_id?: string }[]
    expect(messages[1]?.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"*"}' } },
    ])
    expect(messages[2]?.tool_call_id).toBe('c1')
    expect(Array.isArray(captured[0]?.body['tools'])).toBe(true)
  })

  it('sends image parts as data URLs and keeps text-only messages bare strings', async () => {
    const captured = stubFetch()
    await run({
      messages: [
        { role: 'system', content: 'be helpful' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', mediaType: 'image/png', base64: 'QUJD', name: 'shot.png' },
          ],
        },
      ],
    })
    const messages = captured[0]?.body['messages'] as { role: string; content: unknown }[]
    expect(messages[0]?.content).toBe('be helpful')
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ])
  })

  it('asks for streamed usage and yields the final chunk usage with its cached share', async () => {
    const captured = stubFetch([
      '{"choices":[{"delta":{"content":"ok"}}]}',
      '{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":1000}}}',
    ])
    const events = []
    for await (const event of provider().stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event)
    expect(captured[0]?.body['stream_options']).toEqual({ include_usage: true })
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 30 } })
  })

  it('reads the DeepSeek cache field and skips null usage on content chunks', async () => {
    stubFetch([
      '{"choices":[{"delta":{"content":"ok"}}],"usage":null}',
      '{"choices":[],"usage":{"prompt_tokens":50,"prompt_cache_hit_tokens":20}}',
    ])
    const usage = []
    for await (const event of provider().stream({ messages: [{ role: 'user', content: 'hi' }] })) if (event.type === 'usage') usage.push(event.usage)
    expect(usage).toEqual([{ inputTokens: 50, cachedInputTokens: 20 }])
  })

  it('flattens a tool answer that arrives as parts, since the protocol wants text', async () => {
    const captured = stubFetch()
    await run({
      messages: [{ role: 'tool', content: [{ type: 'text', text: 'done' }], toolCallId: 'c1' }],
    })
    const messages = captured[0]?.body['messages'] as { content: unknown }[]
    expect(messages[0]?.content).toBe('done')
  })
})

describe('openai completions adapter: tool progress', () => {
  it('reports argument progress before completion without exposing partial calls', async () => {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })))
    const iterator = provider().stream({ messages: [{ role: 'user', content: 'write' }] })[Symbol.asyncIterator]()
    const first = iterator.next()
    await Promise.resolve()
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Write","arguments":"{\\"content\\":\\""}}]}}]}\n\n'))
    // The stream stays open: progress must be observable before [DONE].
    await expect(Promise.race([
      first,
      new Promise((resolve) => setTimeout(() => resolve('no progress'), 80)),
    ])).resolves.toMatchObject({ done: false, value: { type: 'toolCallProgress' } })
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hello\\"}"}}]}}]}\n\n'))
    controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n'))
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller.close()
    const events = []
    for (;;) {
      const result = await iterator.next()
      if (result.done) break
      events.push(result.value)
    }
    expect(events).toEqual([
      { type: 'toolCallProgress' },
      { type: 'toolCalls', calls: [{ id: 'c1', name: 'Write', args: { content: 'hello' } }] },
      { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true },
    ])
  })
})

describe('openai completions adapter: failure surfacing', () => {
  it('a mid-stream gateway error chunk rejects with the gateway message', async () => {
    // One API-style relays answer 200, stream a little, then fail upstream:
    // the error arrives as a JSON body chunk, not an HTTP status.
    stubFetch([
      '{"choices":[{"delta":{"content":"par"}}]}',
      '{"error":{"message":"no available channel for this model","code":503}}',
    ])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/provider gateway failure: no available channel for this model/)
  })

  it('a string-form gateway error chunk is surfaced too', async () => {
    stubFetch(['{"error":"upstream connect error"}'])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/provider gateway failure: upstream connect error/)
  })

  it('a long upstream gateway message is truncated, not pasted wholesale', async () => {
    stubFetch([`{"error":{"message":"${'x'.repeat(400)}TAIL-MARKER"}}`])
    const caught = await run({ messages: [{ role: 'user', content: 'hi' }] }).then(() => null, (error: unknown) => error)
    expect(caught).toBeInstanceOf(ProviderError)
    expect((caught as ProviderError).message.startsWith('provider gateway failure: ')).toBe(true)
    expect((caught as ProviderError).message).not.toContain('TAIL-MARKER')
  })

  it('a stream that closes without any model output is an error, not silence', async () => {
    stubFetch([])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/without completion proof/)
  })

  it('a malformed SSE data chunk is a provider error, not a raw SyntaxError', async () => {
    stubFetch(['{not json}'])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(ProviderError)
  })

  it('gateway failures are ProviderError instances the turn loop classifies', async () => {
    stubFetch(['{"error":{"message":"boom"}}'])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(ProviderError)
  })
})

describe('openai completions adapter: retry before the stream starts', () => {
  function sse(text: string): Response {
    return new Response(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  /** One raw SSE record as the gateway would emit it, un-wrapped. */
  function raw(record: string): Response {
    return new Response(`data: ${record}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  function scripted(responses: (() => Response | Promise<Response>)[]): ReturnType<typeof vi.fn> {
    let call = 0
    const fake = vi.fn(async () => {
      const next = responses[Math.min(call, responses.length - 1)]
      call += 1
      return next!()
    })
    vi.stubGlobal('fetch', fake)
    return fake
  }

  function fast(maxRetries?: number): OpenAiCompletionsProvider {
    return new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, ...(maxRetries !== undefined ? { maxRetries } : {}) })
  }

  async function collect(p: OpenAiCompletionsProvider, signal?: AbortSignal): Promise<string> {
    let text = ''
    for await (const event of p.stream({ messages: [{ role: 'user', content: 'hi' }] }, signal !== undefined ? { signal } : undefined)) {
      if (event.type === 'delta') text += event.delta
    }
    return text
  }

  it('retries 429 and 503, honouring retry-after, then streams once', async () => {
    const fake = scripted([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      () => new Response('busy', { status: 503 }),
      () => sse('ok'),
    ])
    expect(await collect(fast())).toBe('ok')
    expect(fake).toHaveBeenCalledTimes(3)
  })

  it('retries a connection failure', async () => {
    const fake = scripted([
      () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }) },
      () => sse('back'),
    ])
    expect(await collect(fast())).toBe('back')
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('does not retry a client error', async () => {
    const fake = scripted([() => new Response('bad key', { status: 401 })])
    await expect(collect(fast())).rejects.toThrow(/HTTP 401: auth_configuration/)
    expect(fake).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxRetries and reports the attempts', async () => {
    const fake = scripted([() => new Response('down', { status: 502 })])
    await expect(collect(fast(2))).rejects.toThrow(/HTTP 502: server_error/)
    expect(fake).toHaveBeenCalledTimes(3)
  })

  it('retries a cloudflare 524 like any other 5xx timeout', async () => {
    const fake = scripted([
      () => new Response('origin timeout', { status: 524 }),
      () => sse('after-524'),
    ])
    expect(await collect(fast())).toBe('after-524')
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('treats an unknown 5xx as retryable by default', async () => {
    const fake = scripted([
      () => new Response('surprise', { status: 598 }),
      () => sse('after-598'),
    ])
    expect(await collect(fast())).toBe('after-598')
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 5xx whose body proves the failure is deterministic', async () => {
    const fake = scripted([() => new Response('{"error":{"message":"Invalid API key provided"}}', { status: 502 })])
    await expect(collect(fast())).rejects.toThrow(/HTTP 502/)
    expect(fake).toHaveBeenCalledTimes(1)
  })

  it('does not retry deterministic server statuses like 501', async () => {
    const fake = scripted([() => new Response('not implemented', { status: 501 })])
    await expect(collect(fast())).rejects.toThrow(/HTTP 501: server_error/)
    expect(fake).toHaveBeenCalledTimes(1)
  })

  it('a gateway error with unknown text is transient; permanent text is not', async () => {
    const hiccup = scripted([() => raw('{"error":{"message":"upstream hiccup 42"}}')])
    await expect(collect(fast())).rejects.toMatchObject({ transient: true, reason: 'server_error' })
    expect(hiccup).toHaveBeenCalledTimes(1)

    const once = scripted([() => raw('{"error":{"message":"Invalid API key provided"}}')])
    await expect(collect(fast())).rejects.toMatchObject({ transient: false })
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('a stop during backoff ends the wait at once', async () => {
    const fake = scripted([() => new Response('later', { status: 429, headers: { 'retry-after': '20' } })])
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('stopped')), 50)
    const started = Date.now()
    await expect(collect(fast(), controller.signal)).rejects.toThrow(/stopped/)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(fake).toHaveBeenCalledTimes(1)
  })

  it('caps an oversized error body', async () => {
    scripted([() => new Response('x'.repeat(50_000), { status: 400 })])
    const error = await collect(fast()).catch((caught: unknown) => caught as Error)
    expect((error as Error).message.length).toBeLessThan(5_000)
    expect((error as Error).message).not.toContain('x'.repeat(100))
  })

  it('surfaces a bounded excerpt for structured HTTP error bodies', async () => {
    scripted([() => new Response('{"error":{"type":"unknown","message":"relay says: bad tool sequence detected"}}', { status: 400 })])
    const error = await collect(fast()).catch((caught: unknown) => caught as Error)
    expect((error as Error).message).toContain('HTTP 400: unknown')
    expect((error as Error).message).toContain('bad tool sequence detected')
  })

  it('caps the surfaced excerpt at 200 characters', async () => {
    scripted([() => new Response(JSON.stringify({ error: { message: 'y'.repeat(1_000) } }), { status: 400 })])
    const error = await collect(fast()).catch((caught: unknown) => caught as Error)
    expect((error as Error).message).toContain('…')
    expect((error as Error).message.length).toBeLessThan(300)
  })

  it('falls back to a top-level message and stays silent for a body cut off mid-JSON', async () => {
    scripted([() => new Response('{"message":"line one\\n\\n  line two"}', { status: 400 })])
    const error = await collect(fast()).catch((caught: unknown) => caught as Error)
    expect((error as Error).message).toContain('line one line two')

    // The bounded reader truncates this body, so it no longer parses as JSON.
    scripted([() => new Response(JSON.stringify({ error: { message: 'z'.repeat(9_000) } }), { status: 400 })])
    const big = await collect(fast()).catch((caught: unknown) => caught as Error)
    expect((big as Error).message).not.toContain('z'.repeat(100))
  })

  /** Request bodies as sent, in order. */
  function bodiesOf(fake: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return fake.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>)
  }
  const capError = (message: string): Response => new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), { status: 400 })

  it('relearns a rejected 32k guess from the error, resends once, and remembers it for the model', async () => {
    const fake = scripted([
      () => capError('max_tokens is too large: 32000. This model supports at most 4096 completion tokens, whereas you provided 32000.'),
      () => sse('ok'),
      () => sse('again'),
    ])
    const p = fast()
    expect(await collect(p)).toBe('ok')
    expect(await collect(p)).toBe('again')
    // 32k guess, corrected resend, then the next request starts at the limit.
    expect(bodiesOf(fake).map((body) => body['max_tokens'])).toEqual([32_000, 4_096, 4_096])
  })

  it('reads the limit from Anthropic, Groq, DashScope and Gemini wordings', () => {
    expect(outputLimitFromError('max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-haiku')).toBe(8_192)
    expect(outputLimitFromError('`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model')).toBe(8_192)
    expect(outputLimitFromError('Range of max_tokens should be [1, 8192]')).toBe(8_192)
    expect(outputLimitFromError('The requested max_output_tokens is out of range: valid range is 1 to 65537 (exclusive)')).toBe(65_536)
    expect(outputLimitFromError("Invalid 'max_completion_tokens': integer above maximum value. Expected a value <= 16384, but got 32000 instead.")).toBe(16_384)
    // vLLM names only this request's room; no cap at all lets vLLM fill it.
    expect(outputLimitFromError("'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 32768 tokens and your request has 6000 input tokens (32000 > 32768 - 6000).")).toBeUndefined()
  })

  it('drops the cap like the baseline when the limit cannot be read (vLLM window form)', async () => {
    const fake = scripted([
      () => capError("'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 32768 tokens and your request has 6000 input tokens (32000 > 32768 - 6000)."),
      () => sse('ok'),
    ])
    expect(await collect(fast())).toBe('ok')
    const [first, second] = bodiesOf(fake)
    expect(first!['max_tokens']).toBe(32_000)
    expect('max_tokens' in second!).toBe(false)
  })

  it('relearns at most once per request, and never over an operator or catalog cap', async () => {
    const reject = (): Response => capError('max_tokens is too large: 4096. This model supports at most 2048 completion tokens, whereas you provided 4096.')
    // A cap that keeps being rejected surfaces after one corrective resend.
    const looping = scripted([reject])
    const error = await collect(fast()).then(() => undefined, (caught: unknown) => caught as ProviderError)
    expect(error?.contextExceeded).toBe(false)
    expect(error?.reason).toBe('unknown')
    expect(error?.transient).toBe(false)
    expect(error?.message).toContain('supports at most 2048')
    expect(looping).toHaveBeenCalledTimes(2)

    // The operator's value is authoritative: shown, not silently replaced.
    const operator = scripted([reject])
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['m'], maxOutputTokens: { m: 4_096 } })
    await expect(collect(p)).rejects.toThrow(/supports at most 2048/)
    expect(operator).toHaveBeenCalledTimes(1)
  })

  // ── Phase 04 (plans/261017-runtime-provider-hardening): bounded relearning ──

  /** One logged physical attempt already consumed, as `runAttempt` does. */
  function ownedRequest(maxAttempts = 4): LogicalRequest {
    const owner = new LogicalRequest({ maxAttempts })
    owner.consume()
    return owner
  }

  async function collectWith(p: OpenAiCompletionsProvider, request: Parameters<OpenAiCompletionsProvider['stream']>[0], owner?: LogicalRequest): Promise<string> {
    let text = ''
    try {
      for await (const event of p.stream(request, owner !== undefined ? { requestOwner: owner } : undefined)) if (event.type === 'delta') text += event.delta
    } finally { owner?.dispose() }
    return text
  }

  const atMost = (limit: number, sent = 32_000): Response => capError(`max_tokens is too large: ${sent}. This model supports at most ${limit} completion tokens, whereas you provided ${sent}.`)
  const vllmWindow = (sent = 32_000): Response => capError(`'max_tokens' or 'max_completion_tokens' is too large: ${sent}. This model's maximum context length is 32768 tokens and your request has 6000 input tokens (${sent} > 32768 - 6000).`)

  it('the corrective resend is charged to the logical request, and none happens without budget', async () => {
    const fake = scripted([() => atMost(4_096), () => sse('ok')])
    const owner = ownedRequest()
    expect(await collectWith(fast(), { messages: [] }, owner)).toBe('ok')
    // The first physical attempt plus the corrective resend.
    expect(owner.attempts).toBe(2)
    expect(bodiesOf(fake).map((body) => body['max_tokens'])).toEqual([32_000, 4_096])

    // Attempt budget spent: the rejection surfaces instead of a free resend…
    const exhausted = scripted([() => atMost(4_096), () => sse('never')])
    const p = fast()
    const spent = ownedRequest(1)
    const error = await collectWith(p, { messages: [] }, spent).then(() => undefined, (caught: unknown) => caught as ProviderError)
    expect(exhausted).toHaveBeenCalledTimes(1)
    expect(error?.classification).toBe('output_cap_rejected')
    expect(error?.transient).toBe(false)
    expect(spent.attempts).toBe(1)
    // …but (review M2) the limit is still learned, and the message blames the
    // guess, not an operator setting that does not exist.
    expect(error?.message).toContain('fallback output-cap guess (32000) rejected')
    expect(error?.message).not.toContain('lower maxOutputTokens')
    expect(p.outputCapDiagnostics()).toMatchObject({ cap: 4_096, learned: true })
    const next = scripted([() => sse('ok')])
    await collectWith(p, { messages: [] })
    expect(bodiesOf(next)[0]!['max_tokens']).toBe(4_096)
  })

  it('review H1: a limit is read only from the output-token field, never a neighbouring one, and tiny limits are not learned', async () => {
    // Mixed multi-field error: the number belongs to temperature.
    const mixed = 'max_tokens is too large: 32000; temperature must be at most 2'
    expect(outputLimitFromError(mixed, 32_000)).toBeUndefined()
    expect(outputLimitFromError('Invalid request: top_p must be less than or equal to 1. Expected a value <= 1, but got 5.', 32_000)).toBeUndefined()
    const fakeMixed = scripted([() => capError(mixed), () => sse('ok')])
    await collect(fast())
    const [, resend] = bodiesOf(fakeMixed)
    // Cap wording without a readable field limit: resend with no cap, never 2.
    expect('max_tokens' in resend!).toBe(false)
    // A neighbouring field's constraint alone is not a cap rejection at all.
    const neighbour = scripted([() => capError('temperature must be at most 2')])
    await expect(collect(fast())).rejects.toThrow()
    expect(neighbour).toHaveBeenCalledTimes(1)
    // Anchored forms still read; the field must own the clause.
    expect(outputLimitFromError('`max_tokens` must be less than or equal to `8192`', 32_000)).toBe(8_192)
    expect(outputLimitFromError("Invalid 'max_completion_tokens': integer above maximum value. Expected a value <= 16384, but got 32000 instead.", 32_000)).toBe(16_384)
    // Tiny limit (< 256): treated as unreadable -> no cap, not learned as a cripple.
    expect(outputLimitFromError('This model supports at most 2 completion tokens', 32_000)).toBeUndefined()
    expect(outputLimitFromError('This model supports at most 255 completion tokens', 32_000)).toBeUndefined()
    expect(outputLimitFromError('This model supports at most 256 completion tokens', 32_000)).toBe(256)
    const tiny = scripted([() => capError('max_tokens is too large: 32000. This model supports at most 16 completion tokens.'), () => sse('ok')])
    const p = fast()
    await collect(p)
    expect('max_tokens' in bodiesOf(tiny)[1]!).toBe(false)
    expect(p.outputCapDiagnostics().cap).toBe('omitted')
  })

  it('review low: diagnostics peek without refreshing LRU recency', async () => {
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['first'] })
    for (let i = 0; i <= 16; i++) {
      scripted([() => atMost(2_048), () => sse('ok')])
      await collectWith(p, { model: i === 0 ? 'first' : `m-${i}`, messages: [] })
      // Reading 'first' repeatedly must not keep it alive.
      if (i < 16) expect(p.outputCapDiagnostics('first').learned).toBe(true)
    }
    expect(p.outputCapDiagnostics('first').learned).toBe(false)
  })

  it('accepts only bounded, plausible limits from the error text', async () => {
    // Above the product budget (256,000): not trusted; falls back to no cap.
    const huge = scripted([() => capError('max_tokens is too large: 32000. This model supports at most 999999 completion tokens.'), () => sse('ok')])
    await collect(fast())
    expect('max_tokens' in bodiesOf(huge)[1]!).toBe(false)
    // A "limit" at or above what was sent cannot explain the rejection.
    expect(outputLimitFromError('This model supports at most 64000 completion tokens', 32_000)).toBeUndefined()
    expect(outputLimitFromError('This model supports at most 64000 completion tokens', 128_000)).toBe(64_000)
    expect(outputLimitFromError('This model supports at most 0 completion tokens')).toBeUndefined()
    // Arbitrary numbers in unknown text are never read as limits.
    expect(outputLimitFromError('request 4242 failed with 8192 tokens somewhere')).toBeUndefined()
  })

  it('learned caps are bounded per instance, keyed by route, and exposed in diagnostics without secrets', async () => {
    const key = 'sk-live-DIAGNOSTICSKEY12345'
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: key, baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['m0'] })
    expect(p.outputCapDiagnostics('m0')).toEqual({ model: 'm0', source: 'fallback', cap: 32_000, learned: false })
    scripted([() => atMost(4_096), () => sse('ok')])
    await collectWith(p, { model: 'm0', messages: [] })
    expect(p.outputCapDiagnostics('m0')).toEqual({ model: 'm0', source: 'fallback', cap: 4_096, learned: true })
    scripted([() => vllmWindow(), () => sse('ok')])
    await collectWith(p, { model: 'vllm-model', messages: [] })
    expect(p.outputCapDiagnostics('vllm-model')).toEqual({ model: 'vllm-model', source: 'fallback', cap: 'omitted', learned: true })
    expect(JSON.stringify([p.outputCapDiagnostics('m0'), p.routeIdentity('m0')])).not.toContain('DIAGNOSTICSKEY')
    // An operator or catalog cap is reported as such and never learned over.
    expect(p.outputCapDiagnostics('gpt-4o')).toEqual({ model: 'gpt-4o', source: 'family', cap: 16_384, learned: false })

    // A relay inventing a new model per request cannot grow the memory: the
    // oldest route is evicted (16 routes per instance).
    for (let i = 1; i <= 16; i++) {
      scripted([() => atMost(2_048), () => sse('ok')])
      await collectWith(p, { model: `spam-${i}`, messages: [] })
    }
    expect(p.outputCapDiagnostics('m0').learned).toBe(false)
    expect(p.outputCapDiagnostics('spam-16')).toMatchObject({ cap: 2_048, learned: true })
  })

  it('credential rotation resets the learned cap and the route identity', async () => {
    const first = new OpenAiCompletionsProvider({ name: 'gw', apiKey: 'sk-account-ONE11111111', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['m'] })
    scripted([() => atMost(4_096), () => sse('ok')])
    await collectWith(first, { messages: [] })
    expect(first.outputCapDiagnostics().cap).toBe(4_096)
    // Hosts re-instantiate the provider when its key changes (web
    // syncRegistrations, CLI per run): the new account starts from the guess.
    const rotated = new OpenAiCompletionsProvider({ name: 'gw', apiKey: 'sk-account-TWO22222222', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['m'] })
    const fake = scripted([() => sse('ok')])
    await collectWith(rotated, { messages: [] })
    expect(bodiesOf(fake)[0]!['max_tokens']).toBe(32_000)
    expect(rotated.routeIdentity().credential).not.toBe(first.routeIdentity().credential)
    expect({ ...rotated.routeIdentity(), credential: '' }).toEqual({ ...first.routeIdentity(), credential: '' })
  })

  it('an unknown Claude alias with thinking: budget below the guess, dropped with the cap, recomputed below a learned cap', async () => {
    const claude = (): OpenAiCompletionsProvider => new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['claude-gateway-x'] })
    // vLLM-style rejection: no limit can be read, so no cap and no budget thinking.
    const dropped = scripted([() => vllmWindow(), () => sse('ok')])
    await collectWith(claude(), { messages: [], thinkingLevel: 'high' })
    const [guess, resend] = bodiesOf(dropped)
    expect([guess!['max_tokens'], guess!['thinking']]).toEqual([32_000, { type: 'enabled', budget_tokens: 16_000 }])
    expect('max_tokens' in resend!).toBe(false)
    expect('thinking' in resend!).toBe(false)
    // A readable limit: the budget is recomputed below the final cap.
    const relearned = scripted([() => atMost(8_192), () => sse('ok')])
    await collectWith(claude(), { messages: [], thinkingLevel: 'max' })
    expect(bodiesOf(relearned).map((body) => [body['max_tokens'], body['thinking']])).toEqual([
      [32_000, { type: 'enabled', budget_tokens: 31_999 }],
      [8_192, { type: 'enabled', budget_tokens: 8_191 }],
    ])
  })

  it('a learned "no cap" that meets a gateway requiring one is forgotten, not repeated', async () => {
    const p = fast()
    scripted([() => vllmWindow(), () => sse('ok')])
    await collect(p)
    expect(p.outputCapDiagnostics().cap).toBe('omitted')
    const missing = scripted([() => capError('max_tokens is required')])
    const error = await collect(p).then(() => undefined, (caught: unknown) => caught as ProviderError)
    expect(missing).toHaveBeenCalledTimes(1)
    expect('max_tokens' in bodiesOf(missing)[0]!).toBe(false)
    expect(error?.classification).toBe('missing_required_cap')
    expect(error?.message).toContain('requires an output cap')
    expect(error?.transient).toBe(false)
    // The next request starts from the documented fallback again.
    const next = scripted([() => sse('ok')])
    await collect(p)
    expect(bodiesOf(next)[0]!['max_tokens']).toBe(32_000)
  })

  it('a small window ceiling bounds the cap; an exhausted one is refused before the network', async () => {
    const fake = scripted([() => sse('ok')])
    await collectWith(fast(), { messages: [], outputCeilingTokens: 700 })
    expect(bodiesOf(fake)[0]!['max_tokens']).toBe(700)
    const none = scripted([() => sse('never')])
    for (const ceiling of [0, -12]) {
      const error = await collectWith(fast(), { messages: [], outputCeilingTokens: ceiling }).then(() => undefined, (caught: unknown) => caught as ProviderError)
      expect(error?.contextExceeded).toBe(true)
    }
    expect(none).not.toHaveBeenCalled()
  })

  it('PH3-B: a pure output-cap rejection of an authoritative cap is one request, terminal, actionable and redacted', async () => {
    const key = 'sk-live-REDACTME00000000'
    const fake = scripted([() => capError(`max_tokens is too large: 32000. This model supports at most 4096 completion tokens, whereas you provided 32000. key ${key}`)])
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: key, baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['m'], maxOutputTokens: { m: 32_000 } })
    const error = await collectWith(p, { messages: [] }).then(() => undefined, (caught: unknown) => caught as ProviderError)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({ reason: 'unknown', classification: 'output_cap_rejected', transient: false, contextExceeded: false })
    expect(error?.message).toContain("lower maxOutputTokens for 'm'")
    expect(error?.message).not.toContain('REDACTME')
  })

  it('a 502-wrapped pure cap rejection is not transient and is not replayed', async () => {
    const fake = scripted([() => new Response(JSON.stringify({ error: { message: 'upstream: This model supports at most 4096 completion tokens, whereas you provided 16384.' } }), { status: 502 })])
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['gpt-4o'] })
    const error = await collectWith(p, { messages: [] }).then(() => undefined, (caught: unknown) => caught as ProviderError)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({ classification: 'output_cap_rejected', transient: false })
    expect(error?.reason).not.toBe('server_error')
  })

  it('shared-window overflow with an authoritative cap stays recoverable even in max_tokens wording', async () => {
    const fake = scripted([() => vllmWindow(3_000)])
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1, models: ['m'], maxOutputTokens: { m: 3_000 } })
    const error = await collectWith(p, { messages: [] }).then(() => undefined, (caught: unknown) => caught as ProviderError)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(error?.contextExceeded).toBe(true)
    expect(error?.classification).toBe('context_exceeded')
  })

  it('redacts credentials an auth error echoes back before they reach the durable message', async () => {
    const key = 'sk-live-THISISTHESECRETKEY0123'
    scripted([() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. Also tried Bearer abcdEFGH12345678 and key_9f8e7d6c5b4a.` } }), { status: 401 })])
    const provider = new OpenAiCompletionsProvider({ name: 'test', apiKey: key, baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1 })
    const error = await collect(provider).catch((caught: unknown) => caught as Error)
    const message = (error as Error).message
    expect(message).toContain('HTTP 401: auth_configuration')
    expect(message).toContain('Incorrect API key provided')
    expect(message).not.toContain('THISISTHESECRETKEY')
    expect(message).not.toContain('abcdEFGH12345678')
    expect(message).not.toContain('9f8e7d6c5b4a')
    expect(message).toContain('[redacted]')

    // A key with no token shape is still caught verbatim.
    const plain = 'plainpassword42'
    scripted([() => new Response(JSON.stringify({ error: { message: `rejected credential ${plain}` } }), { status: 403 })])
    const other = await collect(new OpenAiCompletionsProvider({ name: 'test', apiKey: plain, baseUrl: 'http://127.0.0.1:1/v1', retryBaseMs: 1 })).catch((caught: unknown) => caught as Error)
    expect((other as Error).message).not.toContain(plain)
  })
})

/** One raw SSE response assembled from records, with no extra finish appended. */
function stubRecords(records: readonly string[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    `${records.map((record) => `data: ${record}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )))
}

async function collectEvents(p: OpenAiCompletionsProvider, request: Parameters<OpenAiCompletionsProvider['stream']>[0], signal?: AbortSignal): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of p.stream(request, signal !== undefined ? { signal } : undefined)) events.push(event)
  return events
}

describe('openai completions adapter: compatibility layer', () => {
  it('detects the output-cap field, keeping the historical one for unrecognized endpoints', () => {
    expect(detectMaxTokensField('deepseek', 'https://api.deepseek.com')).toBe('max_tokens')
    expect(detectMaxTokensField('ocproxy', 'http://127.0.0.1:6536/v1')).toBe('max_tokens')
    expect(detectMaxTokensField('zai', 'https://anything.example/v1')).toBe('max_tokens')
    expect(detectMaxTokensField('openai', 'https://api.openai.com/v1')).toBe('max_completion_tokens')
    // A gateway that merely relays OpenAI keeps the modern field by URL.
    expect(detectMaxTokensField('my-relay', 'https://api.openai.com/v1')).toBe('max_completion_tokens')
    // An arbitrarily named local gateway must not change wire behavior.
    expect(detectMaxTokensField('cliproxy1', 'http://127.0.0.1:6536/v1')).toBe('max_tokens')
    expect(detectSupportsStore('openai', 'https://api.openai.com/v1')).toBe(true)
    expect(detectSupportsStore('cliproxy1', 'http://127.0.0.1:6536/v1')).toBe(false)
    // A provider merely NAMED openai (LiteLLM, Azure, vLLM, llama.cpp…) keeps
    // the historical body: the name alone never opts into the native fields.
    expect(detectMaxTokensField('openai', 'http://127.0.0.1:4000/v1')).toBe('max_tokens')
    expect(detectSupportsStore('openai', 'http://127.0.0.1:4000/v1')).toBe(false)
    // Host match is exact, not a substring of some other host.
    expect(detectSupportsStore('x', 'https://api.openai.com.evil.example/v1')).toBe(false)
    expect(detectSupportsStore('x', 'not a url')).toBe(false)
  })

  it('writes the cap into the detected field and sends no other field of its own', async () => {
    const cases: readonly { name: string; baseUrl: string; field: 'max_tokens' | 'max_completion_tokens' }[] = [
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com', field: 'max_tokens' },
      { name: 'cliproxy1', baseUrl: 'http://127.0.0.1:6536/v1', field: 'max_tokens' },
      { name: 'openai', baseUrl: 'https://api.openai.com/v1', field: 'max_completion_tokens' },
    ]
    for (const testCase of cases) {
      const captured = stubFetch()
      const p = new OpenAiCompletionsProvider({ name: testCase.name, apiKey: '', baseUrl: testCase.baseUrl, maxOutputTokens: { m: 4_096 } })
      await collectEvents(p, { model: 'm', messages: [] })
      const body = captured[0]!.body
      expect(body[testCase.field]).toBe(4_096)
      expect(body[testCase.field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined()
    }
  })

  it('an explicit maxTokensField beats detection, and a model with no cap sends the fallback in the detected field', async () => {
    const captured = stubFetch()
    const overridden = new OpenAiCompletionsProvider({ name: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1', maxTokensField: 'max_tokens', maxOutputTokens: { m: 64 } })
    await collectEvents(overridden, { model: 'm', messages: [] })
    expect(captured[0]!.body['max_tokens']).toBe(64)
    expect(captured[0]!.body['max_completion_tokens']).toBeUndefined()

    const unknown = stubFetch()
    await collectEvents(provider(), { model: 'no-such-model-xyz', messages: [] })
    expect(unknown[0]!.body['max_tokens']).toBe(32_000)
    expect('max_completion_tokens' in unknown[0]!.body).toBe(false)

    const native = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1' }), { model: 'no-such-model-xyz', messages: [] })
    expect(native[0]!.body['max_completion_tokens']).toBe(32_000)
    expect('max_tokens' in native[0]!.body).toBe(false)
  })

  it('an unrecognized endpoint gets the exactly historical body', async () => {
    const captured = stubFetch()
    await run({ model: 'some-relay-model', messages: [{ role: 'user', content: 'hi' }], sessionAffinity: 'sess-x' })
    // Pinned literally: the same fields an existing relay received before the
    // compatibility layer, plus only the 32k fallback cap.
    expect(captured[0]!.body).toEqual({
      model: 'some-relay-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 32_000,
    })
  })

  it('sends store:false only where the flag is declared or detected', async () => {
    const native = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1' }), { messages: [] })
    expect(native[0]!.body['store']).toBe(false)

    const declared = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'cliproxy1', apiKey: '', baseUrl: 'http://127.0.0.1:6536/v1', supportsStore: true }), { messages: [] })
    expect(declared[0]!.body['store']).toBe(false)
  })
})

describe('openai completions adapter: session affinity', () => {
  it('always sends the affinity header but gates prompt_cache_key on declared support', async () => {
    const declared = stubFetch()
    await collectEvents(
      new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', supportsPromptCacheKey: true }),
      { messages: [], sessionAffinity: 'sess-1' },
    )
    expect(declared[0]!.headers['x-session-affinity']).toBe('sess-1')
    expect(declared[0]!.body['prompt_cache_key']).toBe('sess-1')

    // Undeclared endpoints still get the header, never the body field: a strict
    // relay must not receive an unknown key.
    const gated = stubFetch()
    await run({ messages: [], sessionAffinity: 'sess-2' })
    expect(gated[0]!.headers['x-session-affinity']).toBe('sess-2')
    expect('prompt_cache_key' in gated[0]!.body).toBe(false)

    const absent = stubFetch()
    await run({ messages: [] })
    expect('x-session-affinity' in absent[0]!.headers).toBe(false)
    expect('prompt_cache_key' in absent[0]!.body).toBe(false)
  })

  it('keeps one stable affinity across a session and hashes an oversized key', async () => {
    const captured = stubFetch()
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', supportsPromptCacheKey: true })
    const session = 's'.repeat(120)
    await collectEvents(p, { messages: [], sessionAffinity: session })
    await collectEvents(p, { messages: [], sessionAffinity: session })
    expect(captured.map((request) => request.headers['x-session-affinity'])).toEqual([session, session])
    expect(captured[0]!.body['prompt_cache_key']).toHaveLength(64)
    expect(captured[0]!.body['prompt_cache_key']).toBe(captured[1]!.body['prompt_cache_key'])
    // Two long ids sharing a 64-char prefix must not collide on one cache key.
    expect(promptCacheKey(`${'p'.repeat(64)}-a`)).not.toBe(promptCacheKey(`${'p'.repeat(64)}-b`))
    expect(promptCacheKey('ses_short')).toBe('ses_short')
  })

  it('detects prompt_cache_key support from the host, like opencode, and lets an explicit flag win', async () => {
    expect(detectSupportsPromptCacheKey('https://api.openai.com/v1')).toBe(true)
    expect(detectSupportsPromptCacheKey('https://openrouter.ai/api/v1')).toBe(true)
    // Azure needs the explicit flag: older api-versions reject unknown fields.
    expect(detectSupportsPromptCacheKey('https://my-res.openai.azure.com/openai')).toBe(false)
    // DeepSeek caches by prefix on its own; opencode leaves it off too.
    expect(detectSupportsPromptCacheKey('https://api.deepseek.com')).toBe(false)
    expect(detectSupportsPromptCacheKey('http://127.0.0.1:6536/v1')).toBe(false)
    expect(detectSupportsPromptCacheKey('https://api.openai.com.evil.example/v1')).toBe(false)
    expect(detectSupportsPromptCacheKey('not a url')).toBe(false)

    const native = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1' }), { messages: [], sessionAffinity: 'sess-n' })
    expect(native[0]!.body['prompt_cache_key']).toBe('sess-n')

    const optedOut = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1', supportsPromptCacheKey: false }), { messages: [], sessionAffinity: 'sess-n' })
    expect('prompt_cache_key' in optedOut[0]!.body).toBe(false)
  })
})

describe('openai completions adapter: re-sent tool-call headers', () => {
  it('accepts a fresh id before arguments accumulated and executes one call', async () => {
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"A","function":{"name":"Glob"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"B","function":{"name":"Glob"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    const events = await collectEvents(provider(), { messages: [] })
    expect(events).toContainEqual({ type: 'toolCalls', calls: [{ id: 'B', name: 'Glob', args: {} }] })
  })

  it('still fails when the id changes after arguments accumulated', async () => {
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"A","function":{"name":"Glob","arguments":"{\\"p\\":1}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"B","function":{"arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    await expect(collectEvents(provider(), { messages: [] })).rejects.toThrow(/conflicting tool ID/)
  })

  it('treats a blank id as a placeholder, rejects a non-string id without echoing it', async () => {
    // Blank means "no id in this fragment": the slot waits for the real header.
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"  ","function":{"name":"Glob"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"A","function":{"arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    expect(await collectEvents(provider(), { messages: [] })).toContainEqual({ type: 'toolCalls', calls: [{ id: 'A', name: 'Glob', args: {} }] })
    // A call that never gets an identity still fails at the batch boundary.
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"Glob","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    await expect(collectEvents(provider(), { messages: [] })).rejects.toMatchObject({ reason: 'invalid_tool_input' })
    // A non-string id is malformed data: fail without echoing the value.
    stubRecords(['{"choices":[{"delta":{"tool_calls":[{"index":0,"id":12345,"function":{"name":"Glob"}}]}}]}'])
    await expect(collectEvents(provider(), { messages: [] })).rejects.toMatchObject({ reason: 'invalid_tool_input' })
    await expect(collectEvents(provider(), { messages: [] })).rejects.not.toThrow('12345')
  })
})
