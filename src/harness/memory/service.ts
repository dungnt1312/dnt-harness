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
  constructor(private readonly home: string) {}

  private dir(workspaceId: WorkspaceId, projectId?: ProjectId): string {
    return projectId === undefined
      ? path.join(this.home, 'workspaces', workspaceId, 'memory', 'workspace')
      : path.join(this.home, 'workspaces', workspaceId, 'memory', 'projects', projectId)
  }

  private filePath(workspaceId: WorkspaceId, projectId: ProjectId | undefined, id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new MemoryError('invalid', `memory id '${id}' must be kebab-case`)
    }
    return path.join(this.dir(workspaceId, projectId), `${id}.md`)
  }

  /** Bounded keyword search within ONE scope (no cross-scope reads). */
  async search(
    scope: { workspaceId: WorkspaceId; projectId?: ProjectId },
    query: string,
    limit = 20,
  ): Promise<MemoryEntry[]> {
    const dir = this.dir(scope.workspaceId, scope.projectId)
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
    const hits: { entry: MemoryEntry; score: number }[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue
      const entry = await this.read(scope, name.slice(0, -3)).catch(() => undefined)
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
    const raw = await fs.readFile(this.filePath(scope.workspaceId, scope.projectId, id), 'utf8').catch(() => {
      throw new MemoryError('not-found', `no memory entry '${id}' in this scope`)
    })
    const parsed = parseMemory(raw)
    if (parsed === undefined) {
      throw new MemoryError('invalid', `memory entry '${id}' is malformed; fix or rewrite it`)
    }
    return {
      id,
      title: parsed.frontmatter.title ?? id,
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
    const now = Date.now()
    const raw = serializeMemory(input.title, input.body, input.pinned === true, now, now)
    await fs.mkdir(path.dirname(file), { recursive: true })
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
    return this.read(scope, input.id)
  }

  /** Update with expected-hash conflict detection (human edits win). */
  async update(
    scope: { workspaceId: WorkspaceId; projectId?: ProjectId },
    input: { id: string; title?: string; body?: string; pinned?: boolean; expectedHash: string },
  ): Promise<MemoryEntry> {
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
    const raw = serializeMemory(title, body, input.pinned ?? current.pinned, current.createdAt, now)
    await replaceFileAtomic(this.filePath(scope.workspaceId, scope.projectId, input.id), raw)
    return this.read(scope, input.id)
  }

  /** Forget: future retrieval excludes the entry; history stays untouched. */
  async forget(scope: { workspaceId: WorkspaceId; projectId?: ProjectId }, id: string): Promise<void> {
    await fs.rm(this.filePath(scope.workspaceId, scope.projectId, id), { force: true })
  }
}

interface ParsedMemory {
  frontmatter: { title?: string; pinned?: boolean; createdAt?: number; updatedAt?: number }
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
      if (key === 'pinned' && value === true) frontmatter.pinned = true
      if (key === 'createdAt' && typeof value === 'number') frontmatter.createdAt = value
      if (key === 'updatedAt' && typeof value === 'number') frontmatter.updatedAt = value
    }
  }
  return { frontmatter, body }
}

function serializeMemory(title: string, body: string, pinned: boolean, createdAt: number, updatedAt: number): string {
  return `---\ntitle: ${JSON.stringify(title)}\npinned: ${pinned}\ncreatedAt: ${createdAt}\nupdatedAt: ${updatedAt}\n---\n\n${body.trim()}\n`
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
