import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsService, Kernel, LlmService, OpenAiCompletionsProvider, SessionsService, ToolsService, readBoundedError, withLegacyCompletion, ProviderError, type StreamEvent } from 'dnt-harness'

const record = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const text = record({ choices: [{ delta: { content: 'partial' } }] })
const finish = (reason: string) => record({ choices: [{ finish_reason: reason }] })
const call = (index = 0, id = 'c', name = 'Glob', args = '{}') => record({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] })
async function collect(wire: string | Uint8Array, completionPolicy?: 'finish-eof') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof wire === 'string' ? wire : new Uint8Array(wire))))
  const provider = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://unused', maxRetries: 0, ...(completionPolicy ? { completionPolicy } : {}) })
  const events = []
  for await (const event of provider.stream({ messages: [] })) events.push(event)
  return events
}
afterEach(() => vi.unstubAllGlobals())
describe('explicit stream completion', () => {
  it('A10 cancels an endless error body at 16 KiB and displays at most 4000 chars', async () => {
    let read = 0
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { read += 1024; controller.enqueue(new Uint8Array(1024).fill(120)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }))
    expect((await readBoundedError(response)).length).toBe(4000)
    expect(read).toBe(16384)
    expect(cancelled).toBe(true)
  })
  it.each(['text', 'calls', 'length', 'unsettled', 'batch-error', 'aggregate', 'legacy-aggregate'] as const)('A01/A03/A05 Agent rejects %s without side effects or model history', async kind => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.provide('limits', { stepRetries: 1, stepRetryBaseMs: 1 })
    const body = vi.fn(async () => 'ok')
    kernel.ctx.tools.register({ name: 'Glob', description: 'test', parameters: { type: 'object', properties: {} }, execute: body })
    const prepare = vi.spyOn(kernel.ctx.tools, 'prepare')
    const approval = vi.fn()
    kernel.ctx.on('tools/pre-execute', async (_payload, next) => { approval(); return next() })
    let attempts = 0
    const aggregate = kind === 'aggregate' || kind === 'legacy-aggregate'
    const provider = { name: 'invalid', async *stream(): AsyncIterable<StreamEvent> {
      attempts++
      if (aggregate && attempts > 1) throw new Error('unexpected subsequent model step')
      if (kind !== 'calls' && kind !== 'batch-error') yield { type: 'delta', delta: aggregate ? 'x'.repeat(7 * 1024 * 1024) : 'partial' }
      if (kind !== 'text') yield { type: 'toolCalls', calls: [{ id: 'c', name: 'Glob', args: aggregate ? { value: 'x'.repeat(2 * 1024 * 1024 - 20) } : {} }] }
      if (kind === 'batch-error') throw new ProviderError('temporary failure', { transient: true })
      if (kind === 'length' || kind === 'unsettled' || kind === 'aggregate') yield { type: 'completion', finishReason: kind === 'length' ? 'length' : 'stop', transport: 'done', policy: 'strict', transportSettled: kind !== 'unsettled' }
    } }
    kernel.ctx.llm.register(kind === 'legacy-aggregate' ? withLegacyCompletion(provider) : provider)
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)
    agent.send('go')
    await agent.run()
    expect(prepare).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
    expect(session.events.some(e => e.type === 'approval/request')).toBe(false)
    if (kind === 'batch-error') expect(attempts).toBe(1)
    expect(session.events.some(e => e.type === 'assistant/chunk')).toBe(kind !== 'calls' && kind !== 'batch-error')
    expect(session.events.some(e => e.type === 'assistant/message')).toBe(false)
    expect(session.deriveMessages().filter(m => m.role === 'assistant')).toEqual([])
    expect(session.events.findLast(e => e.type === 'turn/end')).toMatchObject({ reason: 'failed' })
    await kernel.stop()
  })
  it.each([text, call(), text + 'data: [DONE]\n\n'])('A01 rejects EOF/DONE without semantic finish', async wire => {
    await expect(collect(wire)).rejects.toMatchObject({ reason: 'incomplete_completion' })
  })
  it('A02 finishes exactly once at DONE, ignoring trailing response bytes', async () => {
    const events = await collect(call() + finish('tool_calls') + 'data: [DONE]\n\ndata: broken\n\n')
    expect(events.filter(e => e.type === 'toolCalls')).toHaveLength(1)
    expect(events.filter(e => e.type === 'completion')).toHaveLength(1)
  })
  it('explicit legacy wrapper emits visible policy', async () => {
    const provider = withLegacyCompletion({ name: 'legacy', async *stream(): AsyncIterable<StreamEvent> { yield { type: 'delta', delta: 'ok' } } })
    const events = []
    for await (const event of provider.stream({ messages: [] })) events.push(event)
    expect(events.at(-1)).toEqual({ type: 'completion', finishReason: 'stop', transport: 'legacy', policy: 'legacy-iterable', transportSettled: true })
  })
  it('A02 EOF compatibility is explicit', async () => {
    await expect(collect(text + finish('stop'))).rejects.toMatchObject({ reason: 'incomplete_completion' })
    expect(await collect(text + finish('stop'), 'finish-eof')).toContainEqual({ type: 'completion', finishReason: 'stop', transport: 'eof', policy: 'finish-eof', transportSettled: true })
  })
  it.each(['length', 'content_filter', 'unexpected'])('A03 rejects %s', async reason => {
    await expect(collect(call() + finish(reason) + 'data: [DONE]\n\n')).rejects.toBeInstanceOf(Error)
  })
  it('A03 rejects conflicting finish', async () => {
    await expect(collect(text + finish('stop') + finish('tool_calls') + 'data: [DONE]\n\n')).rejects.toBeInstanceOf(Error)
  })
  it('A03 provider error before boundary overrides valid finish', async () => {
    await expect(collect(text + finish('stop') + record({ error: { message: 'gateway failed' } }) + 'data: [DONE]\n\n')).rejects.toThrow('provider gateway failure')
  })
  it('decodes multiline data records and CRLF', async () => {
    expect(await collect('data: {"choices":\r\ndata: [{"delta":{"content":"ok"}}]}\r\n\r\n' + finish('stop') + 'data: [DONE]\n\n')).toContainEqual({ type: 'delta', delta: 'ok' })
  })
  it('A11 assembles interleaved calls', async () => {
    const events = await collect(call(0, 'a', 'Glob', '{') + call(1, 'b', 'Read', '{}') + record({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }) + finish('tool_calls') + 'data: [DONE]\n\n')
    expect(events.find(e => e.type === 'toolCalls')).toMatchObject({ calls: [{ id: 'a', args: {} }, { id: 'b', args: {} }] })
  })
  it.each([call(128), call(1), call() + call(0, 'different'), call() + call(0, 'c', 'Read'), call(0, 'c', 'Glob', '{'), call() + call(1)])('A11 rejects invalid whole batch', async wire => {
    await expect(collect(wire + finish('tool_calls') + 'data: [DONE]\n\n')).rejects.toBeInstanceOf(Error)
  })
  it('A10 rejects oversized frame', async () => {
    await expect(collect('data: ' + 'x'.repeat(1024 * 1024 + 1))).rejects.toMatchObject({ reason: 'output_limit' })
  })
  it('A10 bounds accumulated arguments across individually bounded frames', async () => {
    const fragment = 'x'.repeat(700_000)
    const continuation = record({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] })
    await expect(collect(call(0, 'c', 'Glob', fragment) + continuation + continuation + finish('tool_calls') + 'data: [DONE]\n\n')).rejects.toMatchObject({ reason: 'output_limit' })
  })
  it('accepts null content with valid tool calls', async () => {
    const wire = record({ choices: [{ delta: { content: null, tool_calls: [{ index: 0, id: 'c', function: { name: 'Glob', arguments: '{}' } }] } }] })
    expect(await collect(wire + finish('tool_calls') + 'data: [DONE]\n\n')).toContainEqual({ type: 'toolCalls', calls: [{ id: 'c', name: 'Glob', args: {} }] })
  })
  it.each([null, 'payload-canary', { index: 0, function: 'payload-canary' }, { index: 0, function: null }])('rejects malformed tool fragment %j without retry or payload echo', async fragment => {
    await expect(collect(record({ choices: [{ delta: { tool_calls: [fragment] } }] }))).rejects.toMatchObject({ reason: 'malformed_protocol', retryable: false })
    await expect(collect(record({ choices: [{ delta: { tool_calls: [fragment] } }] }))).rejects.not.toThrow('payload-canary')
  })
  it('ignores invalid UTF-8 bytes after complete DONE in the same chunk', async () => {
    const bytes = new TextEncoder().encode(text + finish('stop') + 'data: [DONE]\n\n')
    const wire = new Uint8Array(bytes.length + 1)
    wire.set(bytes); wire[bytes.length] = 255
    expect((await collect(wire)).filter(e => e.type === 'completion')).toHaveLength(1)
  })
  it('rejects invalid UTF-8 before DONE', async () => {
    await expect(collect(new Uint8Array([100, 97, 116, 97, 58, 32, 255, 10, 10]))).rejects.toMatchObject({ reason: 'malformed_protocol', retryable: false })
  })
  it('preserves split UTF-8 and CRLF across transport chunks', async () => {
    const bytes = new TextEncoder().encode(record({ choices: [{ delta: { content: 'é' } }] }).replaceAll('\n', '\r\n') + finish('stop') + 'data: [DONE]\r\n\r\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() },
    }))))
    const provider = new OpenAiCompletionsProvider({ name: 'test', apiKey: '', baseUrl: 'http://unused', maxRetries: 0 })
    const events = []
    for await (const event of provider.stream({ messages: [] })) events.push(event)
    expect(events).toContainEqual({ type: 'delta', delta: 'é' })
    expect(events.filter(e => e.type === 'completion')).toHaveLength(1)
  })
  it('counts every CRLF byte toward the frame limit', async () => {
    const frame = ':' + 'x'.repeat(1024 * 1024 - 4) + '\r\n\r\n'
    expect(new TextEncoder().encode(frame).length).toBe(1024 * 1024 + 1)
    await expect(collect(frame + text + finish('stop') + 'data: [DONE]\n\n')).rejects.toMatchObject({ reason: 'output_limit' })
  })
  it('A10 rejects malformed terminal tail', async () => {
    await expect(collect(text + finish('stop') + 'data: {', 'finish-eof')).rejects.toMatchObject({ reason: 'malformed_protocol' })
  })
})
