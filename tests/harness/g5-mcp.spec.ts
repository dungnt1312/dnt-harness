/**
 * G5 MCP production contracts: strict config, encrypted secrets, pinned
 * protocol lifecycle over stdio and Streamable HTTP, timeout/failure,
 * workspace naming and audit hashing.
 */
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_PROTOCOL_VERSION,
  McpConfigError,
  McpConfigStore,
  McpServerClient,
  McpTransportError,
  auditHash,
  mcpToolName,
  parseMcpConfig,
  importClaudeMcp,
  importCodexMcp,
  resolveSecretRefs,
} from 'dnt-harness'

let home = ''
const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g5-'))
})

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

describe('G5 config + secrets', () => {
  it('strictly validates server names/transports and never partially accepts junk', () => {
    expect(() => parseMcpConfig('{ nope')).toThrow(McpConfigError)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { 'bad name': { transport: 'stdio', command: 'x' } } }))).toThrow(/server name/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'socket' } } }))).toThrow(/stdio\|http/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'stdio', command: 'node', unknown: true } } }))).toThrow(/unknown key/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, extra: true, servers: {} }))).toThrow(/unknown top-level key/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'stdio', command: 'node', args: [1] } } }))).toThrow(/array of strings/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'http', url: 'https://x', auth: { type: 'bearer', token: 'plaintext' } } } }))).toThrow(/reference/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'stdio', command: 'x', timeoutMs: Infinity } } }))).toThrow(/positive/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'stdio', command: 'x', provenance: { importedFrom: 'other' } } } }))).toThrow(/claude\|codex/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'stdio', command: 'x', provenance: { importedFrom: 'claude', importedAt: 'now' } } } }))).toThrow(/finite number/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'http', url: 'https://x', auth: { type: 'bearer', token: '${TOKEN}', provider: 'nope' } } } }))).toThrow(/unknown bearer auth key/)
    expect(() => parseMcpConfig(JSON.stringify({ version: 1, servers: { x: { transport: 'http', url: 'https://x', auth: { type: 'oauth', provider: 'p', accessToken: '${TOKEN}', token: '${OTHER}' } } } }))).toThrow(/unknown oauth auth key/)
    expect(mcpToolName('notion', 'query')).toBe('mcp__notion__query')
  })

  it('encrypts secrets at rest; plaintext never appears in secrets.json', async () => {
    const store = new McpConfigStore(home)
    await store.saveSecrets('ws-secret', { API_KEY: 'super-secret-token', OTHER: 'two' })
    const raw = await fs.readFile(store.secretsPath('ws-secret'), 'utf8')
    expect(raw).not.toContain('super-secret-token')
    expect(raw).toContain('aes-256-gcm')
    expect(await store.loadSecrets('ws-secret')).toEqual({ API_KEY: 'super-secret-token', OTHER: 'two' })
    expect(resolveSecretRefs('Bearer ${API_KEY}', await store.loadSecrets('ws-secret'), 'test')).toBe('Bearer super-secret-token')
    expect(() => resolveSecretRefs('${MISSING}', {}, 'test')).toThrow(/not present/)
  })

  it('Claude/Codex imports record provenance and never auto-enable or spawn', () => {
    const claude = importClaudeMcp(JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'] } } }))
    expect(claude.servers.local?.enabled).toBe(false)
    expect(claude.servers.local?.provenance?.importedFrom).toBe('claude')
    const pinned = 'openai/codex@38cbebaf3fe3e81a94bf462079e7cf9659fc9e50'
    const codex = importCodexMcp('[mcp_servers.remote]\nurl = "https://example.test/mcp"', pinned)
    expect(codex.servers.remote?.enabled).toBe(false)
    expect(codex.servers.remote?.provenance?.importedFrom).toBe('codex')
    expect(() => importCodexMcp('[mcp_servers.x]\ncommand = "x"', 'other')).toThrow(/outside pinned adapter/)
  })

  it('audit hashes are stable and do not reveal raw secret text', () => {
    const hash = auditHash({ token: 'super-secret-token' })
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hash).not.toContain('secret')
    expect(auditHash({ token: 'super-secret-token' })).toBe(hash)
  })
})

