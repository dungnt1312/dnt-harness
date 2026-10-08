/**
 * Runtime resilience of the MCP client against real processes and sockets:
 * a crashed stdio server is reconnected instead of timing out forever, a
 * multibyte character split across chunks survives, JSON-RPC errors reach
 * the caller, Streamable HTTP follows the 2025-06-18 session/version rules,
 * a rejected bearer token is replaced on the next request, and an SSE
 * stream is closed once its result arrived.
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedOAuth, McpDispatchError, McpServerClient, OAuthStore } from 'dnt-harness'

const stdioFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))
const servers: Server[] = []
const clients: McpServerClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect().catch(() => undefined)
  for (const server of servers) server.closeAllConnections()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function stdioClient(args: readonly string[], env: Record<string, string> = {}, timeoutMs = 3_000): McpServerClient {
  const client = new McpServerClient('fx', { name: 'fx', transport: 'stdio', command: process.execPath, args, env, enabled: true, timeoutMs } as never, { env }, () => {})
  clients.push(client)
  return client
}

/** The pid of the live stdio child, read through the test-only accessor. */
function childPid(client: McpServerClient): number {
  const pid = (client as unknown as { transport?: { child?: { pid?: number } } }).transport?.child?.pid
  if (pid === undefined) throw new Error('no live child')
  return pid
}

describe('stdio crash recovery', () => {
  it('a crashed server is respawned on the next call instead of timing out', async () => {
    const client = stdioClient([stdioFixture])
    await client.listTools()
    const first = childPid(client)
    process.kill(-first, 'SIGKILL')
    await expect.poll(() => client.state).toBe('failed')
    const started = Date.now()
    const result = await client.callTool('query', { q: 'again' }, 3_000)
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(JSON.stringify(result.content)).toContain('result:again')
    expect(childPid(client)).not.toBe(first)
    expect(client.state).toBe('ready')
  }, 15_000)

  it('a server that dies during a call settles that call at once as possibly dispatched', async () => {
    const client = stdioClient([stdioFixture], {}, 10_000)
    await client.listTools()
    const pid = childPid(client)
    setTimeout(() => process.kill(-pid, 'SIGKILL'), 150)
    const started = Date.now()
    const failure = await client.callTool('hang', {}, 10_000).catch((error: unknown) => error)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect((failure as McpDispatchError).receipt.kind).toBe('possibly_dispatched')
  }, 15_000)

  it('listTools reconnects between retries instead of retrying a dead transport', async () => {
    const client = stdioClient([stdioFixture])
    await client.listTools()
    process.kill(-childPid(client), 'SIGKILL')
    await expect.poll(() => client.state).toBe('failed')
    expect((await client.listTools()).map((tool) => tool.name)).toContain('query')
  }, 15_000)
})

