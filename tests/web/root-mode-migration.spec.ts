/** Startup migration for legacy root sessions: backed up and stamped once. */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'ok' } } }
let home = ''
const servers: WebServer[] = []

beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-root-mode-migrate-')) })
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => {})
  await fs.rm(home, { recursive: true, force: true })
})

async function boot(): Promise<WebServer> {
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'providers.json') })
  servers.push(server)
  return server
}

async function post(base: string, url: string, body: unknown): Promise<Response> {
  return fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function log(wsId: string, sid: string): string {
  return path.join(home, 'workspaces', wsId, 'sessions', sid, 'events.jsonl')
}

describe('legacy root mode migration', () => {
  it('backs up one legacy root, skips child logs, and remains idempotent on restart', async () => {
    const first = await boot()
    const wsId = ((await (await fetch(`${first.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    const root = ((await (await post(first.url, `/api/workspaces/${wsId}/sessions`, {})).json()) as { id: string }).id
    await first.close()
    // Simulate a pre-migration root by dropping only its session/mode fact.
    const originalLines = (await fs.readFile(log(wsId, root), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['type'] !== 'session/mode')
      .map((record, index) => JSON.stringify({ ...record, seq: index + 1 }))
    const original = originalLines.join('\n') + '\n'
    await fs.writeFile(log(wsId, root), original)
    const child = 'session-legacy-child'
    const childLog = `${JSON.stringify({ v: 1, seq: 1, timestamp: Date.now(), type: 'session/child-meta', parentSessionId: root, parentTurnId: 'turn-old', definition: 'explorer', brief: 'legacy' })}\n`
    await fs.mkdir(path.dirname(log(wsId, child)), { recursive: true })
    await fs.writeFile(log(wsId, child), childLog)

    const second = await boot()
    const rootEvents = (await fs.readFile(log(wsId, root), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(rootEvents.filter((event) => event.type === 'session/mode')).toHaveLength(1)
    expect(await fs.readFile(log(wsId, child), 'utf8')).toBe(childLog)
    const backup = path.join(home, 'root-mode-backups', wsId, root)
    expect(await fs.readFile(path.join(backup, 'events.jsonl'), 'utf8')).toBe(original)
    const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8')) as { completed: boolean; originalSha256: string }
    expect(manifest.completed).toBe(true)
    expect(manifest.originalSha256).toMatch(/^[a-f0-9]{64}$/)
    await second.close()

    await boot()
    const after = (await fs.readFile(log(wsId, root), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(after.filter((event) => event.type === 'session/mode')).toHaveLength(1)
  })
})
