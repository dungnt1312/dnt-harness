/**
 * Root-owned live mode: each conversation owns its mode. Switching one
 * conversation changes its next request and its own pending approvals only;
 * a sibling conversation in the same workspace keeps its mode, and the
 * workspace selection is merely the default new conversations snapshot.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const homes: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

async function start(provider: LlmProvider, home?: string): Promise<{ server: WebServer; home: string; wsId: string }> {
  const dir = home ?? await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-root-mode-'))
  if (home === undefined) homes.push(dir)
  const server = await createWebServer({ home: dir, providers: [provider], configFile: path.join(dir, 'p.json') })
  servers.push(server)
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  return { server, home: dir, wsId }
}

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function createSession(base: string, wsId: string): Promise<string> {
  return ((await (await send('POST', `${base}/api/workspaces/${wsId}/sessions`, {})).json()) as { id: string }).id
}

async function modeOf(base: string, wsId: string, sid: string): Promise<{ modeId: string; source: string }> {
  return (await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${sid}/mode`)).json()) as { modeId: string; source: string }
}

async function settle(base: string, wsId: string, sid: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
    if (rows.find((row) => row.id === sid)?.status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('session did not settle')
}

/** A workspace-authored conversation mode with zero exposure: no tools, no optional sources. */
const ZERO_CONTENT = [
  '---', 'name: Zero', 'toolExposure: []', 'workspaceInstructions: false',
  'skills: off', 'memoryPinned: false', 'memoryRetrieval: false', '---', '', 'No tools.',
].join('\n')

async function saveZeroMode(base: string, wsId: string): Promise<void> {
  expect((await send('PUT', `${base}/api/workspaces/${wsId}/modes/zero`, { content: ZERO_CONTENT })).status).toBe(200)
}

describe('root-owned mode', () => {
  it('switching one conversation never changes a sibling in the same workspace', async () => {
    const requests: { sid: string | undefined; tools: string[] }[] = []
    const spy: LlmProvider = {
      name: 'spy', models: ['spy'],
      async *stream(request: ModelRequest) {
        const first = request.messages.find((message) => message.role === 'user')
        requests.push({ sid: typeof first?.content === 'string' ? first.content : undefined, tools: (request.tools ?? []).map((tool) => tool.name) })
        yield { type: 'delta', delta: 'ok' }
      },
    }
    const { server, wsId } = await start(spy)
    const base = server.url
    const a = await createSession(base, wsId)
    const b = await createSession(base, wsId)
    await saveZeroMode(base, wsId)

    expect((await send('PUT', `${base}/api/workspaces/${wsId}/sessions/${a}/mode`, { modeId: 'zero' })).status).toBe(200)
    expect((await modeOf(base, wsId, a)).modeId).toBe('zero')
    expect((await modeOf(base, wsId, b)).modeId).not.toBe('zero')

    await send('POST', `${base}/api/workspaces/${wsId}/sessions/${a}/messages`, { content: 'A' })
    await send('POST', `${base}/api/workspaces/${wsId}/sessions/${b}/messages`, { content: 'B' })
    await settle(base, wsId, a)
    await settle(base, wsId, b)

    const fromA = requests.find((request) => request.sid === 'A')
    const fromB = requests.find((request) => request.sid === 'B')
    // The zero-exposure mode exposes no tools to A; B keeps its own (default) mode's tools.
    expect(fromA?.tools).toEqual([])
    expect(fromB?.tools.length ?? 0).toBeGreaterThan(0)
  }, 20_000)

  it('the workspace selection only seeds new conversations', async () => {
    const quiet: LlmProvider = { name: 'q', models: ['q'], async *stream() { yield { type: 'delta', delta: 'ok' } } }
    const { server, wsId } = await start(quiet)
    const base = server.url
    const existing = await createSession(base, wsId)
    const before = (await modeOf(base, wsId, existing)).modeId

    expect((await send('PUT', `${base}/api/workspaces/${wsId}/mode`, { modeId: 'plan' })).status).toBe(200)
    expect((await modeOf(base, wsId, existing)).modeId).toBe(before)
    const fresh = await createSession(base, wsId)
    expect(await modeOf(base, wsId, fresh)).toMatchObject({ modeId: 'plan', source: 'session' })
  })

  it('a restart preserves different modes for different conversations', async () => {
    const quiet: LlmProvider = { name: 'q', models: ['q'], async *stream() { yield { type: 'delta', delta: 'ok' } } }
    const first = await start(quiet)
    const a = await createSession(first.server.url, first.wsId)
    const b = await createSession(first.server.url, first.wsId)
    await saveZeroMode(first.server.url, first.wsId)
    await send('PUT', `${first.server.url}/api/workspaces/${first.wsId}/sessions/${a}/mode`, { modeId: 'plan' })
    await send('PUT', `${first.server.url}/api/workspaces/${first.wsId}/sessions/${b}/mode`, { modeId: 'zero' })
    await first.server.close()

    const second = await start(quiet, first.home)
    expect((await modeOf(second.server.url, second.wsId, a)).modeId).toBe('plan')
    expect((await modeOf(second.server.url, second.wsId, b)).modeId).toBe('zero')
  })
})