describe('stdio framing and diagnostics', () => {
  it('keeps a multibyte character split across two stdout chunks', async () => {
    // Writes a result whose UTF-8 bytes are split in the middle of "ệ".
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin })
      const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })
        if (msg.method === 'tools/list') return out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'say', inputSchema: { type: 'object' } }] } })
        if (msg.method === 'tools/call') {
          const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Tiếng Việt' }] } }) + '\\n')
          const cut = bytes.indexOf(Buffer.from('ệ')) + 1
          process.stdout.write(bytes.subarray(0, cut))
          setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50)
        }
      })`
    const client = stdioClient(['-e', script])
    const result = await client.callTool('say', {}, 3_000)
    expect(JSON.stringify(result.content)).toContain('Tiếng Việt')
  }, 15_000)

  it('a JSON-RPC error reaches the caller with its code and message, as a known error outcome', async () => {
    const client = stdioClient([stdioFixture])
    const result = await client.callTool('no-such-tool', {}, 3_000)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('-32601')
    expect(JSON.stringify(result.content)).toContain('unknown tool no-such-tool')
    expect(client.state).toBe('ready')
  }, 15_000)

  it('keeps a redacted tail of the server stderr for diagnostics', async () => {
    const script = `process.stderr.write('boot failed: token=SECRET-VALUE-123 missing\\n'); setTimeout(() => process.exit(3), 50)`
    const client = new McpServerClient('fx', { name: 'fx', transport: 'stdio', command: process.execPath, args: ['-e', script], env: { TOKEN: 'SECRET-VALUE-123' }, enabled: true } as never, { env: { TOKEN: 'SECRET-VALUE-123' } }, () => {})
    clients.push(client)
    await expect(client.listTools()).rejects.toThrow()
    expect(client.recentStderr()).toContain('boot failed')
    expect(client.recentStderr()).not.toContain('SECRET-VALUE-123')
  }, 15_000)
})

interface Rpc { readonly id?: number; readonly method: string; readonly params?: { readonly name?: string } }

async function httpFixture(handle: (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => boolean = () => false): Promise<{ url: string; seen: { rpc: Rpc; headers: IncomingMessage['headers'] }[] }> {
  const seen: { rpc: Rpc; headers: IncomingMessage['headers'] }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (req.method !== 'POST') { res.statusCode = 204; res.end(); return }
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc
    seen.push({ rpc, headers: req.headers })
    if (handle(rpc, req, res)) return
    if (rpc.id === undefined) { res.statusCode = 202; res.end(); return }
    const reply = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    }
    if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    if (rpc.method === 'tools/list') return reply({ tools: [{ name: 'alpha', inputSchema: { type: 'object' } }] })
    return reply({ content: [{ type: 'text', text: 'ok' }], isError: false })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, seen }
}

function httpClient(url: string, resolved: Record<string, unknown> = {}): McpServerClient {
  const client = new McpServerClient('remote', { name: 'remote', transport: 'http', url, enabled: true, timeoutMs: 3_000 } as never, resolved as never, () => {})
  clients.push(client)
  return client
}

describe('Streamable HTTP 2025-06-18 rules', () => {
  it('sends MCP-Protocol-Version on every request after initialize', async () => {
    const { url, seen } = await httpFixture()
    const client = httpClient(url)
    await client.listTools()
    await client.callTool('alpha', {}, 3_000)
    const after = seen.filter((entry) => entry.rpc.method !== 'initialize')
    expect(after.length).toBeGreaterThan(1)
    for (const entry of after) expect(entry.headers['mcp-protocol-version']).toBe('2025-06-18')
  })

  it('a 404 for an expired session is not dispatched and the next call starts a new session', async () => {
    let expired = false
    let initializes = 0
    const { url, seen } = await httpFixture((rpc, req, res) => {
      if (rpc.method === 'initialize') { initializes += 1; expired = false; return false }
      if (expired && req.headers['mcp-session-id'] !== undefined && rpc.id !== undefined) {
        res.statusCode = 404
        res.end()
        return true
      }
      return false
    })
    const client = httpClient(url)
    await client.listTools()
    expired = true
    const failure = await client.callTool('alpha', {}, 3_000).catch((error: unknown) => error)
    expect((failure as McpDispatchError).receipt).toEqual({ kind: 'not_dispatched', reason: 'session_expired' })
    const result = await client.callTool('alpha', {}, 3_000)
    expect(result.isError).toBe(false)
    expect(initializes).toBe(2)
    expect(seen.filter((entry) => entry.rpc.method === 'tools/call')).toHaveLength(2)
  })

  it('takes the bearer token per request and asks for a fresh one after a 401', async () => {
    let accepted = 'token-1'
    const asked: (string | undefined)[] = []
    const { url } = await httpFixture((rpc, req, res) => {
      if (rpc.id === undefined) return false
      if (req.headers.authorization !== `Bearer ${accepted}`) {
        res.statusCode = 401
        res.end()
        return true
      }
      return false
    })
    let issued = 1
    const client = httpClient(url, {
      tokenSource: async (rejected?: string) => {
        asked.push(rejected)
        if (rejected !== undefined) issued += 1
        return `token-${issued}`
      },
    })
    await client.listTools()
    accepted = 'token-2' // the server revoked token-1 while the client lives
    const failure = await client.callTool('alpha', {}, 3_000).catch((error: unknown) => error)
    expect((failure as McpDispatchError).receipt).toEqual({ kind: 'not_dispatched', reason: 'auth_rejected' })
    const result = await client.callTool('alpha', {}, 3_000)
    expect(result.isError).toBe(false)
    expect(asked).toContain('token-1')
  })

  it('closes an SSE stream once its result arrived, even if the server keeps it open', async () => {
    let closed = false
    const { url } = await httpFixture((rpc, _req, res) => {
      if (rpc.method !== 'tools/call') return false
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [], isError: false } })}\n\n`)
      res.on('close', () => { closed = true })
      return true // never ends the response
    })
    const client = httpClient(url)
    await client.callTool('alpha', {}, 3_000)
    await expect.poll(() => closed, { timeout: 2_000 }).toBe(true)
  })
})

describe('managed OAuth recovery', () => {
  async function tokenServer(respond: (res: ServerResponse) => void): Promise<string> {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) void _chunk
      respond(res)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/token`
  }

  async function storeWith(phase: 'refresh_in_progress' | 'active', tokenEndpoint: string, expiresAt: number): Promise<{ store: OAuthStore; home: string }> {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-recovery-'))
    const store = new OAuthStore(home, randomBytes(32))
    await store.saveTokens('ws', 'remote', { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt, tokenEndpoint, clientId: 'client', phase, resource: 'http://127.0.0.1/mcp' })
    return { store, home }
  }

  it('a refresh left in progress by a crash is resumed, not stuck forever', async () => {
    const endpoint = await tokenServer((res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })) })
    const { store, home } = await storeWith('refresh_in_progress', endpoint, Date.now() - 1_000)
    try {
      await expect(new ManagedOAuth(store).accessToken('ws', 'remote')).resolves.toBe('new-access')
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('active')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('a transient token endpoint failure keeps the grant usable; a rejected grant needs authorization', async () => {
    let status = 503
    const endpoint = await tokenServer((res) => { res.statusCode = status; res.end('{"error":"invalid_grant"}') })
    const { store, home } = await storeWith('active', endpoint, Date.now() - 1_000)
    try {
      const oauth = new ManagedOAuth(store)
      await expect(oauth.accessToken('ws', 'remote')).rejects.toThrow(/temporar/)
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('active')
      status = 400
      await expect(oauth.accessToken('ws', 'remote')).resolves.toBeUndefined()
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('auth_required')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('a token rejected by the server is refreshed once, even when two callers report it', async () => {
    let exchanges = 0
    const endpoint = await tokenServer((res) => { exchanges += 1; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: `access-${exchanges}`, refresh_token: 'r', expires_in: 3600 })) })
    const { store, home } = await storeWith('active', endpoint, Date.now() + 3_600_000)
    try {
      const oauth = new ManagedOAuth(store)
      const [a, b] = await Promise.all([oauth.replaceRejected('ws', 'remote', 'old-access'), oauth.replaceRejected('ws', 'remote', 'old-access')])
      expect(a).toBe('access-1')
      expect(b).toBe('access-1')
      expect(exchanges).toBe(1)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
