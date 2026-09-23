/**
 * G2 workspace isolation at the service boundary: workspace CRUD with the
 * file-first layout, idempotent migration, project binding with overlap
 * rejection, ownership fail-closed semantics, archive/delete guards, and
 * the app-local writer lease.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kernel, SessionsService, fileSessions, WorkspaceService, ScopeError } from 'mini-dsh'
import type { ProjectId, SessionId, WorkspaceId } from 'mini-dsh'

let home = ''
let dirA = ''
let dirB = ''
let nested = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-'))
  dirA = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-a-'))
  dirB = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-b-'))
  nested = path.join(dirA, 'nested')
  await fs.mkdir(nested, { recursive: true })
})

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(dirA, { recursive: true, force: true })
  await fs.rm(dirB, { recursive: true, force: true })
})

/** A fresh data home per call: tests must not share registry state. */
async function workspaces(): Promise<{ ws: WorkspaceService; home: string }> {
  const h = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-ws-'))
  return { ws: new WorkspaceService(h), home: h }
}

describe('workspace lifecycle', () => {
  it('first boot creates a persisted Default workspace; a second boot adopts the same id', async () => {
    const { ws: w1, home: h1 } = await workspaces()
    await w1.boot()
    const first = w1.list()
    expect(first).toHaveLength(1)
    expect(first[0]?.name).toBe('Default')

    const w2 = new WorkspaceService(h1)
    await w2.boot()
    expect(w2.list()[0]?.id).toBe(first[0]?.id)
  })

  it('create, rename, archive, and restore keep the data directory stable', async () => {
    const { ws } = await workspaces()
    await ws.boot()
    const created = await ws.create('Life')
    const dir = ws.workspaceDir(created.id)
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true })

    const renamed = await ws.rename(created.id, 'Life Personal')
    expect(renamed.name).toBe('Life Personal')
    // The rename moved metadata, not the tree.
    expect((await fs.stat(dir)).isDirectory()).toBe(true)

    const archived = await ws.setArchived(created.id, true)
    expect(archived.archived).toBe(true)
    expect(ws.list().map((row) => row.id)).not.toContain(created.id)
    expect(ws.list({ includeArchived: true }).map((row) => row.id)).toContain(created.id)
    // Restore works.
    expect((await ws.setArchived(created.id, false)).archived).toBe(false)
  })

  it('delete refuses non-empty workspaces and never touches external project folders', async () => {
    const { ws } = await workspaces()
    await ws.boot()
    const target = await ws.create('Doomed')
    await ws.createProject(target.id, 'proj', dirB)
    await expect(ws.delete(target.id)).rejects.toMatchObject({ code: 'workspace-not-empty' })
    // The project record dies only with explicit unbind; the external
    // folder survives everything.
    await ws.deleteProject((await ws.listProjects(target.id))[0]!.id)
    await ws.delete(target.id)
    expect(await fs.stat(dirB)).toBeTruthy()
    expect(() => ws.get(target.id)).toThrow(/no workspace/)
  })

  it('migrates a legacy flat sessions tree into Default idempotently', async () => {
    const legacyHome = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-legacy-'))
    try {
      const legacySessions = path.join(legacyHome, 'sessions', 'session-legacy1')
      await fs.mkdir(legacySessions, { recursive: true })
      await fs.writeFile(path.join(legacySessions, 'events.jsonl'), '', 'utf8')

      const w1 = new WorkspaceService(legacyHome)
      await w1.boot()
      const defaultId = w1.defaultWorkspace
      // Migrated: the legacy tree now lives under Default.
      expect((await fs.stat(path.join(legacyHome, 'workspaces', defaultId, 'sessions', 'session-legacy1'))).isDirectory()).toBe(true)
      expect(await fs.stat(path.join(legacyHome, 'sessions')).then(() => true).catch(() => false)).toBe(false)

      // Second boot: no double migration, same workspace.
      const w2 = new WorkspaceService(legacyHome)
      await w2.boot()
      expect(w2.defaultWorkspace).toBe(defaultId)
    } finally {
      await fs.rm(legacyHome, { recursive: true, force: true })
    }
  })
})

