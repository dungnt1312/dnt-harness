/**
 * RH-1 transport acceptance (RH1-A..F) against real local sockets.
 *
 * Every fixture listens on 127.0.0.1 and counts TCP connections, so
 * "blocked" means zero bytes reached the server, not that an option was set.
 * DNS answers come from a scoped resolver fixture passed to the transport:
 * no Internet DNS, no hosts edits, TLS verification untouched.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRealUndici, OutboundHttp, OutboundTransportUnavailableError, type OutboundResponse } from '../../src/harness/mcp/outbound-http.ts'
import { assertOutboundUrl, OutboundPolicyError, resolvePolicyAddresses, type AddressResolver, type ResolvedAddress } from '../../src/harness/mcp/outbound-policy.ts'
import { McpServerClient } from '../../src/harness/mcp/client.ts'
import { ManagedOAuth } from '../../src/harness/mcp/oauth.ts'
import { OAuthStore } from '../../src/harness/mcp/oauth-store.ts'
import { fetchMedia } from '../../src/harness/tools/image-tools.ts'
import { bunExecutable } from '../helpers/runtime-executable.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

interface Fixture {
  readonly port: number
  readonly origin: string
  /** TCP connections accepted. */
  connections: number
  /** HTTP requests seen, as `METHOD path`. */
  readonly requests: string[]
  readonly headers: IncomingMessage['headers'][]
  close(): Promise<void>
}

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end('ok')): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`)
    state.headers.push(req.headers)
    handler(req, res)
  })
  server.on('connection', () => { state.connections += 1 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const state: Fixture = {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    connections: 0,
    requests: [],
    headers: [],
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  open.push(state)
  return state
}

function transport(resolver: AddressResolver, extra: ConstructorParameters<typeof OutboundHttp>[0] = {}): OutboundHttp {
  const http = new OutboundHttp({ resolver, ...extra })
  open.push(http)
  return http
}

/** Scoped resolver: a fixed answer set per hostname, recording every question. */
function resolverOf(answers: Record<string, readonly ResolvedAddress[]>): AddressResolver & { readonly asked: string[] } {
  const asked: string[] = []
  const resolve = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
    asked.push(hostname)
    const found = answers[hostname]
    if (found === undefined) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return found
  }
  return Object.assign(resolve, { asked })
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 })
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 })

describe('RH1-A: a refusing dispatcher sends zero requests', () => {
  it('a public-mode request to a name resolving to the fixture never connects', async () => {
    const server = await fixture()
    const http = transport(resolverOf({ 'api.public.test': [v4('127.0.0.1')] }))
    // https so the URL itself is acceptable; the refusal must come from the connect-time lookup.
    const error = await http.request(`https://api.public.test:${server.port}/mcp`).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OutboundPolicyError)
    expect(server.connections).toBe(0)
  })

  it('fails closed when fetch is the runtime native fetch (Bun shim shape)', async () => {
    const server = await fixture()
    const real = await loadRealUndici()
    // Bun's shim: native fetch plus an Agent; dispatcher would be ignored.
    const http = transport(resolverOf({ localhost: [v4('127.0.0.1')] }), { loader: async () => ({ ...real, fetch: globalThis.fetch as never }) })
    const error = await http.request(`${server.origin}/`, { allowLoopback: true }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OutboundTransportUnavailableError)
    await expect(http.ready()).rejects.toBeInstanceOf(OutboundTransportUnavailableError)
    expect(server.connections).toBe(0)
  })

  it('fails closed when the dispatcher has no callable dispatch', async () => {
    const server = await fixture()
    const real = await loadRealUndici()
    class NoDispatch { close = async () => undefined }
    const http = transport(resolverOf({}), { loader: async () => ({ ...real, Agent: NoDispatch as never }) })
    await expect(http.request(`${server.origin}/`, { allowLoopback: true })).rejects.toBeInstanceOf(OutboundTransportUnavailableError)
    expect(server.connections).toBe(0)
  })

  it('fails closed when Undici cannot be loaded at all', async () => {
    const http = transport(resolverOf({}), { loader: async () => { throw new Error('module not found') } })
    await expect(http.request('https://api.public.test/')).rejects.toBeInstanceOf(OutboundTransportUnavailableError)
  })

  it('loads real Undici by resolved entry, not the bare specifier', async () => {
    const real = await loadRealUndici()
    expect(real.fetch).not.toBe(globalThis.fetch)
    expect(Function.prototype.toString.call(real.fetch)).not.toMatch(/\[native code\]/)
    await expect(transport(resolverOf({})).ready()).resolves.toBeUndefined()
  })
})