describe('stdio MCP 2025-06-18 fixture', () => {
  function client(timeoutMs = 2_000): McpServerClient {
    return new McpServerClient('fixture', {
      name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true, timeoutMs,
    }, { env: { FIXTURE_ENV: 'x' } }, () => {})
  }

  it('initializes with the pinned protocol, lists tools, and calls one', async () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18')
    const mcp = client()
    const tools = await mcp.listTools()
    expect(tools.map((tool) => tool.name)).toContain('query')
    expect(tools.find((tool) => tool.name === 'query')?.readOnlyHint).toBe(true)
    expect(tools.find((tool) => tool.name === 'interactive')?.requiresUserInteraction).toBe(true)
    const result = await mcp.callTool('query', { q: 'hello' }, 2_000)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('result:hello')
    await mcp.disconnect()
    expect(mcp.state).toBe('disabled')
  }, 15_000)

  it('CPU delta watchdog kills sustained load but leaves an idle server alive', async () => {
    const burner = new McpServerClient('burner', {
      name: 'burner', transport: 'stdio', command: process.execPath, args: [fixture], env: { BURN_AFTER_LIST: '1' }, enabled: true,
      resourceLimits: { cpuPercent: 5, maxLifetimeMs: 10_000 },
    }, { env: { BURN_AFTER_LIST: '1' } }, () => {})
    await burner.listTools()
    // Sustained load is three consecutive over-limit samples (~3 s), then one kill.
    // Each Windows sample is a PowerShell probe, so allow for slow samples.
    await expect.poll(() => burner.watchdogKills, { timeout: 25_000, interval: 250 }).toBe(1)
    await expect(burner.callTool('query', { q: 'x' }, 500)).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(burner.watchdogKills).toBe(1)
    await burner.disconnect()

    const idle = new McpServerClient('idle', {
      name: 'idle', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true,
      resourceLimits: { cpuPercent: 80, maxLifetimeMs: 10_000 },
    }, {}, () => {})
    await idle.listTools()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const result = await idle.callTool('query', { q: 'still-alive' }, 1_000)
    expect(JSON.stringify(result.content)).toContain('still-alive')
    await idle.disconnect()
  }, 45_000)

  it('a short CPU burst is not sustained load: the watchdog leaves the server alive', async () => {
    const bursty = new McpServerClient('bursty', {
      name: 'bursty', transport: 'stdio', command: process.execPath, args: [fixture], env: { BURN_FOR_MS: '1200' }, enabled: true,
      resourceLimits: { cpuPercent: 5, maxLifetimeMs: 20_000 },
    }, { env: { BURN_FOR_MS: '1200' } }, () => {})
    try {
      await bursty.listTools()
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      expect(bursty.watchdogKills).toBe(0)
      const result = await bursty.callTool('query', { q: 'after-burst' }, 2_000)
      expect(JSON.stringify(result.content)).toContain('after-burst')
    } finally {
      await bursty.disconnect()
    }
  }, 30_000)

  it('a stdio server sees only platform basics and its explicit env, never unrelated host secrets', async () => {
    process.env['AMBIENT_SECRET_PROBE'] = 'must-not-leak'
    const probe = new McpServerClient('probe', {
      name: 'probe', transport: 'stdio', command: process.execPath, args: [fixture], env: { EXPLICIT_FOR_SERVER: 'yes' }, enabled: true,
    }, { env: { EXPLICIT_FOR_SERVER: 'yes' } }, () => {})
    try {
      const result = await probe.callTool('env', {}, 5_000)
      const keys = JSON.parse((result.content as { text: string }[])[0]!.text) as string[]
      expect(keys).toContain('EXPLICIT_FOR_SERVER')
      expect(keys).not.toContain('AMBIENT_SECRET_PROBE')
      expect(keys.some((key) => /api_key|token|secret/i.test(key) && key !== 'EXPLICIT_FOR_SERVER')).toBe(false)
    } finally {
      delete process.env['AMBIENT_SECRET_PROBE']
      await probe.disconnect()
    }
  }, 15_000)

  it('the secrets master key must be reachable by this user only; any other principal is refused', async () => {
    const { spawnSync } = await import('node:child_process')
    const { promises: fsp } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const pathModule = await import('node:path')
    const home = await fsp.mkdtemp(pathModule.join(tmpdir(), 'dnt-harness-master-key-'))
    try {
      await new McpConfigStore(home).saveSecrets('ws', { API_KEY: 'value' })
      expect(await new McpConfigStore(home).loadSecrets('ws')).toEqual({ API_KEY: 'value' })
      const key = pathModule.join(home, 'secrets.master.key')
      if (process.platform === 'win32') {
        // LOCAL SERVICE by SID: a principal no denylist of group names would
        // mention, and independent of the display language.
        expect(spawnSync('icacls', [key, '/grant', '*S-1-5-19:R'], { windowsHide: true }).status).toBe(0)
      } else {
        await fsp.chmod(key, 0o640)
      }
      await expect(new McpConfigStore(home).loadSecrets('ws')).rejects.toThrow(/not user-scoped|broader than 0600/)
      if (process.platform === 'win32') {
        expect(spawnSync('icacls', [key, '/remove:g', '*S-1-5-19'], { windowsHide: true }).status).toBe(0)
      } else {
        await fsp.chmod(key, 0o600)
      }
      expect(await new McpConfigStore(home).loadSecrets('ws')).toEqual({ API_KEY: 'value' })
    } finally {
      await fsp.rm(home, { recursive: true, force: true })
    }
  }, 60_000)

  it('isError stays truthful; timeout settles rather than hanging', async () => {
    const mcp = client(300)
    await mcp.listTools()
    const serverError = await mcp.callTool('explode', {}, 1_000)
    expect(serverError.isError).toBe(true)
    const start = Date.now()
    await expect(mcp.callTool('hang', {}, 150)).rejects.toThrow(/timed out/)
    expect(Date.now() - start).toBeLessThan(1_500)
    await mcp.disconnect()
  }, 15_000)
})

