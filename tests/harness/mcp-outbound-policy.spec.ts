import { createServer } from 'node:http'
import { lookup } from 'node:dns/promises'
import { expect, it, vi } from 'vitest'

const { lookups } = vi.hoisted(() => ({ lookups: [] as Function[] }))
vi.mock('undici', async (original) => {
  const actual = await original<typeof import('undici')>()
  return { ...actual, Agent: class extends actual.Agent {
    constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
      super(options)
      lookups.push((options!.connect as { lookup: Function }).lookup)
    }
  } }
})
import { assertOutboundUrl, dispatcherFor } from '../../src/harness/mcp/outbound-policy.ts'

it('returns every validated DNS answer when lookup requests all addresses', async () => {
  const addresses = await lookup('localhost', { all: true, verbatim: true })
  const result = await new Promise((resolve, reject) => {
    lookups[1]!('localhost', { all: true }, (error: Error | null, answer: unknown) => error ? reject(error) : resolve(answer))
  })
  expect(result).toEqual(addresses)
})

it('connects through the loopback dispatcher using a hostname', async () => {
  const server = createServer((_req, res) => res.end('hostname works'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing port')
    const url = new URL(`http://localhost:${address.port}`)
    const response = await fetch(url, { dispatcher: dispatcherFor(url) } as RequestInit)
    expect(await response.text()).toBe('hostname works')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('only permits HTTPS loopback for an explicitly local resource', () => {
  expect(() => assertOutboundUrl('https://127.0.0.1/token')).toThrow(/prohibited/)
  expect(assertOutboundUrl('https://127.0.0.1/token', { allowLoopbackHttp: true }).hostname).toBe('127.0.0.1')
})