describe('RH1-B: DNS answers are judged at connect time', () => {
  it.each([
    ['private IPv4', [v4('10.0.0.7')]],
    ['loopback IPv4', [v4('127.0.0.1')]],
    ['link-local metadata', [v4('169.254.169.254')]],
    ['IPv6 loopback', [v6('::1')]],
    ['IPv6 ULA', [v6('fd00::1')]],
    ['IPv4-mapped private', [v6('::ffff:10.0.0.1')]],
    ['NAT64-embedded private', [v6('64:ff9b::a00:1')]],
    ['mixed public + private', [v4('93.184.216.34'), v4('127.0.0.1')]],
    ['mixed private first', [v4('127.0.0.1'), v6('2606:4700::1111')]],
    ['empty answer', []],
  ] as const)('rejects %s for a public-looking hostname', async (_label, answers) => {
    await expect(resolvePolicyAddresses('cdn.public.test', false, async () => answers)).rejects.toBeInstanceOf(OutboundPolicyError)
  })

  it('returns every vetted answer, families interleaved from the first', async () => {
    await expect(resolvePolicyAddresses('cdn.public.test', false, async () => [v4('93.184.216.34'), v4('93.184.216.35'), v6('2606:4700::1111')]))
      .resolves.toEqual([v4('93.184.216.34'), v6('2606:4700::1111'), v4('93.184.216.35')])
  })

  it('falls back from an unreachable vetted address to the next on connect errors', async () => {
    const server = await fixture((_req, res) => res.end('fallback ok'))
    // ::1 on the fixture port has no listener (fixture is IPv4-only): ECONNREFUSED, then 127.0.0.1.
    const http = transport(resolverOf({ localhost: [v6('::1'), v4('127.0.0.1')] }))
    const response = await http.request(`http://localhost:${server.port}/`, { allowLoopback: true })
    expect(await response.text()).toBe('fallback ok')
    expect(server.connections).toBe(1)
  })

  it('never falls back after a policy refusal, even with an allowed answer in the set', async () => {
    const server = await fixture()
    const http = transport(resolverOf({ 'cdn.public.test': [v4('203.0.113.9'), v4('127.0.0.1')] }))
    await expect(http.request(`https://cdn.public.test:${server.port}/`)).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(server.connections).toBe(0)
  })

  it('blocks mixed answers at connect: the fixture behind the private answer sees nothing', async () => {
    const server = await fixture()
    const http = transport(resolverOf({ 'mixed.public.test': [v4('93.184.216.34'), v4('127.0.0.1')] }))
    await expect(http.request(`https://mixed.public.test:${server.port}/`)).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(server.connections).toBe(0)
  })

  it('re-resolves for every new connection, so a later private answer is refused', async () => {
    const server = await fixture((_req, res) => { res.setHeader('connection', 'close'); res.end('first') })
    let answer: readonly ResolvedAddress[] = [v4('127.0.0.1')]
    const asked: string[] = []
    const http = transport(async (hostname) => { asked.push(hostname); return answer })
    const first = await http.request(`http://localhost:${server.port}/`, { allowLoopback: true })
    expect(await first.text()).toBe('first')
    // Rebinding: the same name now points into the private LAN.
    answer = [v4('10.0.0.7')]
    await expect(http.request(`http://localhost:${server.port}/`, { allowLoopback: true })).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(asked).toEqual(['localhost', 'localhost'])
    expect(server.connections).toBe(1)
  })

  it('the loopback profile refuses a loopback name that resolves off-host', async () => {
    const server = await fixture()
    const http = transport(resolverOf({ localhost: [v4('127.0.0.1'), v4('192.168.1.9')] }))
    await expect(http.request(`http://localhost:${server.port}/`, { allowLoopback: true })).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(server.connections).toBe(0)
  })
})