describe('project binding', () => {
  it('rejects overlapping and nested project roots within a workspace, but lets another workspace bind the same folder', async () => {
    const { ws } = await workspaces()
    await ws.boot()
    const a = await ws.create('WorkA')
    const b = await ws.create('WorkB')

    await ws.createProject(a.id, 'alpha', dirA)
    // Inside one workspace, the same or a nested folder would make two
    // projects claim the same files: refused.
    await expect(ws.createProject(a.id, 'copy', dirA)).rejects.toMatchObject({ code: 'root-overlap' })
    await expect(ws.createProject(a.id, 'nested', nested)).rejects.toMatchObject({ code: 'root-overlap' })
    // Another workspace may bind the same folder (one repo, several
    // workspaces); concurrent writers are still serialized by the root lease.
    const copy = await ws.createProject(b.id, 'copy', dirA)
    expect(copy.workspaceId).toBe(b.id)
    const beta = await ws.createProject(b.id, 'beta', dirB)
    expect(beta.workspaceId).toBe(b.id)
  })

  it('cross-workspace project access fails closed', async () => {
    const { ws } = await workspaces()
    await ws.boot()
    const a = await ws.create('OwnerA')
    const b = await ws.create('OwnerB')
    const project = await ws.createProject(a.id, 'secret', dirA)
    // Direct-ID read from the foreign workspace is refused.
    expect(() => ws.getProject(project.id, b.id)).toThrow(ScopeError)
    expect(ws.getProject(project.id, a.id).id).toBe(project.id)
    // A project binding for a session in the wrong workspace is refused at
    // the API layer through the same check.
  })

  it('reorderProjects persists a dragged order; unspecified ids trail by creation', async () => {
    const { ws, home } = await workspaces()
    await ws.boot()
    const target = await ws.create('Ordered')
    const extra = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-extra-'))
    try {
      const p1 = await ws.createProject(target.id, 'one', dirA)
      const p2 = await ws.createProject(target.id, 'two', dirB)
      const p3 = await ws.createProject(target.id, 'three', extra)
      // Creation order before any drag.
      expect((await ws.listProjects(target.id)).map((row) => row.id)).toEqual([p1.id, p2.id, p3.id])

      // Dragging 'three' above 'one': the untouched 'two' trails, keeping
      // its relative creation position.
      const reordered = await ws.reorderProjects(target.id, [p3.id, p1.id])
      expect(reordered.map((row) => row.id)).toEqual([p3.id, p1.id, p2.id])
      expect(reordered.map((row) => row.order)).toEqual([0, 1, 2])

      // Foreign and duplicate ids fail closed / dedupe.
      await expect(ws.reorderProjects(target.id, ['proj-nope' as ProjectId])).rejects.toMatchObject({ code: 'project-not-found' })
      expect((await ws.reorderProjects(target.id, [p1.id, p1.id, p2.id])).map((row) => row.id)).toEqual([p1.id, p2.id, p3.id])

      // The order written by the last reorder survives a reload from disk.
      const fresh = new WorkspaceService(home)
      await fresh.boot()
      expect((await fresh.listProjects(target.id)).map((row) => row.id)).toEqual([p1.id, p2.id, p3.id])
    } finally {
      await fs.rm(extra, { recursive: true, force: true })
    }
  })

  it('the writer lease serializes distinct sessions and re-admits the holder', async () => {
    const { ws } = await workspaces()
    await ws.boot()
    const sessionA = 'session-lease-a' as SessionId
    const sessionB = 'session-lease-b' as SessionId
    await ws.acquireRoot(dirA, sessionA)
    // The holder re-acquiring its own root is fine.
    await ws.acquireRoot(dirA, sessionA)
    await expect(ws.acquireRoot(dirA, sessionB)).rejects.toMatchObject({ code: 'project-active' })
    await ws.releaseRoot(dirA, sessionA)
    await ws.acquireRoot(dirA, sessionB)
    await ws.releaseRoot(dirA, sessionB)
  })
})