describe('Streamable HTTP transport fixture', () => {
  it('five failed calls open the circuit breaker; the recovery window permits reconnect', async () => {
    let failing = true
    let calls = 0
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.statusCode = 204; res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string }
      if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return }
      if (body.method === 'initialize') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }))
        return
      }
      if (body.method === 'tools/list') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'flaky', inputSchema: { type: 'object', properties: {} } }] } }))
        return
      }
      calls += 1
      if (failing) {
        res.statusCode = 500
        res.end('failed')
      } else {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: 'recovered', isError: false } }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('bad address')
    const audits: string[] = []
    const mcp = new McpServerClient(
      'breaker',
      { name: 'breaker', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true },
      {},
      (event) => audits.push(event.kind),
      { breakerDurationMs: 100, healthIntervalMs: 50, reconnectJitterMs: 10 },
    )
    await mcp.listTools()
    for (let i = 0; i < 5; i++) await expect(mcp.callTool('flaky', {}, 500)).rejects.toThrow(/HTTP 500/)
    expect(mcp.breakerOpenUntil).toBeGreaterThan(Date.now())
    expect(audits).toContain('breaker')
    await expect(mcp.callTool('flaky', {}, 500)).rejects.toThrow(/circuit breaker/)
    failing = false
    let reconnected = 0
    mcp.startHealthChecks(async () => { reconnected += 1 })
    // No user call: the breaker timer/health path must recover automatically
    // and invoke the re-registration callback exactly once.
    for (let i = 0; i < 30 && reconnected === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(reconnected).toBe(1)
    expect(mcp.available).toBe(true)
    expect(calls).toBe(5)
    await mcp.disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 30_000)

  it('HTTP AbortSignal sends notifications/cancelled and settles without hanging', async () => {
    let cancelled = false
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.statusCode = 204; res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string }
      if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return }
      if (body.method === 'notifications/cancelled') { cancelled = true; res.statusCode = 202; res.end(); return }
      res.setHeader('content-type', 'application/json')
      if (body.method === 'initialize') res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }))
      else if (body.method === 'tools/list') res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'hang', inputSchema: { type: 'object', properties: {} } }] } }))
      else { /* tools/call intentionally stays pending until client abort */ }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('bad address')
    const mcp = new McpServerClient('cancel-http', { name: 'cancel-http', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true }, {}, () => {})
    await mcp.listTools()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await expect(mcp.callTool('hang', {}, 5_000, controller.signal)).rejects.toThrow()
    for (let i = 0; i < 20 && !cancelled; i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(cancelled).toBe(true)
    await mcp.disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 15_000)

  it('tools/list pagination returns the complete snapshot', async () => {
    const cursors: (string | undefined)[] = []
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.statusCode = 204; res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { cursor?: string } }
      if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return }
      res.setHeader('content-type', 'application/json')
      if (body.method === 'initialize') res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }))
      else {
        cursors.push(body.params?.cursor)
        const second = body.params?.cursor === 'next'
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: second
          ? { tools: [{ name: 'two', inputSchema: { type: 'object', properties: {} } }] }
          : { tools: [{ name: 'one', inputSchema: { type: 'object', properties: {} } }], nextCursor: 'next' } }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('bad address')
    const mcp = new McpServerClient('pages', { name: 'pages', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true }, {}, () => {})
    expect((await mcp.listTools()).map((tool) => tool.name)).toEqual(['one', 'two'])
    expect(cursors).toEqual([undefined, 'next'])
    await mcp.disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 15_000)

  it('initializes, preserves the MCP session id, and passes bearer auth', async () => {
    const seen: { method: string; auth?: string; session?: string; origin?: string }[] = []
    let deletes = 0
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { deletes += 1; res.statusCode = 204; res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string }
      seen.push({ method: body.method, ...(req.headers.authorization !== undefined ? { auth: req.headers.authorization } : {}), ...(req.headers['mcp-session-id'] !== undefined ? { session: String(req.headers['mcp-session-id']) } : {}), ...(req.headers.origin !== undefined ? { origin: req.headers.origin } : {}) })
      if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return }
      res.setHeader('content-type', 'application/json')
      res.setHeader('mcp-session-id', 'fixture-session')
      if (body.method === 'initialize') res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }))
      else if (body.method === 'tools/list') res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'remote', inputSchema: { type: 'object', properties: {} } }] } }))
      else res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'remote ok' }], isError: false } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('bad address')
    const mcp = new McpServerClient('remote', { name: 'remote', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true }, { bearerToken: 'token-123' }, () => {})
    const tools = await mcp.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['remote'])
    const result = await mcp.callTool('remote', {}, 2_000)
    expect(JSON.stringify(result.content)).toContain('remote ok')
    expect(seen.every((row) => row.auth === 'Bearer token-123')).toBe(true)
    expect(seen.some((row) => row.method === 'notifications/initialized')).toBe(true)
    expect(seen.slice(1).every((row) => row.session === 'fixture-session')).toBe(true)
    expect(seen.every((row) => row.origin?.startsWith('http://127.0.0.1:') === true)).toBe(true)
    await mcp.disconnect()
    expect(deletes).toBe(1)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 15_000)
})
