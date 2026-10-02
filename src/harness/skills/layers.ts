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
      if (typeof record['path'] !== 'string' || absoluteRuleBase(record['path']) === undefined) {
        throw new SkillError('invalid', `rule '${id}' needs an absolute folder path`)
      }
      out.push({ id, kind: 'absolute', path: record['path'], enabled: record['enabled'] })
      continue
    }
    throw new SkillError('invalid', `rule '${id}' has unknown kind '${String(record['kind'])}'`)
  }
  if (workspaceRows > 1) throw new SkillError('invalid', 'at most one workspace rule')
  return out
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
      if (base !== undefined) layers.push({ base, source: 'user', ruleId: rule.id })
    }
  }
  return layers
}

/** Absolute-rule folders must never be grantable to file tools (app-data rule). */
export function protectedRootsForRules(rules: readonly SkillRule[]): string[] {
  const roots: string[] = []
  for (const rule of rules) {
    if (rule.enabled && rule.kind === 'absolute' && rule.path !== undefined) {
      const base = absoluteRuleBase(rule.path)
      if (base !== undefined) roots.push(base)
    }
  }
  return roots
}