describe('session scoping', () => {
  it('sessions require a workspace and keep it for their lifetime', async () => {
    const { home: scoped } = await workspaces()
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(scoped))
    const sessions = kernel.ctx.sessions
    await sessions.boot()

    const ws = new WorkspaceService(scoped)
    await ws.boot()
    const a = await ws.create('ScopeA')

    const session = sessions.create(a.id as WorkspaceId)
    await session.durable()
    // Fixed ownership: visible through workspaceOf, stored in the tree.
    expect(sessions.workspaceOf(session.id)).toBe(a.id)
    expect(session.id).toBeTruthy()

    await kernel.stop()
  })

  it('boot adopts sessions from every workspace directory with ownership', async () => {
    const isolated = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g2-scope-'))
    try {
      const w = new WorkspaceService(isolated)
      await w.boot()
      const a = await w.create('IsoA')

      const k1 = new Kernel()
      k1.ctx.plugin(fileSessions(isolated))
      const s1 = k1.ctx.sessions
      await s1.boot()
      const session = s1.create(a.id as WorkspaceId)
      session.append({ type: 'user/message', turnId: 't1' as never, content: 'owned' })
      await session.durable()
      await k1.stop()

      const k2 = new Kernel()
      k2.ctx.plugin(fileSessions(isolated))
      const s2 = k2.ctx.sessions
      await s2.boot()
      // Ownership survived the restart via the directory layout.
      expect(s2.workspaceOf(session.id)).toBe(a.id)
      expect(s2.has(session.id)).toBe(true)
      const resumed = await s2.load(session.id)
      expect(resumed.deriveMessages()).toEqual([{ role: 'user', content: 'owned' }])
      await k2.stop()
    } finally {
      await fs.rm(isolated, { recursive: true, force: true })
    }
  })

  it('home-mode create() without a workspace fails closed', async () => {
    const { home: scoped } = await workspaces()
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(scoped))
    expect(() => kernel.ctx.sessions.create()).toThrow(/require a workspace/)
    await kernel.stop()
  })

  it('a deleted summary.json is rebuilt from the canonical log at boot', async () => {
    const { home: scoped } = await workspaces()
    let sessionId = ''
    {
      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(scoped))
      const sessions = kernel.ctx.sessions
      await sessions.boot()
      const ws = new WorkspaceService(scoped)
      await ws.boot()
      const session = sessions.create(ws.defaultWorkspace)
      session.append({ type: 'user/message', turnId: 't1' as never, content: 'discoverable' })
      session.append({ type: 'session/title', title: 'rebuilt' })
      await session.durable()
      await sessions.flushSummary(session)
      sessionId = session.id
      await kernel.stop()
    }
    // Derived state dies; the canonical log must stay discoverable.
    await fs.rm(path.join(scoped, 'workspaces', 'default', 'sessions', sessionId, 'summary.json'), { force: true })
    // NOTE: the workspace dir is the Default workspace's id — find it.
    const workspacesRoot = path.join(scoped, 'workspaces')
    const wsDirs = (await fs.readdir(workspacesRoot)).filter((name) => name !== 'default')
    for (const dir of wsDirs) {
      await fs.rm(path.join(workspacesRoot, dir, 'sessions', sessionId, 'summary.json'), { force: true })
    }

    const k2 = new Kernel()
    k2.ctx.plugin(fileSessions(scoped))
    const s2 = k2.ctx.sessions
    await s2.boot()
    const known = s2.summaries()
    const row = known.find((item) => item.id === sessionId)
    expect(row).toBeDefined()
    expect(row?.title).toBe('rebuilt')
    expect(row?.eventCount).toBe(2)
    await k2.stop()
  })

  it('memory-mode services still create sessions without a workspace (unit-test seam)', () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    const session = kernel.ctx.sessions.create()
    expect(kernel.ctx.sessions.workspaceOf(session.id)).toBeUndefined()
    void kernel.stop()
  })
})
