/** Manual HTTP delegation owns an explicit root Turn, never `ad-hoc`. */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

let server: WebServer | undefined
let home = ''
afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
})

function post(base: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function events(base: string, wsId: string, sid: string): Promise<{ type: string; turnId?: string; kind?: string; parentTurnId?: string }[]> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sid}/events`)
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  try {
    const { value } = await reader.read()
    const data = new TextDecoder().decode(value).split('\n').find((line) => line.startsWith('data: '))
    const snapshot = JSON.parse(data?.slice(6) ?? '{}') as { events?: { type: string; turnId?: string; kind?: string; parentTurnId?: string }[] }
    return snapshot.events ?? []
  } finally { await reader.cancel().catch(() => {}) }
}

describe('manual delegation Turn', () => {
  it('a named batch joins one real Turn and closes after both children settle', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-manual-turn-'))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { await gate; yield { type: 'delta', delta: 'done' } } }
    server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    const base = server.url
    const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    const root = ((await (await post(base, `/api/workspaces/${wsId}/sessions`, {})).json()) as { id: string }).id
    const spawn = (objective: string, extra: Record<string, unknown> = {}) => post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: root, task: { objective }, ...extra,
    })

    const first = await spawn('first', { keepOpen: true })
    expect(first.status).toBe(202)
    const a = await first.json() as { childSessionId: string; parentTurnId: string }
    expect(a.parentTurnId).toMatch(/^turn-/)
    const missingId = await spawn('must name batch')
    expect(missingId.status).not.toBe(202)
    const second = await spawn('second', { parentTurnId: a.parentTurnId })
    expect(second.status).toBe(202)
    const b = await second.json() as { childSessionId: string; parentTurnId: string }
    expect(b.parentTurnId).toBe(a.parentTurnId)
    expect((await spawn('closed', { parentTurnId: a.parentTurnId })).status).not.toBe(202)

    let log = await events(base, wsId, root)
    expect(log.filter((event) => event.type === 'turn/start' && event.kind === 'delegation')).toHaveLength(1)
    expect(log.filter((event) => event.type === 'agent/child-spawn' && event.parentTurnId === a.parentTurnId)).toHaveLength(2)
    expect(log.some((event) => event.parentTurnId === 'ad-hoc')).toBe(false)
    expect(log.some((event) => event.type === 'turn/closing' && event.turnId === a.parentTurnId)).toBe(true)
    expect(log.some((event) => event.type === 'turn/end' && event.turnId === a.parentTurnId)).toBe(false)

    release()
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      log = await events(base, wsId, root)
      if (log.some((event) => event.type === 'turn/end' && event.turnId === a.parentTurnId)) break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    expect(log.some((event) => event.type === 'turn/end' && event.turnId === a.parentTurnId)).toBe(true)
    expect(log.filter((event) => event.type === 'agent/child-result' && event.parentTurnId === a.parentTurnId)).toHaveLength(2)
  }, 20_000)
})
