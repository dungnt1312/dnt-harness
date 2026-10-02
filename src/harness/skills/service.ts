import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { SkillError, type SkillSource } from './layers.ts'

export { SkillError } from './layers.ts'
export type { SkillSource } from './layers.ts'

export interface SkillEntry {
  /** Directory/lookup name (kebab-case). */
  readonly name: string
  readonly title: string
  readonly description: string
  readonly source: SkillSource
  /** sha256 of the raw SKILL.md. */
  readonly hash: string
}

export interface LoadedSkill extends SkillEntry {
  readonly instructions: string
}

/**
 * Workspace-scoped skill catalog. A skill is a directory with `SKILL.md`
 * (Markdown + minimal frontmatter) plus optional resource files —
 * file-native, editable by external editors. Loading validates and hashes;
 * an externally edited file loads fresh content with a NEW hash (the hash
 * pins what an execution saw, it never blocks a read). Layers resolve by
 * name in precedence order workspace > user (e.g. `~/.claude/skills`) >
 * bundled; user and bundled skills are read-only.
 */
export class SkillsService {
  private readonly home: string
  private readonly bundledDir: string | undefined
  private readonly userDir: string | undefined
  private readonly mutationTails = new Map<string, Promise<unknown>>()

  constructor(home: string, bundledDir?: string, userDir?: string) {
    this.home = home
    this.bundledDir = bundledDir
    this.userDir = userDir
  }

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'skills')
  }

  /** Configured layers, highest precedence first. */
  private layers(workspaceId: string): Array<readonly [string, SkillSource]> {
    const layers: Array<readonly [string, SkillSource]> = [[this.dir(workspaceId), 'workspace']]
    if (this.userDir !== undefined) layers.push([this.userDir, 'user'])
    if (this.bundledDir !== undefined) layers.push([this.bundledDir, 'bundled'])
    return layers
  }

  /** Catalog: one row per name, the highest-precedence layer wins. */
  async list(workspaceId: string): Promise<SkillEntry[]> {
    const rows = new Map<string, SkillEntry>()
    for (const [base, source] of this.layers(workspaceId)) {
      let entries
      try {
        entries = await fs.readdir(base, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const raw = await fs.readFile(path.join(base, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
        if (raw === undefined) continue
        const parsed = parseSkill(raw)
        if (parsed === undefined) continue // invalid skills are surfaced on load, not served
        if (!rows.has(entry.name)) {
          rows.set(entry.name, {
            name: entry.name,
            title: parsed.title ?? entry.name,
            description: parsed.description ?? '',
            source,
            hash: sha256(raw),
          })
        }
      }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Load one skill's instructions; validates the file before returning. */
  async load(workspaceId: string, name: string): Promise<LoadedSkill> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new SkillError('not-found', `no skill '${name}'`)
    }
    for (const [base, source] of this.layers(workspaceId)) {
      const raw = await fs.readFile(path.join(base, name, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      const parsed = parseSkill(raw)
      if (parsed === undefined) {
        throw new SkillError('invalid', `skill '${name}' has invalid frontmatter; fix SKILL.md before loading`)
      }
      return {
        name,
        title: parsed.title ?? name,
        description: parsed.description ?? '',
        source,
        hash: sha256(raw),
        instructions: parsed.body,
      }
    }
    throw new SkillError('not-found', `no skill '${name}'`)
  }

  /**
   * Create or replace a workspace skill. Content is the raw SKILL.md;
   * validated before write, and `expectedHash` conflicts surface instead
   * of clobbering external edits.
   */
  async save(workspaceId: string, name: string, raw: string, expectedHash?: string): Promise<LoadedSkill> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new SkillError('invalid', `skill name '${name}' must be kebab-case`)
    }
    const parsed = parseSkill(raw)
    if (parsed === undefined) throw new SkillError('invalid', 'SKILL.md needs `name:`/`description:` frontmatter and a body')
    const file = path.join(this.dir(workspaceId), name, 'SKILL.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const current = await fs.readFile(file, 'utf8').catch(() => undefined)
    if (current !== undefined && expectedHash !== undefined && sha256(current) !== expectedHash) {
      throw new SkillError('conflict', `skill '${name}' changed externally; re-read before saving`)
    }
    // Atomic replacement (see modes): crash-safe writes; the external-editor
    // TOCTOU window remains a documented limit.
    await replaceFileAtomic(file, raw)
    return {
      name,
      title: parsed.title ?? name,
      description: parsed.description ?? '',
      source: 'workspace',
      hash: sha256(raw),
      instructions: parsed.body,
    }
  }

  async delete(workspaceId: string, name: string): Promise<void> {
    await fs.rm(path.join(this.dir(workspaceId), name), { recursive: true, force: true })
  }

  // ── Workspace catalog visibility ──────────────────────────────────────────
  // A per-workspace hidden set, persisted beside the skill folders it governs.
  // Hidden skills leave the discovery surfaces (the injected catalog block and
  // the Skill tool's catalog action) but an explicit `Skill load` by name
  // still works — demand-only, not disabled. The set may name skills that do
  // not exist (yet, or on another layer); absent names are ignored everywhere
  // the set is consulted. It exists because user/bundled layers are read-only:
  // the sidecar is the only per-workspace curation those skills admit.

  private hiddenPath(workspaceId: string): string {
    return path.join(this.dir(workspaceId), '.hidden.json')
  }

  /** Names this workspace has hidden from its skill catalog. Absent file → none. */
  async hiddenNames(workspaceId: string): Promise<readonly string[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.hiddenPath(workspaceId), 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { hidden?: unknown }
      if (!Array.isArray(parsed.hidden)) return []
      return parsed.hidden.filter((name): name is string => typeof name === 'string')
    } catch {
      return []
    }
  }

  /** The catalog rows a request may DISCOVER: everything not hidden. */
  async listVisible(workspaceId: string): Promise<SkillEntry[]> {
    const hidden = new Set(await this.hiddenNames(workspaceId))
    if (hidden.size === 0) return this.list(workspaceId)
    return (await this.list(workspaceId)).filter((entry) => !hidden.has(entry.name))
  }

  /**
   * Hide or unhide one skill in this workspace's catalog. The name must be
   * well-formed but need not exist: pre-hiding (or keeping a tombstone for)
   * an absent skill is harmless.
   */
  async setHidden(workspaceId: string, name: string, hidden: boolean): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new SkillError('not-found', `no skill '${name}'`)
    }
    await this.withMutationLock(workspaceId, '.hidden', async () => {
      const current = new Set(await this.hiddenNames(workspaceId))
      if (hidden) current.add(name)
      else current.delete(name)
      const file = this.hiddenPath(workspaceId)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify({ hidden: [...current] }, null, 2)}\n`)
    })
  }

  /** Serializes sidecar mutations per workspace (the modes-service pattern). */
  private withMutationLock<T>(workspaceId: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}\u0000${id}`
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.mutationTails.set(key, tail)
    return previous.then(() => operation().finally(() => {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }))
  }
}

export interface ParsedSkill {
  readonly title?: string
  readonly description?: string
  readonly body: string
}

/** Minimal frontmatter parse; undefined when the file has no valid body. */
export function parseSkill(raw: string): ParsedSkill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const body = (match !== null ? raw.slice(match[0].length) : raw).trim()
  if (body === '') return undefined
  let title: string | undefined
  let description: string | undefined
  if (match !== null) {
    for (const line of (match[1] ?? '').split('\n')) {
      const kv = /^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line.trim())
      if (kv === null) continue
      try {
        const value = JSON.parse(kv[2] ?? '') as unknown
        if (kv[1] === 'name' && typeof value === 'string') title = value
        if (kv[1] === 'description' && typeof value === 'string') description = value
      } catch {
        if (kv[1] === 'name' && (kv[2] ?? '') !== '') title = kv[2]
        if (kv[1] === 'description' && (kv[2] ?? '') !== '') description = kv[2]
      }
    }
  }
  return { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), body }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
