/**
 * Skill source rules: which folders the catalog scans, in precedence order.
 * Pure model + validation + resolution — no fs here; SkillsService owns reads.
 * `SkillError`/`SkillSource` live here too so the resolver can throw without a
 * service import cycle; service.ts re-exports both for API compatibility.
 */
import { homedir } from 'node:os'
import path from 'node:path'

export type SkillSource = 'project' | 'workspace' | 'user' | 'bundled'

export class SkillError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'SkillError'
  }
}

/** One configurable skill source folder; list order is precedence order. */
export interface SkillRule {
  readonly id: string
  readonly kind: 'project' | 'workspace' | 'absolute'
  /** project: relative subfolder; absolute: absolute path (`~` expands). Absent on workspace rows. */
  readonly path?: string
  readonly enabled: boolean
}

/** One resolved scan root handed to SkillsService. */
export interface SkillLayer {
  readonly base: string
  readonly source: SkillSource
  /** The rule a project/user layer resolved from; absent on the workspace layer. */
  readonly ruleId?: string
}

export const MAX_SKILL_RULES = 20
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A skill's lookup name: its kebab-case folder name inside a layer. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Throw unless `name` is a well-formed skill name. Every service entry point
 * that joins a name onto a layer folder calls this first: a name is a single
 * path segment, never `..`, a separator, or anything a URL decode smuggled in.
 */
export function assertSkillName(name: string, code: 'not-found' | 'invalid' = 'not-found'): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError(code, code === 'invalid' ? `skill name '${name}' must be kebab-case` : `no skill '${name}'`)
  }
}

/**
 * Names a NEW workspace skill may not take: `/api/workspaces/:id/skills/sources`
 * is the source-rules route, so a skill called `sources` could never be read
 * or saved over HTTP. Reads stay permissive (a user-layer folder with this
 * name still loads through the Skill tool); only creation refuses it.
 */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(['sources'])

/** {@link assertSkillName} for writes: well-formed AND not reserved. */
export function assertWritableSkillName(name: string): void {
  assertSkillName(name, 'invalid')
  if (RESERVED_SKILL_NAMES.has(name)) {
    throw new SkillError('invalid', `skill name '${name}' is reserved; choose another name`)
  }
}

/** Default volume casing of the host OS (APFS/NTFS defaults fold case). */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

/**
 * Absolute rule folders that are too broad to be a skill layer: a volume root,
 * the home directory, or any ancestor of it. Such a folder would also become a
 * grant-protected root and refuse every folder grant on the host.
 */
export function absoluteRuleTooBroad(base: string, home: string = homedir(), caseInsensitive: boolean = CASE_INSENSITIVE_FS): boolean {
  // macOS and Windows default to case-insensitive volumes: `/users` IS
  // `/Users` there, so the ancestor check must not be fooled by casing.
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value)
  const resolved = fold(path.resolve(base))
  if (path.parse(resolved).root === resolved) return true
  const relHome = path.relative(resolved, fold(path.resolve(home)))
  return relHome === '' || (!relHome.startsWith('..') && !path.isAbsolute(relHome))
}

/** Defaults for a missing/corrupt sources.json: .claude, .agents, workspace, user. */
export function defaultSkillRules(userSkillsDir: string | undefined): SkillRule[] {
  return [
    { id: 'project-claude', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'project-agents', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'workspace', kind: 'workspace', enabled: true },
    ...(userSkillsDir !== undefined ? [{ id: 'user', kind: 'absolute', path: userSkillsDir, enabled: true } satisfies SkillRule] : []),
  ]
}

/**
 * Resolve a project rule's relative path against the project folder. Undefined
 * unless the result lands strictly INSIDE the project: no absolute, drive, UNC,
 * or `..` escape, and not the project root itself.
 */
export function projectRuleBase(projectPath: string, rel: string): string | undefined {
  if (rel === '' || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) return undefined
  const root = path.resolve(projectPath)
  const resolved = path.resolve(root, rel)
  const inner = root.endsWith(path.sep) ? root : root + path.sep
  if (resolved === root || !resolved.startsWith(inner)) return undefined
  return resolved
}

/** `~`, `~/x`, `~\x` expand against the OS home; everything else must already be absolute. */
export function absoluteRuleBase(raw: string): string | undefined {
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith(`~${path.sep}`)
    ? path.join(homedir(), raw === '~' ? '' : raw.slice(2))
    : raw
  return path.isAbsolute(expanded) ? path.normalize(expanded) : undefined
}

