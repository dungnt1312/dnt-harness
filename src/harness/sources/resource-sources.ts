/**
 * Workspace resource sources: which folder layers each resource kind (skills,
 * agents, hooks, commands) may be discovered from. One sidecar per workspace,
 * `<ws>/resource-sources.json`, kept OUT of the Claude-format files those
 * resources live in. The file holds:
 *
 *   skills.rules  the ordered skill source rules (layers.ts), unchanged
 *   disabled      per kind, the fixed layers the workspace switched off
 *
 * A missing file means defaults (everything on) and imports the legacy
 * `<ws>/skills/sources.json` rule list. An unreadable file never re-enables
 * anything silently: the last valid copy keeps applying, and with none every
 * configurable source stays off until Settings rewrites the file.
 */
import { createHash } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { defaultSkillRules, validateSkillRules, validateSkillRulesForWrite, SkillError, type SkillRule } from '../skills/layers.ts'

export const RESOURCE_KINDS = ['skills', 'agents', 'hooks', 'commands'] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

/**
 * The fixed layers a workspace can switch off, per kind. Skills' folder layers
 * are the ordered rules instead, so only plugin and bundled appear here.
 */
export const SWITCHABLE_LAYERS: Readonly<Record<ResourceKind, readonly string[]>> = {
  skills: ['plugin', 'bundled'],
  agents: ['bundled', 'user', 'plugin', 'workspace', 'project'],
  hooks: ['user', 'plugin', 'workspace', 'project', 'local'],
  commands: ['bundled', 'user', 'plugin', 'workspace', 'project'],
}

export interface ResourceSources {
  readonly v: 1
  readonly skills: { readonly rules: readonly SkillRule[] }
  readonly disabled: Readonly<Record<ResourceKind, readonly string[]>>
}

export interface SourcesState {
  readonly doc: ResourceSources
  /** sha256 of the file's raw text (or of the serialized defaults while no file exists). */
  readonly hash: string
  /** Set when the file exists but cannot be used; `doc` is then the fail-closed policy. */
  readonly error?: string
}

