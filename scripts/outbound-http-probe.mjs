#!/usr/bin/env bun
// RH-1 production-module probe. Imports src/harness/mcp/outbound-http.ts and
// its callers directly (no Vitest, no mocks, no aliases) and proves, against
// local sockets that count connections, that blocked destinations receive
// zero requests and the loopback fixture profile still works.
// Run: `bun scripts/outbound-http-probe.mjs` (also invoked by runtime-probes.mjs).
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const { OutboundHttp, OutboundTransportUnavailableError, loadRealUndici } = await import('../src/harness/mcp/outbound-http.ts')
const { OutboundPolicyError } = await import('../src/harness/mcp/outbound-policy.ts')
const { McpServerClient } = await import('../src/harness/mcp/client.ts')
const { ManagedOAuth } = await import('../src/harness/mcp/oauth.ts')
const { OAuthStore } = await import('../src/harness/mcp/oauth-store.ts')
const { discoverOAuth } = await import('../src/harness/mcp/oauth-discovery.ts')
const { fetchMedia } = await import('../src/harness/tools/image-tools.ts')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const cleanup = []

async function fixture(handler = (_req, res) => res.end('ok')) {
  const state = { connections: 0, requests: [] }
  const server = createServer((req, res) => { state.requests.push(`${req.method} ${req.url}`); handler(req, res) })
  server.on('connection', () => { state.connections += 1 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = server.address().port
  state.origin = `http://127.0.0.1:${state.port}`
  cleanup.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }))
  return state
}
const scoped = (answers) => async (hostname) => {
  const found = answers[hostname]
  if (found === undefined) throw new Error(`ENOTFOUND ${hostname}`)
  return found
}
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

