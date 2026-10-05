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
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
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
  })
})
})

