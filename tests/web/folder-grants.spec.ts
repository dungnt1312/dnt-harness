/**
 * Extra file-tool folders ("grants") through the web host: project-level
 * `additionalDirectories` (validated, persisted), session grants
 * (revision-checked, durable across restart), the effective merge, the
 * model being told which folders it may use, file tools actually writing
 * into a granted folder, and child agents receiving the parent's grants.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelRequest, type WebServer } from 'mini-dsh'

let home = ''
let primary = ''
let shared = ''
let docs = ''
let otherRoot = ''
let server: WebServer | undefined

const requests: ModelRequest[] = []
/** Held by a test to pause a child agent's first request (resolved by default). */
let childGate: Promise<void> = Promise.resolve()

const systemText = (request: ModelRequest): string =>
  request.messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')

/** Writes into the shared folder once per turn, then answers. */
const writer: LlmProvider = {
  name: 'writer',
  models: ['writer'],
  async *stream(request) {
    requests.push(request)
    // A child lists the project on its first request, so it makes a second one.
    if (systemText(request).includes('subagent') && !request.messages.some((message) => message.role === 'tool')) {
      await childGate
      yield { type: 'toolCalls', calls: [{ id: `g-${Math.random()}`, name: 'Glob', args: { pattern: '*' } }] }
      return
    }
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    if (text.startsWith('write ') && !request.messages.some((message) => message.role === 'tool')) {
      const target = text.slice('write '.length)
      yield { type: 'toolCalls', calls: [{ id: `w-${Math.random()}`, name: 'Write', args: { path: target, content: 'granted' } }] }
      return
    }
    yield { type: 'delta', delta: 'done' }
  },
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function start(): Promise<WebServer> {
  server = await createWebServer({ home, providers: [writer], configFile: path.join(home, 'providers.json') })
  return server
}

beforeEach(async () => {
  requests.length = 0
  childGate = Promise.resolve()
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-grants-')))
  home = path.join(base, 'home')
  primary = path.join(base, 'primary')
  shared = path.join(base, 'shared')
  docs = path.join(base, 'docs')
  otherRoot = path.join(base, 'other')
  for (const dir of [home, primary, shared, docs, otherRoot]) await fs.mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await fs.rm(path.dirname(home), { recursive: true, force: true })
})

async function setup(base: string): Promise<{ wsId: string; projectId: string; otherId: string; sessionId: string }> {
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const projectId = String((await json(await send('POST', `${base}/api/workspaces/${wsId}/projects`, { name: 'Main', path: primary }))).id)
  const otherId = String((await json(await send('POST', `${base}/api/workspaces/${wsId}/projects`, { name: 'Other', path: otherRoot }))).id)
  const sessionId = String((await json(await send('POST', `${base}/api/workspaces/${wsId}/sessions`, { projectId }))).id)
  return { wsId, projectId, otherId, sessionId }
}

describe('folder grants', () => {
  it('project additionalDirectories are validated and persisted', async () => {
    const { url: base } = await start()
    const { wsId, projectId, otherId } = await setup(base)
    const patch = (additionalDirectories: unknown): Promise<Response> =>
      send('PATCH', `${base}/api/workspaces/${wsId}/projects/${projectId}`, { additionalDirectories })

    expect((await patch([{ kind: 'path', path: 'relative/dir', access: 'read' }])).status).toBe(400)
    expect((await patch([{ kind: 'path', path: path.join(primary, 'sub'), access: 'read' }])).status).toBe(400)
    await fs.mkdir(path.join(primary, 'sub'))
    expect((await patch([{ kind: 'path', path: path.join(primary, 'sub'), access: 'read' }])).status).toBe(400) // inside primary
    expect((await patch([{ kind: 'path', path: home, access: 'read' }])).status).toBe(400) // app storage
    expect((await patch([{ kind: 'path', path: path.parse(primary).root, access: 'read' }])).status).toBe(400) // drive root
    expect((await patch([{ kind: 'path', path: '\\\\host\\share', access: 'read' }])).status).toBe(400)
    expect((await patch([{ kind: 'path', path: shared, access: 'admin' }])).status).toBe(400)

    const ok = await patch([
      { kind: 'path', path: shared, access: 'write' },
      { kind: 'project', projectId: otherId, access: 'read' },
    ])
    expect(ok.status).toBe(200)
    const record = JSON.parse(await fs.readFile(
      path.join(home, 'workspaces', ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id, 'projects', projectId, 'project.json'),
      'utf8',
    )) as { additionalDirectories?: unknown[] }
    expect(record.additionalDirectories).toEqual([
      { kind: 'path', path: shared, access: 'write' },
      { kind: 'project', projectId: otherId, access: 'read' },
    ])
  })

  it('session grants are revision-checked, merged with project grants, and survive restart', async () => {
    const first = await start()
    const { wsId, projectId, sessionId } = await setup(first.url)
    await send('PATCH', `${first.url}/api/workspaces/${wsId}/projects/${projectId}`, { additionalDirectories: [{ kind: 'path', path: docs, access: 'read' }] })
    const grantsUrl = `${first.url}/api/workspaces/${wsId}/sessions/${sessionId}/grants`

    const initial = await json(await fetch(grantsUrl))
    expect(initial.revision).toBe(0)
    expect(initial.effective).toEqual([{ path: docs, access: 'read' }])

    expect((await send('PUT', grantsUrl, { expectedRevision: 5, roots: [] })).status).toBe(409)
    expect((await send('PUT', grantsUrl, { expectedRevision: 0, roots: [{ path: primary, access: 'write' }] })).status).toBe(400)
    const put = await json(await send('PUT', grantsUrl, { expectedRevision: 0, roots: [{ path: shared, access: 'write' }, { path: docs, access: 'write' }] }))
    expect(put.revision).toBe(1)
    // The session's write on docs wins over the project's read.
    expect(put.effective).toEqual([{ path: docs, access: 'write' }, { path: shared, access: 'write' }])

    await first.close()
    server = undefined
    const second = await start()
    const reloaded = await json(await fetch(`${second.url}/api/workspaces/${wsId}/sessions/${sessionId}/grants`))
    expect(reloaded.revision).toBe(1)
    expect(reloaded.roots).toEqual([{ path: shared, access: 'write' }, { path: docs, access: 'write' }])
  }, 20_000)

  it('file tools write into a granted folder and the model is told the granted folders', async () => {
    const { url: base } = await start()
    const { wsId, sessionId } = await setup(base)
    expect((await send('PUT', `${base}/api/workspaces/${wsId}/mode`, { modeId: 'full-access' })).status).toBe(200)
    await send('PUT', `${base}/api/workspaces/${wsId}/sessions/${sessionId}/grants`, { expectedRevision: 0, roots: [{ path: shared, access: 'write' }] })
    const target = path.join(shared, 'from-agent.txt')
    await send('POST', `${base}/api/workspaces/${wsId}/sessions/${sessionId}/messages`, { content: `write ${target}` })
    expect(await waitFor(() => fs.readFile(target, 'utf8').catch(() => undefined), 'granted write')).toBe('granted')
    const system = requests[0]?.messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n') ?? ''
    expect(system).toContain(`Project folder (relative paths resolve here, read-write): ${primary}`)
    expect(system).toContain(`Granted folder (read-write, use absolute paths): ${shared}`)
  }, 20_000)

  it('a refused folder leaves the rest of a project update unapplied', async () => {
    const { url: base } = await start()
    const { wsId, projectId } = await setup(base)
    const refused = await send('PATCH', `${base}/api/workspaces/${wsId}/projects/${projectId}`, {
      name: 'Renamed',
      additionalDirectories: [{ kind: 'path', path: home, access: 'read' }],
    })
    expect(refused.status).toBe(400)
    const projects = (await (await fetch(`${base}/api/workspaces/${wsId}/projects`)).json()) as { id: string; name: string }[]
    expect(projects.find((project) => project.id === projectId)?.name).toBe('Main')
  })

  it('a child agent\'s folders cannot be changed directly', async () => {
    const { url: base } = await start()
    const { wsId, sessionId } = await setup(base)
    const spawned = (await (await send('POST', `${base}/api/workspaces/${wsId}/agents/explorer`, { rootSessionId: sessionId, task: { prompt: 'Look around.' } })).json()) as { childSessionId: string }
    const put = await send('PUT', `${base}/api/workspaces/${wsId}/sessions/${spawned.childSessionId}/grants`, { expectedRevision: 0, roots: [{ path: shared, access: 'write' }] })
    expect([404, 409]).toContain(put.status)
  }, 20_000)

  it('a grant naming another project follows that project when it moves', async () => {
    const { url: base } = await start()
    const { wsId, projectId, otherId, sessionId } = await setup(base)
    await send('PATCH', `${base}/api/workspaces/${wsId}/projects/${projectId}`, { additionalDirectories: [{ kind: 'project', projectId: otherId, access: 'read' }] })
    const grantsUrl = `${base}/api/workspaces/${wsId}/sessions/${sessionId}/grants`
    expect((await json(await fetch(grantsUrl))).effective).toEqual([{ path: otherRoot, access: 'read' }])

    const moved = path.join(path.dirname(otherRoot), 'other-moved')
    await fs.mkdir(moved)
    expect((await send('PATCH', `${base}/api/workspaces/${wsId}/projects/${otherId}`, { path: moved })).status).toBe(200)
    expect((await json(await fetch(grantsUrl))).effective).toEqual([{ path: moved, access: 'read' }])
  })

  it('a folder the parent gains after spawn stays invisible to a running child', async () => {
    const { url: base } = await start()
    const { wsId, sessionId } = await setup(base)
    let release: () => void = () => {}
    childGate = new Promise<void>((resolve) => { release = resolve })
    const grantsUrl = `${base}/api/workspaces/${wsId}/sessions/${sessionId}/grants`
    await send('PUT', grantsUrl, { expectedRevision: 0, roots: [{ path: docs, access: 'read' }] })
    expect((await send('POST', `${base}/api/workspaces/${wsId}/agents/explorer`, { rootSessionId: sessionId, task: { prompt: 'Look around.' } })).status).toBe(202)
    await waitFor(() => requests.find((request) => systemText(request).includes('subagent')), 'first child request')

    // The parent gains a folder while the child is mid-run.
    await send('PUT', grantsUrl, { expectedRevision: 1, roots: [{ path: docs, access: 'read' }, { path: shared, access: 'write' }] })
    release()
    const second = await waitFor(
      () => requests.find((request) => systemText(request).includes('subagent') && request.messages.some((message) => message.role === 'tool')),
      'second child request',
    )
    expect(systemText(second)).toContain(`Granted folder (read-only, use absolute paths): ${docs}`)
    expect(systemText(second)).not.toContain(shared)
  }, 20_000)

  it('a child agent receives the parent session grants at spawn', async () => {
    const { url: base } = await start()
    const { wsId, sessionId } = await setup(base)
    await send('PUT', `${base}/api/workspaces/${wsId}/sessions/${sessionId}/grants`, { expectedRevision: 0, roots: [{ path: docs, access: 'read' }] })
    const spawned = await send('POST', `${base}/api/workspaces/${wsId}/agents/explorer`, { rootSessionId: sessionId, task: { prompt: 'Look around.' } })
    expect(spawned.status).toBe(202)
    const childRequest = await waitFor(
      () => requests.find((request) => request.messages.some((message) => message.role === 'system' && String(message.content).includes('subagent'))),
      'child request',
    )
    const system = childRequest.messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
    expect(system).toContain(`Granted folder (read-only, use absolute paths): ${docs}`)
  }, 20_000)
})
