import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import { McpExecutionJournal } from '../../src/harness/mcp/execution-journal.ts'
import { OAuthStore } from '../../src/harness/mcp/oauth-store.ts'

let web: WebServer | undefined
let home = ''
afterEach(async () => {
  vi.restoreAllMocks()
  await web?.close()
  web = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})
async function boot(provider?: LlmProvider) {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-review-'))
  web = await createWebServer({ home, configFile: path.join(home, 'providers.json'), ...(provider === undefined ? {} : { providers: [provider] }) })
  const base = web.url
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const post = (route: string, body?: unknown) => fetch(`${base}/api/workspaces/${wsId}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { base, wsId, post }
}

describe('MCP server integration review regressions', () => {
  it.each([true, false])('preserves a legacy audit block across startup (owned=%s)', async (owned) => {
    const { wsId } = await boot()
    await web!.close()
    web = undefined
    const legacy = path.join(home, 'mcp-audit-fault.json')
    await fs.writeFile(legacy, JSON.stringify(owned ? { workspaceId: wsId, invocationId: 'legacy' } : { invocationId: 'legacy' }))
    web = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
    const fault = owned ? path.join(home, 'mcp-audit-faults', `${encodeURIComponent(wsId)}.json`) : legacy
    if (owned) await expect(fs.stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(fault, 'utf8')).toContain('legacy')
    const otherResponse = await fetch(`${web.url}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other' }) })
    const other = await otherResponse.json() as { id: string }
    for (const id of [wsId, other.id]) {
      const route = `${web.url}/api/workspaces/${id}/mcp`
      expect((await fetch(`${route}/fixture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transport: 'http', url: 'https://public.example/mcp', enabled: false }) })).status).toBe(201)
      const rows = await (await fetch(route)).json() as { auditFault: boolean }[]
      expect(rows[0]?.auditFault).toBe(!owned || id === wsId)
    }
    const repair = () => fetch(`${web!.url}/api/workspaces/${wsId}/mcp/audit-repair`, { method: 'POST' })
    if (!owned) {
      expect((await repair()).status).toBe(409)
      await fs.writeFile(legacy, JSON.stringify({ workspaceId: wsId, invocationId: 'legacy' }))
    }
    expect((await repair()).status).toBe(200)
    await expect(fs.stat(fault)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('single-flights concurrent first calls and leaves a reopen-valid journal', async () => {
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        if (!request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'toolCalls', calls: [{ id: 'query', name: 'mcp__fixture__query', args: { q: 'x' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        } else {
          yield { type: 'delta', delta: 'done' }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        }
      },
    }
    const { base, wsId, post } = await boot(provider)
    const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))
    expect((await post('/mcp/fixture', { transport: 'stdio', command: process.execPath, args: [fixture], enabled: true, allowedTools: ['query'] })).status).toBe(201)
    expect((await post('/mcp/fixture/enable')).status).toBe(200)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const sessions: { id: string }[] = []
    for (let index = 0; index < 2; index++) {
      const response = await post('/sessions', { provider: 'scripted', model: 'scripted' })
      expect(response.status).toBe(201)
      sessions.push(await response.json() as { id: string })
    }
    const originalOpen = McpExecutionJournal.prototype.open
    const opened = vi.spyOn(McpExecutionJournal.prototype, 'open').mockImplementation(async function (this: McpExecutionJournal) {
      // Hold the first open so both sessions reach journalFor before publication.
      await new Promise((resolve) => setTimeout(resolve, 150))
      return originalOpen.call(this)
    })
    await Promise.all(sessions.map((session) => post(`/sessions/${session.id}/messages`, { content: 'query' })))
    const file = path.join(home, 'workspaces', wsId, 'mcp', 'executions.jsonl')
    for (let attempt = 0; attempt < 100; attempt++) {
      const raw = await fs.readFile(file, 'utf8').catch(() => '')
      if (raw.split('\n').filter((line) => line.includes('"kind":"terminal"')).length === 2) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(opened).toHaveBeenCalledTimes(1)
    opened.mockRestore()
    const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { seq: number; kind: string; outcome?: string })
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4])
    expect(records.filter((record) => record.kind === 'terminal').map((record) => record.outcome)).toEqual(['success', 'success'])
    await expect(new McpExecutionJournal(file).open()).resolves.toEqual({ unresolved: [] })
  }, 15_000)

  it('does not cache failed opens or clear the audit block before repaired bytes validate', async () => {
    const { wsId, post } = await boot()
    const file = path.join(home, 'workspaces', wsId, 'mcp', 'executions.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'corrupt\n')
    const failures = await Promise.all([post('/mcp/audit-repair'), post('/mcp/audit-repair')])
    expect(failures.every((response) => !response.ok)).toBe(true)
    await fs.writeFile(file, '')
    const repaired = await Promise.all([post('/mcp/audit-repair'), post('/mcp/audit-repair')])
    expect(repaired.every((response) => response.ok)).toBe(true)
    await expect(new McpExecutionJournal(file).open()).resolves.toEqual({ unresolved: [] })
  })

  it('refuses foreign audit repair and only clears after the owning journal validates', async () => {
    const { base, wsId, post } = await boot()
    const created = await fetch(`${base}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other' }),
    })
    expect(created.status).toBe(201)
    const other = await created.json() as { id: string }
    const fault = path.join(home, 'mcp-audit-faults', `${encodeURIComponent(wsId)}.json`)
    await fs.mkdir(path.dirname(fault), { recursive: true })
    const metadata = JSON.stringify({ workspaceId: wsId, invocationId: 'failed', outcome: 'success' })
    await fs.writeFile(fault, metadata)
    const file = path.join(home, 'workspaces', wsId, 'mcp', 'executions.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'corrupt\n')
    const foreign = await fetch(`${base}/api/workspaces/${other.id}/mcp/audit-repair`, { method: 'POST' })
    expect(foreign.status).toBe(200)
    expect(await fs.readFile(fault, 'utf8')).toBe(metadata)
    expect((await post('/mcp/audit-repair')).status).toBe(409)
    expect(await fs.readFile(fault, 'utf8')).toBe(metadata)
    await fs.writeFile(file, '')
    expect((await post('/mcp/audit-repair')).status).toBe(200)
    await expect(fs.stat(fault)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['{"invocationId":"legacy"}', 'invalid', 'null'])('keeps unowned or invalid audit metadata blocked (%s)', async (metadata) => {
    const { wsId, post } = await boot()
    const fault = path.join(home, 'mcp-audit-faults', `${encodeURIComponent(wsId)}.json`)
    await fs.mkdir(path.dirname(fault), { recursive: true })
    await fs.writeFile(fault, metadata)
    const response = await post('/mcp/audit-repair')
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('workspaceId metadata')
    expect(await fs.readFile(fault, 'utf8')).toBe(metadata)
  })

  it.each(['active', 'expired', 'rejected', 'auth_required'] as const)('tests a managed OAuth server with %s credentials without exposing tokens', async (scenario) => {
    let refreshes = 0
    const remote = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      res.setHeader('content-type', 'application/json')
      if (req.url === '/token') {
        refreshes++
        res.end(JSON.stringify({ access_token: 'replacement-secret', refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'bearer' }))
        return
      }
      const accepted = scenario === 'active' ? 'access-secret' : 'replacement-secret'
      if (req.headers.authorization !== `Bearer ${accepted}`) { res.statusCode = 401; res.end('{}'); return }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string }
      if (rpc.id === undefined) { res.statusCode = 202; res.end(); return }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'query', inputSchema: { type: 'object' } }] }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
    const address = remote.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      const { wsId, post } = await boot()
      expect((await post('/mcp/remote', { transport: 'http', url: `${origin}/mcp`, enabled: false, auth: { type: 'managed_oauth', provider: 'fixture', resource: `${origin}/mcp`, clientId: 'client' } })).status).toBe(201)
      const store = new OAuthStore(path.join(home, 'oauth'), await fs.readFile(path.join(home, 'oauth.master.key')))
      await store.saveTokens(wsId, 'remote', {
        accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: scenario === 'expired' ? 0 : Date.now() + 3_600_000,
        tokenEndpoint: `${origin}/token`, clientId: 'client', phase: scenario === 'auth_required' ? 'auth_required' : 'active', resource: `${origin}/mcp`,
      })
      let response = await post('/mcp/remote/test')
      // A rejected initialize is not replayed: the next test requests a replacement.
      if (scenario === 'rejected') {
        expect(response.ok).toBe(false)
        response = await post('/mcp/remote/test')
      }
      const body = await response.text()
      expect(body).not.toContain('access-secret')
      expect(body).not.toContain('replacement-secret')
      expect(body).not.toContain('refresh-secret')
      if (scenario === 'auth_required') {
        expect(response.ok).toBe(false)
        expect(body).toContain('auth_required')
      } else {
        expect(response.status).toBe(200)
        expect(JSON.parse(body)).toMatchObject({ tested: true, published: false, enabled: false, tools: ['query'] })
        expect(refreshes).toBe(scenario === 'active' ? 0 : 1)
      }
    } finally {
      await new Promise<void>((resolve) => remote.close(() => resolve()))
    }
  })
})
