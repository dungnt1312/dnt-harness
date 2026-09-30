import { promises as fs, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'
import { newProjectId, newWorkspaceId, type ProjectId, type SessionId, type WorkspaceId } from '../../util/brand.ts'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { ScopeError, type AdditionalDirectory, type AppRecord, type ProjectRecord, type WorkspaceRecord } from './types.ts'

export { ScopeError }
export type { AdditionalDirectory, AppRecord, ProjectRecord, WorkspaceRecord }

/** Rebuildable per-workspace summary for pickers and badges. */
export interface WorkspaceSummary {
  readonly id: WorkspaceId
  readonly name: string
  readonly archived: boolean
  readonly createdAt: number
}

/**
 * The file-first workspace layout, one service instance per data home:
 *
 * ```text
 * <home>/
 *   app.json
 *   workspaces/<ws-id>/
 *     workspace.json
 *     projects/<project-id>/project.json
 *     sessions/<session-id>/…   (G1 store contract)
 * ```
 *
 * Names are display metadata; the id names the directory, so renaming never
 * moves data. Boot adopts any on-disk workspace directory missing from
 * app.json (repair) and migrates a legacy flat `<home>/sessions` tree into
 * the Default workspace idempotently.
 */
export class WorkspaceService {
  private readonly home: string
  private workspaces = new Map<WorkspaceId, WorkspaceRecord>()
  private projects = new Map<ProjectId, ProjectRecord>()
  private app: AppRecord | undefined
  private readonly now: () => number

  constructor(home: string, options: { now?: () => number } = {}) {
    this.home = home
    this.now = options.now ?? Date.now
  }

  // ── paths ──────────────────────────────────────────────────

  get appPath(): string {
    return path.join(this.home, 'app.json')
  }

  workspaceDir(id: WorkspaceId): string {
    return path.join(this.home, 'workspaces', id)
  }

  workspacePath(id: WorkspaceId): string {
    return path.join(this.workspaceDir(id), 'workspace.json')
  }

  projectsDir(id: WorkspaceId): string {
    return path.join(this.workspaceDir(id), 'projects')
  }

  projectPath(wsId: WorkspaceId, pid: ProjectId): string {
    return path.join(this.projectsDir(wsId), pid, 'project.json')
  }

  /** The sessions directory G1's store uses for one workspace. */
  sessionsDir(id: WorkspaceId): string {
    return path.join(this.workspaceDir(id), 'sessions')
  }

  // ── lifecycle ──────────────────────────────────────────────

  /**
   * Load app.json, every workspace and project record. Idempotent
   * migration: a legacy flat `<home>/sessions` tree becomes the Default
   * workspace's sessions; on-disk workspace directories missing from
   * app.json are adopted. Never deletes user files.
   */
  async boot(): Promise<void> {
    await fs.mkdir(this.home, { recursive: true })
    await this.migrateLegacyLayout()
    this.app = await readJson<AppRecord>(this.appPath)
    this.workspaces = new Map()
    this.projects = new Map()

    const workspacesRoot = path.join(this.home, 'workspaces')
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(workspacesRoot, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = entry.name as WorkspaceId
      // Repair: a directory without a valid record (fresh migration, an
      // interrupted create) is adopted, not discarded — its sessions and
      // projects are canonical data.
      let record = await readJson<WorkspaceRecord>(this.workspacePath(id))
      if (record === undefined) {
        record = { v: 1, id, name: id, archived: false, createdAt: this.now() }
        await writeJson(this.workspacePath(id), record)
      }
      this.workspaces.set(record.id, record)
      await this.loadProjects(record.id)
    }

    if (this.workspaces.size === 0) {
      // The first boot creates Default and persists its record, so later
      // boots adopt the SAME id (idempotent migration).
      await this.create('Default')
    }
    if (this.app === undefined || !this.workspaces.has(this.app.defaultWorkspace)) {
      const first = [...this.workspaces.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (first !== undefined) {
        this.app = { v: 1, defaultWorkspace: first.id }
        await writeJson(this.appPath, this.app)
      }
    }
  }

  /** Legacy `<home>/sessions` → `<home>/workspaces/<default>/sessions`. */
  private async migrateLegacyLayout(): Promise<void> {
    const legacy = path.join(this.home, 'sessions')
    let hasLegacy = false
    try {
      hasLegacy = (await fs.stat(legacy)).isDirectory()
    } catch {
      hasLegacy = false
    }
    if (!hasLegacy) return
    const defaultDir = this.sessionsDir('default' as WorkspaceId)
    let hasTarget = false
    try {
      hasTarget = (await fs.stat(defaultDir)).isDirectory()
    } catch {
      hasTarget = false
    }
    if (hasTarget) return // already migrated: idempotent no-op
    await fs.mkdir(path.dirname(defaultDir), { recursive: true })
    // Windows can transiently EPERM a directory rename (AV/index locks);
    // retry before giving up — migration must not die on a hiccup.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(legacy, defaultDir)
        break
      } catch (error) {
        if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
  }

  private async loadProjects(wsId: WorkspaceId): Promise<void> {
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(this.projectsDir(wsId), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const record = await readJson<ProjectRecord>(this.projectPath(wsId, entry.name as ProjectId))
      if (record === undefined || record.workspaceId !== wsId) continue
      this.projects.set(record.id, record)
    }
  }

  // ── workspace CRUD ─────────────────────────────────────────

  /** Create a workspace (display name only; the id owns the directory). */
  async create(name: string): Promise<WorkspaceRecord> {
    const record = this.createSync(name)
    await writeJson(this.workspacePath(record.id), record)
    return record
  }

  private createSync(name: string): WorkspaceRecord {
    const id = newWorkspaceId()
    const record: WorkspaceRecord = {
      v: 1,
      id,
      name: name.trim() === '' ? 'Untitled' : name.trim().slice(0, 80),
      archived: false,
      createdAt: this.now(),
    }
    this.workspaces.set(id, record)
    return record
  }

  /** Every workspace; archived ones included but flagged. */
  list(options: { includeArchived?: boolean } = {}): WorkspaceSummary[] {
    const rows = [...this.workspaces.values()].sort((a, b) => a.createdAt - b.createdAt)
    return rows
      .filter((record) => options.includeArchived === true || !record.archived)
      .map(({ id, name, archived, createdAt }) => ({ id, name, archived, createdAt }))
  }

  /** Direct-ID lookup; fails closed on an unknown id. */
  get(id: WorkspaceId): WorkspaceRecord {
    const record = this.workspaces.get(id)
    if (record === undefined) {
      throw new ScopeError('workspace-not-found', `no workspace '${id}'`)
    }
    return record
  }

  /**
   * Lookup for OPERATIONAL boundaries (creating sessions, starting work,
   * mutating controls or projects): an archived workspace is readable but
   * not executable. History reads go through {@link get}.
   */
  requireActive(id: WorkspaceId): WorkspaceRecord {
    const record = this.get(id)
    if (record.archived) {
      throw new ScopeError('workspace-archived', `workspace '${record.name}' is archived; restore it to continue`)
    }
    return record
  }

  /** Rename is display metadata only: the directory keeps its id. */
  async rename(id: WorkspaceId, name: string): Promise<WorkspaceRecord> {
    const record = this.get(id)
    const trimmed = name.trim()
    if (trimmed === '') throw new ScopeError('root-invalid', 'workspace name cannot be empty')
    const updated: WorkspaceRecord = { ...record, name: trimmed.slice(0, 80) }
    this.workspaces.set(id, updated)
    await writeJson(this.workspacePath(id), updated)
    return updated
  }

  /**
   * Archive or restore. Archiving requires settled execution: the caller
   * (host) must have stopped active sessions and resolved pending work
   * first — this service refuses only structural problems.
   */
  async setArchived(id: WorkspaceId, archived: boolean): Promise<WorkspaceRecord> {
    const record = this.get(id)
    if (record.archived === archived) return record
    const updated: WorkspaceRecord = { ...record, archived }
    this.workspaces.set(id, updated)
    await writeJson(this.workspacePath(id), updated)
    return updated
  }

  /**
   * Delete an EMPTY workspace only: no sessions, no projects. Populated
   * workspaces are refused — there is no cascade deletion. External project
   * folders are never touched (their metadata dies with the record, the
   * user's repository does not).
   */
  async delete(id: WorkspaceId): Promise<void> {
    this.get(id)
    // The last workspace cannot go away: the host needs a live default.
    if (this.workspaces.size <= 1) {
      throw new ScopeError('last-workspace', 'cannot delete the last workspace')
    }
    if ((await this.listSessionsDir(id)).length > 0) {
      throw new ScopeError('workspace-not-empty', `workspace '${id}' still holds sessions`)
    }
    if (this.listProjects(id).length > 0) {
      throw new ScopeError('workspace-not-empty', `workspace '${id}' still holds projects`)
    }
    if (this.app?.defaultWorkspace === id) {
      const next = this.list({ includeArchived: true }).find((ws) => ws.id !== id)
      if (next !== undefined) {
        this.app = { v: 1, defaultWorkspace: next.id }
        await writeJson(this.appPath, this.app)
      }
    }
    await fs.rm(this.workspaceDir(id), { recursive: true, force: true })
    this.workspaces.delete(id)
  }

  private async listSessionsDir(id: WorkspaceId): Promise<string[]> {
    try {
      return await fs.readdir(this.sessionsDir(id))
    } catch {
      return []
    }
  }

  get defaultWorkspace(): WorkspaceId {
    if (this.app === undefined) {
      throw new ScopeError('workspace-not-found', 'workspaces are not booted yet')
    }
    return this.app.defaultWorkspace
  }

  // ── projects ───────────────────────────────────────────────

  /**
   * Bind a project to a workspace with an external working folder. The
   * folder must exist. Overlapping or nested folders between projects are
   * allowed — the same physical folder may be bound any number of times,
   * in the same workspace or across workspaces (profiles).
   */
  async createProject(workspaceId: WorkspaceId, name: string, rawPath: string): Promise<ProjectRecord> {
    const workspace = this.get(workspaceId)
    if (workspace.archived) {
      throw new ScopeError('workspace-archived', `workspace '${workspace.name}' is archived`)
    }
    const abs = path.resolve(rawPath)
    let stat: Stats | undefined
    try {
      stat = await fs.stat(abs)
    } catch {
      throw new ScopeError('root-invalid', `no such directory '${rawPath}'`)
    }
    if (!stat.isDirectory()) {
      throw new ScopeError('root-invalid', `'${rawPath}' is not a directory`)
    }
    const canonical = await fs.realpath(abs)
    const id = newProjectId()
    const record: ProjectRecord = {
      v: 1,
      id,
      name: name.trim() === '' ? path.basename(canonical) : name.trim().slice(0, 80),
      workspaceId,
      path: canonical,
      order: this.listProjects(workspaceId).reduce((max, existing) => Math.max(max, existing.order ?? -1), -1) + 1,
      createdAt: this.now(),
    }
    this.projects.set(id, record)
    await writeJson(this.projectPath(workspaceId, id), record)
    return record
  }

  listProjects(workspaceId: WorkspaceId): ProjectRecord[] {
    this.get(workspaceId)
    return [...this.projects.values()]
      .filter((record) => record.workspaceId === workspaceId)
      // Never-reordered records (no `order`) trail explicitly ordered ones,
      // keeping their own creation order until the first drag assigns orders.
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt)
  }

  /**
   * Persist a sidebar order for the workspace's projects. Ids beyond the
   * workspace are refused; ids left out trail the ordered ones by creation.
   */
  async reorderProjects(workspaceId: WorkspaceId, orderedIds: readonly ProjectId[]): Promise<ProjectRecord[]> {
    this.get(workspaceId)
    const known = new Map(this.listProjects(workspaceId).map((record) => [record.id, record]))
    const ordered: ProjectRecord[] = []
    const seen = new Set<ProjectId>()
    let index = 0
    for (const id of orderedIds) {
      const record = known.get(id)
      if (record === undefined) throw new ScopeError('project-not-found', `no project '${id}' in this workspace`)
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push({ ...record, order: index++ })
    }
    for (const record of known.values()) {
      if (!seen.has(record.id)) ordered.push({ ...record, order: index++ })
    }
    for (const record of ordered) {
      if (record.order === known.get(record.id)?.order) continue
      this.projects.set(record.id, record)
      await writeJson(this.projectPath(workspaceId, record.id), record)
    }
    return this.listProjects(workspaceId)
  }

  /** Direct-ID lookup; a workspace mismatch fails closed (never leaks). */
  getProject(id: ProjectId, workspaceId?: WorkspaceId): ProjectRecord {
    const record = this.projects.get(id)
    if (record === undefined) {
      throw new ScopeError('project-not-found', `no project '${id}'`)
    }
    if (workspaceId !== undefined && record.workspaceId !== workspaceId) {
      throw new ScopeError('scope-mismatch', `project '${id}' does not belong to this workspace`)
    }
    return record
  }

  /**
   * Retarget a project's working folder. Callers must ensure idle execution
   * and resolved pending work; user repository files are never moved.
   */
  async setProjectPath(id: ProjectId, workspaceId: WorkspaceId, rawPath: string): Promise<ProjectRecord> {
    const record = this.getProject(id, workspaceId)
    const abs = path.resolve(rawPath)
    let stat: Stats | undefined
    try {
      stat = await fs.stat(abs)
    } catch {
      throw new ScopeError('root-invalid', `no such directory '${rawPath}'`)
    }
    if (!stat.isDirectory()) {
      throw new ScopeError('root-invalid', `'${rawPath}' is not a directory`)
    }
    const canonical = await fs.realpath(abs)
    const updated: ProjectRecord = { ...record, path: canonical }
    this.projects.set(id, updated)
    await writeJson(this.projectPath(record.workspaceId, id), updated)
    return updated
  }

  /**
   * Replace the extra folders this project grants its sessions. The host
   * validates folders before calling (it owns the app-storage and home
   * rules); this only checks that project references stay in the workspace.
   */
  async setAdditionalDirectories(id: ProjectId, workspaceId: WorkspaceId, directories: readonly AdditionalDirectory[]): Promise<ProjectRecord> {
    const record = this.getProject(id, workspaceId)
    for (const entry of directories) {
      if (entry.kind !== 'project') continue
      if (entry.projectId === id) throw new ScopeError('root-invalid', 'a project cannot grant itself')
      this.getProject(entry.projectId, workspaceId)
    }
    const { additionalDirectories: _previous, ...rest } = record
    const updated: ProjectRecord = directories.length > 0 ? { ...rest, additionalDirectories: [...directories] } : rest
    this.projects.set(id, updated)
    await writeJson(this.projectPath(record.workspaceId, id), updated)
    return updated
  }

  /** Rename is display metadata only; ids and folders stay stable. */
  async renameProject(id: ProjectId, workspaceId: WorkspaceId, name: string): Promise<ProjectRecord> {
    const record = this.getProject(id, workspaceId)
    const trimmed = name.trim()
    if (trimmed === '') throw new ScopeError('root-invalid', 'project name cannot be empty')
    const updated: ProjectRecord = { ...record, name: trimmed.slice(0, 80) }
    this.projects.set(id, updated)
    await writeJson(this.projectPath(record.workspaceId, id), updated)
    return updated
  }

  /** Unbind a project (metadata only — the external folder is untouched). */
  async deleteProject(id: ProjectId, workspaceId?: WorkspaceId): Promise<void> {
    const record = this.getProject(id, workspaceId)
    await fs.rm(path.join(this.projectsDir(record.workspaceId), id), { recursive: true, force: true })
    this.projects.delete(id)
  }

  /** Canonical mutual-containment check: equal or nested in either direction. */
  private rootsOverlap(a: string, b: string): boolean {
    return this.containsRoot(a, b) || this.containsRoot(b, a)
  }

  private containsRoot(parent: string, child: string): boolean {
    const np = process.platform === 'win32' ? parent.toLowerCase() : parent
    const nc = process.platform === 'win32' ? child.toLowerCase() : child
    const rel = path.relative(np, nc)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }

  /**
   * App-local writer coordination: one write-capable execution per
   * protected project root. This coordinates THIS application only —
   * external editors and unrestricted shell writes elsewhere are outside
   * its reach.
   */
  private readonly leases = new Map<string, SessionId>()

  /**
   * Leases are hierarchical: a folder is busy when another session holds it,
   * any folder inside it, or any folder containing it — a write into a
   * granted subfolder of another project must contend with that project.
   */
  async acquireRoot(root: string, sessionId: SessionId): Promise<void> {
    const key = await fs.realpath(root).catch(() => path.resolve(root))
    const normalized = process.platform === 'win32' ? key.toLowerCase() : key
    for (const [held, holder] of this.leases) {
      if (holder !== sessionId && this.rootsOverlap(held, normalized)) {
        throw new ScopeError('project-active', 'another session is executing on this project folder')
      }
    }
    this.leases.set(normalized, sessionId)
  }

  async releaseRoot(root: string, sessionId: SessionId): Promise<void> {
    const key = await fs.realpath(root).catch(() => path.resolve(root))
    const normalized = process.platform === 'win32' ? key.toLowerCase() : key
    const holder = this.leases.get(normalized)
    if (holder === sessionId) this.leases.delete(normalized)
  }
}

// ── JSON record IO (validated, atomic) ─────────────────────────

async function readJson<T extends { v: number }>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed['v'] !== 'number') return undefined
    return parsed as unknown as T
  } catch {
    return undefined
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await replaceFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
