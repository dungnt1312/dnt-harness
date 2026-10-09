/**
 * Settings → System Prompts: per-workspace replacements for the fixed
 * harness prompts. Covers the GET/PUT surface (defaults, override, CAS
 * conflict, validation), workspace isolation, corrupt-file degradation, and
 * the real effect: the next request assembled in that workspace carries the
 * override as its system block instead of the default text.
 */
import { tmpdir } from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, DEFAULT_BASE_SYSTEM, DEFAULT_CHILD_SYSTEM, type LlmProvider, type WebServer } from 'dnt-harness'

let root = ''
const servers: WebServer[] = []
const serverHomes = new WeakMap<WebServer, string>()

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-prompts-web-'))
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function start(providers: readonly LlmProvider[]): Promise<WebServer> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-prompts-home-'))
  const server = await createWebServer({ home, providers, configFile: path.join(home, 'p.json') })
  servers.push(server)
  serverHomes.set(server, home)
  return server
}

const getJson = async <T>(base: string, pathname: string): Promise<T> => (await (await fetch(`${base}${pathname}`)).json()) as T
const putPrompts = (base: string, wsId: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/workspaces/${wsId}/system-prompts`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

interface PromptsView {
  readonly base: { readonly text: string; readonly overridden: boolean }
  readonly child: { readonly text: string; readonly overridden: boolean }
  readonly defaults: { readonly base: string; readonly child: string }
  readonly hash: string
  readonly warning?: string
}

const getPrompts = (base: string, wsId: string): Promise<PromptsView> => getJson(base, `/api/workspaces/${wsId}/system-prompts`)
const workspaceIds = (base: string): Promise<string[]> => getJson<{ readonly id: string }[]>(base, '/api/workspaces').then((rows) => rows.map((row) => row.id))

describe('system prompt overrides', () => {
  it('GET returns the defaults until anything is saved', async () => {
    const server = await start([])
    const wsId = (await workspaceIds(server.url))[0]!
    const view = await getPrompts(server.url, wsId)
    expect(view.base).toEqual({ text: DEFAULT_BASE_SYSTEM, overridden: false })
    expect(view.child).toEqual({ text: DEFAULT_CHILD_SYSTEM, overridden: false })
    expect(view.defaults.base).toBe(DEFAULT_BASE_SYSTEM)
    expect(view.defaults.child).toBe(DEFAULT_CHILD_SYSTEM)
    expect(view.warning).toBeUndefined()
  })

  it('PUT saves an override; the next request carries it as the system block', async () => {
    const requests: { system: string }[] = []
    const spy: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        const first = request.messages[0]
        requests.push({ system: typeof first?.content === 'string' ? first.content : '' })
        yield { type: 'delta', delta: 'ack' }
      },
    }
    const server = await start([spy])
    const base = server.url
    const wsId = (await workspaceIds(base))[0]!
    const before = await getPrompts(base, wsId)

    const saved = await putPrompts(base, wsId, { base: 'HOUSE BASE: answer in numbered lists.', child: '' })
    expect(saved.status).toBe(200)
    const after = await getPrompts(base, wsId)
    expect(after.base).toEqual({ text: 'HOUSE BASE: answer in numbered lists.', overridden: true })
    expect(after.child).toEqual({ text: DEFAULT_CHILD_SYSTEM, overridden: false })
    expect(after.hash).not.toBe(before.hash)

    const created = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    const session = (await created.json()) as { id: string }
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }),
    })
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBe(1)
    expect(requests[0]?.system.startsWith('HOUSE BASE: answer in numbered lists.')).toBe(true)
    expect(requests[0]?.system).not.toContain(DEFAULT_BASE_SYSTEM)

    // A blank save clears the override; the default rides the next request.
    expect((await putPrompts(base, wsId, { base: '   ' })).status).toBe(200)
    const cleared = await getPrompts(base, wsId)
    expect(cleared.base).toEqual({ text: DEFAULT_BASE_SYSTEM, overridden: false })
  })

  it('workspaces are isolated: a save in one leaves the others untouched', async () => {
    const server = await start([])
    const base = server.url
    await fetch(`${base}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Elsewhere' }),
    })
    const ids = await workspaceIds(base)
    expect(ids.length).toBeGreaterThanOrEqual(2)

    expect((await putPrompts(base, ids[0]!, { base: 'ONLY THIS PROFILE' })).status).toBe(200)
    const untouched = await getPrompts(base, ids[1]!)
    expect(untouched.base.overridden).toBe(false)
    expect(untouched.base.text).toBe(DEFAULT_BASE_SYSTEM)
    const overridden = await getPrompts(base, ids[0]!)
    expect(overridden.base.text).toBe('ONLY THIS PROFILE')
  })

  it('a stale expectedHash conflicts instead of overwriting', async () => {
    const server = await start([])
    const base = server.url
    const wsId = (await workspaceIds(base))[0]!
    const first = await getPrompts(base, wsId)
    expect((await putPrompts(base, wsId, { base: 'ONE', expectedHash: first.hash })).status).toBe(200)
    // The hash moved; replaying the old one must be refused.
    expect((await putPrompts(base, wsId, { base: 'TWO', expectedHash: first.hash })).status).toBe(409)
    const view = await getPrompts(base, wsId)
    expect(view.base.text).toBe('ONE')
  })

  it('oversized or non-string prompts are refused', async () => {
    const server = await start([])
    const base = server.url
    const wsId = (await workspaceIds(base))[0]!
    expect((await putPrompts(base, wsId, { base: 'x'.repeat(20_001) })).status).toBe(400)
    expect((await putPrompts(base, wsId, { base: 42 })).status).toBe(400)
    expect((await putPrompts(base, wsId, { base: 'fine', child: 42 })).status).toBe(400)
    const view = await getPrompts(base, wsId)
    expect(view.base.overridden).toBe(false)
  })

  it('a system-prompts.json FIFO is ignored without blocking chat', async () => {
    if (process.platform === 'win32') return
    let calls = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        calls += 1
        yield { type: 'delta', delta: 'ok' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const server = await start([provider])
    const base = server.url
    const wsId = (await workspaceIds(base))[0]!
    const home = serverHomes.get(server)!
    const workspaceDir = path.join(home, 'workspaces', wsId)
    await fs.mkdir(workspaceDir, { recursive: true })
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => execFile('mkfifo', [path.join(workspaceDir, 'system-prompts.json')], (error) => error === null ? resolve() : reject(error)))
    const session = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' }).then((response) => response.json()) as { id: string }
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }),
    })
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1)
  })

  it('an unknown workspace 404s and a corrupt file degrades to defaults with a warning', async () => {
    const server = await start([])
    const base = server.url
    expect((await fetch(`${base}/api/workspaces/ws-nope/system-prompts`)).status).toBe(404)

    const wsId = (await workspaceIds(base))[0]!
    const home = serverHomes.get(server)!
    await fs.mkdir(path.join(home, 'workspaces', wsId), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'system-prompts.json'), '{ broken', 'utf8')
    const view = await getPrompts(base, wsId)
    expect(view.base.overridden).toBe(false)
    expect(view.base.text).toBe(DEFAULT_BASE_SYSTEM)
    expect(view.warning).toMatch(/corrupt/)
  })
})