describe('prohibited ranges (M1)', () => {
  it.each([
    ['NAT64 local-use 64:ff9b:1::/48 embedding 10.0.0.1', '64:ff9b:1::a00:1'],
    ['NAT64 local-use embedding loopback', '64:ff9b:1:0:0:0:7f00:1'],
    ['6to4 embedding 10.0.0.1', '2002:a00:1::1'],
    ['6to4 embedding 127.0.0.1', '2002:7f00:1::'],
    ['6to4 embedding 192.168.1.1', '2002:c0a8:101::1'],
    ['site-local fec0::/10', 'fec0::1'],
    ['site-local upper edge', 'feff::1'],
    ['documentation 2001:db8::/32', '2001:db8::1'],
    ['documentation 2001:db8 high', '2001:db8:ffff::1'],
  ])('rejects %s', (_label, ip) => {
    expect(() => assertOutboundUrl(`https://[${ip}]/`)).toThrow(/prohibited/)
  })

  it.each([
    ['IETF protocol assignments 192.0.0.0/24', '192.0.0.8'],
    ['TEST-NET-1 192.0.2.0/24', '192.0.2.10'],
    ['TEST-NET-2 198.51.100.0/24', '198.51.100.7'],
    ['TEST-NET-3 203.0.113.0/24', '203.0.113.200'],
  ])('rejects %s', (_label, ip) => {
    expect(() => assertOutboundUrl(`https://${ip}/`)).toThrow(/prohibited/)
  })

  it.each([
    ['6to4 embedding a public IPv4', '2002:808:808::1'],
    ['NAT64 local-use embedding a public IPv4', '64:ff9b:1::808:808'],
    ['adjacent to 2001:db8', '2001:db9::1'],
    ['adjacent to 192.0.2/24', '192.0.3.1'],
    ['adjacent to 198.51.100/24', '198.51.101.1'],
    ['adjacent to 203.0.113/24', '203.0.114.1'],
  ])('allows %s', (_label, ip) => {
    expect(assertOutboundUrl(ip.includes(':') ? `https://[${ip}]/` : `https://${ip}/`).protocol).toBe('https:')
  })

  it('DNS answers in the new ranges are refused at connect', async () => {
    for (const address of ['2002:a00:1::1', '64:ff9b:1::a00:1', 'fec0::1', '2001:db8::1']) {
      await expect(resolvePolicyAddresses('x.public.test', false, async () => [v6(address)])).rejects.toBeInstanceOf(OutboundPolicyError)
    }
    for (const address of ['192.0.0.8', '192.0.2.1', '198.51.100.1', '203.0.113.1']) {
      await expect(resolvePolicyAddresses('x.public.test', false, async () => [v4(address)])).rejects.toBeInstanceOf(OutboundPolicyError)
    }
  })

  it('6to4 is not treated as direct loopback by the local profile', () => {
    expect(() => assertOutboundUrl('http://[2002:7f00:1::]/', { allowLoopbackHttp: true })).toThrow()
  })
})

describe('RH1-C: literal prohibited URLs never reach the network', () => {
  it.each([
    'https://10.0.0.5/mcp',
    'https://169.254.169.254/latest',
    'https://[::ffff:a00:1]/',
    'https://[64:ff9b::7f00:1]/',
    'http://cdn.public.test/plain',
    'https://user:pw@cdn.public.test/',
    'file:///etc/passwd',
  ])('%s is refused before any send or DNS lookup', async (url) => {
    const resolver = resolverOf({})
    let sent = 0
    const http = transport(resolver, { sender: async () => { sent += 1; return new Response('') as unknown as OutboundResponse } })
    await expect(http.request(url)).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(sent).toBe(0)
    expect(resolver.asked).toEqual([])
  })

  it('a loopback literal without the local profile is refused; with it, the fixture answers', async () => {
    const server = await fixture((_req, res) => res.end('local ok'))
    const http = transport(resolverOf({}))
    await expect(http.request(`${server.origin}/`)).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(server.connections).toBe(0)
    const response = await http.request(`${server.origin}/`, { allowLoopback: true })
    expect(await response.text()).toBe('local ok')
    expect(server.connections).toBe(1)
  })

  it('sends redirect: manual and returns the 3xx to the caller unfollowed', async () => {
    const target = await fixture()
    const server = await fixture((_req, res) => { res.writeHead(302, { location: `${target.origin}/next` }); res.end() })
    const http = transport(resolverOf({}))
    const response = await http.request(`${server.origin}/`, { allowLoopback: true })
    expect(response.status).toBe(302)
    await response.body?.cancel()
    expect(target.connections).toBe(0)
  })
})

