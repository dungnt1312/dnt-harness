import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { frontmatterBoolean, hintText, parseCommand, splitFrontmatter, type CommandDefinition } from '../commands/catalog.ts'
import { SKILL_NAME_PATTERN, SkillError, skillFolderIn, assertSkillName, assertWritableSkillName, validateSkillRulesForWrite, type SkillLayer, type SkillRule, type SkillSource } from './layers.ts'
import { ResourceSourcesError, ResourceSourcesStore } from '../sources/resource-sources.ts'

export { SkillError } from './layers.ts'
export type { SkillSource } from './layers.ts'

export interface SkillEntry {
  /** Directory/lookup name (kebab-case). */
  readonly name: string
  readonly title: string
  readonly description: string
  readonly source: SkillSource
  /** The source rule a project/user layer resolved from; absent on default layers. */
  readonly ruleId?: string
  /** sha256 of the raw SKILL.md. */
  readonly hash: string
  /** Claude `disable-model-invocation: true`: only the user can run it (`/name`). */
  readonly disableModelInvocation?: true
  /** Claude `user-invocable: false`: hidden from the `/` menu, the model may still load it. */
  readonly userInvocable?: false
  /** Claude `argument-hint`, shown in the `/` menu. */
  readonly argumentHint?: string
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
 * name, first hit wins. The `*In` methods take explicit layers resolved from
 * the workspace's source rules (`sources.json`, see layers.ts: project rule
 * folders, the workspace folder, absolute/user folders, in rule order, with
 * bundled appended last by the host). The legacy workspace-only methods use
 * the fixed order workspace > user > bundled. Only the workspace folder is
 * writable; every other layer is read-only.
 */
export class SkillsService {
  private readonly home: string
  private readonly bundledDir: string | undefined
  private readonly userDir: string | undefined
  private readonly mutationTails = new Map<string, Promise<unknown>>()
  /** Shared per-workspace source policy (skill rules + which fixed layers are off). */
  readonly sourcesStore: ResourceSourcesStore

