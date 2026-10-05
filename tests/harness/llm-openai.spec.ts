/**
 * The OpenAI-completions adapter's wire format: thinking overrides are
 * translated into documented request fields (never a raw passthrough), and
 * the tools key disappears entirely when a mode exposes no tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompletionsProvider, ProviderError } from 'dnt-harness'
import { LogicalRequest } from '../../src/harness/llm/request-lifecycle.ts'
import { wrapUntrusted } from '../../src/harness/context/builder.ts'

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

/** Stub global fetch with an SSE chat-completions responder. */
function stubFetch(chunks: readonly string[] = ['{"choices":[{"delta":{"content":"ok"}}]}']): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  const fake = vi.fn(async (input: string | URL, init?: { body?: string }) => {
    captured.push({ url: String(input), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> })
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
  it('preserves base system and wrapped compaction system blocks in order on the local wire', async () => {
    const captured = stubFetch()
    const baseSystem = 'Base system instructions. This is the same conversation continuing after compaction, not a new session.'
    const compactionSystem = wrapUntrusted('compacted-history', 'through-seq="42"', 'Synthetic summary: 44f6ada; browser audio acceptance pending.')
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
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/provider gateway failure/)
  })

  it('a string-form gateway error chunk is surfaced too', async () => {
    stubFetch(['{"error":"upstream connect error"}'])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/provider gateway failure/)
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
})
