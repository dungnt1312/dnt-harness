/**
 * Transport limits and lifecycle against real sockets and processes: a
 * decompression bomb stays bounded, every discovery path sees the same
 * paginated tool set, a list_changed storm coalesces, a redirected call is
 * never re-sent, abort listeners never outlive their request, and concurrent
 * connects share one transport.
 */
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { McpDispatchError, McpServerClient } from 'mini-dsh'

const stdioFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))
const servers: Server[] = []
const clients: McpServerClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect().catch(() => undefined)
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

interface Rpc { readonly id?: number; readonly method: string; readonly params?: { readonly name?: string; readonly cursor?: string } }
type Handler = (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => boolean

const PAGE_ONE = [{ name: 'alpha', inputSchema: { type: 'object' } }, { name: 'beta', inputSchema: { type: 'object' } }]
const PAGE_TWO = [{ name: 'gamma', inputSchema: { type: 'object' } }]

/** A minimal Streamable HTTP MCP server with two tools/list pages. */
async function httpFixture(extra: Handler = () => false): Promise<{ url: string; seen: Rpc[] }> {
  const seen: Rpc[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (req.method !== 'POST') { res.statusCode = 204; res.end(); return }
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc
    seen.push(rpc)
    const reply = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    }
    if (rpc.id === undefined) { res.statusCode = 202; res.end(); return }
    if (extra(rpc, req, res)) return
    if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } })
    if (rpc.method === 'tools/list') return reply(rpc.params?.cursor === 'page-2' ? { tools: PAGE_TWO } : { tools: PAGE_ONE, nextCursor: 'page-2' })
    if (rpc.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'ok' }], isError: false })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no' } }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen }
}

function httpClient(url: string, extra: Record<string, unknown> = {}, bearerToken?: string): McpServerClient {
  const client = new McpServerClient('http-fixture', { name: 'http-fixture', transport: 'http', url, enabled: true, timeoutMs: 5_000, ...extra } as never, bearerToken !== undefined ? { bearerToken } : {}, () => {}, { healthIntervalMs: 60 })
  clients.push(client)
  return client
}

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''))
}

describe('Streamable HTTP limits', () => {
  it('refuses a gzip body that inflates past the decoded limit instead of buffering it', async () => {
    // ~20 MB of JSON compresses to a few kilobytes.
    const bomb = gzipSync(Buffer.from(`{"jsonrpc":"2.0","id":3,"result":{"content":"${' '.repeat(20_000_000)}"}}`))
    expect(bomb.byteLength).toBeLessThan(100_000)
    const { url } = await httpFixture((rpc, _req, res) => {
      if (rpc.method !== 'tools/call') return false
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(bomb)
      return true
    })
    const client = httpClient(url)
    await expect(client.callTool('alpha', {}, 5_000)).rejects.toThrow(/decoded limit/)
  })

  it('every discovery path sees the whole paginated tool set, not the first page', async () => {
    const { url } = await httpFixture((rpc, _req, res) => {
      if (rpc.method !== 'tools/call' || rpc.params?.name !== 'announce') return false
      sse(res, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, { jsonrpc: '2.0', id: rpc.id, result: { content: [], isError: false } }])
      return true
    })
    const client = httpClient(url)
    const all = ['alpha', 'beta', 'gamma']
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(all)

    // Health check path.
    client.startHealthChecks(async () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(client.cachedTools().map((tool) => tool.name)).toEqual(all)

    // list_changed path.
    const before = client.toolRefreshes
    await client.callTool('announce', {}, 5_000)
    await expect.poll(() => client.toolRefreshes).toBeGreaterThan(before)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.cachedTools().map((tool) => tool.name)).toEqual(all)
  })

  it('a list_changed storm runs one refresh plus one coalesced follow-up', async () => {
    const { url, seen } = await httpFixture((rpc, _req, res) => {
      if (rpc.method !== 'tools/call' || rpc.params?.name !== 'storm') return false
      const storm = Array.from({ length: 200 }, () => ({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
      sse(res, [...storm, { jsonrpc: '2.0', id: rpc.id, result: { content: [], isError: false } }])
      return true
    })
    const client = httpClient(url)
    await client.listTools()
    const listedBefore = seen.filter((rpc) => rpc.method === 'tools/list').length
    await client.callTool('storm', {}, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(client.toolRefreshes).toBeLessThanOrEqual(2)
    // Each refresh walks both pages; 200 notifications cost at most two walks.
    expect(seen.filter((rpc) => rpc.method === 'tools/list').length - listedBefore).toBeLessThanOrEqual(4)
  })

  it('a redirected call is possibly dispatched, never followed, and never re-sent with credentials', async () => {
    const elsewhere = await httpFixture()
    const { url, seen } = await httpFixture((rpc, _req, res) => {
      if (rpc.method !== 'tools/call') return false
      res.writeHead(307, { location: elsewhere.url })
      res.end()
      return true
    })
    const client = httpClient(url, {}, 'secret-token')
    const failure = await client.callTool('alpha', {}, 5_000).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpDispatchError)
    expect((failure as McpDispatchError).receipt).toEqual({ kind: 'possibly_dispatched', reason: 'redirect_followed' })
    expect(seen.filter((rpc) => rpc.method === 'tools/call')).toHaveLength(1)
    expect(elsewhere.seen).toHaveLength(0)
  })

  it('abort listeners never outlive their request, on success, failure, or a dead server', async () => {
    const { url } = await httpFixture((rpc, _req, res) => {
      if (rpc.method !== 'tools/call' || rpc.params?.name !== 'broken') return false
      res.writeHead(500)
      res.end('boom')
      return true
    })
    const client = httpClient(url)
    const turn = new AbortController()
    await client.callTool('alpha', {}, 5_000, turn.signal)
    expect(getEventListeners(turn.signal, 'abort')).toHaveLength(0)
    await client.callTool('broken', {}, 5_000, turn.signal).catch(() => undefined)
    expect(getEventListeners(turn.signal, 'abort')).toHaveLength(0)
    for (const server of servers) server.closeAllConnections()
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    await client.callTool('alpha', {}, 1_000, turn.signal).catch(() => undefined)
    expect(getEventListeners(turn.signal, 'abort')).toHaveLength(0)
  })

  it('an already-stopped turn sends nothing and reports the call as not dispatched', async () => {
    const { url, seen } = await httpFixture()
    const client = httpClient(url)
    await client.listTools()
    const stopped = new AbortController()
    stopped.abort()
    const failure = await client.callTool('alpha', {}, 5_000, stopped.signal).catch((error: unknown) => error)
    expect((failure as McpDispatchError).receipt).toEqual({ kind: 'not_dispatched', reason: 'cancelled_before_send' })
    expect(seen.filter((rpc) => rpc.method === 'tools/call')).toHaveLength(0)
  })
})

describe('connect lifecycle', () => {
  it('concurrent first calls share one connect: one transport, one process', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-connect-storm-'))
    try {
      const spawned = path.join(home, 'spawned.log')
      const env = { INIT_FILE: spawned, INIT_DELAY_MS: '150' }
      const client = new McpServerClient('fixture', { name: 'fixture', transport: 'stdio', command: process.execPath, args: [stdioFixture], env, enabled: true } as never, { env }, () => {})
      clients.push(client)
      await Promise.all([
        ...Array.from({ length: 5 }, () => client.listTools()),
        ...Array.from({ length: 5 }, (_, index) => client.callTool('query', { q: String(index) }, 5_000)),
      ])
      expect(client.transportsStarted).toBe(1)
      expect((await fs.readFile(spawned, 'utf8')).trim().split('\n')).toHaveLength(1)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 20_000)
})
