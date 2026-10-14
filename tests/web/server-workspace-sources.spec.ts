/**
 * Workspace Sources over HTTP: one document for skills rules and the fixed
 * layer switches of skills/agents/hooks/commands, with stale-hash refusal, the
 * legacy /skills/sources adapter, and switches that reach real discovery.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const dirs: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
})

async function start(): Promise<{ base: string; home: string; claude: string; wsId: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-wssrc-'))
  const claude = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-wssrc-claude-'))
  dirs.push(home, claude)
  const server = await createWebServer({ home, configFile: path.join(home, 'p.json'), userSkillsDir: path.join(claude, 'skills'), userClaudeDir: claude })
  servers.push(server)
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  return { base: server.url, home, claude, wsId }
}

type SourcesView = {
  doc: { skills: { rules: { id: string; enabled: boolean }[] }; disabled: Record<string, string[]> }
  hash: string
  error?: string
  layers: Record<string, { id: string; available: boolean; path: string }[]>
}

const getSources = async (base: string, wsId: string): Promise<SourcesView> =>
  (await (await fetch(`${base}/api/workspaces/${wsId}/sources`)).json()) as SourcesView

const putSources = (base: string, wsId: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/workspaces/${wsId}/sources`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const agentNames = async (base: string, wsId: string): Promise<string[]> =>
  ((await (await fetch(`${base}/api/workspaces/${wsId}/agents`)).json()) as { definition: { name: string } }[]).map((row) => row.definition.name)

describe('GET/PUT /api/workspaces/:wid/sources', () => {
  it('returns defaults, a hash, and the layers each kind reads from', async () => {
    const { base, wsId, claude } = await start()
    const view = await getSources(base, wsId)
    expect(view.doc.skills.rules.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])
    expect(view.doc.disabled).toEqual({ skills: [], agents: [], hooks: [], commands: [] })
    expect(view.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(view.layers['agents']!.map((layer) => layer.id)).toEqual(['bundled', 'user', 'plugin', 'workspace', 'project'])
    expect(view.layers['hooks']!.find((layer) => layer.id === 'user')).toMatchObject({ available: true, path: path.join(claude, 'settings.json') })
  })

  it('PUT round-trips, answers the new hash, and refuses a stale one with 409', async () => {
    const { base, wsId } = await start()
    const loaded = await getSources(base, wsId)
    const next = { ...loaded.doc, disabled: { ...loaded.doc.disabled, agents: ['bundled'] } }
    const saved = await putSources(base, wsId, { doc: next, expectedHash: loaded.hash })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as SourcesView).doc.disabled['agents']).toEqual(['bundled'])
    expect((await getSources(base, wsId)).doc.disabled['agents']).toEqual(['bundled'])

    const stale = await putSources(base, wsId, { doc: loaded.doc, expectedHash: loaded.hash })
    expect(stale.status).toBe(409)
    expect((await getSources(base, wsId)).doc.disabled['agents']).toEqual(['bundled'])
  })

  it('PUT rejects malformed documents with 400', async () => {
    const { base, wsId } = await start()
    const loaded = await getSources(base, wsId)
    const bad: unknown[] = [
      { doc: null },
      { doc: { ...loaded.doc, disabled: { agents: ['galaxy'] } } },
      { doc: { ...loaded.doc, disabled: { hooks: ['bundled'] } } },
      { doc: { skills: { rules: [{ id: 'a', kind: 'project', path: '../escape', enabled: true }] } } },
    ]
    for (const body of bad) expect((await putSources(base, wsId, body)).status, JSON.stringify(body)).toBe(400)
  })

  it('unknown workspaces fail closed', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/api/workspaces/nope/sources`)).status).toBe(404)
  })
})

describe('legacy /skills/sources adapter', () => {
  it('writes through the shared document and keeps the other kinds', async () => {
    const { base, wsId } = await start()
    const loaded = await getSources(base, wsId)
    await putSources(base, wsId, { doc: { ...loaded.doc, disabled: { ...loaded.doc.disabled, hooks: ['user'] } }, expectedHash: loaded.hash })

    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'workspace', kind: 'workspace', enabled: true }] }),
    })
    expect(put.status).toBe(200)
    const after = await getSources(base, wsId)
    expect(after.doc.skills.rules).toEqual([{ id: 'workspace', kind: 'workspace', enabled: true }])
    expect(after.doc.disabled['hooks']).toEqual(['user'])
    const viaOld = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: { id: string }[] }
    expect(viaOld.rules.map((rule) => rule.id)).toEqual(['workspace'])
  })

  it('imports an existing skills/sources.json on first read', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-wssrc-legacy-'))
    dirs.push(home)
    // The workspace id is only known after boot; seed through a first boot, then restart on the same home.
    const first = await createWebServer({ home, configFile: path.join(home, 'p.json') })
    const wsId = ((await (await fetch(`${first.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    await first.close()
    await fs.mkdir(path.join(home, 'workspaces', wsId, 'skills'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'skills', 'sources.json'), JSON.stringify({ rules: [{ id: 'old', kind: 'workspace', enabled: false }] }), 'utf8')
    const second = await createWebServer({ home, configFile: path.join(home, 'p.json') })
    servers.push(second)
    expect((await getSources(second.url, wsId)).doc.skills.rules).toEqual([{ id: 'old', kind: 'workspace', enabled: false }])
  })
})

describe('switches reach discovery', () => {
  it('agents: disabling bundled and user layers removes their roles from the catalog and spawn lookup', async () => {
    const { base, wsId, claude } = await start()
    await fs.mkdir(path.join(claude, 'agents'), { recursive: true })
    await fs.writeFile(path.join(claude, 'agents', 'from-user.md'), '---\nname: from-user\ndescription: user role\n---\n\nbody\n', 'utf8')
    expect(await agentNames(base, wsId)).toEqual(expect.arrayContaining(['explorer', 'from-user']))

    const loaded = await getSources(base, wsId)
    await putSources(base, wsId, { doc: { ...loaded.doc, disabled: { ...loaded.doc.disabled, agents: ['bundled', 'user'] } }, expectedHash: loaded.hash })
    expect(await agentNames(base, wsId)).toEqual([])
    expect((await fetch(`${base}/api/workspaces/${wsId}/agents/from-user`)).status).toBe(404)

    const again = await getSources(base, wsId)
    await putSources(base, wsId, { doc: { ...again.doc, disabled: { ...again.doc.disabled, agents: [] } }, expectedHash: again.hash })
    expect(await agentNames(base, wsId)).toEqual(expect.arrayContaining(['explorer', 'from-user']))
  })

  it('hooks: disabling the user layer drops its hooks from the effective list', async () => {
    const { base, wsId, claude } = await start()
    await fs.writeFile(path.join(claude, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo from-user' }] }] } }), 'utf8')
    const effective = async (): Promise<{ command: string; layer: string }[]> =>
      ((await (await fetch(`${base}/api/workspaces/${wsId}/hooks`)).json()) as { effective: { command: string; layer: string }[] }).effective
    expect((await effective()).map((hook) => hook.layer)).toContain('user')

    const loaded = await getSources(base, wsId)
    await putSources(base, wsId, { doc: { ...loaded.doc, disabled: { ...loaded.doc.disabled, hooks: ['user'] } }, expectedHash: loaded.hash })
    expect((await effective()).map((hook) => hook.layer)).not.toContain('user')
  })

  it('commands: disabling the workspace layer removes its commands from the catalog', async () => {
    const { base, wsId, home } = await start()
    await fs.mkdir(path.join(home, 'workspaces', wsId, 'commands'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'commands', 'ws-only.md'), 'workspace command body', 'utf8')
    const names = async (): Promise<string[]> =>
      ((await (await fetch(`${base}/api/workspaces/${wsId}/commands`)).json()) as { commands: { name: string }[] }).commands.map((row) => row.name)
    expect(await names()).toContain('ws-only')

    const loaded = await getSources(base, wsId)
    await putSources(base, wsId, { doc: { ...loaded.doc, disabled: { ...loaded.doc.disabled, commands: ['workspace'] } }, expectedHash: loaded.hash })
    expect(await names()).not.toContain('ws-only')
  })
})
