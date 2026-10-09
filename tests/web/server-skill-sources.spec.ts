/**
 * Skill source rules over HTTP: defaults, validation, project-scoped catalog
 * and detail reads, and rule containment at read time.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

let root = ''
const servers: WebServer[] = []

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-src-'))
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function start(): Promise<{ base: string; home: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-src-home-'))
  const server = await createWebServer({ home, configFile: path.join(home, 'p.json'), userSkillsDir: path.join(home, 'user-skills') })
  servers.push(server)
  return { base: server.url, home }
}

const post = async (base: string, pathname: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

const firstWorkspace = async (base: string): Promise<string> =>
  (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id

describe('skill sources routes', () => {
  it('GET returns the materialized defaults and PUT round-trips a new list', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const defaults = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: { id: string; kind: string }[] }
    expect(defaults.rules.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])

    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'claude', kind: 'project', path: '.claude/skills', enabled: false }] }),
    })
    expect(put.status).toBe(200)
    const after = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: { id: string; enabled: boolean }[] }
    expect(after.rules).toMatchObject([{ id: 'claude', enabled: false }])
  })

  it('disabling the absolute user source removes its skills from the catalog immediately', async () => {
    const { base, home } = await start()
    const wsId = await firstWorkspace(base)
    const userDir = path.join(home, 'user-skills')
    await fs.mkdir(path.join(userDir, 'global-only'), { recursive: true })
    await fs.writeFile(path.join(userDir, 'global-only', 'SKILL.md'), '---\nname: global-only\ndescription: global\n---\n\nGLOBAL', 'utf8')
    const catalog = async (): Promise<{ name: string }[]> =>
      (await (await fetch(`${base}/api/workspaces/${wsId}/skills`)).json()) as { name: string }[]
    expect((await catalog()).some((row) => row.name === 'global-only')).toBe(true)

    const current = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: Array<{ id: string; kind: string; path?: string; enabled: boolean }> }
    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: current.rules.map((rule) => rule.id === 'user' ? { ...rule, enabled: false } : rule) }),
    })
    expect(put.status).toBe(200)
    expect((await catalog()).some((row) => row.name === 'global-only')).toBe(false)
  })

  it('PUT rejects malformed rule lists with 400', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const bad: unknown[] = [
      { rules: 'no' },
      { rules: [{ id: 'a', kind: 'project', path: '../escape', enabled: true }] },
      { rules: [{ id: 'a', kind: 'absolute', path: 'relative', enabled: true }] },
      { rules: [{ id: 'a', kind: 'galactic', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'b', kind: 'workspace', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'a', kind: 'project', path: 'x', enabled: true }] },
    ]
    for (const body of bad) {
      const response = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
  })

  it('projectId resolves project rule layers for the catalog and one skill read', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'proj-'))
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'dup'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: claude wins\n---\n\nCLAUDE', 'utf8')
    await fs.mkdir(path.join(proj, '.agents', 'skills', 'dup'), { recursive: true })
    await fs.writeFile(path.join(proj, '.agents', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: agents\n---\n\nAGENTS', 'utf8')
    await fs.mkdir(path.join(proj, '.agents', 'skills', 'only-agents'), { recursive: true })
    await fs.writeFile(path.join(proj, '.agents', 'skills', 'only-agents', 'SKILL.md'), '---\nname: only-agents\ndescription: x\n---\n\nA', 'utf8')
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Skilled', path: proj })).json()) as { id: string }

    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills?projectId=${project.id}`)).json()) as { name: string; source: string; ruleId?: string }[]
    expect(rows.find((row) => row.name === 'dup')).toMatchObject({ source: 'project', ruleId: 'project-claude' })
    expect(rows.find((row) => row.name === 'only-agents')).toMatchObject({ source: 'project', ruleId: 'project-agents' })
    const plain = (await (await fetch(`${base}/api/workspaces/${wsId}/skills`)).json()) as { name: string }[]
    expect(plain.some((row) => row.name === 'dup')).toBe(false)

    const detail = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/dup?projectId=${project.id}`)).json()) as { source: string; instructions: string }
    expect(detail.source).toBe('project')
    expect(detail.instructions).toContain('CLAUDE')
    expect((await fetch(`${base}/api/workspaces/${wsId}/skills?projectId=nope`)).status).toBe(400)
  })

  it('lists and reads files inside a skill folder on its owning layer', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'tree-'))
    const skillDir = path.join(proj, '.claude', 'skills', 'tree-skill')
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: tree-skill\ndescription: x\n---\n\nBODY', 'utf8')
    await fs.writeFile(path.join(skillDir, 'scripts', 'run.sh'), 'echo hi', 'utf8')
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Tree', path: proj })).json()) as { id: string }

    const files = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/tree-skill/files?projectId=${project.id}`)).json()) as { files: { path: string }[] }
    expect(files.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])

    const read = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/tree-skill/file?projectId=${project.id}&path=${encodeURIComponent('scripts/run.sh')}`)).json()) as { path: string; content: string }
    expect(read.content).toBe('echo hi')

    const escape = await fetch(`${base}/api/workspaces/${wsId}/skills/tree-skill/file?projectId=${project.id}&path=${encodeURIComponent('../outside.txt')}`)
    expect(escape.status).toBe(400)
    const missing = await fetch(`${base}/api/workspaces/${wsId}/skills/tree-skill/file?projectId=${project.id}&path=nope.txt`)
    expect(missing.status).toBe(404)
    expect((await fetch(`${base}/api/workspaces/${wsId}/skills/no-such/files?projectId=${project.id}`)).status).toBe(404)
  })

  it('an escaping stored rule reads as nothing (containment re-checked at read time)', async () => {    const { base, home } = await start()
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'escape-'))
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Escape', path: proj })).json()) as { id: string }
    // A sibling folder really holds the skill; the escaping rule points at it.
    // Hand-crafted sources.json bypasses PUT validation; the read-time check
    // inside resolveSkillLayers must still refuse the escape.
    const sibling = path.join(root, 'escape-sib')
    await fs.mkdir(path.join(sibling, 'sneaky'), { recursive: true })
    await fs.writeFile(path.join(sibling, 'sneaky', 'SKILL.md'), '---\nname: sneaky\ndescription: x\n---\n\nSNEAKY', 'utf8')
    await fs.mkdir(path.join(home, 'workspaces', wsId, 'skills'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'skills', 'sources.json'), JSON.stringify({ rules: [
      { id: 'sneaky', kind: 'project', path: '../escape-sib', enabled: true },
      { id: 'ws', kind: 'workspace', enabled: true },
    ] }), 'utf8')
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills?projectId=${project.id}`)).json()) as { name: string; source: string }[]
    expect(rows.every((row) => row.source !== 'project')).toBe(true)
  })

  it('DELETE refuses traversal names and never removes anything outside the skill folder', async () => {
    const { base, home } = await start()
    const wsId = await firstWorkspace(base)
    const canary = path.join(home, 'workspaces', wsId, 'canary.txt')
    await fs.writeFile(canary, 'alive', 'utf8')
    for (const name of ['..%2F..', '..%2F..%2F..', '..', 'a%2Fb', 'UPPER']) {
      const response = await fetch(`${base}/api/workspaces/${wsId}/skills/${name}`, { method: 'DELETE' })
      expect([400, 404, 405]).toContain(response.status)
    }
    expect(await fs.readFile(canary, 'utf8')).toBe('alive')
    expect((await fs.stat(path.join(home, 'workspaces'))).isDirectory()).toBe(true)
    // A well-formed name still deletes its own folder.
    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/gone-soon`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '---\nname: gone-soon\ndescription: x\n---\n\nBODY' }),
    })
    expect(put.status).toBe(200)
    expect((await fetch(`${base}/api/workspaces/${wsId}/skills/gone-soon`, { method: 'DELETE' })).status).toBe(200)
    expect(await fs.stat(path.join(home, 'workspaces', wsId, 'skills', 'gone-soon')).catch(() => undefined)).toBeUndefined()
  })

  it('file preview refuses a symlink that points outside the skill folder', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'link-'))
    const secret = path.join(root, `secret-${path.basename(proj)}.txt`)
    await fs.writeFile(secret, 'TOP SECRET', 'utf8')
    const skillDir = path.join(proj, '.claude', 'skills', 'linky')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: linky\ndescription: x\n---\n\nBODY', 'utf8')
    await fs.writeFile(path.join(skillDir, 'inside.txt'), 'fine', 'utf8')
    await fs.symlink(secret, path.join(skillDir, 'leak.txt'))
    await fs.symlink(path.join(skillDir, 'inside.txt'), path.join(skillDir, 'alias.txt'))
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Link', path: proj })).json()) as { id: string }
    const read = (rel: string): Promise<Response> =>
      fetch(`${base}/api/workspaces/${wsId}/skills/linky/file?projectId=${project.id}&path=${encodeURIComponent(rel)}`)
    const leak = await read('leak.txt')
    expect(leak.status).toBe(400)
    expect(await leak.text()).not.toContain('TOP SECRET')
    // An in-folder symlink still previews.
    const alias = await read('alias.txt')
    expect(alias.status).toBe(200)
    expect(((await alias.json()) as { content: string }).content).toBe('fine')
  })

  it('the catalog skips folders whose names cannot be loaded', async () => {
    const { base, home } = await start()
    const wsId = await firstWorkspace(base)
    const dir = path.join(home, 'workspaces', wsId, 'skills')
    for (const name of ['Bad Name', 'UPPER', 'good-one']) {
      await fs.mkdir(path.join(dir, name), { recursive: true })
      await fs.writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: x\ndescription: y\n---\n\n${name}`, 'utf8')
    }
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills`)).json()) as { name: string }[]
    expect(rows.map((row) => row.name)).toEqual(['good-one'])
  })

  it('PUT refuses a too-broad absolute rule (drive root or home)', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    for (const bad of ['/', '~']) {
      const response = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: [{ id: 'wide', kind: 'absolute', path: bad, enabled: true }, { id: 'ws', kind: 'workspace', enabled: true }] }),
      })
      expect(response.status).toBe(400)
    }
  })

  it('a stored too-broad rule keeps the rest of the list (no silent reset to defaults)', async () => {
    const { base, home } = await start()
    const wsId = await firstWorkspace(base)
    await fs.mkdir(path.join(home, 'workspaces', wsId, 'skills'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'skills', 'sources.json'), JSON.stringify({ rules: [
      { id: 'legacy-home', kind: 'absolute', path: '~', enabled: true },
      { id: 'custom', kind: 'project', path: 'my/skills', enabled: true },
      { id: 'ws', kind: 'workspace', enabled: false },
    ] }), 'utf8')
    const got = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: { id: string }[] }
    expect(got.rules.map((rule) => rule.id)).toEqual(['legacy-home', 'custom', 'ws'])
    // The UI re-sends the whole list: disabling the broad rule must be accepted.
    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [
        { id: 'legacy-home', kind: 'absolute', path: '~', enabled: false },
        { id: 'custom', kind: 'project', path: 'my/skills', enabled: true },
        { id: 'ws', kind: 'workspace', enabled: false },
      ] }),
    })
    expect(put.status).toBe(200)
  })

  it("a skill named 'sources' cannot be created (it collides with the rules route)", async () => {
    const { base, home } = await start()
    const wsId = await firstWorkspace(base)
    const response = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '---\nname: sources\ndescription: x\n---\n\nBODY' }),
    })
    expect(response.status).toBe(400)
    expect(await fs.stat(path.join(home, 'workspaces', wsId, 'skills', 'sources')).catch(() => undefined)).toBeUndefined()
  })

  it('a save reports warnings when the workspace copy is disabled or shadowed', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'shadow-'))
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'twin'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'twin', 'SKILL.md'), '---\nname: twin\ndescription: p\n---\n\nPROJECT', 'utf8')
    await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Shadowy', path: proj })
    const save = async (name: string): Promise<{ warnings?: string[] }> => (await (await fetch(`${base}/api/workspaces/${wsId}/skills/${name}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `---\nname: ${name}\ndescription: w\n---\n\nWORKSPACE` }),
    })).json()) as { warnings?: string[] }
    expect((await save('solo')).warnings).toBeUndefined()
    expect((await save('twin')).warnings?.join(' ')).toContain('Shadowy')

    await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'ws', kind: 'workspace', enabled: false }] }),
    })
    expect((await save('solo')).warnings?.join(' ')).toMatch(/disabled/)
  })

  it('absolute rule folders of every workspace stay ungrantable, across restarts', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-protect-home-'))
    const area = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-protect-')))
    const folderA = path.join(area, 'skills-a')
    const folderB = path.join(area, 'skills-b')
    const projectDir = path.join(area, 'project')
    for (const dir of [folderA, folderB, projectDir]) await fs.mkdir(dir, { recursive: true })
    const boot = async (): Promise<WebServer> => {
      const server = await createWebServer({ home, configFile: path.join(home, 'p.json') })
      servers.push(server)
      return server
    }
    const putRules = (base: string, wsId: string, folder: string): Promise<Response> => fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'ws', kind: 'workspace', enabled: true }, { id: 'shared', kind: 'absolute', path: folder, enabled: true }] }),
    })
    const first = await boot()
    const wsOne = await firstWorkspace(first.url)
    const wsTwo = ((await (await post(first.url, '/api/workspaces', { name: 'Second' })).json()) as { id: string }).id
    expect((await putRules(first.url, wsOne, folderA)).status).toBe(200)
    // A second workspace's save must not drop the first workspace's folder.
    expect((await putRules(first.url, wsTwo, folderB)).status).toBe(200)

    const grantStatus = async (base: string, folder: string): Promise<number> => {
      const project = (await (await post(base, `/api/workspaces/${wsOne}/projects`, { name: `P${Math.random()}`, path: projectDir })).json()) as { id: string }
      const session = (await (await post(base, `/api/workspaces/${wsOne}/sessions`, { projectId: project.id })).json()) as { id: string }
      const response = await fetch(`${base}/api/workspaces/${wsOne}/sessions/${session.id}/grants`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, roots: [{ path: folder, access: 'read' }] }),
      })
      return response.status
    }
    expect(await grantStatus(first.url, folderA)).toBe(400)
    expect(await grantStatus(first.url, folderB)).toBe(400)
    await first.close()

    // Persisted rules protect their folders from the first request after a restart.
    const second = await boot()
    expect(await grantStatus(second.url, folderA)).toBe(400)
    expect(await grantStatus(second.url, folderB)).toBe(400)
    await second.close()
    await fs.rm(area, { recursive: true, force: true })
  })

/** Read the session's current snapshot (first SSE frame), then cancel the stream. */
async function readAllEvents(base: string, wsId: string, sessionId: string): Promise<Array<{ type: string; ok?: boolean; output?: string }>> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 6_000
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine !== undefined) {
          const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string; ok?: boolean; output?: string }[] }
          return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}