  constructor(home: string, bundledDir?: string, userDir?: string, sourcesStore?: ResourceSourcesStore) {
    this.home = home
    this.bundledDir = bundledDir
    this.userDir = userDir
    this.sourcesStore = sourcesStore ?? new ResourceSourcesStore(home, userDir)
  }

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'skills')
  }

  /** The workspace layer's folder, for callers that resolve rule layers. */
  workspaceSkillsDir(workspaceId: string): string {
    return this.dir(workspaceId)
  }

  /** Plugin skill layers for a workspace/project (set by the host when plugins are wired). */
  private pluginLayerSource: ((workspaceId: string, projectId: string | undefined) => Promise<SkillLayer[]>) | undefined

  setPluginLayers(source: (workspaceId: string, projectId: string | undefined) => Promise<SkillLayer[]>): void {
    this.pluginLayerSource = source
  }

  async pluginLayers(workspaceId: string, projectId: string | undefined): Promise<SkillLayer[]> {
    return this.pluginLayerSource?.(workspaceId, projectId) ?? []
  }

  /** The bundled layer's scan root, when the service was built with one. */
  bundledLayer(): SkillLayer | undefined {
    return this.bundledDir !== undefined ? { base: this.bundledDir, source: 'bundled' } : undefined
  }

  /** Default layers when no rules apply: workspace > user > bundled. */
  private defaultLayers(workspaceId: string): SkillLayer[] {
    const layers: SkillLayer[] = [{ base: this.dir(workspaceId), source: 'workspace' }]
    if (this.userDir !== undefined) layers.push({ base: this.userDir, source: 'user' })
    if (this.bundledDir !== undefined) layers.push({ base: this.bundledDir, source: 'bundled' })
    return layers
  }

  // ── Source rules ─────────────────────────────────────────────────────────
  // The ordered rule list decides which folders the catalog scans and in what
  // precedence; see layers.ts for the pure model. It lives in the workspace's
  // shared `resource-sources.json` (see sources/resource-sources.ts), which
  // imports the legacy `skills/sources.json` until the first save.

  /** The effective rule list (defaults, the legacy file, or the shared document). */
  async sources(workspaceId: string): Promise<SkillRule[]> {
    return [...(await this.sourcesStore.read(workspaceId)).doc.skills.rules]
  }

  /** Replace the rule list; validated, atomic; returns what was stored. Other kinds' switches are kept. */
  async setSources(workspaceId: string, raw: unknown): Promise<SkillRule[]> {
    const rules = validateSkillRulesForWrite(raw)
    try {
      await this.sourcesStore.update(workspaceId, (doc) => ({ ...doc, skills: { rules } }))
    } catch (error) {
      if (error instanceof ResourceSourcesError) throw new SkillError('invalid', error.message)
      throw error
    }
    return rules
  }

  /** Fixed skill layers (`plugin`, `bundled`) this workspace switched off. */
  async disabledLayers(workspaceId: string): Promise<ReadonlySet<string>> {
    return this.sourcesStore.disabled(workspaceId, 'skills')
  }

  /** Catalog: one row per name, the highest-precedence layer wins. */
  async list(workspaceId: string): Promise<SkillEntry[]> {
    return this.listIn(this.defaultLayers(workspaceId))
  }

  /**
   * Layer-aware catalog scan; the first layer carrying a name wins. Only
   * folders whose name is loadable (kebab-case) are listed, so the catalog
   * never advertises a skill `loadIn` would refuse. Names already claimed by
   * a higher layer are skipped before any read, and parsed SKILL.md heads are
   * cached by (mtime, size) — this scan runs on every model request.
   */
  async listIn(layers: readonly SkillLayer[]): Promise<SkillEntry[]> {
    const rows = new Map<string, SkillEntry>()
    for (const layer of layers) {
      let entries: { readonly name: string; readonly folder: string }[]
      if (layer.single === true) {
        entries = [{ name: path.basename(layer.base), folder: layer.base }]
      } else {
        try {
          entries = (await fs.readdir(layer.base, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => ({ name: entry.name, folder: path.join(layer.base, entry.name) }))
        } catch {
          continue
        }
      }
      await Promise.all(entries.map(async (entry) => {
        if (!SKILL_NAME_PATTERN.test(entry.name)) return
        const name = layer.prefix !== undefined ? `${layer.prefix}:${entry.name}` : entry.name
        if (rows.has(name)) return
        const head = await this.readHead(path.join(entry.folder, 'SKILL.md'))
        if (head === undefined) return // missing or invalid: surfaced on load, not served
        rows.set(name, {
          name,
          title: head.title ?? entry.name,
          description: head.description ?? '',
          source: layer.source,
          ...(layer.ruleId !== undefined ? { ruleId: layer.ruleId } : {}),
          hash: head.hash,
          ...(head.disableModelInvocation === true ? { disableModelInvocation: true as const } : {}),
          ...(head.userInvocable === false ? { userInvocable: false as const } : {}),
          ...(head.argumentHint !== undefined ? { argumentHint: head.argumentHint } : {}),
        })
      }))
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Parsed catalog head of one SKILL.md, keyed by path and validated by (mtime, size). */
  private readonly headCache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly head: SkillHead | undefined }>()

  private async readHead(file: string): Promise<SkillHead | undefined> {
    const stat = await fs.stat(file).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) {
      this.headCache.delete(file)
      return undefined
    }
    const cached = this.headCache.get(file)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.head
    const raw = await fs.readFile(file, 'utf8').catch(() => undefined)
    const parsed = raw !== undefined ? parseSkill(raw) : undefined
    let head: SkillHead | undefined
    if (raw !== undefined && parsed !== undefined) {
      const { frontmatter } = splitFrontmatter(raw)
      const hint = hintText(frontmatter['argument-hint'])
      head = {
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        hash: sha256(raw),
        ...(frontmatterBoolean(frontmatter['disable-model-invocation']) === true ? { disableModelInvocation: true } : {}),
        ...(frontmatterBoolean(frontmatter['user-invocable']) === false ? { userInvocable: false } : {}),
        ...(hint !== undefined ? { argumentHint: hint } : {}),
      }
    }
    if (this.headCache.size > 2_000) this.headCache.clear()
    this.headCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, head })
    return head
  }

  /** Load one skill's instructions; validates the file before returning. */
  async load(workspaceId: string, name: string): Promise<LoadedSkill> {
    return this.loadIn(this.defaultLayers(workspaceId), name)
  }

  /** Layer-aware load; the first layer holding the name wins. */
  async loadIn(layers: readonly SkillLayer[], name: string): Promise<LoadedSkill> {
    assertSkillName(name)
    const resolved = await this.resolveName(layers, name)
    if (resolved !== undefined) {
      const { layer, folder, qualified } = resolved
      const raw = await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8').catch(() => undefined)
      const parsed = raw !== undefined ? parseSkill(raw) : undefined
      if (raw !== undefined && parsed === undefined) {
        throw new SkillError('invalid', `skill '${qualified}' has invalid frontmatter; fix SKILL.md before loading`)
      }
      if (raw !== undefined && parsed !== undefined) {
        return {
          name: qualified,
          title: parsed.title ?? qualified,
          description: parsed.description ?? '',
          source: layer.source,
          ...(layer.ruleId !== undefined ? { ruleId: layer.ruleId } : {}),
          hash: sha256(raw),
          instructions: parsed.body,
        }
      }
    }
    throw new SkillError('not-found', `no skill '${name}'`)
  }

  // ── Skill file tree ──────────────────────────────────────────────────────
  // Settings renders each skill as a folder; these reads power it. The OWNING
  // layer is the first layer holding <base>/<name>/SKILL.md — the same
  // first-hit rule the catalog row used, so the tree shows what that row is.

  /**
   * A skill as a Claude command (`/name`, or a `Skill` load with arguments):
   * the full frontmatter (allowed-tools, model, arguments, …) and its real
   * folder for `Base directory for this skill`. Undefined when no layer has it.
   */
  async commandIn(layers: readonly SkillLayer[], name: string): Promise<CommandDefinition | undefined> {
    const resolved = await this.resolveName(layers, name)
    if (resolved === undefined) return undefined
    const { layer, folder, qualified } = resolved
    const file = path.join(folder, 'SKILL.md')
    const raw = await fs.readFile(file, 'utf8').catch(() => undefined)
    if (raw === undefined) return undefined
    if (parseSkill(raw) === undefined) throw new SkillError('invalid', `skill '${qualified}' has invalid frontmatter; fix SKILL.md before loading`)
    const dir = await fs.realpath(folder).catch(() => folder)
    const plugin = layer.plugin
    return parseCommand(qualified, raw, {
      source: layer.source,
      path: file,
      skillDir: dir,
      ...(plugin !== undefined ? { plugin } : {}),
    })
  }

  /**
   * A name → its owning layer and folder. Exact names first (first layer
   * wins); then, as Claude resolves a bare plugin skill name, a unique
   * `plugin:<name>` when no plain layer has `<name>`.
   */
  async resolveName(layers: readonly SkillLayer[], name: string): Promise<{ readonly layer: SkillLayer; readonly folder: string; readonly qualified: string } | undefined> {
    for (const layer of layers) {
      const folder = skillFolderIn(layer, name)
      if (folder === undefined) continue
      const stat = await fs.stat(path.join(folder, 'SKILL.md')).catch(() => undefined)
      if (stat !== undefined && stat.isFile()) return { layer, folder, qualified: layer.prefix !== undefined ? `${layer.prefix}:${name.slice(name.indexOf(':') + 1)}` : name }
    }
    if (!SKILL_NAME_PATTERN.test(name)) return undefined
    const found: { layer: SkillLayer; folder: string; qualified: string }[] = []
    for (const layer of layers) {
      if (layer.prefix === undefined) continue
      const qualified = `${layer.prefix}:${name}`
      const folder = skillFolderIn(layer, qualified)
      if (folder === undefined) continue
      const stat = await fs.stat(path.join(folder, 'SKILL.md')).catch(() => undefined)
      if (stat !== undefined && stat.isFile() && !found.some((item) => item.qualified === qualified)) found.push({ layer, folder, qualified })
    }
    return found.length === 1 ? found[0] : undefined
  }

  /** The first layer holding the skill, or undefined. */
  async ownerLayer(layers: readonly SkillLayer[], name: string): Promise<SkillLayer | undefined> {
    assertSkillName(name)
    for (const layer of layers) {
      const folder = skillFolderIn(layer, name)
      if (folder === undefined) continue
      const stat = await fs.stat(path.join(folder, 'SKILL.md')).catch(() => undefined)
      if (stat !== undefined && stat.isFile()) return layer
    }
    return undefined
  }

  /** The owning skill folder, as a REAL path (symlinks resolved once, here). */
  private async owningSkillDir(layers: readonly SkillLayer[], name: string): Promise<string> {
    const owner = await this.ownerLayer(layers, name)
    const folder = owner !== undefined ? skillFolderIn(owner, name) : undefined
    if (folder === undefined) throw new SkillError('not-found', `no skill '${name}'`)
    return await fs.realpath(folder)
  }

  /** Every file inside one skill's folder (recursive, `/`-separated, SKILL.md first). */
  async filesIn(layers: readonly SkillLayer[], name: string): Promise<Array<{ readonly path: string; readonly bytes: number }>> {
    const dir = await this.owningSkillDir(layers, name)
    const files: Array<{ path: string; bytes: number }> = []
    const walk = async (current: string, rel: string): Promise<void> => {
      if (files.length > 200) return
      for (const item of await fs.readdir(current, { withFileTypes: true })) {
        const childRel = rel === '' ? item.name : `${rel}/${item.name}`
        if (item.isDirectory()) await walk(path.join(current, item.name), childRel)
        else if (item.isFile()) {
          const stat = await fs.stat(path.join(current, item.name)).catch(() => undefined)
          files.push({ path: childRel, bytes: stat?.size ?? 0 })
        }
      }
    }
    await walk(dir, '')
    files.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))
    return files
  }

  /** One file's utf8 content from the skill's folder; contained and capped. */
  async readFileIn(layers: readonly SkillLayer[], name: string, rel: string): Promise<{ readonly path: string; readonly content: string; readonly bytes: number }> {
    const dir = await this.owningSkillDir(layers, name)
    if (rel === '' || rel.includes('\\') || rel.includes('\0')) throw new SkillError('invalid', 'bad file path')
    const normalized = path.posix.normalize(rel)
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
      throw new SkillError('invalid', 'file path escapes the skill folder')
    }
    const target = path.resolve(dir, normalized)
    if (!target.startsWith(dir + path.sep)) throw new SkillError('invalid', 'file path escapes the skill folder')
    // Lexical containment is not enough: a symlink inside the folder (or a
    // symlinked subfolder) can point anywhere. Re-check on the real path.
    const real = await fs.realpath(target).catch(() => undefined)
    if (real === undefined) throw new SkillError('not-found', `no file '${normalized}' in skill '${name}'`)
    if (!real.startsWith(dir + path.sep)) throw new SkillError('invalid', 'file path escapes the skill folder')
    const raw = await fs.readFile(real, 'utf8').catch(() => undefined)
    if (raw === undefined) throw new SkillError('not-found', `no file '${normalized}' in skill '${name}'`)
    if (raw.length > 512 * 1024) throw new SkillError('invalid', 'file too large to preview (over 512 KB)')
    if (raw.includes('\0')) throw new SkillError('invalid', 'binary file — preview is text-only')
    return { path: normalized, content: raw, bytes: Buffer.byteLength(raw, 'utf8') }
  }

  /**
   * Create or replace a workspace skill. Content is the raw SKILL.md;
   * validated before write, and `expectedHash` conflicts surface instead
   * of clobbering external edits.
   */
  async save(workspaceId: string, name: string, raw: string, expectedHash?: string): Promise<LoadedSkill> {
    assertWritableSkillName(name)
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

  /**
   * Remove one workspace skill folder. The name is validated first: it is
   * joined onto the workspace folder and removed recursively, so a `..` or a
   * separator smuggled through a URL decode would otherwise delete app data.
   */
  async delete(workspaceId: string, name: string): Promise<void> {
    assertSkillName(name, 'invalid')
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
    return this.listVisibleIn(workspaceId, this.defaultLayers(workspaceId))
  }

  /** Discovery rows for explicit rule-resolved layers; hidden still filters. */
  async listVisibleIn(workspaceId: string, layers: readonly SkillLayer[]): Promise<SkillEntry[]> {
    const hidden = new Set(await this.hiddenNames(workspaceId))
    const rows = await this.listIn(layers)
    return hidden.size === 0 ? rows : rows.filter((entry) => !hidden.has(entry.name))
  }

  /**
   * Hide or unhide one skill in this workspace's catalog. The name must be
   * well-formed but need not exist: pre-hiding (or keeping a tombstone for)
   * an absent skill is harmless.
   */
  async setHidden(workspaceId: string, name: string, hidden: boolean): Promise<void> {
    assertSkillName(name)
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

/** The catalog-relevant part of a parsed SKILL.md (no body). */
interface SkillHead {
  readonly title?: string
  readonly description?: string
  readonly hash: string
  readonly disableModelInvocation?: boolean
  readonly userInvocable?: boolean
  readonly argumentHint?: string
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
