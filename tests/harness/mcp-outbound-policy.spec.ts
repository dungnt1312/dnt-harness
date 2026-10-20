import { createServer } from 'node:http'
import { lookup } from 'node:dns/promises'
import { expect, it } from 'vitest'
import { assertOutboundUrl, resolvePolicyAddresses } from '../../src/harness/mcp/outbound-policy.ts'
import { OutboundHttp } from '../../src/harness/mcp/outbound-http.ts'

it('resolves a loopback hostname to a vetted answer for the loopback profile', async () => {
  const addresses = await lookup('localhost', { all: true, verbatim: true })
  const vetted = await resolvePolicyAddresses('localhost', true)
  expect(vetted.map(({ address }) => address).sort()).toEqual(addresses.map(({ address }) => address).sort())
  await expect(resolvePolicyAddresses('localhost', false)).rejects.toThrow(/prohibited/)
})

it('connects through the loopback dispatcher using a hostname', async () => {
  const server = createServer((_req, res) => res.end('hostname works'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Scoped resolver: no dependence on how the machine resolves `localhost`.
  const http = new OutboundHttp({ resolver: async () => [{ address: '127.0.0.1', family: 4 }] })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing port')
    const response = await http.request(`http://localhost:${address.port}`, { allowLoopback: true })
    expect(await response.text()).toBe('hostname works')
  } finally {
    await http.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('connects to an IPv4-only fixture via the real system resolver for localhost (falls back across vetted answers)', async () => {
  // localhost commonly resolves to [::1, 127.0.0.1]; the fixture listens on IPv4 only.
  const server = createServer((_req, res) => res.end('system localhost'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const http = new OutboundHttp()
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing port')
    const response = await http.request(`http://localhost:${address.port}/`, { allowLoopback: true })
    expect(await response.text()).toBe('system localhost')
  } finally {
    await http.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('only permits HTTPS loopback for an explicitly local resource', () => {
  expect(() => assertOutboundUrl('https://127.0.0.1/token')).toThrow(/prohibited/)
  expect(assertOutboundUrl('https://127.0.0.1/token', { allowLoopbackHttp: true }).hostname).toBe('127.0.0.1')
})