describe('RH1-D: redirects and credentials', () => {
  it('MCP POST does not follow a redirect toward another server', async () => {
    const internal = await fixture()
    const mcp = await fixture((_req, res) => { res.writeHead(307, { location: `${internal.origin}/admin` }); res.end() })
    const http = transport(resolverOf({}))
    const client = new McpServerClient('fx', { name: 'fx', transport: 'http', url: `${mcp.origin}/mcp`, enabled: true }, { bearerToken: 'secret-token' }, () => {}, { outboundHttp: http })
    open.push({ close: () => client.disconnect() })
    await expect(client.listTools()).rejects.toThrow(/redirect/)
    expect(mcp.requests).toEqual(['POST /mcp'])
    expect(internal.connections).toBe(0)
  })

  it('OAuth token exchange does not follow a redirect and keeps the grant temporary-safe', async () => {
    const internal = await fixture()
    const as = await fixture((_req, res) => { res.writeHead(302, { location: `${internal.origin}/steal` }); res.end() })
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { randomBytes } = await import('node:crypto')
    const home = await mkdtemp(path.join(tmpdir(), 'dnt-rh1-oauth-'))
    open.push({ close: () => rm(home, { recursive: true, force: true }) })
    const store = new OAuthStore(home, randomBytes(32))
    const oauth = new ManagedOAuth(store, transport(resolverOf({})))
    const { state } = await oauth.begin({ workspaceId: 'ws', server: 'remote', principalId: 'p', resource: `${as.origin}/mcp`, authorizationEndpoint: `${as.origin}/authorize`, tokenEndpoint: `${as.origin}/token`, clientId: 'c', redirectUri: 'http://127.0.0.1:4317/cb', scopes: [] })
    await oauth.deposit(state, 'code')
    await expect(oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' })).rejects.toThrow(/redirected/)
    expect(as.requests).toEqual(['POST /token'])
    expect(internal.connections).toBe(0)
  })

  it('a media redirect from the configured origin to a private foreign origin is not sent', async () => {
    const privateTarget = await fixture()
    const provider = await fixture((_req, res) => { res.writeHead(302, { location: `${privateTarget.origin}/x.png` }); res.end() })
    const http = transport(resolverOf({}))
    const credentials = (url: URL) => url.origin === provider.origin ? { authorization: 'Bearer sk-provider' } : {}
    await expect(fetchMedia(`${provider.origin}/v1/files/a.png`, `${provider.origin}/v1`, { gateway: fetch, http }, AbortSignal.timeout(5_000), credentials))
      .rejects.toThrow(/refusing media url/)
    expect(provider.headers[0]?.['authorization']).toBe('Bearer sk-provider')
    expect(privateTarget.connections).toBe(0)
  })

  it('a foreign hop that redirects back to the configured private origin is refused', async () => {
    const provider = await fixture()
    // The foreign CDN is a public-looking name whose (fixture) answer is public; the send is the seam.
    const hops: Array<{ url: string; authorization: string | null }> = []
    const http = transport(resolverOf({ 'cdn.public.test': [v4('93.184.216.34')] }), {
      sender: async (url, init) => {
        hops.push({ url: url.href, authorization: init.headers['authorization'] ?? null })
        return new Response(null, { status: 302, headers: { location: `${provider.origin}/v1/files/a.png` } }) as unknown as OutboundResponse
      },
    })
    const credentials = (url: URL) => url.origin === provider.origin ? { authorization: 'Bearer sk-provider' } : {}
    await expect(fetchMedia('https://cdn.public.test/a.png', `${provider.origin}/v1`, { gateway: fetch, http }, AbortSignal.timeout(5_000), credentials))
      .rejects.toThrow(/refusing media url/)
    expect(hops).toEqual([{ url: 'https://cdn.public.test/a.png', authorization: null }])
    expect(provider.connections).toBe(0)
  })
})

describe('RH1-E: abort and deadline settle the transport', () => {
  it('caller abort before headers rejects and closes the socket', async () => {
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => { closed = resolve })
    const server = await fixture((req) => { req.socket.on('close', () => closed()) })
    const http = transport(resolverOf({}))
    const controller = new AbortController()
    const pending = http.request(`${server.origin}/hang`, { allowLoopback: true, signal: controller.signal })
    await expect.poll(() => server.requests.length).toBe(1)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await socketClosed
  })

  it('caller abort during the body errors the stream (signal survives headers)', async () => {
    const server = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n') })
    const http = transport(resolverOf({}))
    const controller = new AbortController()
    const response = await http.request(`${server.origin}/sse`, { allowLoopback: true, signal: controller.signal })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('data: one')
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
  })

  it('the internal deadline also bounds the body, not only the headers', async () => {
    const server = await fixture((_req, res) => { res.writeHead(200); res.write('partial') })
    const http = transport(resolverOf({}))
    const started = Date.now()
    const response = await http.request(`${server.origin}/slow`, { allowLoopback: true, timeoutMs: 300 })
    await expect(response.text()).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('an already-aborted signal sends nothing', async () => {
    const server = await fixture()
    const http = transport(resolverOf({}))
    const controller = new AbortController()
    controller.abort()
    let sent = false
    await expect(http.request(`${server.origin}/`, { allowLoopback: true, signal: controller.signal, onSend: () => { sent = true } })).rejects.toThrow()
    expect(sent).toBe(false)
    expect(server.connections).toBe(0)
  })

  it('onSend fires only after the connect-time policy passed', async () => {
    const server = await fixture()
    const http = transport(resolverOf({ 'api.public.test': [v4('127.0.0.1')], localhost: [v4('127.0.0.1')] }))
    let refused = 0
    await expect(http.request(`https://api.public.test:${server.port}/`, { onSend: () => { refused += 1 } })).rejects.toBeInstanceOf(OutboundPolicyError)
    expect(refused).toBe(0)
    let allowed = 0
    await (await http.request(`http://localhost:${server.port}/`, { allowLoopback: true, onSend: () => { allowed += 1 } })).text()
    expect(allowed).toBe(1)
  })

  it('close() destroys sockets still busy after the grace period', async () => {
    const server = await fixture((_req, res) => { res.writeHead(200); res.write('streaming') })
    const http = new OutboundHttp({ resolver: resolverOf({}) })
    const response = await http.request(`http://127.0.0.1:${server.port}/`, { allowLoopback: true })
    const reader = response.body!.getReader()
    await reader.read()
    const started = Date.now()
    await http.close(100)
    expect(Date.now() - started).toBeLessThan(3_000)
    await expect(reader.read()).rejects.toThrow()
  })

  it('close() shuts both pools and later requests fail closed', async () => {
    const server = await fixture()
    const http = new OutboundHttp({ resolver: resolverOf({}) })
    await (await http.request(`${server.origin}/`, { allowLoopback: true })).text()
    await http.close()
    await expect(http.request(`${server.origin}/`, { allowLoopback: true })).rejects.toBeInstanceOf(OutboundTransportUnavailableError)
    expect(server.connections).toBe(1)
  })
})

describe('bodies are bounded and released on every failure path', () => {
  /** A fixture whose response body is observed: resolves when the client drops the socket. */
  async function watched(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    let dropped!: () => void
    const closed = new Promise<void>((resolve) => { dropped = resolve })
    const server = await fixture((req, res) => { res.on('close', () => dropped()); handler(req, res) })
    return { server, closed }
  }

  it('M2: an unusable MCP session id cancels the body before failing', async () => {
    const { server, closed } = await watched((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'x'.repeat(10_000) })
      res.write('{"jsonrpc":"2.0",') // never finished: only a cancel releases it
    })
    const client = new McpServerClient('fx', { name: 'fx', transport: 'http', url: `${server.origin}/mcp`, enabled: true }, {}, () => {}, { outboundHttp: transport(resolverOf({})) })
    open.push({ close: () => client.disconnect() })
    await expect(client.listTools()).rejects.toThrow(/session id/)
    await closed
  })

  it('M3: a chunked media body over the cap is cancelled mid-stream', async () => {
    const { server, closed } = await watched((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' }) // chunked: no content-length
      res.write(Buffer.alloc(64 * 1024))
      res.write(Buffer.alloc(64 * 1024)) // and then hangs open
    })
    const { generateImageTool } = await import('../../src/harness/tools/image-tools.ts')
    const tool = generateImageTool({
      // Configured (local) provider origin: the download is same-origin and streams through the gateway fetch.
      resolve: () => ({ ok: true, config: { baseUrl: `${server.origin}/v1`, apiKey: '', model: 'm' } }),
      fetch: (async (input: string, init?: RequestInit) => input.endsWith('/images/generations')
        ? Response.json({ data: [{ url: `${server.origin}/v1/big.png` }] })
        : fetch(input, init)) as unknown as typeof fetch,
      outboundHttp: transport(resolverOf({})),
      maxBytes: 1024,
      store: async () => { throw new Error('must not store') },
      read: async () => { throw new Error('unused') },
      resolvePath: async () => { throw new Error('unused') },
    })
    await expect(tool.execute({ prompt: 'x' }, { root: '/tmp', workspaceId: 'ws' })).rejects.toThrow(/exceeds the limit of 1024 bytes/)
    expect(server.requests).toEqual(['GET /v1/big.png'])
    await closed
  })

  async function tokenFlow(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const as = await fixture(handler)
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { randomBytes } = await import('node:crypto')
    const home = await mkdtemp(path.join(tmpdir(), 'dnt-rh1-token-'))
    open.push({ close: () => rm(home, { recursive: true, force: true }) })
    const oauth = new ManagedOAuth(new OAuthStore(home, randomBytes(32)), transport(resolverOf({})))
    const { state } = await oauth.begin({ workspaceId: 'ws', server: 'remote', principalId: 'p', resource: `${as.origin}/mcp`, authorizationEndpoint: `${as.origin}/authorize`, tokenEndpoint: `${as.origin}/token`, clientId: 'c', redirectUri: 'http://127.0.0.1:4317/cb', scopes: [] })
    await oauth.deposit(state, 'code')
    return oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' }).then(() => undefined, (error: unknown) => error)
  }

  it('M3: an oversize token response is refused and cancelled, not buffered', async () => {
    let dropped!: () => void
    const closed = new Promise<void>((resolve) => { dropped = resolve })
    const error = await tokenFlow((_req, res) => {
      res.on('close', () => dropped())
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(`{"access_token":"${'a'.repeat(70 * 1024)}`) // over 64 KiB, never ends
    })
    expect(String(error)).toMatch(/too large/)
    await closed
  })

  it('M3: a token body that fails after 200 is temporary, not a permanent rejection', async () => {
    const { OAuthTemporaryError } = await import('../../src/harness/mcp/oauth.ts')
    const error = await tokenFlow((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"access_token":')
      setTimeout(() => req.socket.destroy(), 20)
    })
    expect(error).toBeInstanceOf(OAuthTemporaryError)
  })
})

