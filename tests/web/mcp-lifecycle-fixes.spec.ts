/**
 * Regressions from the 2026-10-13 MCP flow audit (host lifecycle layer).
 * See plans/reports/code-review-261013-2052-mcp-flow-audit.md. Each case goes
 * through the real web host with the stdio fixture server.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'
import { parseMcpName } from '../../src/web/execution-authority.ts'
import { startOAuthFixture, type OAuthFixture } from '../support/oauth-fixture.ts'

const fixturePath = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

let web: WebServer | undefined
let oauth: OAuthFixture | undefined
let home = ''
afterEach(async () => {
  await web?.close()
  web = undefined
  await oauth?.close()
  oauth = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

const idle: LlmProvider = {
  name: 'scripted', models: ['scripted'],
  async *stream() {
    yield { type: 'delta', delta: 'ok' }
    yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  },
}

async function boot(extra: { readonly requests?: ModelRequest[] } = {}) {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-lifecycle-'))
  const provider: LlmProvider = extra.requests === undefined ? idle : {
    ...idle,
    async *stream(request) {
      extra.requests!.push(request)
      yield* idle.stream(request)
    },
  }
  web = await createWebServer({ home, configFile: path.join(home, 'providers.json'), providers: [provider] })
  const base = web.url
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const api = (route: string, body?: unknown, method = 'POST') => fetch(`${base}/api/workspaces/${wsId}${route}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const rows = async () => (await (await api('/mcp', undefined, 'GET')).json()) as Array<{ name: string; status: string; enabled: boolean; lastError?: string }>
  const row = async (name: string) => (await rows()).find((entry) => entry.name === name)
  const stdio = (env?: Record<string, string>) => ({ transport: 'stdio', command: process.execPath, args: [fixturePath], enabled: false, ...(env === undefined ? {} : { env }) })
  /** One chat turn: it runs the pre-step that connects enabled servers. */
  const turn = async (): Promise<void> => {
    const session = await (await api('/sessions', { provider: 'scripted', model: 'scripted' })).json() as { id: string }
    await api(`/sessions/${session.id}/messages`, { content: 'hi' })
    const file = path.join(home, 'workspaces', wsId, 'sessions', session.id, 'events.jsonl')
    for (let attempt = 0; attempt < 100; attempt++) {
      const raw = await fs.readFile(file, 'utf8').catch(() => '')
      if (raw.includes('"type":"turn/end"')) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return { base, wsId, api, rows, row, stdio, turn }
}

describe('MCP lifecycle audit regressions', () => {
  it('#1 an unrelated save during a connect does not strand the server in a cancelled state', async () => {
    const ctx = await boot()
    expect((await ctx.api('/mcp/slow', ctx.stdio({ INIT_DELAY_MS: '600' }))).status).toBe(201)
    expect((await ctx.api('/mcp/slow/enable')).status).toBe(200)
    // A first save drops the live client, so the next turn has to connect again.
    expect((await ctx.api('/mcp/other', ctx.stdio())).status).toBe(201)
    expect((await ctx.row('slow'))?.status).toBe('idle')
    // That connect is IN FLIGHT (slow initialize) when a second, unrelated save fences the workspace.
    const turn = ctx.turn()
    await expect.poll(async () => (await ctx.row('slow'))?.status, { timeout: 5_000, interval: 25 }).toBe('connecting')
    expect((await ctx.api('/mcp/third', ctx.stdio())).status).toBe(201)
    await turn
    // A later turn must bring `slow` up without a manual Enable/Reconnect.
    await ctx.turn()
    await expect.poll(async () => (await ctx.row('slow'))?.status, { timeout: 10_000, interval: 200 }).toBe('ready')
  }, 30_000)

  it('#3 a failed Enable is reported as failed with its reason, not as connecting', async () => {
    const ctx = await boot()
    expect((await ctx.api('/mcp/broken', { ...ctx.stdio({ TOKEN: '${MISSING_SECRET}' }) })).status).toBe(201)
    const enabled = await ctx.api('/mcp/broken/enable')
    expect(enabled.ok).toBe(false)
    const row = await ctx.row('broken')
    expect(row?.enabled).toBe(true)
    expect(row?.status).toBe('failed')
    expect(row?.lastError).toMatch(/MISSING_SECRET/)
  })

  it('#3 an enabled server that nothing is connecting is idle, not connecting', async () => {
    const ctx = await boot()
    expect((await ctx.api('/mcp/quiet', ctx.stdio())).status).toBe(201)
    expect((await ctx.api('/mcp/quiet/enable')).status).toBe(200)
    // Any save fences the workspace and drops every live client.
    expect((await ctx.api('/mcp/other', ctx.stdio())).status).toBe(201)
    expect((await ctx.row('quiet'))?.status).toBe('idle')
  })

  it('#2 a server that fails to come back after a fence stops advertising its tools', async () => {
    const requests: ModelRequest[] = []
    const ctx = await boot({ requests })
    await ctx.api('/mode', undefined, 'GET')
    expect((await ctx.api('/mcp/fx', ctx.stdio())).status).toBe(201)
    expect((await ctx.api('/mcp/fx/enable')).status).toBe(200)
    await ctx.turn()
    const names = (): string[] => (requests.at(-1)?.tools ?? []).map((tool) => tool.name)
    expect(names()).toContain('mcp__fx__query')
    // Point the server at a missing secret: the next connect fails.
    const stored = await (await ctx.api('/mcp/fx', undefined, 'GET')).json() as Record<string, unknown>
    expect((await ctx.api('/mcp/fx', { ...stored, env: { TOKEN: '${MISSING_SECRET}' } })).status).toBe(201)
    await ctx.turn()
    expect(names()).not.toContain('mcp__fx__query')
  }, 30_000)

  it('#4 reconnect refuses a disabled server instead of enabling it unpinned', async () => {
    const ctx = await boot()
    expect((await ctx.api('/mcp/unpinned', ctx.stdio())).status).toBe(201)
    const response = await ctx.api('/mcp/unpinned/reconnect')
    expect(response.status).toBe(409)
    expect((await ctx.row('unpinned'))?.enabled).toBe(false)
  })

  it('#14 import never overwrites a server that already exists', async () => {
    const ctx = await boot()
    expect((await ctx.api('/mcp/keep', ctx.stdio())).status).toBe(201)
    expect((await ctx.api('/mcp/keep/enable')).status).toBe(200)
    const content = JSON.stringify({ mcpServers: { keep: { command: 'node', args: ['other.js'] }, fresh: { command: 'node', args: ['x.js'] } } })
    const imported = await ctx.api('/mcp/import', { content })
    expect(imported.status).toBe(409)
    expect(await imported.text()).toContain('keep')
    const stored = await (await ctx.api('/mcp/keep', undefined, 'GET')).json() as { args: string[]; enabled: boolean }
    expect(stored.args).toEqual([fixturePath])
    expect(stored.enabled).toBe(true)
    expect((await ctx.row('fresh'))).toBeUndefined()
  })

  it('#12 deleting an OAuth server revokes the grant at the provider', async () => {
    oauth = await startOAuthFixture()
    const ctx = await boot()
    const url = oauth.mcpUrl
    expect((await ctx.api('/mcp/remote', { transport: 'http', url, enabled: false, auth: { type: 'managed_oauth', provider: new URL(url).host, resource: url } })).status).toBe(201)
    const begun = await (await ctx.api('/mcp/remote/oauth/begin', {})).json() as { authorizationUrl: string; state: string }
    await fetch(await oauth.authorize(begun.authorizationUrl))
    expect((await ctx.api('/mcp/remote/oauth/complete', { state: begun.state })).status).toBe(200)
    expect((await ctx.api('/mcp/remote', undefined, 'DELETE')).status).toBe(200)
    expect(oauth.revocations).toHaveLength(1)
  })

  it('#11 completing a sign-in is refused once the server points somewhere else', async () => {
    oauth = await startOAuthFixture()
    const ctx = await boot()
    const url = oauth.mcpUrl
    const auth = (resource: string) => ({ type: 'managed_oauth', provider: new URL(resource).host, resource })
    expect((await ctx.api('/mcp/remote', { transport: 'http', url, enabled: false, auth: auth(url) })).status).toBe(201)
    const begun = await (await ctx.api('/mcp/remote/oauth/begin', {})).json() as { authorizationUrl: string; state: string }
    await fetch(await oauth.authorize(begun.authorizationUrl))
    const moved = `${oauth.origin}/other-mcp`
    expect((await ctx.api('/mcp/remote', { transport: 'http', url: moved, enabled: false, auth: auth(moved) })).status).toBe(201)
    const completed = await ctx.api('/mcp/remote/oauth/complete', { state: begun.state })
    expect(completed.status).toBe(400)
    expect(((await ctx.rows()).find((entry) => entry.name === 'remote') as { oauth?: { state: string } }).oauth?.state).toBe('not_connected')
  })

  it('#13 a plugin server the user disabled stays disabled when plugins re-sync', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-plugin-'))
    const market = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mkt-'))
    const plugin = path.join(market, 'plugins', 'toolkit')
    await fs.mkdir(path.join(market, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true })
    await fs.writeFile(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'local-market', owner: { name: 'T' }, plugins: [{ name: 'toolkit', source: './plugins/toolkit' }] }))
    await fs.writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'toolkit', version: '1.0.0' }))
    await fs.writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.invalid/mcp' } } }))
    try {
      web = await createWebServer({ home, configFile: path.join(home, 'p.json'), providers: [idle], userClaudeDir: await fs.mkdtemp(path.join(tmpdir(), 'dnt-user-')) })
      const base = web.url
      const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
      const post = (route: string, body?: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      expect((await post('/api/plugins/marketplaces', { source: market })).status).toBe(201)
      expect((await post(`/api/workspaces/${wsId}/plugins/toolkit@local-market/install`, { scope: 'workspace' })).status).toBe(200)
      const server = 'plugin_toolkit_docs'
      expect((await post(`/api/workspaces/${wsId}/mcp/${server}/disable`)).status).toBe(200)
      // Another plugin action re-syncs; the user's Disable must survive it.
      expect((await post(`/api/workspaces/${wsId}/plugins/toolkit@local-market/enable`, { scope: 'workspace' })).status).toBe(200)
      const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()) as Array<{ name: string; enabled: boolean }>
      expect(rows.find((entry) => entry.name === server)?.enabled).toBe(false)
    } finally {
      await fs.rm(market, { recursive: true, force: true })
    }
  })

  it('#17 the schema a model sees keeps the interactive suffix', async () => {
    const requests: ModelRequest[] = []
    const ctx = await boot({ requests })
    expect((await ctx.api('/mcp/fx', ctx.stdio())).status).toBe(201)
    expect((await ctx.api('/mcp/fx/enable')).status).toBe(200)
    await ctx.turn()
    const tool = (requests.at(-1)?.tools ?? []).find((entry) => entry.name === 'mcp__fx__interactive')
    expect(tool?.description).toContain('(interactive — always asks)')
  }, 30_000)

  it('#19 a server name that would collide in tool names is refused', async () => {
    const ctx = await boot()
    for (const name of ['a__b', '_a', 'a_']) {
      const response = await ctx.api(`/mcp/${name}`, ctx.stdio())
      expect(response.status, name).toBe(400)
    }
    expect((await ctx.api('/mcp/a_b', ctx.stdio())).status).toBe(201)
    expect(parseMcpName('mcp__a_b__query')).toEqual({ server: 'a_b', tool: 'query' })
  })
})
