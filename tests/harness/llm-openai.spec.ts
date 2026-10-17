/**
 * The OpenAI-completions adapter's wire format: thinking overrides are
 * translated into documented request fields (never a raw passthrough), and
 * the tools key disappears entirely when a mode exposes no tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompletionsProvider, ProviderError } from 'dnt-harness'
import { detectMaxTokensField, detectSupportsStore, toolCallIdReissueCount } from '../../src/harness/llm/openai.ts'
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
    await run({ model: 'deepseek-chat', messages: [], outputCeilingTokens: 120_000 })
    await run({ model: 'some-unknown-model', messages: [], outputCeilingTokens: 200_000 })
    await run({ model: 'some-unknown-model', messages: [], outputCeilingTokens: 12_000 })
    await run({ model: 'some-unknown-model', messages: [], maxOutputTokens: 64_000 })
    await run({ model: 'some-unknown-model', messages: [], maxOutputTokens: 8_000, outputCeilingTokens: 5_000 }) // an explicit request cap is still clamped
    expect(captured.map(c => c.body['max_tokens'])).toEqual([32_000, 32_000, 12_000, 32_000, 5_000])
    expect(captured.every(c => !('outputCeilingTokens' in c.body))).toBe(true)
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
    const before = stubFetch()
    await run({ model: 'gpt-5.6', messages: [] })
    const historical = before[0]!.body
    expect(historical['stream_options']).toEqual({ include_usage: true })
    expect('store' in historical).toBe(false)
    expect('prompt_cache_key' in historical).toBe(false)

    const after = stubFetch()
    await run({ model: 'gpt-5.6', messages: [], providerOptions: {} })
    expect(after[0]!.body).toEqual(historical)
  })

  it('sends store:false only where the flag is declared or detected, and honors usage opt-out', async () => {
    const native = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1' }), { messages: [] })
    expect(native[0]!.body['store']).toBe(false)

    const declared = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'cliproxy1', apiKey: '', baseUrl: 'http://127.0.0.1:6536/v1', supportsStore: true }), { messages: [] })
    expect(declared[0]!.body['store']).toBe(false)

    const withoutUsage = stubFetch()
    await collectEvents(new OpenAiCompletionsProvider({ name: 'cliproxy1', apiKey: '', baseUrl: 'http://127.0.0.1:6536/v1', supportsUsageInStreaming: false }), { messages: [] })
    expect('stream_options' in withoutUsage[0]!.body).toBe(false)
  })

  it('fails a physical attempt that never sends headers when a deadline is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
      return new Response('')
    }))
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', headerTimeoutMs: 20, maxRetries: 0 })
    await expect(collectEvents(p, { messages: [] })).rejects.toMatchObject({ reason: 'first_progress_timeout', phase: 'headers', transient: true })
  })

  it('a caller stop during the header wait stays a cancellation, not a deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
      return new Response('')
    }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('stopped')), 10)
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', headerTimeoutMs: 60_000, maxRetries: 0 })
    await expect(collectEvents(p, { messages: [] }, controller.signal)).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('a caller stop after headers still reaches a stalled stream when a deadline is configured', async () => {
    // The body is bound to the attempt signal, as a real fetch body is: if the
    // caller's abort stopped being forwarded once headers arrived, this read
    // would hang until the test timeout.
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const wire = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
          wire?.addEventListener('abort', () => controller.error(wire.reason), { once: true })
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))
    const controller = new AbortController()
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', headerTimeoutMs: 60_000, maxRetries: 0 })
    const stream = p.stream({ messages: [] }, { signal: controller.signal })[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.value).toMatchObject({ type: 'delta', delta: 'hi' })
    controller.abort(new Error('stopped'))
    await expect(stream.next()).rejects.toMatchObject({ reason: 'cancelled' })
  }, 5_000)
})

describe('openai completions adapter: provider options', () => {
  const tools = [{ name: 'Read', description: 'read', parameters: { type: 'object' as const, properties: {} } }]

  it('lowers only whitelisted fields and drops the rest', async () => {
    const captured = stubFetch()
    await run({
      messages: [],
      tools,
      providerOptions: {
        toolChoice: 'required',
        parallelToolCalls: false,
        responseFormat: 'json_object',
        stop: ['STOP', ''],
        temperature: 0.2,
        seed: 7,
      },
    })
    const body = captured[0]!.body
    expect(body['tool_choice']).toBe('required')
    expect(body['parallel_tool_calls']).toBe(false)
    expect(body['response_format']).toEqual({ type: 'json_object' })
    expect(body['stop']).toEqual(['STOP'])
    expect('temperature' in body).toBe(false)
    expect('seed' in body).toBe(false)
  })

  it('maps a named tool choice and passes a full response_format object through', async () => {
    const captured = stubFetch()
    const schema = { type: 'json_schema', json_schema: { name: 'answer' } }
    await run({ messages: [], tools, providerOptions: { toolChoice: { name: 'Read' }, responseFormat: schema } })
    expect(captured[0]!.body['tool_choice']).toEqual({ type: 'function', function: { name: 'Read' } })
    expect(captured[0]!.body['response_format']).toEqual(schema)
  })

  it('never sends a tool choice when the request exposes no tools', async () => {
    const captured = stubFetch()
    await run({ messages: [], providerOptions: { toolChoice: 'required' } })
    expect('tool_choice' in captured[0]!.body).toBe(false)
  })

  it('ignores malformed option values instead of forwarding them', async () => {
    const captured = stubFetch()
    await run({
      messages: [],
      tools,
      providerOptions: { toolChoice: { nope: true }, parallelToolCalls: 'yes', responseFormat: 'xml', stop: 'STOP' },
    })
    const body = captured[0]!.body
    expect('tool_choice' in body).toBe(false)
    expect('parallel_tool_calls' in body).toBe(false)
    expect('response_format' in body).toBe(false)
    expect('stop' in body).toBe(false)
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

  it('keeps one stable affinity across a session and truncates an oversized key', async () => {
    const captured = stubFetch()
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', supportsPromptCacheKey: true })
    const session = 's'.repeat(120)
    await collectEvents(p, { messages: [], sessionAffinity: session })
    await collectEvents(p, { messages: [], sessionAffinity: session })
    expect(captured.map((request) => request.headers['x-session-affinity'])).toEqual([session, session])
    expect(captured[0]!.body['prompt_cache_key']).toHaveLength(64)
    expect(captured[0]!.body['prompt_cache_key']).toBe(captured[1]!.body['prompt_cache_key'])
  })
})

describe('openai completions adapter: re-sent tool-call headers', () => {
  it('accepts a fresh id before arguments accumulated and executes one call', async () => {
    const before = toolCallIdReissueCount()
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"A","function":{"name":"Glob"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"B","function":{"name":"Glob"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    const events = await collectEvents(provider(), { messages: [] })
    expect(events).toContainEqual({ type: 'toolCalls', calls: [{ id: 'B', name: 'Glob', args: {} }] })
    expect(toolCallIdReissueCount()).toBe(before + 1)
  })

  it('still fails when the id changes after arguments accumulated', async () => {
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"A","function":{"name":"Glob","arguments":"{\\"p\\":1}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"B","function":{"arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    await expect(collectEvents(provider(), { messages: [] })).rejects.toThrow(/conflicting tool ID/)
  })

  it('wire.toolCallIdReuse expect keeps accumulated arguments and takes the newest id', async () => {
    stubRecords([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"A","function":{"name":"Glob","arguments":"{\\"p\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"B","function":{"arguments":"1}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])
    const p = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', wire: { toolCallIdReuse: 'expect' } })
    expect(await collectEvents(p, { messages: [] })).toContainEqual({ type: 'toolCalls', calls: [{ id: 'B', name: 'Glob', args: { p: 1 } }] })
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
