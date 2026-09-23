import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { BUNDLED_MODES, DEFAULT_MODE_ID, KNOWN_MODE_TOOLS } from './bundled.ts'
import { ModeError, type ModeDefinition, type ModeFrontmatter, type ModeSources, type ResolvedMode } from './types.ts'

export { BUNDLED_MODES, DEFAULT_MODE_ID }
export { ModeError }
export type { ModeDefinition, ModeFrontmatter, ModeSources, ResolvedMode }

/**
 * Workspace-scoped mode registry. Bundled modes are read-only constants;
 * custom modes are Markdown/frontmatter files under
 * `<home>/workspaces/<ws>/modes/<id>.md`, owned by that workspace.
 * Selecting a validated mode is live; a mode file is NOT hot-reloaded —
 * edits apply to future resolutions, and the resolved hash pins what an
 * execution actually saw.
 */
export class ModesService {
  private readonly home: string
  /** Tails of per-file mutation queues; unrelated modes proceed independently. */
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(home: string) {
    this.home = home
  }

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'modes')
  }

  /**
   * Mode ids are filenames, never paths. Validate before bundled lookup or any
   * filesystem operation so decoded URL separators cannot escape `modes/`.
   */
  private assertModeId(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new ModeError('invalid', `mode id '${id}' must be kebab-case`)
    }
  }

  private filePath(workspaceId: string, id: string): string {
    this.assertModeId(id)
    return path.join(this.dir(workspaceId), `${id}.md`)
  }

  /** Serialize mutations only for one workspace-mode pair. */
  private async withMutationLock<T>(workspaceId: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}\u0000${id}`
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.mutationTails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }

  /** Bundled + workspace modes (custom overrides never shadow bundled ids). */
  async list(workspaceId: string): Promise<ResolvedMode[]> {
    const rows: ResolvedMode[] = BUNDLED_MODES.map((definition) => ({ definition, source: 'bundled' as const }))
    let entries
    try {
      entries = await fs.readdir(this.dir(workspaceId), { withFileTypes: true })
    } catch {
      return rows
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const id = entry.name.slice(0, -3)
      if (BUNDLED_MODES.some((mode) => mode.id === id)) continue
      try {
        const resolved = await this.resolve(workspaceId, id)
        rows.push(resolved)
      } catch {
        // Invalid files are surfaced in resolve(); listing skips them
        // rather than serving something unvalidated.
      }
    }
    return rows
  }

  /**
   * Resolve one mode by id: bundled constants or a validated workspace
   * file. Unknown and invalid ids both fail loud.
   */
  async resolve(workspaceId: string, id: string): Promise<ResolvedMode> {
    this.assertModeId(id)
    const bundled = BUNDLED_MODES.find((mode) => mode.id === id)
    if (bundled !== undefined) return { definition: bundled, source: 'bundled' }
    let raw: string
    try {
      raw = await fs.readFile(this.filePath(workspaceId, id), 'utf8')
    } catch {
      throw new ModeError('not-found', `no mode '${id}'`)
    }
    const definition = parseModeFile(id, raw)
    return { definition, source: 'workspace', hash: sha256(raw) }
  }

  /**
   * One mode's raw Markdown, for an editor. `resolve` returns the parsed
   * definition, which is not something a file editor can round-trip. A
   * bundled id yields the canonical serialization — exactly what Duplicate
   * would write — with no hash, because there is no file to conflict with.
   */
  async load(workspaceId: string, id: string): Promise<{ id: string; raw: string; source: 'bundled' | 'workspace'; hash?: string }> {
    this.assertModeId(id)
    const bundled = BUNDLED_MODES.find((mode) => mode.id === id)
    if (bundled !== undefined) return { id, raw: serializeModeFile(bundled), source: 'bundled' }
    let raw: string
    try {
      raw = await fs.readFile(this.filePath(workspaceId, id), 'utf8')
    } catch {
      throw new ModeError('not-found', `no mode '${id}'`)
    }
    parseModeFile(id, raw) // never hand back content that would not load
    return { id, raw, source: 'workspace', hash: sha256(raw) }
  }

  /**
   * Create or replace a workspace mode file. Content is the raw Markdown
   * (frontmatter + instructions body); it is validated BEFORE the write
   * lands, and `expectedHash` conflicts surface instead of clobbering
   * external edits.
   */
  async save(workspaceId: string, id: string, raw: string, expectedHash?: string): Promise<ResolvedMode> {
    this.assertModeId(id)
    if (BUNDLED_MODES.some((mode) => mode.id === id)) {
      throw new ModeError('duplicate', `'${id}' is a bundled mode; duplicate it to customize`)
    }
    const definition = parseModeFile(id, raw) // validate before writing anything
    return this.withMutationLock(workspaceId, id, async () => {
      const file = this.filePath(workspaceId, id)
      let current: string | undefined
      try {
        current = await fs.readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current === undefined ? expectedHash !== undefined : expectedHash === undefined || sha256(current) !== expectedHash) {
        throw new ModeError('conflict', `conflict: '${id}' changed externally; re-read before saving`)
      }
      await fs.mkdir(path.dirname(file), { recursive: true })
      // Atomic replacement (temp + sync + rename): a crash mid-write never
      // leaves a half-valid mode file behind. This in-process lock makes the
      // check/write sequence coherent with concurrent API saves and deletes.
      await replaceFileAtomic(file, raw)
      // A saved mode is an enabled mode: a recreated id must not inherit the
      // old entry's hidden state.
      await this.withMutationLock(workspaceId, '.disabled', async () => {
        const disabled = new Set(await this.disabledIds(workspaceId))
        if (!disabled.delete(id)) return
        const stateFile = this.disabledPath(workspaceId)
        await replaceFileAtomic(stateFile, `${JSON.stringify({ disabled: [...disabled] }, null, 2)}\n`)
      })
      return { definition, source: 'workspace', hash: sha256(raw) }
    })
  }

  /** Duplicate a bundled (or any) mode into the workspace for customization. */
  async duplicate(workspaceId: string, sourceId: string, newId: string): Promise<ResolvedMode> {
    this.assertModeId(sourceId)
    this.assertModeId(newId)
    const source = await this.resolve(workspaceId, sourceId)
    const raw = serializeModeFile({ ...source.definition, id: newId })
    return this.save(workspaceId, newId, raw)
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    this.assertModeId(id)
    if (BUNDLED_MODES.some((mode) => mode.id === id)) {
      throw new ModeError('duplicate', 'bundled modes cannot be deleted')
    }
    await this.withMutationLock(workspaceId, id, async () => {
      try {
        await fs.rm(this.filePath(workspaceId, id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ModeError('not-found', `no mode '${id}'`)
        }
        throw error
      }
    })
  }

  // ── Workspace selected mode (durable) ───────────────────────────────
  // The workspace's live selection is persisted so a server restart restores
  // the same mode (e.g. Full access) instead of falling back to the default.
  // Missing/invalid selections fall back to DEFAULT_MODE_ID.

  private selectedPath(workspaceId: string): string {
    return path.join(this.dir(workspaceId), '.selected.json')
  }

  /** The persisted selected mode for this workspace, if any. */
  async selectedId(workspaceId: string): Promise<string | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(this.selectedPath(workspaceId), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as { selected?: unknown; modeId?: unknown }
      const candidate = parsed.selected ?? parsed.modeId
      if (typeof candidate !== 'string' || candidate.trim() === '') return undefined
      const id = candidate.trim()
      // Must still resolve (bundled always does; custom may have been deleted
      // or become invalid). An unresolvable id is treated as absent so the
      // caller can fall back to the default without surfacing a hard error.
      try {
        await this.resolve(workspaceId, id)
      } catch {
        return undefined
      }
      if ((await this.disabledIds(workspaceId)).includes(id)) return undefined
      return id
    } catch {
      return undefined
    }
  }

  /** Persist the workspace's selected mode. */
  async setSelected(workspaceId: string, id: string): Promise<void> {
    await this.resolve(workspaceId, id) // validate before persisting
    await this.withMutationLock(workspaceId, '.selected', async () => {
      const file = this.selectedPath(workspaceId)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify({ selected: id }, null, 2)}\n`)
    })
  }

  // ── Workspace enablement ──────────────────────────────────────────────────
  // A per-workspace disabled set, persisted beside the mode files it governs.
  // Absent ids (a deleted file, a mode that returns) are ignored wherever the
  // set is consulted, and saving a mode clears its entry, so a recreated id
  // starts enabled.

  private disabledPath(workspaceId: string): string {
    return path.join(this.dir(workspaceId), '.disabled.json')
  }

  /** Ids this workspace has hidden from its mode picker. Absent file → none. */
  async disabledIds(workspaceId: string): Promise<readonly string[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.disabledPath(workspaceId), 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as { disabled?: unknown }
      if (!Array.isArray(parsed.disabled)) return []
      return parsed.disabled.filter((id): id is string => typeof id === 'string')
    } catch {
      return []
    }
  }

  /**
   * Show or hide one mode in this workspace's picker. Bundled modes may be
   * hidden too; the mode must exist, and the selected-mode refusal lives at
   * the route, which knows the live controls.
   */
  async setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<void> {
    await this.resolve(workspaceId, id) // not-found / invalid surfaces here
    await this.withMutationLock(workspaceId, '.disabled', async () => {
      const current = new Set(await this.disabledIds(workspaceId))
      if (enabled) current.delete(id)
      else current.add(id)
      const file = this.disabledPath(workspaceId)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify({ disabled: [...current] }, null, 2)}\n`)
    })
  }
}

/** The exact frontmatter keys a mode file may carry. */
const KNOWN_FRONTMATTER_KEYS = new Set([
  'name', 'description', 'history', 'workspaceInstructions', 'skills',
  'memoryPinned', 'memoryRetrieval', 'toolExposure', 'permissionDefaults', 'outOfGrant',
])

/**
 * The permission keys the approval gate can actually match: an exact known
 * tool, an exact MCP tool, an `mcp__<server>__*` wildcard, or the catch-all
 * `*`. Anything else — `mcp__*__read`, `Ba*h`, a legacy lowercase `bash` —
 * would be stored and then silently never apply, so it is rejected at the
 * boundary instead. Mirrors the resolution order in `approval/policy.ts`.
 */
function isPermissionKey(tool: string): boolean {
  if (tool === '*' || KNOWN_MODE_TOOLS.includes(tool)) return true
  const parts = tool.split('__')
  return parts.length === 3
    && parts[0] === 'mcp'
    && /^[A-Za-z0-9_-]+$/.test(parts[1] ?? '')
    && (parts[2] === '*' || (parts[2] !== '' && !parts[2]?.includes('*')))
}

/**
 * Parse and validate one mode file STRICTLY: unknown keys, invalid enum
 * values, non-boolean flags, unknown tool names, and invalid permission
 * entries are REJECTED (ModeError), never silently coerced into a
 * different mode — invalid content is never executed.
 */
export function parseModeFile(id: string, raw: string): ModeDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const body = match !== null ? raw.slice(match[0].length) : raw
  const frontmatter = match !== null ? parseFrontmatter(match[1] ?? '') : {}
  const invalid: string[] = []

  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) invalid.push(`unknown frontmatter key '${key}'`)
  }
  if (frontmatter.name !== undefined && typeof frontmatter.name !== 'string') {
    invalid.push("'name' must be a string")
  }
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() !== '' ? frontmatter.name.trim() : id

  let history: ModeSources['history'] = 'recent'
  if (frontmatter.history !== undefined) {
    if (frontmatter.history === 'none' || frontmatter.history === 'compact' || frontmatter.history === 'recent') {
      history = frontmatter.history
    } else {
      invalid.push(`'history' must be none|recent|compact, got ${JSON.stringify(frontmatter.history)}`)
    }
  }
  const sources = {
    history,
    workspaceInstructions: true,
    memoryPinned: true,
    memoryRetrieval: true,
    skills: 'on-demand' as ModeSources['skills'],
  }
  for (const flag of ['workspaceInstructions', 'memoryPinned', 'memoryRetrieval'] as const) {
    const value: unknown = frontmatter[flag]
    if (value === undefined) {
      // default true
    } else if (value === true || value === false) {
      sources[flag] = value
    } else {
      invalid.push(`'${flag}' must be a boolean`)
    }
  }
  if (frontmatter.skills === undefined) {
    // default on-demand
  } else if (frontmatter.skills === 'off' || frontmatter.skills === 'on-demand') {
    sources.skills = frontmatter.skills
  } else {
    invalid.push(`'skills' must be off|on-demand, got ${JSON.stringify(frontmatter.skills)}`)
  }

  let toolExposure: string[] = []
  if (frontmatter.toolExposure !== undefined) {
    if (!Array.isArray(frontmatter.toolExposure)) {
      invalid.push("'toolExposure' must be an array of tool names")
    } else {
      const names = (frontmatter.toolExposure as unknown[]).map((tool) => String(tool))
      const unknown = names.filter((tool) => !KNOWN_MODE_TOOLS.includes(tool))
      if (unknown.length > 0) {
        invalid.push(`'toolExposure' names unknown tools: ${unknown.join(', ')} (known: ${KNOWN_MODE_TOOLS.join(', ')})`)
      } else {
        toolExposure = names
      }
    }
  }

  const permissionDefaults: Record<string, 'allow' | 'ask' | 'deny'> = {}
  if (frontmatter.permissionDefaults !== undefined) {
    if (frontmatter.permissionDefaults === null || typeof frontmatter.permissionDefaults !== 'object') {
      invalid.push("'permissionDefaults' must be an object of tool → allow|ask|deny")
    } else {
      for (const [tool, mode] of Object.entries(frontmatter.permissionDefaults as Record<string, unknown>)) {
        if (!isPermissionKey(tool)) {
          invalid.push(`'permissionDefaults' key '${tool}' would never match; use a known tool (${KNOWN_MODE_TOOLS.join(', ')}), 'mcp__<server>__<tool>', 'mcp__<server>__*', or '*'`)
        } else if (mode === 'allow' || mode === 'ask' || mode === 'deny') {
          permissionDefaults[tool] = mode
        } else {
          invalid.push(`'permissionDefaults.${tool}' must be allow|ask|deny, got ${JSON.stringify(mode)}`)
        }
      }
    }
  }

  let outOfGrant: 'allow' | 'ask' | undefined
  if (frontmatter.outOfGrant !== undefined) {
    if (frontmatter.outOfGrant === 'allow' || frontmatter.outOfGrant === 'ask') outOfGrant = frontmatter.outOfGrant
    else invalid.push(`'outOfGrant' must be allow|ask, got ${JSON.stringify(frontmatter.outOfGrant)}`)
  }

  if (invalid.length > 0) {
    throw new ModeError('invalid', `mode '${id}' is invalid: ${invalid.join('; ')}`)
  }
  return {
    id,
    name,
    instructions: body.trim(),
    sources,
    toolExposure,
    permissionDefaults,
    ...(outOfGrant !== undefined ? { outOfGrant } : {}),
  }
}

function parseFrontmatter(block: string): ModeFrontmatter {
  // A minimal `key: value` parser keeps mode files dependency-free; values
  // may be inline JSON arrays/objects.
  const result: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const key = match[1] ?? ''
    const rawValue = match[2]?.trim() ?? ''
    try {
      result[key] = JSON.parse(rawValue) as unknown
    } catch {
      result[key] = rawValue
    }
  }
  return result as ModeFrontmatter
}

/** Serialize a definition back to canonical Markdown/frontmatter form. */
export function serializeModeFile(definition: ModeDefinition): string {
  const fm: string[] = [`name: ${JSON.stringify(definition.name)}`, `history: ${definition.sources.history}`,
    `workspaceInstructions: ${definition.sources.workspaceInstructions}`, `skills: ${definition.sources.skills}`,
    `memoryPinned: ${definition.sources.memoryPinned}`, `memoryRetrieval: ${definition.sources.memoryRetrieval}`,
    `toolExposure: ${JSON.stringify(definition.toolExposure)}`,
    `permissionDefaults: ${JSON.stringify(definition.permissionDefaults)}`,
    ...(definition.outOfGrant !== undefined ? [`outOfGrant: ${definition.outOfGrant}`] : [])]
  return `---\n${fm.join('\n')}\n---\n\n${definition.instructions.trim()}\n`
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
