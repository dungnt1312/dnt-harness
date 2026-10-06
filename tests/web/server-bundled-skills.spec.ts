/**
 * The bundled skill layer over HTTP: repo-shipped skills appear in every
 * catalog surface at the lowest precedence, are shadowed by a workspace
 * skill of the same name, survive a custom rule list, join the file tools'
 * protected roots, and pass their own format validation.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, parseSkill, type LlmProvider, type WebServer } from 'dnt-harness'

let root = ''
let bundled = ''
const servers: WebServer[] = []

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bundled-skills-'))
  bundled = path.join(root, 'bundled-skills')
  await writeBundledSkill('bundled-only', 'BUNDLED STEPS')
  await writeBundledSkill('name-clash', 'BUNDLED CLASH')
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function start(providers?: readonly LlmProvider[]): Promise<{ base: string; home: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bundled-home-'))
  const server = await createWebServer({
    home,
    ...(providers !== undefined ? { providers } : {}),
    configFile: path.join(home, 'p.json'),
    bundledSkillsDir: bundled,
  })
  servers.push(server)
  return { base: server.url, home }
}

const post = async (base: string, pathname: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

const firstWorkspace = async (base: string): Promise<string> =>
  (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id

async function readAllEvents(base: string, wsId: string, sessionId: string): Promise<{ type: string; [key: string]: unknown }[]> {
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
          const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string; [key: string]: unknown }[] }
          return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}

async function writeBundledSkill(name: string, body: string): Promise<void> {
  await fs.mkdir(path.join(bundled, name), { recursive: true })
  await fs.writeFile(path.join(bundled, name, 'SKILL.md'), `---\nname: ${name}\ndescription: bundled fixture for ${name}\n---\n\n${body}`, 'utf8')
}

describe('bundled skill layer', () => {
  it('bundled skills show in the catalog and detail read, and load marks their source', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills`)).json()) as { name: string; source: string }[]
    const row = rows.find((entry) => entry.name === 'bundled-only')
    expect(row).toMatchObject({ source: 'bundled' })

    const detail = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/bundled-only`)).json()) as { source: string; instructions: string }
    expect(detail.source).toBe('bundled')
    expect(detail.instructions).toContain('BUNDLED STEPS')
  })

  it('a workspace skill with the same name shadows the bundled one', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/name-clash`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '---\nname: name-clash\ndescription: workspace copy\n---\n\nWORKSPACE STEPS' }),
    })
    expect(put.status).toBe(200)

    const detail = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/name-clash`)).json()) as { source: string; instructions: string }
    expect(detail.source).toBe('workspace')
    expect(detail.instructions).toContain('WORKSPACE STEPS')
  })

  it('a custom rule list never drops the bundled layer', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'claude', kind: 'project', path: '.claude/skills', enabled: false }] }),
    })
    expect(put.status).toBe(200)

    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills`)).json()) as { name: string }[]
    expect(rows.some((entry) => entry.name === 'bundled-only')).toBe(true)
  })

  it('the bundled folder joins the protected roots and cannot be granted to file tools', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    const proj = await fs.mkdtemp(path.join(root, 'proj-'))
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Guarded', path: proj })).json()) as { id: string }
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }

    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/grants`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, roots: [{ path: bundled, access: 'read' }] }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('overlaps application storage')
  })

  it('the Skill tool catalogs and loads a bundled skill', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls' as const, calls: [{ id: 'c1', name: 'Skill', args: { action: 'catalog' } }] }
          yield { type: 'completion' as const, finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        } else if (step === 2) {
          yield { type: 'toolCalls' as const, calls: [{ id: 'l1', name: 'Skill', args: { action: 'load', name: 'bundled-only' } }] }
          yield { type: 'completion' as const, finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        } else {
          yield { type: 'delta' as const, delta: 'done' }
          yield { type: 'completion' as const, finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        }
      },
    }
    const { base } = await start([provider])
    const wsId = await firstWorkspace(base)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'skills' })

    await expect.poll(async () => {
      const events = await readAllEvents(base, wsId, session.id)
      return events.filter((event) => event.type === 'tool/result').length
    }, { timeout: 6_000 }).toBe(2)
    const results = (await readAllEvents(base, wsId, session.id)).filter((event) => event.type === 'tool/result') as { ok?: boolean; output?: string }[]
    expect(results[0]?.output).toContain('bundled-only [bundled]')
    expect(results[1]).toMatchObject({ ok: true })
    expect(results[1]?.output).toContain("skill 'bundled-only' loaded")
  })

  it('bundled SKILL.md files pass the harness format validation', async () => {
    const entries = await fs.readdir(bundled, { withFileTypes: true })
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const raw = await fs.readFile(path.join(bundled, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseSkill(raw)
      expect(parsed, `${entry.name}/SKILL.md must parse`).toBeDefined()
      expect(raw).toMatch(/^---\nname: [a-z0-9][a-z0-9-]{0,63}\n/m)
      expect(parsed?.description).not.toBe('')
      expect(parsed?.body.trim()).not.toBe('')
      expect(entry.name).toBe(/^name: ([a-z0-9][a-z0-9-]{0,63})$/m.exec(raw)?.[1])
    }
  })
})
