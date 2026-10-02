/**
 * The OpenAI-completions adapter's wire format: thinking overrides are
 * translated into documented request fields (never a raw passthrough), and
 * the tools key disappears entirely when a mode exposes no tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompletionsProvider, ProviderError } from 'dnt-harness'

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

describe('openai completions adapter: failure surfacing', () => {
  it('a mid-stream gateway error chunk rejects with the gateway message', async () => {
    // One API-style relays answer 200, stream a little, then fail upstream:
    // the error arrives as a JSON body chunk, not an HTTP status.
    stubFetch([
      '{"choices":[{"delta":{"content":"par"}}]}',
      '{"error":{"message":"no available channel for this model","code":503}}',
    ])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/no available channel/)
  })

  it('a string-form gateway error chunk is surfaced too', async () => {
    stubFetch(['{"error":"upstream connect error"}'])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/upstream connect error/)
  })

  it('a stream that closes without any model output is an error, not silence', async () => {
    stubFetch([])
    await expect(run({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/without any model output/)
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
    return new Response(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
      () => { throw new TypeError('fetch failed') },
      () => sse('back'),
    ])
    expect(await collect(fast())).toBe('back')
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('does not retry a client error', async () => {
    const fake = scripted([() => new Response('bad key', { status: 401 })])
    await expect(collect(fast())).rejects.toThrow(/HTTP 401: bad key/)
    expect(fake).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxRetries and reports the attempts', async () => {
    const fake = scripted([() => new Response('down', { status: 502 })])
    await expect(collect(fast(2))).rejects.toThrow(/HTTP 502: down \(after 3 attempts\)/)
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
    expect((error as Error).message).toContain('[truncated]')
  })
})