describe('Skill tool with project layers', () => {
  it('catalog and load resolve project-layer skills for a bound session', async () => {
    const seen: string[] = []
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n'))
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls' as const, calls: [{ id: 'c1', name: 'Skill', args: { action: 'catalog' } }] }
          yield { type: 'completion' as const, finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        } else if (step === 2) {
          yield { type: 'toolCalls' as const, calls: [{ id: 'l1', name: 'Skill', args: { action: 'load', name: 'proj-skill' } }] }
          yield { type: 'completion' as const, finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        } else {
          yield { type: 'delta' as const, delta: 'done' }
          yield { type: 'completion' as const, finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-tool-home-'))
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), userSkillsDir: path.join(home, 'user-skills') })
    servers.push(server)
    const base = server.url
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'tool-proj-'))
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'proj-skill'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: from the project\n---\n\nPROJECT STEPS', 'utf8')
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Tooled', path: proj })).json()) as { id: string }
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'skills' })

    await expect.poll(async () => {
      const events = await readAllEvents(base, wsId, session.id)
      return events.filter((event) => event.type === 'tool/result').length
    }, { timeout: 6_000 }).toBe(2)
    const results = (await readAllEvents(base, wsId, session.id)).filter((event) => event.type === 'tool/result')
    expect(results[0]?.output).toContain('proj-skill [project]')
    expect(results[1]).toMatchObject({ ok: true })
    expect(results[1]?.output).toContain("skill 'proj-skill' loaded")
    expect(seen[0]).toContain(path.join(home, 'workspaces', wsId, 'skills'))
    expect(seen[0]).toContain('These locations are not filesystem grants')
  })

  it("a child definition's skills preload through the rule layers (project folder included)", async () => {
    const seen: string[] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n'))
        yield { type: 'delta' as const, delta: 'done' }
        yield { type: 'completion' as const, finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-child-home-'))
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'child-proj-'))
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'proj-recipe'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'proj-recipe', 'SKILL.md'), '---\nname: proj-recipe\ndescription: p\n---\n\nPROJECT RECIPE BODY', 'utf8')
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Childish', path: proj })).json()) as { id: string }
    expect((await post(base, `/api/workspaces/${wsId}/agents/reciper/import`, {
      dialect: 'dnt-harness',
      content: '---\nname: reciper\ndescription: uses the project recipe\ntools: ["Read"]\nskills: ["proj-recipe"]\n---\n\nFollow the recipe.',
    })).status).toBe(201)
    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/reciper`, { rootSessionId: rootSession.id, task: { objective: 'cook' } })
    expect(spawned.status).toBe(202)
    const handle = (await spawned.json()) as { childSessionId: string }
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${rootSession.id}/children/${handle.childSessionId}?waitMs=8000`)
    expect(seen.some((text) => text.includes('PROJECT RECIPE BODY'))).toBe(true)
    expect(seen.some((text) => text.includes('Harness authoring reference') && text.includes(path.join(home, 'workspaces', wsId, 'agents')))).toBe(true)
  }, 20_000)
})
})

