/**
 * The OpenAI-completions adapter's wire format: thinking overrides are
 * translated into documented request fields (never a raw passthrough), and
 * the tools key disappears entirely when a mode exposes no tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompletionsProvider } from 'mini-dsh'

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
