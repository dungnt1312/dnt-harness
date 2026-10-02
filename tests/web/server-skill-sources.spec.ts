/**
 * Skill source rules over HTTP: defaults, validation, project-scoped catalog
 * and detail reads, and rule containment at read time.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'mini-dsh'

let root = ''
const servers: WebServer[] = []

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-skill-src-'))
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function start(): Promise<{ base: string; home: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-skill-src-home-'))
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

  it('an escaping stored rule reads as nothing (containment re-checked at read time)', async () => {
    const { base, home } = await start()
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
})
