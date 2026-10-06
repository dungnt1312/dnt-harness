import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import type { ProjectId, WorkspaceId } from '../../util/brand.ts'

export interface MemoryEntry {
  readonly id: string
  readonly title: string
  readonly scope: { readonly workspaceId: WorkspaceId; readonly projectId?: ProjectId }
  readonly pinned: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly body: string
  readonly hash: string
}

export class MemoryError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'conflict' | 'scope',
    message: string,
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}

/**
 * File-first memory: one Markdown entry per fact/topic under
 * `<home>/workspaces/<ws>/memory/workspace/<id>.md` or
 * `.../memory/projects/<project-id>/<id>.md`. Entries carry stable ids,
 * titles, timestamps and provenance frontmatter. Scope checks are structural
 * (the path IS the scope); writes verify `expectedHash` so human edits are
 * never clobbered; forget deletes the file — future retrieval excludes it
 * while history stays untouched.
 */
export class MemoryService {
  private readonly home: string
  constructor(home: string) { this.home = path.resolve(home) }

  root(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }): string {
    return this.dir(scope.workspaceId, scope.projectId)
  }

  /** Reject linked ancestors, including an existing root reached through a linked parent. */
  private async safeRoot(root: string): Promise<void> {
    const home = path.resolve(this.home)
    const target = path.resolve(root)
    if (!target.startsWith(home + path.sep)) throw new MemoryError('scope', 'memory root escapes home')
    let cursor = home
    if (!(await fs.lstat(cursor)).isDirectory()) throw new MemoryError('scope', 'memory home is not a trusted directory')
    for (const part of path.relative(home, target).split(path.sep)) {
      cursor = path.join(cursor, part)
      try {
        const stat = await fs.lstat(cursor)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MemoryError('scope', 'memory root ancestry must be directories, not symlinks')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
  }

  private async safeFile(root: string, file: string): Promise<void> {
    await this.safeRoot(path.dirname(file))
    if (!file.startsWith(root + path.sep)) throw new MemoryError('scope', 'memory file escapes root')
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new MemoryError('scope', 'memory files must be regular files, not symlinks')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async safeMutation(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }, file: string): Promise<void> {
    const root = this.root(scope)
    await this.safeRoot(root)
    await this.safeFile(root, file)
    await this.safeFile(root, path.join(root, 'MEMORY.md'))
    // prepare() also initializes the workspace index for a project scope.
    if (scope.projectId !== undefined) {
      const workspaceRoot = this.root({ workspaceId: scope.workspaceId })
      await this.safeFile(workspaceRoot, path.join(workspaceRoot, 'MEMORY.md'))
    }
  }

  private async topicIds(root: string): Promise<string[]> {
    await this.safeRoot(root)
    const ids: string[] = []
    const walk = async (dir: string): Promise<void> => {
      await this.safeRoot(dir)
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || sensitiveSegment(entry.name)) continue
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'memory.md') {
          const id = path.relative(root, file).split(path.sep).join('/').slice(0, -3)
          if (validId(id)) ids.push(id)
        }
      }
    }
    await walk(root)
    return ids
  }

  /** Create missing indexes only; an agent-owned index is never regenerated. */
  async prepare(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }): Promise<void> {
    const projects = scope.projectId === undefined ? [undefined] : [undefined, scope.projectId]
    // Preflight every index before any mkdir/index publication.
    for (const projectId of projects) {
      const root = this.dir(scope.workspaceId, projectId)
      await this.safeFile(root, path.join(root, 'MEMORY.md'))
    }
    for (const projectId of projects) {
      const root = this.dir(scope.workspaceId, projectId)
      await this.safeRoot(root)
      await fs.mkdir(root, { recursive: true })
      await this.safeRoot(root)
      await this.safeFile(root, path.join(root, 'MEMORY.md'))
      const index = path.join(root, 'MEMORY.md')
      // Fast path: a safe regular index already owns its contents and the wx
      // create below would lose the EEXIST race anyway, so topic traversal is
      // skipped entirely. A link or nonregular file that appeared after the
      // preflight is still rejected, never silently kept or read.
      const existing = await fs.lstat(index).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (existing !== undefined) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new MemoryError('scope', 'memory files must be regular files, not symlinks')
        continue
      }
      const pointers: string[] = []
      for (const id of await this.topicIds(root)) {
        const name = `${id}.md`
        const file = path.join(root, name)
        await this.safeFile(root, file)
        const raw = await fs.readFile(file, 'utf8').catch(() => '')
        const parsed = parseMemory(raw)
        if (parsed === undefined) continue
        pointers.push(`- [${(parsed.frontmatter.name ?? parsed.frontmatter.title ?? name.slice(0, -3)).replace(/[\]\n\r]/g, '')}](${name})`)
      }
      try {
        const handle = await fs.open(index, 'wx')
        try { await handle.writeFile(pointers.join('\n') + (pointers.length ? '\n' : '')) } finally { await handle.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  /** UTF-8 safe bounded index, including its truncation notice. */
  async index(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }): Promise<string> {
    const root = this.root(scope)
    await this.safeRoot(root)
    const file = path.join(root, 'MEMORY.md')
    let raw = ''
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile()) throw new MemoryError('scope', 'memory index must be a regular file, not a symlink')
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
    if (body === '') return ''
    const lines = body.split(/\r?\n/)
    const warning = '\n> WARNING: MEMORY.md was truncated; keep pointers short and detail in topic files.'
    const oversized = lines.length > 200 || Buffer.byteLength(body, 'utf8') > 25 * 1024
    const budget = 25 * 1024 - (oversized ? Buffer.byteLength(warning, 'utf8') : 0)
    const selected: string[] = []
    let bytes = 0
    for (const line of lines.slice(0, oversized ? 198 : 200)) {
      const next = (selected.length ? 1 : 0) + Buffer.byteLength(line, 'utf8')
      if (bytes + next > budget) break
      selected.push(line)
      bytes += next
    }
    return selected.join('\n') + (oversized ? warning : '')
  }

  private dir(workspaceId: WorkspaceId, projectId?: ProjectId): string {
    return projectId === undefined
      ? path.join(this.home, 'workspaces', workspaceId, 'memory', 'workspace')
      : path.join(this.home, 'workspaces', workspaceId, 'memory', 'projects', projectId)
  }

  private filePath(workspaceId: WorkspaceId, projectId: ProjectId | undefined, id: string): string {
    if (!validId(id)) throw new MemoryError('invalid', `memory id '${id}' must be a safe relative topic id without .md`)
    return path.join(this.dir(workspaceId, projectId), `${id}.md`)
  }

  /** Bounded keyword search within ONE scope (no cross-scope reads). */
  async search(
    scope: { workspaceId: WorkspaceId; projectId?: ProjectId },
    query: string,
    limit = 20,
  ): Promise<MemoryEntry[]> {
    const dir = this.dir(scope.workspaceId, scope.projectId)
    const names = await this.topicIds(dir)
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
    const hits: { entry: MemoryEntry; score: number }[] = []
    for (const id of names.sort()) {
      const entry = await this.read(scope, id).catch(() => undefined)
      if (entry === undefined) continue
      const haystack = `${entry.title}\n${entry.body}`.toLowerCase()
      let score = 0
      for (const term of terms) {
        let index = haystack.indexOf(term)
        while (index >= 0) {
          score += 1
          index = haystack.indexOf(term, index + term.length)
        }
      }
      if (score > 0 || terms.length === 0) hits.push({ entry, score })
    }
    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => hit.entry)
  }

  /** Direct read within scope; a foreign id is a not-found (never a leak). */
  async read(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }, id: string): Promise<MemoryEntry> {
    const file = this.filePath(scope.workspaceId, scope.projectId, id)
    await this.safeFile(this.root(scope), file)
    const raw = await fs.readFile(file, 'utf8').catch(() => {
      throw new MemoryError('not-found', `no memory entry '${id}' in this scope`)
    })
    const parsed = parseMemory(raw)
    if (parsed === undefined) {
      throw new MemoryError('invalid', `memory entry '${id}' is malformed; fix or rewrite it`)
    }
    return {
      id,
      title: parsed.frontmatter.name ?? parsed.frontmatter.title ?? id,
      scope: { workspaceId: scope.workspaceId, ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}) },
      pinned: parsed.frontmatter.pinned === true,
      createdAt: parsed.frontmatter.createdAt ?? 0,
      updatedAt: parsed.frontmatter.updatedAt ?? 0,
      body: parsed.body,
      hash: sha256(raw),
    }
  }

  /** Pinned entries within one scope, oldest first. */
  async pinned(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }): Promise<MemoryEntry[]> {
    const all = await this.search(scope, '', 100)
    return all.filter((entry) => entry.pinned)
  }

  async create(
    scope: { workspaceId: WorkspaceId; projectId?: ProjectId },
    input: { id: string; title: string; body: string; pinned?: boolean },
  ): Promise<MemoryEntry> {
    if (input.title.trim() === '' || input.body.trim() === '') {
      // Validate BEFORE writing: an invalid file must never land.
      throw new MemoryError('invalid', 'memory entries need a non-empty title and body')
    }
    const file = this.filePath(scope.workspaceId, scope.projectId, input.id)
    await this.safeMutation(scope, file)
    const now = Date.now()
    const raw = `---\nname: ${JSON.stringify(input.title)}\ndescription: ${JSON.stringify(input.body.trim().split('\n')[0]?.slice(0, 200) ?? '')}\nmetadata:\n  type: reference\npinned: ${input.pinned === true}\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n${input.body.trim()}\n`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await this.safeMutation(scope, file)
    // Exclusive create: concurrent creators race at the filesystem, and
    // exactly one wins (EEXIST → conflict) — no check-then-write window.
    let handle
    try {
      handle = await fs.open(file, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new MemoryError('conflict', `memory entry '${input.id}' already exists; use update`)
      }
      throw error
    }
    try {
      await handle.writeFile(raw, 'utf8')
    } finally {
      await handle.close()
    }
    await this.addPointer(scope, input.id, input.title)
    return this.read(scope, input.id)
  }

  private async addPointer(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }, id: string, title: string): Promise<void> {
    await this.prepare(scope)
    const file = path.join(this.root(scope), 'MEMORY.md')
    await this.safeFile(this.root(scope), file)
    const index = await fs.readFile(file, 'utf8')
    if (!index.includes(`](${id}.md)`)) await fs.appendFile(file, `- [${title.replace(/[\]\n\r]/g, '')}](${id}.md)\n`)
  }

  /** Update with expected-hash conflict detection (human edits win). */
  async update(
    scope: { workspaceId: WorkspaceId; projectId?: ProjectId },
    input: { id: string; title?: string; body?: string; pinned?: boolean; expectedHash: string },
  ): Promise<MemoryEntry> {
    await this.safeMutation(scope, this.filePath(scope.workspaceId, scope.projectId, input.id))
    const current = await this.read(scope, input.id)
    if (current.hash !== input.expectedHash) {
      throw new MemoryError('conflict', `memory entry '${input.id}' changed externally; re-read before updating`)
    }
    const title = input.title ?? current.title
    const body = input.body ?? current.body
    if (title.trim() === '' || body.trim() === '') {
      // Validate before publication: a rejected update must leave the last
      // valid entry intact, just like create does.
      throw new MemoryError('invalid', 'memory entries need a non-empty title and body')
    }
    const now = Date.now()
    const file = this.filePath(scope.workspaceId, scope.projectId, input.id)
    const before = await fs.readFile(file, 'utf8').catch(() => '')
    if (sha256(before) !== current.hash) throw new MemoryError('conflict', `memory entry '${input.id}' changed externally; re-read before updating`)
    const existing = parseMemory(before)
    const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(before)
    const raw = header !== null
      ? `${patchFrontmatter(header[1] ?? '', existing?.frontmatter.name !== undefined ? 'name' : 'title', title, now, input.pinned ?? current.pinned)}\n\n${body.trim()}\n`
      : serializeMemory(title, body, input.pinned ?? current.pinned, current.createdAt, now)
    await this.safeMutation(scope, file)
    await replaceFileAtomic(file, raw)
    if (title !== current.title) {
      const indexFile = path.join(this.root(scope), 'MEMORY.md')
      await this.safeFile(this.root(scope), indexFile)
      const index = await fs.readFile(indexFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (index !== undefined) {
        const oldPointer = pointer(input.id, current.title)
        const updated = index.split(/(\r?\n)/).map((line) => line === oldPointer ? pointer(input.id, title) : line).join('')
        if (updated !== index) await replaceFileAtomic(indexFile, updated)
      }
    }
    return this.read(scope, input.id)
  }

  /** Forget: future retrieval excludes the entry; history stays untouched. */
  async forget(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }, id: string): Promise<void> {
    const file = this.filePath(scope.workspaceId, scope.projectId, id)
    await this.safeMutation(scope, file)
    await fs.rm(file, { force: true })
    const index = path.join(this.root(scope), 'MEMORY.md')
    await this.safeFile(this.root(scope), index)
    const text = await fs.readFile(index, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (text !== undefined) await replaceFileAtomic(index, text.split('\n').filter((line) => !line.includes(`](${id}.md)`)).join('\n'))
  }
}