/** Validate an untyped rules payload; the workspace row's path is forced off. */
export function validateSkillRules(raw: unknown): SkillRule[] {
  const rules = raw !== null && typeof raw === 'object' ? (raw as { rules?: unknown }).rules : undefined
  if (!Array.isArray(rules)) throw new SkillError('invalid', "body needs a 'rules' array")
  if (rules.length > MAX_SKILL_RULES) throw new SkillError('invalid', `at most ${MAX_SKILL_RULES} rules`)
  const seen = new Set<string>()
  let workspaceRows = 0
  const out: SkillRule[] = []
  for (const row of rules) {
    if (row === null || typeof row !== 'object') throw new SkillError('invalid', 'each rule must be an object')
    const record = row as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || seen.has(id)) {
      throw new SkillError('invalid', `rule id '${String(id)}' must be unique kebab-case`)
    }
    seen.add(id)
    if (record['enabled'] !== true && record['enabled'] !== false) throw new SkillError('invalid', `rule '${id}' needs a boolean 'enabled'`)
    if (record['kind'] === 'workspace') {
      workspaceRows += 1
      out.push({ id, kind: 'workspace', enabled: record['enabled'] })
      continue
    }
    if (record['kind'] === 'project') {
      if (typeof record['path'] !== 'string' || projectRuleBase('/anchor', record['path']) === undefined) {
        throw new SkillError('invalid', `rule '${id}' needs a relative folder path without '..'`)
      }
      out.push({ id, kind: 'project', path: record['path'], enabled: record['enabled'] })
      continue
    }
    if (record['kind'] === 'absolute') {
      const base = typeof record['path'] === 'string' ? absoluteRuleBase(record['path']) : undefined
      if (base === undefined) {
        throw new SkillError('invalid', `rule '${id}' needs an absolute folder path`)
      }
      out.push({ id, kind: 'absolute', path: record['path'] as string, enabled: record['enabled'] })
      continue
    }
    throw new SkillError('invalid', `rule '${id}' has unknown kind '${String(record['kind'])}'`)
  }
  if (workspaceRows > 1) throw new SkillError('invalid', 'at most one workspace rule')
  return out
}

/**
 * Write-time policy on top of {@link validateSkillRules}: refuse NEW
 * too-broad absolute folders. Kept out of the shape validation on purpose —
 * `sources()` re-validates the stored file on every read, and a stored list
 * that predates this policy must keep its customizations (resolution and
 * grant protection skip the broad rule instead of the whole list resetting).
 */
export function validateSkillRulesForWrite(raw: unknown): SkillRule[] {
  const rules = validateSkillRules(raw)
  for (const rule of rules) {
    // Only ENABLED broad rules are refused: the UI re-sends the whole list on
    // every change, so a stored broad rule must stay disable-able/removable.
    if (rule.kind !== 'absolute' || rule.path === undefined || !rule.enabled) continue
    const base = absoluteRuleBase(rule.path)
    if (base !== undefined && absoluteRuleTooBroad(base)) {
      throw new SkillError('invalid', `rule '${rule.id}' is too broad: a drive root or the home folder (or above it) cannot be a skill folder`)
    }
  }
  return rules
}

/** Enabled rules → ordered scan roots; unresolvable rules skip silently. */
export function resolveSkillLayers(
  rules: readonly SkillRule[],
  ctx: { readonly workspaceDir: string; readonly projectPath?: string },
): SkillLayer[] {
  const layers: SkillLayer[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.kind === 'workspace') {
      layers.push({ base: path.resolve(ctx.workspaceDir), source: 'workspace' })
    } else if (rule.kind === 'project') {
      if (ctx.projectPath === undefined || rule.path === undefined) continue
      const base = projectRuleBase(ctx.projectPath, rule.path)
      if (base !== undefined) layers.push({ base, source: 'project', ruleId: rule.id })
    } else if (rule.path !== undefined) {
      const base = absoluteRuleBase(rule.path)
      // A stored too-broad rule (written before the write-time refusal) is
      // skipped here rather than scanning `/` or the home folder.
      if (base !== undefined && !absoluteRuleTooBroad(base)) layers.push({ base, source: 'user', ruleId: rule.id })
    }
  }
  return layers
}

/**
 * Absolute-rule folders must never be grantable to file tools (app-data rule).
 * Too-broad folders are skipped defensively (validation already refuses them):
 * protecting `/` or the home folder would refuse every grant on the host.
 */
export function protectedRootsForRules(rules: readonly SkillRule[]): string[] {
  const roots: string[] = []
  for (const rule of rules) {
    if (rule.enabled && rule.kind === 'absolute' && rule.path !== undefined) {
      const base = absoluteRuleBase(rule.path)
      if (base !== undefined && !absoluteRuleTooBroad(base) && !roots.includes(base)) roots.push(base)
    }
  }
  return roots
}
