/**
 * Claude Code plugins through the web host: a local marketplace, install at
 * workspace scope, every component (commands, skills, agents, hooks, MCP)
 * live for the workspace, `enabledPlugins` layering, disable/uninstall, and
 * git-backed sources through the clone seam.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const dirs: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
})

const temp = async (prefix: string): Promise<string> => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
const write = async (file: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}
const json = (value: unknown): string => JSON.stringify(value, null, 2)
const post = (base: string, pathname: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

/** A marketplace folder holding one full-featured plugin. */
async function marketplace(): Promise<string> {
  const root = await temp('dnt-mkt-')
  await write(path.join(root, '.claude-plugin', 'marketplace.json'), json({
    name: 'local-market',
    owner: { name: 'Tests' },
    plugins: [
      { name: 'toolkit', source: './plugins/toolkit', description: 'Everything' },
      { name: 'remote', source: { source: 'url', url: 'https://example.invalid/remote.git', sha: 'abcdef1' } },
      { name: 'npm-only', source: { source: 'npm', package: 'x' } },
    ],
  }))
  const plugin = path.join(root, 'plugins', 'toolkit')
  await write(path.join(plugin, '.claude-plugin', 'plugin.json'), json({ name: 'toolkit', version: '1.2.0', description: 'Everything' }))
  await write(path.join(plugin, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nHello from ${CLAUDE_PLUGIN_ROOT} to $ARGUMENTS')
  await write(path.join(plugin, 'skills', 'brainstorm', 'SKILL.md'), '---\nname: brainstorm\ndescription: Brainstorm ideas\n---\nBRAINSTORM BODY')
  await write(path.join(plugin, 'agents', 'helper.md'), '---\nname: helper\ndescription: Helps\n---\nHelp.')
  await write(path.join(plugin, 'hooks', 'hooks.json'), json({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf "plugin root %s" "${CLAUDE_PLUGIN_ROOT}"' }] }] } }))
  await write(path.join(plugin, '.mcp.json'), json({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.invalid/mcp' }, live: { type: 'sse', url: 'https://x' } } }))
  return root
}

async function start(extra: { readonly pluginClone?: (url: string, target: string) => Promise<string> } = {}): Promise<{ base: string; home: string; wsId: string; requests: ModelRequest[]; userClaude: string }> {
  const home = await temp('dnt-plug-home-')
  const userClaude = await temp('dnt-plug-user-')
  const requests: ModelRequest[] = []
  const provider: LlmProvider = {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      requests.push(request)
      yield { type: 'delta', delta: 'ok' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), userClaudeDir: userClaude, ...extra })
  servers.push(server)
  const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
  return { base: server.url, home, wsId, requests, userClaude }
}

async function turnEnd(home: string, wsId: string, sessionId: string): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const file = path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl')
  let events: Array<{ type: string; [key: string]: unknown }> = []
  await expect.poll(async () => {
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    events = raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { type: string })
    return events.some((event) => event.type === 'turn/end')
  }, { timeout: 8_000 }).toBe(true)
  return events
}

interface PluginRowView { id: string; installed: boolean; active: boolean; enabled?: { value: boolean; scope: string }; components?: { commands: number; skills: number; agents: number; hooks: boolean; mcpServers: string[] }; notes?: string[] }

describe('Claude Code plugins over the web host', () => {
  it('adds a local marketplace, installs a plugin at workspace scope, and every component goes live', async () => {
    const s = await start()
    const market = await marketplace()
    const added = await post(s.base, '/api/plugins/marketplaces', { source: market })
    expect(added.status).toBe(201)
    expect(await added.json()).toEqual({ name: 'local-market', plugins: 3 })

    const install = await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/install`, { scope: 'workspace' })
    expect(install.status).toBe(200)
    const installed = await install.json() as { plugins: PluginRowView[]; notes?: string[] }
    const row = installed.plugins.find((plugin) => plugin.id === 'toolkit@local-market')
    expect(row).toMatchObject({ installed: true, active: true, enabled: { value: true, scope: 'workspace' } })
    expect(row?.components).toEqual({ commands: 1, skills: 1, agents: 1, hooks: true, mcpServers: ['docs', 'live'] })
    expect(installed.notes?.some((note) => note.includes("'live'") && note.includes('sse'))).toBe(true)

    // Claude settings format: enabledPlugins in the workspace settings.json.
    const settings = JSON.parse(await fs.readFile(path.join(s.home, 'workspaces', s.wsId, 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, boolean> }
    expect(settings.enabledPlugins).toEqual({ 'toolkit@local-market': true })
    // Installed into the host's own store, never ~/.claude.
    const store = JSON.parse(await fs.readFile(path.join(s.home, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { version: string; installPath: string }[]> }
    const record = store.plugins['toolkit@local-market']?.[0]
    expect(record?.version).toBe('1.2.0')
    expect(path.dirname(record?.installPath ?? '')).toBe(path.join(s.home, 'plugins', 'cache', 'local-market', 'toolkit'))
    expect(path.basename(record?.installPath ?? '')).toMatch(/^1\.2\.0-[0-9a-f]{12}$/)
    expect(await fs.readdir(s.userClaude)).toEqual([])

    // Commands: namespaced and expanded with the plugin root.
    const commands = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/commands`)).json() as { commands: { name: string; source: string }[] }
    expect(commands.commands).toEqual([expect.objectContaining({ name: 'toolkit:hello', source: 'plugin' })])
    // Skills: `plugin:skill` in the catalog.
    const skills = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/skills`)).json() as { name: string; source: string }[]
    expect(skills.find((skill) => skill.name === 'toolkit:brainstorm')?.source).toBe('plugin')
    // Agents: `plugin:agent`.
    const agents = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/agents`)).json() as { rows?: { definition: { name: string }; source: string }[] } | { definition: { name: string }; source: string }[]
    const agentRows = Array.isArray(agents) ? agents : agents.rows ?? []
    expect(agentRows.find((agent) => agent.definition.name === 'toolkit:helper')?.source).toBe('plugin')
    // MCP: materialized as plugin-owned, enabled entries with Claude's tool prefix.
    const mcp = JSON.parse(await fs.readFile(path.join(s.home, 'workspaces', s.wsId, 'mcp.json'), 'utf8')) as { servers: Record<string, { enabled: boolean; url?: string; provenance?: { plugin?: string } }> }
    expect(mcp.servers['plugin_toolkit_docs']).toMatchObject({ enabled: true, url: 'https://mcp.example.invalid/mcp', provenance: { plugin: 'toolkit@local-market' } })
    expect(mcp.servers['plugin_toolkit_live']).toBeUndefined()

    // A turn: the plugin hook runs with CLAUDE_PLUGIN_ROOT; the command expands.
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/toolkit:hello Ada' })
    const log = await turnEnd(s.home, s.wsId, id)
    const users = log.filter((event) => event.type === 'user/message').map((event) => String(event['content']))
    expect(users.some((text) => text.includes(`plugin root ${record?.installPath}`))).toBe(true)
    expect(users).toContain(`Hello from ${record?.installPath} to Ada`)
    // A bare skill name reaches the plugin skill when nothing else has it.
    const { id: second } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${second}/messages`, { content: '/brainstorm' })
    const secondLog = await turnEnd(s.home, s.wsId, second)
    expect(secondLog.filter((event) => event.type === 'user/message').map((event) => String(event['content'])).some((text) => text.includes('BRAINSTORM BODY'))).toBe(true)
  })

  it('project settings can turn a workspace-enabled plugin off; uninstall removes MCP, store and cache', async () => {
    const s = await start()
    await post(s.base, '/api/plugins/marketplaces', { source: await marketplace() })
    await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/install`, { scope: 'workspace' })
    const project = await temp('dnt-plug-proj-')
    await write(path.join(project, '.claude', 'settings.json'), json({ enabledPlugins: { 'toolkit@local-market': false } }))
    const projectId = (await (await post(s.base, `/api/workspaces/${s.wsId}/projects`, { name: 'P', path: project })).json() as { id: string }).id

    const inProject = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/plugins?projectId=${projectId}`)).json() as { plugins: PluginRowView[] }
    expect(inProject.plugins[0]).toMatchObject({ active: false, enabled: { value: false, scope: 'project' } })
    const projectCommands = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/commands?projectId=${projectId}`)).json() as { commands: unknown[] }
    expect(projectCommands.commands).toEqual([])

    const removed = await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/uninstall`, { scope: 'workspace' })
    expect(removed.status).toBe(200)
    const mcp = JSON.parse(await fs.readFile(path.join(s.home, 'workspaces', s.wsId, 'mcp.json'), 'utf8')) as { servers: Record<string, unknown> }
    expect(Object.keys(mcp.servers)).toEqual([])
    const store = JSON.parse(await fs.readFile(path.join(s.home, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, unknown> }
    expect(store.plugins).toEqual({})
    expect(await fs.readdir(path.join(s.home, 'plugins', 'cache', 'local-market', 'toolkit'))).toEqual([])
    const settings = JSON.parse(await fs.readFile(path.join(s.home, 'workspaces', s.wsId, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['enabledPlugins']).toBeUndefined()
  })

  it('lists a plugin enabled in ~/.claude/settings.json but not installed here, and never writes ~/.claude', async () => {
    const s = await start()
    await write(path.join(s.userClaude, 'settings.json'), json({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }))
    const listed = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/plugins`)).json() as { plugins: PluginRowView[] }
    expect(listed.plugins).toEqual([expect.objectContaining({ id: 'superpowers@claude-plugins-official', installed: false, active: false, enabled: { value: true, scope: 'user' } })])
    const refused = await post(s.base, `/api/workspaces/${s.wsId}/plugins/superpowers@claude-plugins-official/disable`, { scope: 'user' })
    expect(refused.status).toBe(400)
    expect(JSON.parse(await fs.readFile(path.join(s.userClaude, 'settings.json'), 'utf8'))).toEqual({ enabledPlugins: { 'superpowers@claude-plugins-official': true } })
  })

  it('fetches git sources through the clone seam and refuses unsupported ones', async () => {
    const cloned: string[] = []
    const s = await start({
      pluginClone: async (url, target) => {
        cloned.push(url)
        await write(path.join(target, '.claude-plugin', 'plugin.json'), json({ name: 'remote', version: '0.3.0' }))
        await write(path.join(target, 'commands', 'ping.md'), 'pong $ARGUMENTS')
        return 'abcdef1234567890'
      },
    })
    await post(s.base, '/api/plugins/marketplaces', { source: await marketplace() })
    const ok = await post(s.base, `/api/workspaces/${s.wsId}/plugins/remote@local-market/install`, {})
    expect(ok.status).toBe(200)
    expect(cloned).toEqual(['https://example.invalid/remote.git'])
    const store = JSON.parse(await fs.readFile(path.join(s.home, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { version: string; gitCommitSha?: string }[]> }
    expect(store.plugins['remote@local-market']?.[0]).toMatchObject({ version: '0.3.0', gitCommitSha: 'abcdef1234567890' })
    const npm = await post(s.base, `/api/workspaces/${s.wsId}/plugins/npm-only@local-market/install`, {})
    expect(npm.status).toBe(422)
    expect(((await npm.json()) as { error: string }).error).toMatch(/not supported/)
  })

  it('refuses marketplace inputs that are not owner/repo, a git URL or an absolute folder', async () => {
    const s = await start()
    for (const source of ['', 'relative/dir/x', '--upload-pack=evil', 'ftp://x']) {
      const response = await post(s.base, '/api/plugins/marketplaces', { source })
      expect(response.status).toBe(400)
    }
  })

  it('rejects traversal plugin ids and never deletes outside the cache', async () => {
    const s = await start()
    const sentinel = path.join(s.home, 'workspaces', s.wsId, 'sentinel.txt')
    await write(sentinel, 'keep')
    for (const id of ['..%40..', '.%40.', 'x%40..', '..%40x']) {
      const response = await post(s.base, `/api/workspaces/${s.wsId}/plugins/${id}/uninstall`, { scope: 'workspace' })
      expect(response.status).toBe(400)
    }
    expect(await fs.readFile(sentinel, 'utf8')).toBe('keep')
    expect((await fs.stat(path.join(s.home, 'workspaces'))).isDirectory()).toBe(true)
  })

  it('keeps published cache folders immutable: same version with new bytes gets a new folder', async () => {
    const s = await start()
    const market = await marketplace()
    await post(s.base, '/api/plugins/marketplaces', { source: market })
    await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/install`, { scope: 'workspace' })
    const first = (JSON.parse(await fs.readFile(path.join(s.home, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { installPath: string }[]> }).plugins['toolkit@local-market']![0]!.installPath
    // Same version, different content; a second workspace installs it.
    await write(path.join(market, 'plugins', 'toolkit', 'commands', 'hello.md'), 'CHANGED')
    const other = (await (await post(s.base, '/api/workspaces', { name: 'Other' })).json() as { id: string }).id
    await post(s.base, `/api/workspaces/${other}/plugins/toolkit@local-market/install`, { scope: 'workspace' })
    const records = (JSON.parse(await fs.readFile(path.join(s.home, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { installPath: string }[]> }).plugins['toolkit@local-market']!
    expect(records).toHaveLength(2)
    expect(records[1]!.installPath).not.toBe(first)
    expect(await fs.readFile(path.join(first, 'commands', 'hello.md'), 'utf8')).toContain('Hello from')
    expect(path.basename(first)).toMatch(/^1\.2\.0-[0-9a-f]{12}$/)
    // CLAUDE_PLUGIN_DATA exists once the plugin is loaded.
    expect((await fs.stat(path.join(s.home, 'plugins', 'data', 'toolkit@local-market'))).isDirectory()).toBe(true)
  })

  it('one invalid plugin MCP server neither blocks other servers nor the removal of a disabled plugin', async () => {
    const s = await start()
    const market = await marketplace()
    await write(path.join(market, '.claude-plugin', 'marketplace.json'), json({
      name: 'local-market',
      plugins: [{ name: 'toolkit', source: './plugins/toolkit' }, { name: 'broken', source: './plugins/broken' }],
    }))
    await write(path.join(market, 'plugins', 'broken', '.claude-plugin', 'plugin.json'), json({ name: 'broken', version: '1.0.0' }))
    await write(path.join(market, 'plugins', 'broken', '.mcp.json'), json({ mcpServers: { bad: { type: 'http', url: 'not a url' }, good: { type: 'http', url: 'https://good.example.invalid/mcp' } } }))
    await post(s.base, '/api/plugins/marketplaces', { source: market })
    await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/install`, {})
    const readServers = async (): Promise<string[]> =>
      Object.keys((JSON.parse(await fs.readFile(path.join(s.home, 'workspaces', s.wsId, 'mcp.json'), 'utf8')) as { servers: Record<string, unknown> }).servers).sort()
    expect(await readServers()).toEqual(['plugin_toolkit_docs'])

    // Disable toolkit AND add a plugin with one invalid + one valid server.
    await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/disable`, {})
    const result = await (await post(s.base, `/api/workspaces/${s.wsId}/plugins/broken@local-market/install`, {})).json() as { notes?: string[] }
    expect(result.notes?.some((note) => note.includes('plugin_broken_bad'))).toBe(true)
    // The removal of toolkit's server and the valid server both went through.
    expect(await readServers()).toEqual(['plugin_broken_good'])
  })

  it('reloads plugin components when hooks.json or .mcp.json change on disk', async () => {
    const s = await start()
    const market = await marketplace()
    await post(s.base, '/api/plugins/marketplaces', { source: market })
    await post(s.base, `/api/workspaces/${s.wsId}/plugins/toolkit@local-market/install`, {})
    const store = JSON.parse(await fs.readFile(path.join(s.home, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { installPath: string }[]> }
    const installPath = store.plugins['toolkit@local-market']![0]!.installPath
    const componentsOf = async (): Promise<{ mcpServers: string[] }> =>
      ((await (await fetch(`${s.base}/api/workspaces/${s.wsId}/plugins`)).json()) as { plugins: PluginRowView[] }).plugins[0]!.components as { mcpServers: string[] }
    expect((await componentsOf()).mcpServers).toEqual(['docs', 'live'])
    await write(path.join(installPath, '.mcp.json'), json({ mcpServers: { only: { type: 'http', url: 'https://only.example.invalid/mcp' } } }))
    expect((await componentsOf()).mcpServers).toEqual(['only'])
  })

  it('a plugin agent cannot claim another plugin namespace', async () => {
    const s = await start()
    const market = await temp('dnt-mkt-agent-ns-')
    await write(path.join(market, '.claude-plugin', 'marketplace.json'), json({ name: 'ns-market', plugins: [{ name: 'zed', source: './zed' }] }))
    await write(path.join(market, 'zed', '.claude-plugin', 'plugin.json'), json({ name: 'zed', version: '1.0.0' }))
    await write(path.join(market, 'zed', 'agents', 'helper.md'), '---\nname: other:helper\ndescription: Spoof\n---\nX')
    await post(s.base, '/api/plugins/marketplaces', { source: market })
    await post(s.base, `/api/workspaces/${s.wsId}/plugins/zed@ns-market/install`, {})
    const agents = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/agents`)).json() as { rows?: { definition: { name: string } }[] } | { definition: { name: string } }[]
    const names = (Array.isArray(agents) ? agents : agents.rows ?? []).map((row) => row.definition.name)
    expect(names).toContain('zed:helper')
    expect(names).not.toContain('other:helper')
  })

  it('refuses a relative plugin source symlink that escapes its marketplace', async () => {
    if (process.platform === 'win32') return
    const s = await start()
    const market = await temp('dnt-mkt-symlink-')
    const outside = await temp('dnt-plugin-outside-')
    await write(path.join(outside, '.claude-plugin', 'plugin.json'), json({ name: 'escape', version: '1.0.0' }))
    await write(path.join(outside, 'commands', 'pwn.md'), 'outside')
    await fs.mkdir(path.join(market, '.claude-plugin'), { recursive: true })
    await fs.symlink(outside, path.join(market, 'escape'), 'dir')
    await write(path.join(market, '.claude-plugin', 'marketplace.json'), json({
      name: 'symlink-market', plugins: [{ name: 'escape', source: './escape' }],
    }))
    expect((await post(s.base, '/api/plugins/marketplaces', { source: market })).status).toBe(201)
    const installed = await post(s.base, `/api/workspaces/${s.wsId}/plugins/escape@symlink-market/install`, {})
    expect(installed.status).toBe(400)
    expect(((await installed.json()) as { error: string }).error).toMatch(/outside the marketplace after symlink resolution/)
    expect(await fs.stat(path.join(s.home, 'plugins', 'cache', 'symlink-market', 'escape')).catch(() => undefined)).toBeUndefined()
  })
})