function sensitiveSegment(segment: string): boolean {
  return ['.git', '.env', 'secrets', 'skills', 'agents', 'commands'].includes(segment.toLowerCase())
}

function validId(id: string): boolean {
  const segments = id.split('/')
  return id.length <= 1024 && segments.every((segment, index) => Buffer.byteLength(segment + (index === segments.length - 1 ? '.md' : ''), 'utf8') <= 255 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(segment) && !sensitiveSegment(segment) && segment.toLowerCase() !== 'memory' && !segment.toLowerCase().endsWith('.md'))
}

function pointer(id: string, title: string): string {
  return `- [${title.replace(/[\]\n\r]/g, '')}](${id}.md)`
}

interface ParsedMemory {
  frontmatter: { title?: string; name?: string; description?: string; type?: string; pinned?: boolean; createdAt?: number; updatedAt?: number }
  body: string
}

function parseMemory(raw: string): ParsedMemory | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const body = (match !== null ? raw.slice(match[0].length) : raw).trim()
  if (body === '') return undefined
  const frontmatter: ParsedMemory['frontmatter'] = {}
  if (match !== null) {
    for (const line of (match[1] ?? '').split('\n')) {
      const kv = /^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line.trim())
      if (kv === null) continue
      const key = kv[1] ?? ''
      let value: unknown = kv[2]
      try {
        value = JSON.parse(kv[2] ?? '') as unknown
      } catch {
        // keep raw string
      }
      if (key === 'title' && typeof value === 'string') frontmatter.title = value
      if (key === 'name' && typeof value === 'string') frontmatter.name = value
      if (key === 'description' && typeof value === 'string') frontmatter.description = value
      if (key === 'type' && typeof value === 'string' && ['user', 'feedback', 'project', 'reference'].includes(value)) frontmatter.type = value
      if (key === 'pinned' && value === true) frontmatter.pinned = true
      if (key === 'createdAt' && typeof value === 'number') frontmatter.createdAt = value
      if (key === 'updatedAt' && typeof value === 'number') frontmatter.updatedAt = value
    }
  }
  return { frontmatter, body }
}

function patchFrontmatter(header: string, titleKey: 'name' | 'title', title: string, updatedAt: number, pinned: boolean): string {
  const lines = header.split(/\r?\n/)
  const changes = new Map([[titleKey, JSON.stringify(title)], ['updatedAt', String(updatedAt)], ['pinned', String(pinned)]])
  for (let i = 0; i < lines.length; i++) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*):/.exec(lines[i] ?? '')
    if (match !== null && changes.has(match[1]!)) {
      lines[i] = `${match[1]}: ${changes.get(match[1]!)}`
      changes.delete(match[1]!)
    }
  }
  for (const [key, value] of changes) lines.push(`${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---`
}

function serializeMemory(title: string, body: string, pinned: boolean, createdAt: number, updatedAt: number): string {
  return `---\ntitle: ${JSON.stringify(title)}\npinned: ${pinned}\ncreatedAt: ${createdAt}\nupdatedAt: ${updatedAt}\n---\n\n${body.trim()}\n`
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
