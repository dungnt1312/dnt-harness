/** Startup migration for legacy root sessions: backed up and stamped once. */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebServer, Kernel, SessionsService, type LlmProvider, type WebServer } from 'dnt-harness'
import { migrateRootModes } from '../../src/harness/modes/root-migration.ts'
import { DEFAULT_MODE_ID, ModesService } from '../../src/harness/modes/service.ts'
import type { SessionId, WorkspaceId } from '../../src/util/brand.ts'

const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'ok' } } }
let home = ''
const servers: WebServer[] = []

beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-root-mode-migrate-')) })
afterEach(async () => {
  vi.restoreAllMocks()
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

function marker(): string {
  return path.join(home, 'root-mode-migration.json')
}

/** Rewrite a root's log without its session/mode fact, as a pre-migration log. */
async function stripMode(wsId: string, sid: string): Promise<string> {
  const lines = (await fs.readFile(log(wsId, sid), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['type'] !== 'session/mode')
    .map((record, index) => JSON.stringify({ ...record, seq: index + 1 }))
  const original = lines.join('\n') + '\n'
  await fs.writeFile(log(wsId, sid), original)
  return original
}

async function modeCount(wsId: string, sid: string): Promise<number> {
  return (await fs.readFile(log(wsId, sid), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { type: string })
    .filter((event) => event.type === 'session/mode').length
}

interface MarkerRecord { version: number; completedAt: number; verified: { id: string; lastSeq: number; child?: boolean }[] }

async function readMarker(): Promise<MarkerRecord> {
  return JSON.parse(await fs.readFile(marker(), 'utf8')) as MarkerRecord
}

const CHILD = 'session-legacy-child'

/** A child log the parent never recorded: still a child by its own log. */
async function writeChild(wsId: string, parent: string): Promise<void> {
  await fs.mkdir(path.dirname(log(wsId, CHILD)), { recursive: true })
  await fs.writeFile(log(wsId, CHILD), `${JSON.stringify({ v: 1, seq: 1, timestamp: Date.now(), type: 'session/child-meta', parentSessionId: parent, parentTurnId: 'turn-old', definition: 'explorer', brief: 'legacy' })}\n`)
}

/** Ids of canonical reads issued by the root-mode migration itself (not child recovery). */
function spyMigrationReads(): string[] {
  const original = SessionsService.prototype.readCanonicalEvents
  const ids: string[] = []
  vi.spyOn(SessionsService.prototype, 'readCanonicalEvents').mockImplementation(function (this: SessionsService, id) {
    if (new Error().stack?.includes('root-migration') === true) ids.push(id)
    return original.call(this, id)
  })
  return ids
}

async function seed(count: number, options: { child?: boolean } = {}): Promise<{ wsId: string; roots: string[] }> {
  const server = await boot()
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const roots: string[] = []
  for (let i = 0; i < count; i++) {
    roots.push(((await (await post(server.url, `/api/workspaces/${wsId}/sessions`, {})).json()) as { id: string }).id)
  }
  await server.close()
  if (options.child === true) await writeChild(wsId, roots[0]!)
  // The next boot's pass resolves the new roots and records them.
  await (await boot()).close()
  return { wsId, roots }
}

describe('legacy root mode migration', () => {
  it('backs up one legacy root, skips child logs, and remains idempotent on restart', async () => {
    const first = await boot()
    const wsId = ((await (await fetch(`${first.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    const root = ((await (await post(first.url, `/api/workspaces/${wsId}/sessions`, {})).json()) as { id: string }).id
    await first.close()
    // Simulate a pre-migration data home: a root without its session/mode
    // fact, and no completion marker from a previous pass.
    await fs.rm(marker(), { force: true })
    const original = await stripMode(wsId, root)
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

  it('records a versioned completion marker with each verified session and its canonical length', async () => {
    const { wsId, roots } = await seed(2, { child: true })
    const record = await readMarker()
    expect(record.version).toBe(2)
    expect(typeof record.completedAt).toBe('number')
    const byId = new Map(record.verified.map((entry) => [entry.id, entry]))
    expect([...byId.keys()].sort()).toEqual([...roots, CHILD].sort())
    for (const root of roots) {
      const lines = (await fs.readFile(log(wsId, root), 'utf8')).trim().split('\n')
      expect(byId.get(root)).toEqual({ id: root, lastSeq: lines.length })
    }
    expect(byId.get(CHILD)).toEqual({ id: CHILD, lastSeq: 1, child: true })
  })

  it('a later boot issues no migration read for verified roots and children', async () => {
    await seed(3, { child: true })
    const reads = spyMigrationReads()
    await (await boot()).close()
    expect(reads).toEqual([])
  })

  it('reports verified children in skippedChildren without reading them', async () => {
    const { wsId } = await seed(1, { child: true })
    const reads = spyMigrationReads()
    const kernel = new Kernel()
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { home }) })
    try {
      await kernel.ctx.sessions.boot()
      const modes = new ModesService(home)
      const fallback = await modes.resolve(wsId as WorkspaceId, DEFAULT_MODE_ID)
      const result = await migrateRootModes(home, kernel.ctx.sessions, modes, () => fallback)
      expect(result).toEqual({ migrated: 0, skippedChildren: 1, defaultedWorkspaces: [] })
      expect(reads).toEqual([])
    } finally {
      await kernel.stop()
    }
  })

  it('still stamps a root the marker has not verified, reading only that root', async () => {
    const { wsId, roots } = await seed(2)
    // A root created later without a snapshot (an older host, or a creation
    // path that does not stamp one) is absent from the marker.
    const server = await boot()
    const extra = ((await (await post(server.url, `/api/workspaces/${wsId}/sessions`, {})).json()) as { id: string }).id
    await server.close()
    await stripMode(wsId, extra)
    const reads = spyMigrationReads()
    await (await boot()).close()
    expect(reads).toEqual([extra])
    expect(await modeCount(wsId, extra)).toBe(1)
    expect((await readMarker()).verified.map((entry) => entry.id).sort()).toEqual([...roots, extra].sort())
  })

  it('re-stamps a verified root whose log was restored to its pre-migration backup', async () => {
    const { wsId, roots } = await seed(1)
    const root = roots[0]!
    await fs.rm(marker())
    await stripMode(wsId, root)
    await (await boot()).close()
    expect(await modeCount(wsId, root)).toBe(1)
    expect((await readMarker()).verified.map((entry) => entry.id)).toContain(root)
    // The user copies the backup back over the live log: shorter than verified.
    await fs.copyFile(path.join(home, 'root-mode-backups', wsId, root, 'events.jsonl'), log(wsId, root))
    expect(await modeCount(wsId, root)).toBe(0)
    const reads = spyMigrationReads()
    await (await boot()).close()
    expect(reads).toEqual([root])
    expect(await modeCount(wsId, root)).toBe(1)
  })

  it('a verified root whose log disappeared is re-read and fails the boot, as without a marker', async () => {
    const { wsId, roots } = await seed(1)
    await fs.rm(log(wsId, roots[0]!))
    await expect(boot()).rejects.toThrow()
    await expect(fs.stat(log(wsId, roots[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes no marker when a pass fails part-way, and a later boot completes it', async () => {
    const { wsId, roots } = await seed(2)
    await fs.rm(marker())
    for (const root of roots) await stripMode(wsId, root)
    const original = SessionsService.prototype.readCanonicalEvents
    let calls = 0
    const reads = vi.spyOn(SessionsService.prototype, 'readCanonicalEvents').mockImplementation(async function (this: SessionsService, id) {
      calls += 1
      if (calls === 2) throw new Error('simulated read failure')
      return original.call(this, id)
    })
    await expect(boot()).rejects.toThrow('simulated read failure')
    await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
    reads.mockRestore()

    await (await boot()).close()
    for (const root of roots) expect(await modeCount(wsId, root)).toBe(1)
    expect((await readMarker()).verified.map((entry) => entry.id).sort()).toEqual([...roots].sort())
  })

  it('rescans every session when the marker is missing, older or unreadable', async () => {
    const { wsId, roots } = await seed(2)
    const ids = roots.map((id) => ({ id, lastSeq: 1 }))
    const stale = [
      undefined,
      JSON.stringify({ version: 1, completedAt: 1, verified: roots }),
      JSON.stringify({ version: 2, completedAt: 1, verified: roots }),
      JSON.stringify({ version: 0, completedAt: 1, verified: ids }),
      '{not json',
    ]
    for (const content of stale) {
      if (content === undefined) await fs.rm(marker(), { force: true })
      else await fs.writeFile(marker(), content)
      await stripMode(wsId, roots[0]!)
      const reads = spyMigrationReads()
      await (await boot()).close()
      expect([...new Set(reads)].sort()).toEqual([...roots].sort())
      expect(await modeCount(wsId, roots[0]!)).toBe(1)
      vi.restoreAllMocks()
      expect((await readMarker()).version).toBe(2)
    }
  })

  it('stamps the mode at creation for a root made through the legacy sessions route', async () => {
    const server = await boot()
    const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    const created = (await (await post(server.url, '/api/sessions', {})).json()) as { id: string }
    expect(await modeCount(wsId, created.id)).toBe(1)
    await server.close()
  })
})
