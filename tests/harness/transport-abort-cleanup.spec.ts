import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { cancelReader } from '../../src/harness/llm/completion.ts'
import { OpenAiCompletionsProvider } from '../../src/harness/llm/openai.ts'

describe('abort transport cleanup', () => {
  it('confirms an errored reader is terminal even when cancel rejects', async () => {
    const failure = new DOMException('aborted', 'AbortError')
    const reader = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure) } }).getReader()
    let settled = 0
    try {
      expect(await cancelReader(reader, () => { settled++ })).toBe(true)
      expect(settled).toBe(1)
    } finally { reader.releaseLock() }
  })

  it('does not confirm cleanup when the underlying cancellation rejects', async () => {
    const reader = new ReadableStream<Uint8Array>({ cancel() { throw new Error('cleanup failed') } }).getReader()
    let settled = 0
    try {
      expect(await cancelReader(reader, () => { settled++ })).toBe(false)
      expect(settled).toBe(0)
    } finally { reader.releaseLock() }
  })

  it('settles a real HTTP provider stream after Stop aborts a pending read', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing server address')
    const provider = new OpenAiCompletionsProvider({ name: 'local', apiKey: '', baseUrl: `http://127.0.0.1:${address.port}`, maxRetries: 0 })
    const controller = new AbortController()
    let settled = 0
    const iterator = provider.stream({ messages: [] }, { signal: controller.signal, onTransportSettled: () => { settled++ } })[Symbol.asyncIterator]()
    try {
      expect(await iterator.next()).toMatchObject({ value: { type: 'delta', delta: 'hello' } })
      const pending = iterator.next()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ reason: 'cancelled', transportSettled: true })
      expect(settled).toBe(1)
    } finally {
      controller.abort()
      await iterator.return?.()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