describe('RH1-F: production wiring has no policy bypass', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []
  })
  const policyOwned = [
    ...files(path.join(ROOT, 'src/harness/mcp')),
    path.join(ROOT, 'src/web/mcp-oauth-connect.ts'),
    path.join(ROOT, 'src/harness/tools/image-tools.ts'),
    path.join(ROOT, 'src/harness/tools/video-tools.ts'),
  ]

  it('policy-owned modules never value-import bare undici or call global fetch for policy traffic', () => {
    for (const file of policyOwned) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/^import (?!type )[^\n]*from 'undici'/m)
      expect(text, file).not.toMatch(/fetchImpl\s*===\s*fetch/)
      if (file.includes(`${path.sep}mcp${path.sep}`) || file.endsWith('mcp-oauth-connect.ts')) {
        expect(text, file).not.toMatch(/(?<![.\w])fetch\(/)
      }
    }
  })

  it('production code never constructs a transport with an injected sender or loader', () => {
    for (const file of files(path.join(ROOT, 'src'))) {
      if (file.endsWith(`${path.sep}outbound-http.ts`)) continue
      const text = readFileSync(file, 'utf8')
      // A sender/loader/resolver can only enter through the constructor.
      expect(text, file).not.toMatch(/new OutboundHttp\(/)
      expect(text, file).not.toMatch(/fetchImpl/)
    }
  })

  it('production server wiring does not pass a raw fetch to ManagedOAuth', () => {
    const server = readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    expect(server).not.toMatch(/new ManagedOAuth\([^,]+,\s*fetch\b/)
  })
})

describe('RH1-A under Bun: the production module, without Vitest', () => {
  it('the Bun probe proves blocked destinations receive zero requests', () => {
    let bun: string
    try { bun = bunExecutable() } catch { return expect.fail('Bun 1.4.3 is required for the RH-1 probe (set DNT_BUN_EXECUTABLE)') }
    const run = spawnSync(bun, [path.join(ROOT, 'scripts/outbound-http-probe.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    expect(run.stdout + run.stderr).toMatch(/probes passed/)
    expect(run.status, run.stdout + run.stderr).toBe(0)
  }, 90_000)
})
