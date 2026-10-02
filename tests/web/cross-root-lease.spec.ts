/**
 * Writer leases across folders: a write into another project's folder
 * through a grant contends with that project's own running turn; a write
 * question that is still pending (or denied) never holds the other
 * project's lease; leases are hierarchical, so nested folders contend.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebServer, WorkspaceService, type LlmProvider, type WebServer } from 'dnt-harness'
import type { SessionId } from '../../src/util/brand.ts'

let base = ''
let home = ''
let rootX = ''
let rootY = ''
let server: WebServer | undefined
let release: () => void = () => {}
let gate = new Promise<void>((resolve) => { release = resolve })

/**
 * `write <path>` writes once; with ` hold` the turn then stays busy without
 * owning the project folder until the test releases the gate.
 */
const writer: LlmProvider = {
  name: 'writer',
  models: ['writer'],
  async *stream(request) {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const answered = request.messages.slice(request.messages.lastIndexOf(lastUser!)).some((message) => message.role === 'tool')
    const command = /(write|read) (\S+)/.exec(text)
    if (!answered && command !== null) {
      const id = `w-${Math.random().toString(36).slice(2)}`
      yield command[1] === 'read'
        ? { type: 'toolCalls', calls: [{ id, name: 'Read', args: { path: command[2] } }] }
        : { type: 'toolCalls', calls: [{ id, name: 'Write', args: { path: command[2], content: 'x' } }] }
      return
    }
    if (text.includes(' hold')) await gate
    yield { type: 'delta', delta: 'done' }
  },
}

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function idOf(response: Response): Promise<string> {
  return String(((await response.json()) as { id: string }).id)
}

async function toolResults(url: string): Promise<{ ok: boolean; output: string }[]> {
  const response = await fetch(url)
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const { value } = await reader.read()
  await reader.cancel().catch(() => {})
  const data = new TextDecoder().decode(value).split('\n').find((line) => line.startsWith('data: '))
  const snapshot = JSON.parse(data?.slice('data: '.length) ?? '{}') as { events?: { type: string; ok: boolean; output: string }[] }
  return (snapshot.events ?? []).filter((event) => event.type === 'tool/result')
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeEach(async () => {
  gate = new Promise<void>((resolve) => { release = resolve })
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-lease-')))
  home = path.join(base, 'home')
  rootX = path.join(base, 'x')
  rootY = path.join(base, 'y')
  for (const dir of [home, rootX, rootY]) await fs.mkdir(dir, { recursive: true })
})

afterEach(async () => {
  release()
  await server?.close().catch(() => {})
  server = undefined
  await fs.rm(base, { recursive: true, force: true })
})

async function setup(mode: string): Promise<{ url: string; wsId: string; sessionX: string; sessionY: string }> {
  server = await createWebServer({ home, providers: [writer], configFile: path.join(home, 'providers.json') })
  const url = server.url
  const wsId = ((await (await fetch(`${url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  await send('PUT', `${url}/api/workspaces/${wsId}/mode`, { modeId: mode })
  const projectX = await idOf(await send('POST', `${url}/api/workspaces/${wsId}/projects`, { name: 'X', path: rootX }))
  const projectY = await idOf(await send('POST', `${url}/api/workspaces/${wsId}/projects`, { name: 'Y', path: rootY }))
  const sessionX = await idOf(await send('POST', `${url}/api/workspaces/${wsId}/sessions`, { projectId: projectX }))
  const sessionY = await idOf(await send('POST', `${url}/api/workspaces/${wsId}/sessions`, { projectId: projectY }))
  return { url, wsId, sessionX, sessionY }
}

describe('cross-root file independence', () => {
  it('a granted write into another project proceeds while that project has a running turn', async () => {
    const { url, wsId, sessionX, sessionY } = await setup('edit-automatically')
    await send('PUT', `${url}/api/workspaces/${wsId}/sessions/${sessionX}/grants`, { expectedRevision: 0, roots: [{ path: rootY, access: 'write' }] })
    // Y's own turn writes into Y and stays busy; it cannot own the folder.
    await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionY}/messages`, { content: `write ${path.join(rootY, 'own.txt')} hold` })
    await waitFor(() => fs.readFile(path.join(rootY, 'own.txt'), 'utf8').catch(() => undefined), "Y's write")

    await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionX}/messages`, { content: `write ${path.join(rootY, 'from-x.txt')}` })
    const eventsX = `${url}/api/workspaces/${wsId}/sessions/${sessionX}/events`
    const result = await waitFor(async () => (await toolResults(eventsX))[0], "X's tool result")
    expect(result.ok).toBe(true)
    expect(result.output).not.toMatch(/project busy/)
    expect(await fs.readFile(path.join(rootY, 'from-x.txt'), 'utf8')).toBe('x')
  }, 20_000)

  it('reads through a grant while another root is running', async () => {
    const { url, wsId, sessionX, sessionY } = await setup('edit-automatically')
    await send('PUT', `${url}/api/workspaces/${wsId}/sessions/${sessionX}/grants`, { expectedRevision: 0, roots: [{ path: rootY, access: 'read' }] })
    await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionY}/messages`, { content: `write ${path.join(rootY, 'own.txt')} hold` })
    await waitFor(() => fs.readFile(path.join(rootY, 'own.txt'), 'utf8').catch(() => undefined), "Y's write")

    await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionX}/messages`, { content: `read ${path.join(rootY, 'own.txt')}` })
    const result = await waitFor(async () => (await toolResults(`${url}/api/workspaces/${wsId}/sessions/${sessionX}/events`))[0], "X's read")
    expect(result.ok).toBe(true)
    expect(result.output).not.toMatch(/project busy/)
  }, 20_000)

  it('a pending out-of-grant write question never blocks another root', async () => {
    const { url, wsId, sessionX, sessionY } = await setup('edit-automatically')
    // No grant: X's write into Y waits for an out-of-grant approval.
    await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionX}/messages`, { content: `write ${path.join(rootY, 'from-x.txt')}` })
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Meanwhile Y writes into its own folder unhindered.
    await send('POST', `${url}/api/workspaces/${wsId}/sessions/${sessionY}/messages`, { content: `write ${path.join(rootY, 'own.txt')}` })
    expect(await waitFor(() => fs.readFile(path.join(rootY, 'own.txt'), 'utf8').catch(() => undefined), "Y's write")).toBe('x')
  }, 20_000)

  it('the deprecated WorkspaceService lease API still has its legacy hierarchy (not used by ordinary tools)', async () => {
    const service = new WorkspaceService(home)
    await service.acquireRoot(rootY, 'a' as SessionId)
    const nested = path.join(rootY, 'sub')
    await fs.mkdir(nested)
    await expect(service.acquireRoot(nested, 'b' as SessionId)).rejects.toThrow(/another session/)
    await expect(service.acquireRoot(base, 'b' as SessionId)).rejects.toThrow(/another session/)
    await service.acquireRoot(nested, 'a' as SessionId)
    await service.releaseRoot(rootY, 'a' as SessionId)
    await service.releaseRoot(nested, 'a' as SessionId)
    await service.acquireRoot(nested, 'b' as SessionId)
  })
})