console.log(JSON.stringify({ runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}` }))

try {
  // Real Undici loaded by resolved entry, never Bun's shim.
  const real = await loadRealUndici()
  record('real Undici fetch is not the runtime native fetch', real.fetch !== globalThis.fetch && !/\[native code\]/.test(Function.prototype.toString.call(real.fetch)))

  // Bare-specifier regression: under Bun, `undici` is the native shim; the transport must refuse it.
  if (process.versions.bun) {
    const bare = await import('undici')
    const server = await fixture()
    const http = new OutboundHttp({ loader: async () => bare })
    const outcome = await settle(http.request(`${server.origin}/`, { allowLoopback: true }))
    record("bare 'undici' (Bun shim) fails closed with zero requests", outcome.error instanceof OutboundTransportUnavailableError && server.connections === 0, `${outcome.error?.message ?? 'request succeeded'}; connections=${server.connections}`)
  }

  const http = new OutboundHttp({ resolver: scoped({ localhost: [{ address: '127.0.0.1', family: 4 }], 'api.public.test': [{ address: '127.0.0.1', family: 4 }], 'mixed.public.test': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }) })
  cleanup.push(() => http.close())

  {
    const server = await fixture((_req, res) => res.end('loopback ok'))
    const response = await http.request(`http://localhost:${server.port}/`, { allowLoopback: true })
    const text = await response.text()
    record('allowed loopback-profile request works (hostname, connect-time lookup)', text === 'loopback ok' && server.connections === 1, `body=${text}`)
  }
  {
    // Real system resolver: localhost is often [::1, 127.0.0.1]; the fixture is IPv4-only.
    const server = await fixture((_req, res) => res.end('system localhost'))
    const system = new OutboundHttp()
    cleanup.push(() => system.close())
    const outcome = await settle(system.request(`http://localhost:${server.port}/`, { allowLoopback: true }).then((r) => r.text()))
    record('system resolver localhost reaches an IPv4-only fixture (falls back across vetted answers)', outcome.value === 'system localhost', String(outcome.value ?? outcome.error?.message))
  }
  {
    const server = await fixture((_req, res) => res.end('fallback ok'))
    const v6first = new OutboundHttp({ resolver: scoped({ localhost: [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }] }) })
    cleanup.push(() => v6first.close())
    const outcome = await settle(v6first.request(`http://localhost:${server.port}/`, { allowLoopback: true }).then((r) => r.text()))
    record('injected [unreachable ::1, 127.0.0.1] falls back to the IPv4 fixture', outcome.value === 'fallback ok' && server.connections === 1, String(outcome.value ?? outcome.error?.message))
  }
  {
    const server = await fixture()
    let sent = 0
    const outcome = await settle(http.request(`https://api.public.test:${server.port}/`, { onSend: () => { sent += 1 } }))
    record('onSend does not fire when the connect-time policy refuses', outcome.error instanceof OutboundPolicyError && sent === 0, `onSend=${sent}`)
  }
  {
    const server = await fixture()
    const outcome = await settle(http.request(`https://api.public.test:${server.port}/`))
    record('public name resolving to loopback is blocked at connect (zero requests)', outcome.error instanceof OutboundPolicyError && server.connections === 0, `connections=${server.connections}`)
  }
  {
    const server = await fixture()
    const outcome = await settle(http.request(`https://mixed.public.test:${server.port}/`))
    record('mixed public/private DNS answers are blocked (zero requests)', outcome.error instanceof OutboundPolicyError && server.connections === 0, `connections=${server.connections}`)
  }
  {
    const server = await fixture()
    const outcome = await settle(http.request(`${server.origin}/`))
    record('literal loopback without the local profile is blocked pre-network', outcome.error instanceof OutboundPolicyError && server.connections === 0, `connections=${server.connections}`)
  }
  {
    const server = await fixture((_req, res) => { res.writeHead(200); res.write('data: one\n\n') })
    const controller = new AbortController()
    const response = await http.request(`${server.origin}/sse`, { allowLoopback: true, signal: controller.signal })
    const reader = response.body.getReader()
    const first = await reader.read()
    controller.abort()
    const after = await settle(reader.read())
    record('SSE streams and caller abort errors the body', new TextDecoder().decode(first.value).includes('data: one') && after.error !== undefined)
  }

  // Callers, through their production code paths.
  {
    const internal = await fixture()
    const mcp = await fixture((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
        const rpc = JSON.parse(body)
        if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'probe-session' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'probe', version: '1' } } : { tools: [] } }))
      })
    })
    const client = new McpServerClient('probe', { name: 'probe', transport: 'http', url: `${mcp.origin}/mcp`, enabled: true }, {}, () => {}, { outboundHttp: http })
    const tools = await settle(client.listTools())
    await client.disconnect()
    record('MCP POST + session DELETE via the policy transport (loopback profile)', tools.error === undefined && mcp.requests.includes('POST /mcp') && mcp.requests.includes('DELETE /mcp'), mcp.requests.join(', '))
    const redirecting = await fixture((_req, res) => { res.writeHead(307, { location: `${internal.origin}/admin` }); res.end() })
    const blocked = new McpServerClient('probe2', { name: 'probe2', transport: 'http', url: `${redirecting.origin}/mcp`, enabled: true }, { bearerToken: 'secret' }, () => {}, { outboundHttp: http })
    const outcome = await settle(blocked.listTools())
    await blocked.disconnect()
    record('MCP redirect is not followed (target receives zero requests)', outcome.error !== undefined && internal.connections === 0, `connections=${internal.connections}`)
  }
  {
    const outcome = await settle(discoverOAuth('https://10.0.0.5/mcp', { http }))
    record('OAuth discovery refuses a private literal before sending', /prohibited/.test(String(outcome.error?.message)))
    const server = await fixture()
    const viaName = await settle(discoverOAuth(`https://api.public.test:${server.port}/mcp`, { http }))
    record('OAuth discovery to a name resolving private is blocked at connect (zero requests)', viaName.error !== undefined && server.connections === 0, `connections=${server.connections}`)
  }
  {
    const internal = await fixture()
    const as = await fixture((_req, res) => { res.writeHead(302, { location: `${internal.origin}/steal` }); res.end() })
    const home = await mkdtemp(path.join(tmpdir(), 'dnt-rh1-probe-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const oauth = new ManagedOAuth(new OAuthStore(home, randomBytes(32)), http)
    const { state } = await oauth.begin({ workspaceId: 'ws', server: 'remote', principalId: 'p', resource: `${as.origin}/mcp`, authorizationEndpoint: `${as.origin}/authorize`, tokenEndpoint: `${as.origin}/token`, clientId: 'c', redirectUri: 'http://127.0.0.1:4317/cb', scopes: [] })
    await oauth.deposit(state, 'code')
    const outcome = await settle(oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' }))
    record('OAuth token exchange rejects a redirect (target receives zero requests)', /redirected/.test(String(outcome.error?.message)) && as.requests.length === 1 && internal.connections === 0, as.requests.join(', '))
  }
  {
    const privateTarget = await fixture()
    const provider = await fixture((_req, res) => { res.writeHead(302, { location: `${privateTarget.origin}/x.png` }); res.end() })
    const outcome = await settle(fetchMedia(`${provider.origin}/v1/a.png`, `${provider.origin}/v1`, { gateway: fetch, http }, AbortSignal.timeout(5_000)))
    record('media redirect to a private foreign origin is refused (zero requests)', /refusing media url/.test(String(outcome.error?.message)) && privateTarget.connections === 0, `connections=${privateTarget.connections}`)
  }
} catch (error) {
  record('probe crashed', false, String(error?.stack ?? error))
} finally {
  for (const close of cleanup.reverse()) await close().catch(() => undefined)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} probes passed`)
process.exit(failed.length === 0 ? 0 : 1)