export class ResourceSourcesError extends Error {
  constructor(readonly code: 'invalid' | 'conflict', message: string) {
    super(message)
    this.name = 'ResourceSourcesError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const emptyDisabled = (): Record<ResourceKind, string[]> => ({ skills: [], agents: [], hooks: [], commands: [] })

export function defaultResourceSources(userSkillsDir: string | undefined): ResourceSources {
  return { v: 1, skills: { rules: defaultSkillRules(userSkillsDir) }, disabled: emptyDisabled() }
}

/** Everything off: what applies when the file is unreadable and no valid copy was ever seen. */
function failClosed(userSkillsDir: string | undefined): ResourceSources {
  return {
    v: 1,
    skills: { rules: defaultSkillRules(userSkillsDir).map((rule) => ({ ...rule, enabled: false })) },
    disabled: { skills: [...SWITCHABLE_LAYERS.skills], agents: [...SWITCHABLE_LAYERS.agents], hooks: [...SWITCHABLE_LAYERS.hooks], commands: [...SWITCHABLE_LAYERS.commands] },
  }
}

function serialize(doc: ResourceSources): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

function disabledFrom(raw: unknown, strict: boolean): Record<ResourceKind, string[]> {
  const out = emptyDisabled()
  if (raw === undefined) return out
  if (!isRecord(raw)) throw new ResourceSourcesError('invalid', "'disabled' must be an object keyed by resource kind")
  for (const kind of RESOURCE_KINDS) {
    const value = raw[kind]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new ResourceSourcesError('invalid', `disabled.${kind} must be a list of layer names`)
    }
    for (const layer of value as string[]) {
      if (!SWITCHABLE_LAYERS[kind].includes(layer)) {
        // A stored file may name a layer a newer build added; only writes refuse it.
        if (strict) throw new ResourceSourcesError('invalid', `'${layer}' is not a switchable ${kind} layer`)
        continue
      }
      if (!out[kind].includes(layer)) out[kind].push(layer)
    }
  }
  return out
}

/** Parse a stored file; throws on a malformed or unsupported document. */
function parseStored(raw: string): ResourceSources {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ResourceSourcesError('invalid', `invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(parsed) || parsed['v'] !== 1) throw new ResourceSourcesError('invalid', 'unsupported resource-sources version')
  const skills = parsed['skills']
  try {
    return { v: 1, skills: { rules: validateSkillRules({ rules: isRecord(skills) ? skills['rules'] : undefined }) }, disabled: disabledFrom(parsed['disabled'], false) }
  } catch (error) {
    if (error instanceof SkillError) throw new ResourceSourcesError('invalid', error.message)
    throw error
  }
}

/** Validate an incoming document (PUT body): strict about layers, rules and the too-broad policy. */
export function validateSourcesInput(raw: unknown): ResourceSources {
  if (!isRecord(raw)) throw new ResourceSourcesError('invalid', "body needs a 'doc' object")
  const skills = raw['skills']
  try {
    return {
      v: 1,
      skills: { rules: validateSkillRulesForWrite({ rules: isRecord(skills) ? skills['rules'] : undefined }) },
      disabled: disabledFrom(raw['disabled'], true),
    }
  } catch (error) {
    if (error instanceof SkillError) throw new ResourceSourcesError('invalid', error.message)
    throw error
  }
}

export class ResourceSourcesStore {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly lastGood = new Map<string, ResourceSources>()
  private readonly revisions = new Map<string, number>()

  constructor(private readonly home: string, private readonly userSkillsDir?: string) {}

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId)
  }

  file(workspaceId: string): string {
    return path.join(this.dir(workspaceId), 'resource-sources.json')
  }

  /** Bumps on every successful write; folded into per-conversation catalog snapshots. */
  revision(workspaceId: string): number {
    return this.revisions.get(workspaceId) ?? 0
  }

  /**
   * Reads are synchronous on purpose: the hook policy is read on the prompt
   * admission path, before the turn's first step, and an async read there
   * adds event-loop turns before the turn admits its input. That window is
   * where a Stop can land first and cancel the turn before admission; the
   * input then simply stays queued (nothing is lost), but it is an avoidable
   * delay on every prompt. The file is a few hundred bytes, read fresh each
   * call (a manual edit applies at once). Writes stay async and locked.
   *
   * History: `server-g1 > input accepted during cancellation` used to depend
   * on admission winning that race (it failed 8/8 with an async read here).
   * It now waits for `input/settled` explicitly, so it no longer constrains
   * this choice.
   */
  async read(workspaceId: string): Promise<SourcesState> {
    let raw: string
    try {
      raw = readFileSync(this.file(workspaceId), 'utf8')
    } catch {
      return this.fromLegacy(workspaceId)
    }
    try {
      const doc = parseStored(raw)
      this.lastGood.set(workspaceId, doc)
      return { doc, hash: sha256(raw) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { doc: this.lastGood.get(workspaceId) ?? failClosed(this.userSkillsDir), hash: sha256(raw), error: `resource-sources.json is unusable (${message})` }
    }
  }

  /** The legacy `<ws>/skills/sources.json` rule list, else defaults; never an error. */
  private fromLegacy(workspaceId: string): SourcesState {
    let rules: readonly SkillRule[]
    try {
      rules = validateSkillRules(JSON.parse(readFileSync(path.join(this.dir(workspaceId), 'skills', 'sources.json'), 'utf8')) as unknown)
    } catch {
      rules = defaultSkillRules(this.userSkillsDir)
    }
    const doc: ResourceSources = { v: 1, skills: { rules }, disabled: emptyDisabled() }
    return { doc, hash: sha256(serialize(doc)) }
  }

  /** The layers switched off for one kind. Never throws. */
  async disabled(workspaceId: string, kind: ResourceKind): Promise<ReadonlySet<string>> {
    return new Set((await this.read(workspaceId)).doc.disabled[kind])
  }

  /** Replace the whole document. `expectedHash` (the hash the editor loaded) rejects a stale write. */
  async write(workspaceId: string, doc: ResourceSources, expectedHash?: string): Promise<SourcesState> {
    return this.locked(workspaceId, async () => {
      if (expectedHash !== undefined && (await this.read(workspaceId)).hash !== expectedHash) {
        throw new ResourceSourcesError('conflict', 'the sources changed on the server since you opened them')
      }
      return this.commit(workspaceId, doc)
    })
  }

  /** Read-modify-write under the workspace lock; refuses to build on an unusable file. */
  async update(workspaceId: string, mutate: (doc: ResourceSources) => ResourceSources): Promise<SourcesState> {
    return this.locked(workspaceId, async () => {
      const current = await this.read(workspaceId)
      if (current.error !== undefined) throw new ResourceSourcesError('invalid', `${current.error}; repair it in Settings → Sources`)
      return this.commit(workspaceId, mutate(current.doc))
    })
  }

  private async commit(workspaceId: string, doc: ResourceSources): Promise<SourcesState> {
    const raw = serialize(doc)
    await fs.mkdir(this.dir(workspaceId), { recursive: true })
    await replaceFileAtomic(this.file(workspaceId), raw)
    this.lastGood.set(workspaceId, doc)
    this.revisions.set(workspaceId, this.revision(workspaceId) + 1)
    return { doc, hash: sha256(raw) }
  }

  private locked<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(workspaceId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(workspaceId, tail)
    return previous.then(() => operation().finally(() => {
      release()
      if (this.tails.get(workspaceId) === tail) this.tails.delete(workspaceId)
    }))
  }
}

// ── What Settings shows: each switchable layer and where it reads from ────────

export interface SourceLayerInfo {
  readonly id: string
  readonly label: string
  /** The folder or file read, or a template for per-project layers. */
  readonly path: string
  /** False when this host has no such layer (e.g. no `~/.claude` configured). */
  readonly available: boolean
}

export interface SourceHostPaths {
  readonly workspaceDir: string
  readonly userClaudeDir?: string
  readonly bundledSkillsDir?: string
  readonly bundledCommandsDir?: string
}

export function describeSourceLayers(host: SourceHostPaths): Record<ResourceKind, readonly SourceLayerInfo[]> {
  const user = (sub: string): { path: string; available: boolean } =>
    host.userClaudeDir !== undefined ? { path: path.join(host.userClaudeDir, sub), available: true } : { path: `~/.claude/${sub}`, available: false }
  const plugin = (what: string): SourceLayerInfo => ({ id: 'plugin', label: 'Plugins', path: `Enabled plugins' ${what}`, available: true })
  return {
    skills: [
      plugin('skills'),
      { id: 'bundled', label: 'Bundled', path: host.bundledSkillsDir ?? 'Shipped with the app', available: host.bundledSkillsDir !== undefined },
    ],
    agents: [
      { id: 'bundled', label: 'Bundled', path: 'Built-in roles: explorer, worker, reviewer, verifier', available: true },
      { id: 'user', label: 'User', ...user('agents') },
      plugin('agents'),
      { id: 'workspace', label: 'Workspace', path: path.join(host.workspaceDir, 'agents'), available: true },
      { id: 'project', label: 'Project', path: '<project>/.claude/agents', available: true },
    ],
    hooks: [
      { id: 'user', label: 'User', ...user('settings.json') },
      plugin('hooks'),
      { id: 'workspace', label: 'Workspace', path: path.join(host.workspaceDir, 'settings.json'), available: true },
      { id: 'project', label: 'Project', path: '<project>/.claude/settings.json', available: true },
      { id: 'local', label: 'Project local', path: '<project>/.claude/settings.local.json', available: true },
    ],
    commands: [
      { id: 'bundled', label: 'Bundled', path: host.bundledCommandsDir ?? 'Shipped with the app', available: host.bundledCommandsDir !== undefined },
      { id: 'user', label: 'User', ...user('commands') },
      plugin('commands'),
      { id: 'workspace', label: 'Workspace', path: path.join(host.workspaceDir, 'commands'), available: true },
      { id: 'project', label: 'Project', path: '<project>/.claude/commands (and ancestors)', available: true },
    ],
  }
}
