# Project Skill Layers + SkillsPanel Two-Tab UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skills load from the bound project's folder (`.claude/skills`, `.agents/skills`) via a per-workspace ordered rule list editable in Settings, with the SkillsPanel rebuilt as a dntspace-style two-tab/two-pane UI.

**Architecture:** Rules are data in `workspaces/<ws>/skills/sources.json`; a pure resolver (`resolveSkillLayers`) turns rules + the bound project's path into an ordered layer list that a layer-aware `SkillsService` scans (first-hit-wins). The server resolves layers at the catalog injection, the Skill tool, and panel routes; `PUT skills/sources` refreshes the folder-grants protected roots. Spec: `docs/superpowers/specs/2026-10-02-project-skill-layers-design.md`.

**Tech Stack:** TypeScript ESM (Node), Vitest, React + Tailwind (settings-kit primitives).

## Global Constraints

- `SkillSource` becomes `'project' | 'workspace' | 'user' | 'bundled'`; `bundled` stays implicit last and is never a rule.
- Precedence = rule list order, first hit wins (shadowing); disabled/missing rules skip; a corrupt `sources.json` degrades to defaults.
- Project rule paths: relative only — no absolute, drive (`C:`), UNC (`\\`), or `..` escape; containment re-checked at read time.
- Only the workspace layer is writable (`save`/`delete` unchanged); active skills stay hash-pinned per turn (no hot reload).
- Workspace rule: exactly 0–1 per list, kind/path forced server-side, toggle/position only.
- ≤ 20 rules; ids unique kebab-case `[a-z0-9][a-z0-9-]{0,63}`.
- Web optional JSX props use conditional spread (`exactOptionalPropertyTypes`); never spread `DOMRect`.
- Test commands run from repo root: `npx vitest run <file>`; typecheck: `npm run typecheck`.
- Do not touch files outside this plan's list (concurrent sessions have WIP in the tree); stage only files this plan created/modified.

---

### Task 1: Rule model, validation, resolver (`layers.ts`)

**Files:**
- Create: `src/harness/skills/layers.ts`
- Create: `tests/harness/skill-layers.spec.ts`
- Modify: `src/index.ts` (export the new module, one line, after the existing skills export)

**Interfaces:**
- Consumes: nothing (new pure module).
- Produces: `SkillSource`, `SkillError` (moved here, re-exported by service), `SkillRule`, `SkillLayer`, `MAX_SKILL_RULES = 20`, `defaultSkillRules(userSkillsDir?)`, `validateSkillRules(raw)`, `resolveSkillLayers(rules, ctx)`, `projectRuleBase(projectPath, rel)`, `absoluteRuleBase(raw)`, `protectedRootsForRules(rules)`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/harness/skill-layers.spec.ts`:

```ts
/** Pure unit coverage for the skill rule model: validation, resolution, protection. */
import { describe, expect, it } from 'vitest'
import {
  MAX_SKILL_RULES,
  absoluteRuleBase,
  defaultSkillRules,
  projectRuleBase,
  protectedRootsForRules,
  resolveSkillLayers,
  validateSkillRules,
  SkillError,
} from 'dnt-harness'

describe('defaultSkillRules', () => {
  it('orders .claude, .agents, workspace, user and omits the user row without a dir', () => {
    const rules = defaultSkillRules('C:/Users/x/.claude/skills')
    expect(rules.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])
    expect(rules[3]).toMatchObject({ kind: 'absolute', path: 'C:/Users/x/.claude/skills', enabled: true })
    expect(defaultSkillRules(undefined).map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace'])
  })
})

describe('validateSkillRules', () => {
  it('accepts a well-formed list and drops a workspace row path', () => {
    const rules = validateSkillRules({ rules: [
      { id: 'a', kind: 'project', path: '.claude/skills', enabled: true },
      { id: 'ws', kind: 'workspace', path: 'C:/ignored', enabled: false },
      { id: 'b', kind: 'absolute', path: '~/shared-skills', enabled: true },
    ] })
    expect(rules).toHaveLength(3)
    expect(rules[1]).toEqual({ id: 'ws', kind: 'workspace', enabled: false })
  })

  it('rejects malformed payloads with SkillError invalid', () => {
    const bad: unknown[] = [
      null,
      {},
      { rules: 'no' },
      { rules: [{ id: 'a', kind: 'project', path: '../escape', enabled: true }] },
      { rules: [{ id: 'a', kind: 'project', path: 'C:/abs', enabled: true }] },
      { rules: [{ id: 'a', kind: 'absolute', path: 'relative/path', enabled: true }] },
      { rules: [{ id: 'a', kind: 'galactic', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'b', kind: 'workspace', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'a', kind: 'project', path: 'x', enabled: true }] },
      { rules: [{ id: 'A', kind: 'workspace', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace' }] },
      { rules: Array.from({ length: MAX_SKILL_RULES + 1 }, (_, i) => ({ id: `r${i}`, kind: 'project', path: '.x', enabled: true })) },
    ]
    for (const payload of bad) expect(() => validateSkillRules(payload)).toThrow(SkillError)
  })
})

describe('projectRuleBase / absoluteRuleBase', () => {
  it('resolves a relative rule inside the project and refuses escapes', () => {
    expect(projectRuleBase('C:/proj', '.claude/skills')).toBe('C:/proj/.claude/skills')
    expect(projectRuleBase('C:/proj', 'sub/../.agents/skills')).toBe('C:/proj/.agents/skills')
    expect(projectRuleBase('C:/proj', '../outside')).toBeUndefined()
    expect(projectRuleBase('C:/proj', 'C:/abs')).toBeUndefined()
    expect(projectRuleBase('C:/proj', '')).toBeUndefined()
    expect(projectRuleBase('C:/proj', '.')).toBeUndefined()
  })

  it('expands ~ against the home dir and refuses relative absolute rules', () => {
    expect(absoluteRuleBase('D:/shared')).toBe('D:/shared')
    expect(absoluteRuleBase('~')).toBeAbsolutePath()
    expect(absoluteRuleBase('relative')).toBeUndefined()
  })
})

describe('resolveSkillLayers', () => {
  const rules = [
    { id: 'p1', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'p2', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'off', kind: 'project', path: '.hidden/skills', enabled: false },
    { id: 'ws', kind: 'workspace', enabled: true },
    { id: 'u', kind: 'absolute', path: '~/skills-u', enabled: true },
  ] as const

  it('emits enabled rules in order with sources and rule ids', () => {
    const layers = resolveSkillLayers(rules, { workspaceDir: 'C:/home/workspaces/ws/skills', projectPath: 'C:/proj' })
    expect(layers.map((layer) => layer.source)).toEqual(['project', 'project', 'workspace', 'user'])
    expect(layers[0]).toMatchObject({ base: 'C:/proj/.claude/skills', ruleId: 'p1' })
    expect(layers[2]).toMatchObject({ base: 'C:/home/workspaces/ws/skills' })
    expect(layers[2]?.ruleId).toBeUndefined()
  })

  it('skips project rules without a bound project and escaping rules', () => {
    const layers = resolveSkillLayers(rules, { workspaceDir: 'C:/ws-skills' })
    expect(layers.map((layer) => layer.source)).toEqual(['workspace', 'user'])
    const escape = resolveSkillLayers(
      [{ id: 'x', kind: 'project', path: '../..', enabled: true }],
      { workspaceDir: 'C:/ws', projectPath: 'C:/proj' },
    )
    expect(escape).toEqual([])
  })
})

describe('protectedRootsForRules', () => {
  it('collects enabled absolute rule folders only', () => {
    expect(protectedRootsForRules([
      { id: 'u', kind: 'absolute', path: 'D:/skills', enabled: true },
      { id: 'off', kind: 'absolute', path: 'E:/off', enabled: false },
      { id: 'p', kind: 'project', path: '.claude/skills', enabled: true },
    ])).toEqual(['D:/skills'])
  })
})
```

Note: `.toBeAbsolutePath()` is not a vitest matcher — write that one assertion as
`expect(absoluteRuleBase('~')?.startsWith(process.env.USERPROFILE ?? process.env.HOME ?? homedirFromOs())).toBe(true)`;
simplest: `import { homedir } from 'node:os'` and
`expect(absoluteRuleBase('~')).toBe(path.join(homedir(), ''))` is wrong for `~` alone —
assert `absoluteRuleBase('~') === homedir()` (the implementation returns `homedir()` for bare `~`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/harness/skill-layers.spec.ts`
Expected: FAIL — cannot import from `dnt-harness` (module missing).

- [ ] **Step 3: Implement `src/harness/skills/layers.ts`**

```ts
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
    ...(userSkillsDir !== undefined ? [{ id: 'user', kind: 'absolute', path: userSkillsDir, enabled: true }] : []),
  ]
}

/**
 * Resolve a project rule's relative path against the project folder. Undefined
 * unless the result lands strictly INSIDE the project: no absolute, drive, UNC,
 or `..` escape, and not the project root itself.
 */
export function projectRuleBase(projectPath: string, rel: string): string | undefined {
  if (rel === '' || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) return undefined
  const resolved = path.resolve(projectPath, rel)
  const inner = projectPath.endsWith(path.sep) ? projectPath : projectPath + path.sep
  if (resolved === projectPath || !resolved.startsWith(inner)) return undefined
  return resolved
}

/** `~`/`~/x` expand against the OS home; everything else must already be absolute. */
export function absoluteRuleBase(raw: string): string | undefined {
  const expanded = raw === '~' || raw.startsWith(`~${path.sep}`) || raw.startsWith('~\\')
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
    if (record['kind'] === 'workspace') {
      if (record['enabled'] !== true && record['enabled'] !== false) throw new SkillError('invalid', `rule '${id}' needs a boolean 'enabled'`)
      workspaceRows += 1
      out.push({ id, kind: 'workspace', enabled: record['enabled'] })
      continue
    }
    if (record['enabled'] !== true && record['enabled'] !== false) throw new SkillError('invalid', `rule '${id}' needs a boolean 'enabled'`)
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
      layers.push({ base: ctx.workspaceDir, source: 'workspace' })
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
```

- [ ] **Step 4: Export from the package root**

In `src/index.ts`, directly after the existing skills service export (line ~174), add:

```ts
export { SkillError, defaultSkillRules, projectRuleBase, absoluteRuleBase, validateSkillRules, resolveSkillLayers, protectedRootsForRules, MAX_SKILL_RULES, type SkillRule, type SkillLayer, type SkillSource } from './harness/skills/layers.ts'
```

Then REMOVE `SkillError` and the `SkillSource` type from the service.ts export line in
`src/index.ts` (they now flow through the re-export in service.ts — see Task 2 step 3;
until Task 2 lands keep both lines and expect the duplicate-export error, resolved next task).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/harness/skill-layers.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add src/harness/skills/layers.ts tests/harness/skill-layers.spec.ts src/index.ts
git commit -m "feat(skills): rule model, validation, and layer resolver"
```

---

### Task 2: SkillsService — layer-aware reads + sources store

**Files:**
- Modify: `src/harness/skills/service.ts`
- Modify: `tests/harness/g3-context.spec.ts` (the `skills + memory units` block gains assertions)

**Interfaces:**
- Consumes: from Task 1 — `SkillRule`, `SkillLayer`, `SkillSource`, `SkillError`, `defaultSkillRules`, `validateSkillRules`.
- Produces: `SkillsService.workspaceSkillsDir(wsId)`, `SkillsService.sources(wsId): Promise<SkillRule[]>`, `SkillsService.setSources(wsId, raw): Promise<SkillRule[]>`, `SkillsService.listIn(layers)`, `SkillsService.loadIn(layers, name)`, `SkillsService.listVisibleIn(wsId, layers)`; `SkillEntry.ruleId?: string`; existing `list/load/listVisible` keep signatures.

- [ ] **Step 1: Write the failing tests**

In `tests/harness/g3-context.spec.ts`, inside the existing `describe('skills + memory units')` block, after the external-edit test, add:

```ts
it('sources round-trip, fall back to defaults, and drive layer-aware scans', async () => {
  const { SkillsService } = await import('dnt-harness')
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g3-skill-rules-'))
  const skills = new SkillsService(home, undefined, 'C:/Users/x/.claude/skills')
  const ws = 'wsrules' as ProjectId
  const defaults = await skills.sources(ws)
  expect(defaults.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])

  const proj = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g3-skill-proj-'))
  await fs.mkdir(path.join(proj, '.claude', 'skills', 'dup'), { recursive: true })
  await fs.writeFile(path.join(proj, '.claude', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: claude wins\n---\n\nCLAUDE', 'utf8')
  await fs.mkdir(path.join(proj, '.agents', 'skills', 'dup'), { recursive: true })
  await fs.writeFile(path.join(proj, '.agents', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: agents\n---\n\nAGENTS', 'utf8')
  await fs.mkdir(path.join(proj, '.agents', 'skills', 'only-agents'), { recursive: true })
  await fs.writeFile(path.join(proj, '.agents', 'skills', 'only-agents', 'SKILL.md'), '---\nname: only-agents\ndescription: x\n---\n\nA', 'utf8')

  const layers = resolveSkillLayers(defaults, { workspaceDir: skills.workspaceSkillsDir(ws), projectPath: proj })
  const rows = await skills.listIn(layers)
  expect(rows.find((row) => row.name === 'dup')).toMatchObject({ source: 'project', ruleId: 'project-claude' })
  expect(rows.find((row) => row.name === 'only-agents')).toMatchObject({ source: 'project', ruleId: 'project-agents' })
  const loaded = await skills.loadIn(layers, 'dup')
  expect(loaded.instructions).toContain('CLAUDE')

  // Hidden still applies per workspace regardless of layers.
  await skills.setHidden(ws, 'dup', true)
  expect((await skills.listVisibleIn(ws, layers)).some((row) => row.name === 'dup')).toBe(false)

  // Round-trip persists; a corrupt file falls back to defaults.
  const saved = await skills.setSources(ws, { rules: [{ id: 'claude', kind: 'project', path: '.claude/skills', enabled: true }] })
  expect(saved).toHaveLength(1)
  expect((await skills.sources(ws)).map((rule) => rule.id)).toEqual(['claude'])
  await fs.writeFile(path.join(home, 'workspaces', ws as string, 'skills', 'sources.json'), '{broken', 'utf8')
  expect((await skills.sources(ws)).map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])

  // The legacy workspace-only signatures still work (default layers).
  expect(await skills.list(ws)).toEqual([])
})
```

Add `resolveSkillLayers` to the existing `dnt-harness` import at the top of the block
(the file already imports `SkillsService` dynamically; import the resolver the same way
or add a top-level static import — match the file's existing import style).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/harness/g3-context.spec.ts`
Expected: FAIL — `skills.sources`/`listIn`/`workspaceSkillsDir` do not exist.

- [ ] **Step 3: Implement in `src/harness/skills/service.ts`**

Replace the header types (the local `SkillSource`/`SkillError` definitions) with re-exports
from layers, and rewrite the scan methods. The full set of changes:

```ts
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { defaultSkillRules, validateSkillRules, type SkillError, type SkillLayer, type SkillRule, type SkillSource } from './layers.ts'

export { SkillError } from './layers.ts'
export type { SkillSource } from './layers.ts'
```

Delete the local `export type SkillSource = ...` and the local `SkillError` class
(keep `SkillEntry`/`LoadedSkill` but add `ruleId`):

```ts
export interface SkillEntry {
  /** Directory/lookup name (kebab-case). */
  readonly name: string
  readonly title: string
  readonly description: string
  readonly source: SkillSource
  /** The source rule a project/user layer resolved from; absent otherwise. */
  readonly ruleId?: string
  /** sha256 of the raw SKILL.md. */
  readonly hash: string
}
```

Change the private layers helper and add the sources store + layer-aware methods
(`dir`, `hiddenPath`, `hiddenNames`, `setHidden`, `save`, `delete`, `parseSkill`, `sha256`
stay as-is; `load` and `list`/`listVisible` bodies move into the `In` variants):

```ts
  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'skills')
  }

  /** The workspace layer's folder, for callers that resolve rule layers. */
  workspaceSkillsDir(workspaceId: string): string {
    return this.dir(workspaceId)
  }

  /** Default layers when no rules apply: workspace > user > bundled. */
  private defaultLayers(workspaceId: string): SkillLayer[] {
    const layers: SkillLayer[] = [{ base: this.dir(workspaceId), source: 'workspace' }]
    if (this.userDir !== undefined) layers.push({ base: this.userDir, source: 'user' })
    if (this.bundledDir !== undefined) layers.push({ base: this.bundledDir, source: 'bundled' })
    return layers
  }

  // ── Source rules (sources.json beside .hidden.json) ───────────────────────

  private sourcesPath(workspaceId: string): string {
    return path.join(this.dir(workspaceId), 'sources.json')
  }

  /** The effective rule list; a missing or corrupt file degrades to the defaults. */
  async sources(workspaceId: string): Promise<SkillRule[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.sourcesPath(workspaceId), 'utf8')
    } catch {
      return defaultSkillRules(this.userDir)
    }
    try {
      const rules = validateSkillRules(JSON.parse(raw) as unknown)
      return rules.some((rule) => rule.kind === 'workspace') ? rules : [...rules, ...defaultSkillRules(this.userDir).filter((rule) => rule.kind === 'workspace')]
    } catch {
      return defaultSkillRules(this.userDir)
    }
  }

  /** Replace the rule list; validated, atomic, returns what was stored. */
  async setSources(workspaceId: string, raw: unknown): Promise<SkillRule[]> {
    const rules = validateSkillRules(raw)
    await this.withMutationLock(workspaceId, 'sources', async () => {
      const file = this.sourcesPath(workspaceId)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify({ rules }, null, 2)}\n`)
    })
    return rules
  }

  /** Catalog: one row per name, the highest-precedence layer wins. */
  async list(workspaceId: string): Promise<SkillEntry[]> {
    return this.listIn(this.defaultLayers(workspaceId))
  }

  /** Layer-aware catalog scan; first layer carrying a name wins. */
  async listIn(layers: readonly SkillLayer[]): Promise<SkillEntry[]> {
    const rows = new Map<string, SkillEntry>()
    for (const layer of layers) {
      let entries
      try {
        entries = await fs.readdir(layer.base, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const raw = await fs.readFile(path.join(layer.base, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
        if (raw === undefined) continue
        const parsed = parseSkill(raw)
        if (parsed === undefined) continue // invalid skills are surfaced on load, not served
        if (!rows.has(entry.name)) {
          rows.set(entry.name, {
            name: entry.name,
            title: parsed.title ?? entry.name,
            description: parsed.description ?? '',
            source: layer.source,
            ...(layer.ruleId !== undefined ? { ruleId: layer.ruleId } : {}),
            hash: sha256(raw),
          })
        }
      }
    }
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Load one skill's instructions; validates the file before returning. */
  async load(workspaceId: string, name: string): Promise<LoadedSkill> {
    return this.loadIn(this.defaultLayers(workspaceId), name)
  }

  /** Layer-aware load; the first layer holding the name wins. */
  async loadIn(layers: readonly SkillLayer[], name: string): Promise<LoadedSkill> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      throw new SkillError('not-found', `no skill '${name}'`)
    }
    for (const layer of layers) {
      const raw = await fs.readFile(path.join(layer.base, name, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      const parsed = parseSkill(raw)
      if (parsed === undefined) {
        throw new SkillError('invalid', `skill '${name}' has invalid frontmatter; fix SKILL.md before loading`)
      }
      return {
        name,
        title: parsed.title ?? name,
        description: parsed.description ?? '',
        source: layer.source,
        ...(layer.ruleId !== undefined ? { ruleId: layer.ruleId } : {}),
        hash: sha256(raw),
        instructions: parsed.body,
      }
    }
    throw new SkillError('not-found', `no skill '${name}'`)
  }

  /** The catalog rows a request may DISCOVER (hidden filtered), for explicit layers. */
  async listVisibleIn(workspaceId: string, layers: readonly SkillLayer[]): Promise<SkillEntry[]> {
    const hidden = new Set(await this.hiddenNames(workspaceId))
    const rows = await this.listIn(layers)
    return hidden.size === 0 ? rows : rows.filter((entry) => !hidden.has(entry.name))
  }

  async listVisible(workspaceId: string): Promise<SkillEntry[]> {
    return this.listVisibleIn(workspaceId, this.defaultLayers(workspaceId))
  }
```

Also update `LoadedSkill` to include the optional `ruleId` field the same way, and the
`save()` return object stays `source: 'workspace'` (no ruleId).

`LoadedSkill`:

```ts
export interface LoadedSkill extends SkillEntry {
  readonly instructions: string
}
```

(no change needed — it inherits `ruleId` from `SkillEntry`).

- [ ] **Step 4: Fix `src/index.ts` duplicates**

The service.ts export line in `src/index.ts` (line ~174) becomes:

```ts
export { SkillsService, parseSkill, type SkillEntry, type LoadedSkill, type SkillRule } from './harness/skills/service.ts'
```

(`SkillError`/`SkillSource` already flow from the Task 1 layers export line; re-exports
through service.ts keep internal imports working.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/harness/g3-context.spec.ts tests/harness/skill-layers.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/harness/skills/service.ts src/index.ts tests/harness/g3-context.spec.ts
git commit -m "feat(skills): layer-aware SkillsService with per-workspace source rules"
```

---

### Task 3: Server — sources routes, `projectId` on list/load, protected roots

**Files:**
- Modify: `src/web/server.ts`
- Create: `tests/web/server-skill-sources.spec.ts`

**Interfaces:**
- Consumes: Task 1–2 (`resolveSkillLayers`, `protectedRootsForRules`, `skills.sources/setSources/listIn/loadIn/listVisibleIn/workspaceSkillsDir`, `SkillLayer`).
- Produces: `GET/PUT /api/workspaces/:wsId/skills/sources`; `GET /skills?projectId=` and `GET /skills/:name?projectId=`; internal helper `skillLayersFor(wsId, projectId)`; refreshed `grantPolicy.protectedRoots` on PUT.

- [ ] **Step 1: Write the failing server tests**

Create `tests/web/server-skill-sources.spec.ts`:

```ts
/**
 * Skill source rules over HTTP: defaults, validation, project-scoped catalog
 * and detail reads, and the rule-driven grant protection refresh.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'

let root = ''
const servers: WebServer[] = []

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-src-'))
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function start(): Promise<{ server: WebServer; base: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-src-home-'))
  const server = await createWebServer({ home, configFile: path.join(home, 'p.json') })
  servers.push(server)
  return { server, base: server.url }
}

const post = async (base: string, pathname: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

describe('skill sources routes', () => {
  it('GET returns the materialized defaults and PUT round-trips a new list', async () => {
    const { base } = await start()
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const defaults = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: { id: string; kind: string }[] }
    expect(defaults.rules.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])

    const put = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'claude', kind: 'project', path: '.claude/skills', enabled: false }] }),
    })
    expect(put.status).toBe(200)
    const after = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/sources`)).json()) as { rules: { id: string; enabled: boolean }[] }
    expect(after.rules).toMatchObject([{ id: 'claude', enabled: false }])
  })

  it('PUT rejects malformed rule lists with 400', async () => {
    const { base } = await start()
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const bad = [
      { rules: 'no' },
      { rules: [{ id: 'a', kind: 'project', path: '../escape', enabled: true }] },
      { rules: [{ id: 'a', kind: 'absolute', path: 'relative', enabled: true }] },
      { rules: [{ id: 'a', kind: 'galactic', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'b', kind: 'workspace', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'a', kind: 'project', path: 'x', enabled: true }] },
    ]
    for (const body of bad) {
      const response = await fetch(`${base}/api/workspaces/${wsId}/skills/sources`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
  })

  it('projectId resolves project rule layers for the catalog and one skill read', async () => {
    const { base } = await start()
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const proj = await fs.mkdtemp(path.join(root, 'proj-'))
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'dup'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: claude wins\n---\n\nCLAUDE', 'utf8')
    await fs.mkdir(path.join(proj, '.agents', 'skills', 'dup'), { recursive: true })
    await fs.writeFile(path.join(proj, '.agents', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: agents\n---\n\nAGENTS', 'utf8')
    await fs.mkdir(path.join(proj, '.agents', 'skills', 'only-agents'), { recursive: true })
    await fs.writeFile(path.join(proj, '.agents', 'skills', 'only-agents', 'SKILL.md'), '---\nname: only-agents\ndescription: x\n---\n\nA', 'utf8')
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Skilled', path: proj })).json()) as { id: string }

    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills?projectId=${project.id}`)).json()) as { name: string; source: string; ruleId?: string }[]
    expect(rows.find((row) => row.name === 'dup')).toMatchObject({ source: 'project', ruleId: 'project-claude' })
    expect(rows.find((row) => row.name === 'only-agents')).toMatchObject({ source: 'project', ruleId: 'project-agents' })
    const plain = (await (await fetch(`${base}/api/workspaces/${wsId}/skills`)).json()) as { name: string }[]
    expect(plain.some((row) => row.name === 'dup')).toBe(false)

    const detail = (await (await fetch(`${base}/api/workspaces/${wsId}/skills/dup?projectId=${project.id}`)).json()) as { source: string; instructions: string }
    expect(detail.source).toBe('project')
    expect(detail.instructions).toContain('CLAUDE')
    expect((await fetch(`${base}/api/workspaces/${wsId}/skills?projectId=nope`)).status).toBe(400)
  })

  it('an escaping stored rule reads as nothing (containment re-checked at read time)', async () => {
    const { base } = await start()
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const proj = await fs.mkdtemp(path.join(root, 'escape-'))
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Escape', path: proj })).json()) as { id: string }
    await fs.writeFile(path.join(proj, 'sources.json'), JSON.stringify({ rules: [
      { id: 'sneaky', kind: 'project', path: '../outside', enabled: true },
      { id: 'ws', kind: 'workspace', enabled: true },
    ] }), 'utf8')
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/skills?projectId=${project.id}`)).json()) as { name: string; source: string }[]
    expect(rows.every((row) => row.source !== 'project')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/server-skill-sources.spec.ts`
Expected: FAIL — `/skills/sources` 404s; `projectId` param ignored.

- [ ] **Step 3: Implement in `src/web/server.ts`**

(a) Import the helpers at the existing skills import (line ~121):

```ts
import { SkillsService } from '../harness/skills/service.ts'
import { protectedRootsForRules, resolveSkillLayers, type SkillLayer } from '../harness/skills/layers.ts'
```

(keep `SkillError` imported from service.ts as today).

(b) Add the scope helper after the `readWorkspaceInstructions` function (~line 1835):

```ts
  /** Ordered skill layers for a scope: rules + the bound project's folder. */
  async function skillLayersFor(workspaceId: WorkspaceId, projectId: ProjectId | undefined): Promise<SkillLayer[]> {
    const rules = await skills.sources(workspaceId)
    let projectPath: string | undefined
    if (projectId !== undefined) projectPath = workspaces.getProject(projectId, workspaceId).path
    return resolveSkillLayers(rules, { workspaceDir: skills.workspaceSkillsDir(workspaceId), ...(projectPath !== undefined ? { projectPath } : {}) })
  }

  /** Layers for a query-string projectId; throws when the id is not a project of the workspace. */
  async function layersFromQuery(workspaceId: WorkspaceId): Promise<SkillLayer[]> {
    const raw = query.get('projectId')
    return skillLayersFor(workspaceId, raw !== null && raw !== '' ? (raw as ProjectId) : undefined)
  }
```

(c) Sources routes — insert BEFORE the `wsSkillHidden` block (~line 4241), same style:

```ts
    // Skill source rules (before /skills/:name, which has no room for the segment).
    const wsSkillSources = /^\/api\/workspaces\/([^/]+)\/skills\/sources$/.exec(pathname)
    if (wsSkillSources !== null && (req.method === 'GET' || req.method === 'PUT')) {
      const wsId = decodeURIComponent(wsSkillSources[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, req.method === 'PUT')
      if (req.method === 'GET') {
        send(200, { rules: await deps.skills.sources(wsId) })
        return
      }
      const body = await readJson(req)
      try {
        const rules = await deps.skills.setSources(wsId, body)
        // Absolute rule folders join the protected roots immediately: grant
        // validation reads this array, so rules take effect on the next grant.
        grantPolicy.protectedRoots.splice(
          0,
          grantPolicy.protectedRoots.length,
          ...(deniedRoots ?? []),
          ...protectedRootsForRules(rules),
          ...(options.userSkillsDir !== undefined ? [options.userSkillsDir] : []),
        )
        send(200, { rules })
      } catch (error) {
        if (error instanceof SkillError) {
          send(400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }
```

(d) List route gains `projectId` — replace the `GET && skillName === undefined` block
inside `wsSkillsMatch` (~line 4269) with:

```ts
      if (req.method === 'GET' && skillName === undefined) {
        // The settings list shows every row (hidden included) with its state;
        // discovery surfaces filter separately via listVisible. A projectId
        // query adds that project's rule layers (unknown id → 400).
        let layers: SkillLayer[]
        try {
          layers = await layersFromQuery(wsId)
        } catch {
          send(400, { error: 'unknown projectId' })
          return
        }
        const [rows, hidden] = await Promise.all([deps.skills.listIn(layers), deps.skills.hiddenNames(wsId)])
        const hiddenSet = new Set(hidden)
        send(200, rows.map((row) => ({ ...row, ...(hiddenSet.has(row.name) ? { hidden: true } : {}) })))
        return
      }
```

(e) Detail route gains `projectId` — replace the `GET && skillName !== undefined` body
(~line 4303) with:

```ts
      if (req.method === 'GET' && skillName !== undefined) {
        // One skill's raw instructions + hash: the settings editor loads real
        // content so saves are never blind overwrites. projectId selects the
        // project's rule layers for project-layer rows.
        let layers: SkillLayer[]
        try {
          layers = await layersFromQuery(wsId)
        } catch {
          send(400, { error: 'unknown projectId' })
          return
        }
        try {
          const loaded = await deps.skills.loadIn(layers, skillName)
          send(200, { name: loaded.name, title: loaded.title, description: loaded.description, source: loaded.source, ruleId: loaded.ruleId, hash: loaded.hash, instructions: loaded.instructions })
        } catch (error) {
          if (error instanceof SkillError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
```

(`ruleId: loaded.ruleId` may be `undefined` — with `exactOptionalPropertyTypes` this is a
plain object literal sent to `send`, not JSX/typed optional props, so it is fine; if
typecheck complains, spread conditionally.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web/server-skill-sources.spec.ts tests/web/server-g3.spec.ts tests/web/server.spec.ts`
Expected: PASS (g3/server guard the existing routes).

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts tests/web/server-skill-sources.spec.ts
git commit -m "feat(web): skill source rules routes with project-scoped catalog reads"
```

---

### Task 4: Catalog injection + Skill tool use project layers

**Files:**
- Modify: `src/web/server.ts`
- Modify: `tests/web/server-skill-sources.spec.ts` (append two session tests)

**Interfaces:**
- Consumes: Task 3 `skillLayersFor`.
- Produces: catalog block and Skill tool `catalog`/`load` honor `scope.projectId`; no new APIs.

- [ ] **Step 1: Write the failing tests**

Append to `tests/web/server-skill-sources.spec.ts`:

```ts
import type { LlmProvider } from 'dnt-harness'

/** Read every event of a session (SSE snapshot consumed to the end). */
async function readAllEvents(base: string, wsId: string, sessionId: string): Promise<Array<{ type: string; ok?: boolean; output?: string }>> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const chunks: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(new TextDecoder().decode(value))
  }
  return chunks.join('').split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as { type: string; ok?: boolean; output?: string })
}

describe('Skill tool with project layers', () => {
  it('catalog and load resolve project-layer skills for a bound session', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) yield { type: 'toolCalls', calls: [{ id: 'c1', name: 'Skill', args: { action: 'catalog' } }] }
        else if (step === 2) yield { type: 'toolCalls', calls: [{ id: 'l1', name: 'Skill', args: { action: 'load', name: 'proj-skill' } }] }
        else yield { type: 'delta', delta: 'done' }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-skill-tool-home-'))
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const proj = await fs.mkdtemp(path.join(root, 'tool-proj-'))
    await fs.mkdir(path.join(proj, '.claude', 'skills', 'proj-skill'), { recursive: true })
    await fs.writeFile(path.join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: from the project\n---\n\nPROJECT STEPS', 'utf8')
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Tooled', path: proj })).json()) as { id: string }
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'skills' })

    await expect.poll(async () => {
      const events = await readAllEvents(base, wsId, session.id)
      return events.filter((event) => event.type === 'tool/result').length
    }, { timeout: 6_000 }).toBe(2)
    const results = (await readAllEvents(base, wsId, session.id)).filter((event) => event.type === 'tool/result')
    expect(results[0]?.output).toContain('proj-skill [project]')
    expect(results[1]).toMatchObject({ ok: true })
    expect(results[1]?.output).toContain("skill 'proj-skill' loaded")
  })
})
```

(The `readAllEvents` helper mirrors `tests/web/server-g3.spec.ts`; if g3 exports one, reuse it instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/server-skill-sources.spec.ts`
Expected: FAIL — `proj-skill` absent from catalog output ('no skills available' or workspace rows only).

- [ ] **Step 3: Implement in `src/web/server.ts`**

(a) Catalog injection (~line 1908) becomes:

```ts
    const skillCatalog = mode.definition.sources.skills === 'on-demand'
      && scope?.workspaceId !== undefined
      && exposed.some((schema) => schema.name === 'Skill')
      ? await skillLayersFor(scope.workspaceId, scope.projectId)
          .then((layers) => skills.listVisibleIn(scope.workspaceId as WorkspaceId, layers))
          .then((rows) => rows.map((entry) => {
            const description = entry.description === '' ? entry.title : entry.description
            return { name: entry.name, description: description.length > 500 ? `${description.slice(0, 499)}…` : description }
          }))
          .catch(() => undefined)
      : undefined
```

(b) Skill tool — in the tool handler, both `skills.listVisible(scope.workspaceId)` calls
(catalog action ~line 1177 and the not-found suggestions ~line 1210) and the
`skills.load(scope.workspaceId, name.trim())` call (~line 1191) become layer-aware:

```ts
        const catalogRows = async (): Promise<SkillEntry[]> => {
          const layers = await skillLayersFor(scope.workspaceId, scope.projectId)
          return skills.listVisibleIn(scope.workspaceId, layers)
        }
```

(catalog action uses `await catalogRows()` in place of `skills.listVisible(scope.workspaceId)`;
suggestions likewise), and the load branch:

```ts
      try {
        const layers = await skillLayersFor(scope.workspaceId, scope.projectId)
        const loaded = await skills.loadIn(layers, name.trim())
        perTurn.set(loaded.name, { name: loaded.name, instructions: loaded.instructions, hash: loaded.hash })
        skillSnapshots.set(scope.sessionId, perTurn)
        return `skill '${loaded.name}' loaded (hash ${loaded.hash.slice(0, 12)}); its instructions are included in context`
      } catch (error) {
```

If `SkillEntry` is not imported in the handler's scope, type the helper's return as
`Awaited<ReturnType<typeof skills.listVisibleIn>>` instead — avoid a new import just for typing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web/server-skill-sources.spec.ts tests/web/server-g3.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts tests/web/server-skill-sources.spec.ts
git commit -m "feat(skills): catalog injection and Skill tool honor project rule layers"
```

---

### Task 5: Web types + API client

**Files:**
- Modify: `web/lib/types.ts` (SkillRow block, ~line 482)
- Modify: `web/lib/api.ts` (G3 skills section, ~line 674)

**Interfaces:**
- Produces: `SkillRow.source` gains `'project'`; `SkillRow.ruleId?: string`; `SkillRuleRow`; `listSkills(wsId, projectId?)`; `getSkill(wsId, name, projectId?)`; `getSkillSources(wsId)`; `putSkillSources(wsId, rules)`.

- [ ] **Step 1: Update `web/lib/types.ts`**

Replace the `SkillRow` interface:

```ts
export interface SkillRow {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly source: 'project' | 'workspace' | 'user' | 'bundled'
  /** The source rule a project row resolved from (panel grouping). */
  readonly ruleId?: string
  /** sha256 of the raw SKILL.md — the optimistic-concurrency token. */
  readonly hash: string
  /** Present when this workspace hides the skill from discovery surfaces. */
  readonly hidden?: boolean
}

/** One configurable skill source folder; list order is precedence order. */
export interface SkillRuleRow {
  readonly id: string
  readonly kind: 'project' | 'workspace' | 'absolute'
  readonly path?: string
  readonly enabled: boolean
}
```

- [ ] **Step 2: Update `web/lib/api.ts`**

In the G3 skills section, replace `listSkills`/`getSkill` and append sources functions:

```ts
export function listSkills(workspaceId: string, projectId?: string): Promise<SkillRow[]> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills${projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) => json<SkillRow[]>(r))
}

/** One skill's raw SKILL.md + hash (the settings editor's load). */
export function getSkill(workspaceId: string, name: string, projectId?: string): Promise<SkillRow & { readonly instructions: string }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}${projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) =>
    json<SkillRow & { readonly instructions: string }>(r),
  )
}

/** The workspace's skill source rules (defaults materialized). */
export function getSkillSources(workspaceId: string): Promise<{ readonly rules: readonly SkillRuleRow[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/sources`).then((r) => json<{ readonly rules: readonly SkillRuleRow[] }>(r))
}

/** Replace the skill source rules (validated server-side, last-write-wins). */
export function putSkillSources(workspaceId: string, rules: readonly SkillRuleRow[]): Promise<{ readonly rules: readonly SkillRuleRow[] }> {
  return apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/sources`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules }),
  }).then((r) => json<{ readonly rules: readonly SkillRuleRow[] }>(r))
}
```

Add `SkillRuleRow` to the type import list on line 2. Keep `saveSkill`/`deleteSkill`/`setSkillHidden` unchanged.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/lib/types.ts web/lib/api.ts
git commit -m "feat(web): skill source rule types and API client"
```

---

### Task 6: SkillsPanel — Skills tab (tree + detail)

**Files:**
- Rewrite: `web/components/settings/SkillsPanel.tsx`
- Create: `web/components/settings/skills-panel.spec.tsx`

**Interfaces:**
- Consumes: Task 5 client functions; settings-kit primitives (`PanelBody`, `PanelIntro`, `Section`, `ItemList`, `ItemRow`, `EmptyState`, `InlineConfirm`, `Notice`, `Field`, `TextInput`, `CodeArea`, `WorkspaceRequired`, `useActionRunner`, `type NoticeState`); `Badge`, `Button`, `IconButton`, `Icon`, `TextInput`; `Markdown` from `../../Markdown.tsx`; `listProjects` from api.
- Produces: `SkillsPanel({ workspaceId })` rendering the two-tab panel; Task 7 adds the folders tab body.

- [ ] **Step 1: Write the failing component tests**

Create `web/components/settings/skills-panel.spec.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteSkill, getSkill, getSkillSources, listProjects, listSkills, saveSkill, setSkillHidden } from '../../lib/api.ts'
import { SkillsPanel } from './SkillsPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
  setSkillHidden: vi.fn(),
  getSkillSources: vi.fn(),
  putSkillSources: vi.fn(),
  listProjects: vi.fn(),
}))

const mocked = vi.mocked({ listSkills, getSkill, saveSkill, deleteSkill, setSkillHidden, getSkillSources, putSkillSources, listProjects })

const row = (name: string, source: 'project' | 'workspace' | 'user', extra: Record<string, unknown> = {}) =>
  ({ name, title: name, description: `${name} does things`, source, hash: `hash-${name}`, ...extra })

beforeEach(() => {
  mocked.listSkills.mockImplementation(async (_ws: string, projectId?: string) =>
    projectId === undefined
      ? [row('ws-skill', 'workspace'), row('user-skill', 'user')]
      : projectId === 'p1'
        ? [row('proj-claude', 'project', { ruleId: 'project-claude' })]
        : [])
  mocked.getSkillSources.mockResolvedValue({ rules: [
    { id: 'project-claude', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'project-agents', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'workspace', kind: 'workspace', enabled: true },
    { id: 'user', kind: 'absolute', path: '~/.claude/skills', enabled: true },
  ] })
  mocked.listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] as never)
  mocked.getSkill.mockResolvedValue({ ...row('ws-skill', 'workspace'), instructions: '---\nname: ws-skill\ndescription: x\n---\n\nBODY TEXT' })
  mocked.setSkillHidden.mockResolvedValue({ name: 'ws-skill', hidden: true })
})

let container: HTMLDivElement | null = null
let root: Root | null = null
const render = async (ui: React.ReactNode): Promise<void> => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(ui))
}
const click = async (el: Element): Promise<void> => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})

describe('SkillsPanel skills tab', () => {
  it('groups rows by project rule then workspace then user, with counts', async () => {
    await render(<SkillsPanel workspaceId="ws-1" />)
    expect(await screen.findByText('proj-claude')).toBeDefined()
    expect(screen.getByText('.claude/skills · Alpha')).toBeDefined()
    expect(screen.getByText('Workspace')).toBeDefined()
    expect(screen.getByText('User (~/.claude/skills)')).toBeDefined()
  })

  it('opens the detail pane with preview markdown, edit only for workspace rows', async () => {
    await render(<SkillsPanel workspaceId="ws-1" />)
    await click(await screen.findByText('ws-skill'))
    expect(await screen.findByText('BODY TEXT')).toBeDefined()
    expect(screen.getByText('Workspace', { selector: '[data-tone], .inline-flex, span' })).toBeDefined()
    await click(screen.getByRole('button', { name: /edit/i }))
    expect(await screen.findByDisplayValue(/BODY TEXT/)).toBeDefined()
  })

  it('project rows show a read-only notice and no editor', async () => {
    await render(<SkillsPanel workspaceId="ws-1" />)
    await click(await screen.findByText('proj-claude'))
    expect(await screen.findByText(/read-only/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
  })

  it('the In catalog switch hides a skill via setSkillHidden', async () => {
    await render(<SkillsPanel workspaceId="ws-1" />)
    await click(await screen.findByText('ws-skill'))
    const toggle = await screen.findByRole('checkbox', { name: /in catalog/i })
    await click(toggle)
    expect(mocked.setSkillHidden).toHaveBeenCalledWith('ws-1', 'ws-skill', true)
  })

  it('search narrows the tree across groups', async () => {
    await render(<SkillsPanel workspaceId="ws-1" />)
    const input = await screen.findByPlaceholderText(/search/i)
    await act(async () => {
      input.value = 'proj-cla'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(screen.getByText('proj-claude')).toBeDefined()
    expect(screen.queryByText('ws-skill')).toBeNull()
  })

  it('the workspace editor saves through saveSkill with the loaded hash', async () => {
    mocked.saveSkill.mockResolvedValue({ name: 'ws-skill', hash: 'hash-new' })
    await render(<SkillsPanel workspaceId="ws-1" />)
    await click(await screen.findByText('ws-skill'))
    await click(await screen.findByRole('button', { name: /edit/i }))
    const area = await screen.findByRole('textbox')
    await act(async () => {
      ;(area as HTMLTextAreaElement).value = '---\nname: ws-skill\ndescription: x\n---\n\nNEW BODY'
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(screen.getByRole('button', { name: /save skill/i }))
    expect(mocked.saveSkill).toHaveBeenCalledWith('ws-1', 'ws-skill', '---\nname: ws-skill\ndescription: x\n---\n\nNEW BODY', 'hash-ws-skill')
  })
})
```

Note: `screen` comes from `@testing-library/dom` re-export if the repo's specs use it —
check how `web/components/settings/settings-panels.spec.tsx` queries the DOM and MATCH
THAT STYLE exactly (the repo may query `container.querySelector` directly). Adjust all
`screen.*` calls to the established pattern before running; keep the assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/components/settings/skills-panel.spec.tsx`
Expected: FAIL — panel is the old flat list.

- [ ] **Step 3: Rewrite `web/components/settings/SkillsPanel.tsx`**

Full component (two tabs; the folders body is a stub replaced in Task 7):

```tsx
import { useCallback, useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { Markdown } from '../../Markdown.tsx'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { deleteSkill, getSkill, getSkillSources, listProjects, listSkills, putSkillSources, saveSkill, setSkillHidden } from '../../lib/api.ts'
import type { ProjectRow, SkillRow, SkillRuleRow } from '../../lib/types.ts'
import {
  CodeArea, EmptyState, InlineConfirm, ItemList, ItemRow, Notice, PanelBody, PanelIntro, Section, WorkspaceRequired, useActionRunner, type NoticeState,
} from './settings-kit.tsx'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_PLACEHOLDER = '---\nname: deploy-notes\ndescription: how deploys work\n---\n\nDeploy runs via pm2…'
const isConflict = (cause: unknown): boolean => /409/.test(String(cause))
type PanelTab = 'skills' | 'folders'

interface SkillGroup {
  readonly key: string
  readonly label: string
  readonly source: SkillRow['source']
  readonly rows: readonly SkillRow[]
}

/** Skills settings: layer-grouped catalog + detail pane, and the rule editor. */
export function SkillsPanel(props: { readonly workspaceId: string | null }) {
  return <SkillsPanelContent key={props.workspaceId} {...props} />
}

function SkillsPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [tab, setTab] = useScopedState<PanelTab>('skills')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [rules, setRules] = useScopedState<readonly SkillRuleRow[]>([])
  const [projects, setProjects] = useScopedState<readonly ProjectRow[]>([])
  const [baseRows, setBaseRows] = useScopedState<readonly SkillRow[]>([])
  const [projectRows, setProjectRows] = useScopedState<readonly Readonly<{ projectId: string; rows: readonly SkillRow[] }>>([])
  const [selected, setSelected] = useScopedState<{ readonly name: string; readonly source: SkillRow['source']; readonly projectId?: string } | null>(null)
  const [detail, setDetail] = useScopedState<SkillRow & { readonly instructions: string } | null>(null)
  const [editing, setEditing] = useScopedState<{ readonly name: string; readonly isNew: boolean; readonly hash: string | null; readonly loaded: string } | null>(null)
  const [newName, setNewName] = useScopedState('')
  const [content, setContent] = useScopedState('')
  const [conflict, setConflict] = useScopedState(false)
  const [deleteName, setDeleteName] = useScopedState<string | null>(null)
  const [search, setSearch] = useScopedState('')
  const [sourceFilter, setSourceFilter] = useScopedState<'all' | SkillRow['source']>('all')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refresh = useCallback(async (): Promise<void> => {
    if (workspaceId === null) return
    try {
      const [baseRows, sources, projectRows] = await Promise.all([listSkills(workspaceId), getSkillSources(workspaceId), listProjects(workspaceId)])
      setBaseRows(baseRows)
      setRules(sources.rules)
      setProjects(projectRows)
      setProjectRows(await Promise.all(projectRows.map(async (project) => ({
        projectId: project.id,
        rows: await listSkills(workspaceId, project.id).catch(() => [] as SkillRow[]),
      }))))
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  if (workspaceId === null) return <WorkspaceRequired />

  const projectRuleOf = (ruleId: string | undefined): SkillRuleRow | undefined => rules.find((rule) => rule.id === ruleId)
  const projectName = (projectId: string): string => projects.find((project) => project.id === projectId)?.name ?? projectId

  /** Project × rule groups first, then the default layers. Empty groups are dropped. */
  const groups: readonly SkillGroup[] = (() => {
    const out: SkillGroup[] = []
    for (const entry of projectRows) {
      for (const rule of rules.filter((candidate) => candidate.kind === 'project' && candidate.enabled)) {
        const rows = entry.rows.filter((row) => row.ruleId === rule.id)
        if (rows.length > 0) out.push({ key: `${entry.projectId}:${rule.id}`, label: `${rule.path} · ${projectName(entry.projectId)}`, source: 'project', rows })
      }
    }
    const baseGroup = (source: SkillRow['source'], label: string): SkillGroup | undefined => {
      const rows = baseRows.filter((row) => row.source === source)
      return rows.length > 0 ? { key: source, label, source, rows } : undefined
    }
    out.push(baseGroup('workspace', 'Workspace'), baseGroup('user', 'User (~/.claude/skills)'), baseGroup('bundled', 'Bundled'))
    return out.filter((group): group is SkillGroup => group !== undefined)
  })()

  const visibleGroups = groups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => (sourceFilter === 'all' || row.source === sourceFilter) && (search === '' || `${row.name}
${row.title}
${row.description}`.toLowerCase().includes(search.toLowerCase()))) }))
    .filter((group) => group.rows.length > 0)
  const totalVisible = visibleGroups.reduce((sum, group) => sum + group.rows.length, 0)

  const openDetail = (row: SkillRow, projectId: string | undefined): Promise<void> => run(`open:${row.name}`, async () => {
    setNotice(null); setConflict(false)
    setSelected({ name: row.name, source: row.source, ...(projectId !== undefined ? { projectId } : {}) })
    setDetail(await getSkill(workspaceId, row.name, projectId))
    setEditing(null)
  })

  const beginNew = (): void => {
    setSelected(null); setDetail(null); setEditing({ name: '', isNew: true, hash: null, loaded: '' })
    setNewName(''); setContent(''); setConflict(false); setNotice(null)
  }

  const openEditor = (loaded: SkillRow & { readonly instructions: string }): void => {
    setEditing({ name: loaded.name, isNew: false, hash: loaded.hash, loaded: loaded.instructions })
    setContent(loaded.instructions)
  }

  const name = editing === null ? '' : editing.isNew ? newName.trim() : editing.name
  const allNames = groups.flatMap((group) => group.rows.map((row) => row.name))
  const nameInvalid = editing?.isNew === true && newName.trim() !== '' && !SKILL_NAME.test(newName.trim())
  const nameTaken = editing?.isNew === true && allNames.includes(newName.trim())
  const unchanged = editing !== null && !editing.isNew && content === editing.loaded
  const cannotSave = name === '' || content.trim() === '' || nameInvalid || nameTaken || unchanged

  const save = (hashOverride?: string): Promise<void> => run('save', async () => {
    if (editing === null) return
    try {
      const saved = await saveSkill(workspaceId, name, content, hashOverride ?? editing.hash ?? undefined)
      setNotice({ kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` })
      setEditing(null); setDetail(null); setSelected(null)
      await refresh()
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'Changed on disk since you opened it.' })
    }
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (editing === null || selected?.projectId !== undefined) return
    const fresh = await getSkill(workspaceId, editing.name)
    const saved = await saveSkill(workspaceId, editing.name, content, fresh.hash)
    setNotice({ kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` })
    setEditing(null)
    await refresh()
  })

  const reloadServer = (): Promise<void> => run('reload', async () => {
    if (editing === null) return
    const fresh = await getSkill(workspaceId, editing.name)
    setContent(fresh.instructions)
    setEditing({ ...editing, hash: fresh.hash, loaded: fresh.instructions })
    setConflict(false)
    setNotice({ kind: 'info', text: 'Loaded the server version.' })
  })

  const remove = (row: SkillRow): Promise<void> => run(`delete:${row.name}`, async () => {
    await deleteSkill(workspaceId, row.name)
    setDeleteName(null); setDetail(null); setSelected(null)
    setNotice({ kind: 'ok', text: `Deleted ${row.name}.` })
    await refresh()
  })

  const toggleCatalog = (row: SkillRow): Promise<void> => run(`catalog:${row.name}`, async () => {
    const next = !(row.hidden ?? false)
    await setSkillHidden(workspaceId, row.name, next)
    setNotice({
      kind: 'ok',
      text: next ? `${row.name} is hidden from discovery; the model loads it only when the user names it.` : `${row.name} is back in the skill catalog.`,
    })
    await refresh()
  })

  const badgeTone = (source: SkillRow['source']): 'blue' | 'green' | 'gray' => source === 'workspace' ? 'blue' : source === 'project' ? 'green' : 'gray'

  const detailBody = (): ReactNode => {
    if (editing !== null) {
      return (
        <Section title={editing.isNew ? 'New skill' : `Edit ${editing.name}`}>
          {editing.isNew ? (
            <Field label="Name" tone={nameInvalid || nameTaken ? 'bad' : 'default'}
              hint={nameInvalid ? 'Use lowercase letters, numbers, and single hyphens.' : nameTaken ? 'A skill with this name exists.' : 'Kebab-case directory name, e.g. deploy-notes.'}>
              <TextInput mono invalid={nameInvalid || nameTaken} value={newName} placeholder="deploy-notes" onChange={(e) => setNewName(e.target.value)} />
            </Field>
          ) : null}
          <Field label="SKILL.md content" hint="Markdown with frontmatter (name, description).">
            <CodeArea tall value={content} placeholder={SKILL_PLACEHOLDER} onChange={(e) => setContent(e.target.value)} />
          </Field>
          {conflict ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              <span className="min-w-0 flex-1 basis-48">The file changed on disk since you opened it.</span>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reloadServer()}>Reload server version</Button>
              <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void overwrite()}>Overwrite anyway</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy !== null || cannotSave} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save skill'}</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setEditing(null); setConflict(false) }}>Cancel</Button>
          </div>
        </Section>
      )
    }
    if (selected === null || detail === null) return <EmptyState>Select a skill to preview it.</EmptyState>
    const readOnly = selected.source !== 'workspace'
    return (
      <Section title={detail.title === detail.name ? detail.name : `${detail.name} — ${detail.title}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badgeTone(selected.source)}>{selected.source}</Badge>
          {(detail.hidden ?? false) ? <Icon name="eyeOff" size={13} className="text-fg-faint" /> : null}
          <span className="min-w-0 flex-1" />
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted" title="List in the model's skill catalog">
            <input type="checkbox" className="size-3.5 accent-primary" aria-label={`Offer ${detail.name} in the skill catalog`}
              checked={!(detail.hidden ?? false)} disabled={busy !== null}
              onChange={() => void toggleCatalog({ ...detail, source: selected.source })} />
            In catalog
          </label>
        </div>
        <p className="font-mono text-xs text-fg-faint">/SKILL.md</p>
        {readOnly ? <Notice kind="info" text="This layer is read-only here — edit the file with an external editor; changes load fresh on the next read." /> : null}
        {detail.description !== '' ? <p className="text-[13px] text-fg-muted">{detail.description}</p> : null}
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border-subtle p-3 text-[13px]">
          <Markdown content={detail.instructions} />
        </div>
        {!readOnly ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => openEditor(detail)}><Icon name="code" size={13} />Edit raw</Button>
            {deleteName === detail.name ? (
              <InlineConfirm message={`Delete “${detail.name}”? Its SKILL.md is removed from this workspace.`} confirmLabel="Delete permanently"
                busy={busy === `delete:${detail.name}`} onConfirm={() => void remove(detail)} onCancel={() => setDeleteName(null)} />
            ) : (
              <IconButton label={`Delete ${detail.name}`} disabled={busy !== null} onClick={() => setDeleteName(detail.name)}><Icon name="trash" size={14} /></IconButton>
            )}
          </div>
        ) : null}
      </Section>
    )
  }

  return (
    <PanelBody>
      <PanelIntro>Skills are SKILL.md instruction packages the model loads by name. Project folders (.claude/skills, .agents/skills) follow the rule list in “Source folders”; precedence is list order, first match wins.</PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}
      <div className="flex gap-1 rounded-lg bg-bg-inset p-1 text-[13px]">
        {(['skills', 'folders'] as const).map((candidate) => (
          <button key={candidate} type="button"
            className={`rounded-md px-3 py-1.5 ${tab === candidate ? 'bg-bg-surface text-fg shadow-sm' : 'text-fg-muted'}`}
            onClick={() => setTab(candidate)}>
            {candidate === 'skills' ? 'Skills' : 'Source folders'}
          </button>
        ))}
      </div>
      {tab === 'skills' ? (
        <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(240px,2fr)_3fr]">
          <Section
            title="Skills"
            count={totalVisible}
            actions={<Button variant="outline" size="sm" disabled={busy !== null} onClick={beginNew}><Icon name="plus" size={13} />New skill</Button>}
          >
            <div className="flex flex-wrap gap-2">
              <TextInput value={search} placeholder="Search skills" onChange={(e) => setSearch(e.target.value)} />
              <select className="rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5 text-[13px]"
                value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as 'all' | SkillRow['source'])}>
                <option value="all">All</option>
                <option value="project">Project</option>
                <option value="workspace">Workspace</option>
                <option value="user">User</option>
                <option value="bundled">Bundled</option>
              </select>
            </div>
            {visibleGroups.length === 0 ? <EmptyState>No skills match.</EmptyState> : (
              <ItemList label="Skills">
                {visibleGroups.map((group) => (
                  <div key={group.key} className="space-y-1">
                    <p className="flex items-center gap-1.5 pt-1 text-xs font-medium text-fg-faint">
                      <Icon name="folder" size={12} />{group.label}
                      <span className="ml-auto">{group.rows.length}</span>
                    </p>
                    {group.rows.map((row) => (
                      <ItemRow key={`${group.key}:${row.name}`}
                        title={<>
                          <button type="button" className={`break-all text-left ${selected?.name === row.name && selected.source === row.source ? 'text-fg' : 'text-fg-muted hover:text-fg'}`}
                            onClick={() => void openDetail(row, row.source === 'project' ? projectRows.find((entry) => entry.rows.includes(row))?.projectId : undefined)}>
                            {row.name}
                          </button>
                          {(row.hidden ?? false) ? <Icon name="eyeOff" size={12} className="text-fg-faint" /> : null}
                        </>}
                        meta={row.description !== '' ? row.description : undefined}
                      />
                    ))}
                  </div>
                ))}
              </ItemList>
            )}
          </Section>
          {detailBody()}
        </div>
      ) : (
        <Section title="Source folders" count={rules.length}>
          <FoldersEditor workspaceId={workspaceId} rules={rules} onSaved={(saved) => { setRules(saved.rules); void refresh() }} setNotice={setNotice} busy={busy !== null} />
        </Section>
      )}
    </PanelBody>
  )
}

/** Placeholder — replaced by Task 7 with the full rule editor. */
function FoldersEditor(_props: { readonly workspaceId: string; readonly rules: readonly SkillRuleRow[]; readonly onSaved: (saved: { readonly rules: readonly SkillRuleRow[] }) => void; readonly setNotice: (notice: NoticeState) => void; readonly busy: boolean }): ReactNode {
  return <EmptyState>Rule editor lands in the next task.</EmptyState>
}
```

Adaptations at write time (allowed, keep behavior): query style must match
`settings-panels.spec.tsx` (`screen` vs `container` queries); if `Badge`/`Icon` names
differ (`eyeOff`, `code`, `folder` — check `web/components/common/Icon.tsx`'s icon map
and pick existing names; fall back to `x`/`chevron` names that exist), adjust; `Notice`
import used in detail; ensure `Section` accepts the `count` prop as today.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/components/settings/skills-panel.spec.tsx`
Expected: PASS (adjust queries to repo conventions if needed).

Also run the settings suite for regressions:

Run: `npx vitest run web/components/settings/`
Expected: PASS (old skills assertions in `settings-panels.spec.tsx` / `management.spec.tsx`
that referenced the flat list — if any break because the DOM changed, UPDATE those
assertions to the new tree/detail DOM in the same commit; do not delete coverage).

- [ ] **Step 5: Commit**

```bash
git add web/components/settings/SkillsPanel.tsx web/components/settings/skills-panel.spec.tsx web/components/settings/settings-panels.spec.tsx web/components/settings/management.spec.tsx
git commit -m "feat(web): skills settings two-pane catalog with layer groups"
```

---

### Task 7: Source folders tab (rule editor)

**Files:**
- Modify: `web/components/settings/SkillsPanel.tsx` (replace the `FoldersEditor` stub)
- Modify: `web/components/settings/skills-panel.spec.tsx` (append describe block)

**Interfaces:**
- Consumes: `putSkillSources`, `getSkillSources` (Task 5); props passed from Task 6.
- Produces: `FoldersEditor` — immediate-persistence rule editor (toggle, ↑/↓, remove, add).

- [ ] **Step 1: Write the failing tests**

Append to `skills-panel.spec.tsx`:

```tsx
describe('SkillsPanel source folders tab', () => {
  beforeEach(() => { mocked.putSkillSources.mockResolvedValue({ rules: [] }) })

  const openFolders = async (): Promise<void> => {
    await render(<SkillsPanel workspaceId="ws-1" />)
    await click(await screen.findByRole('button', { name: 'Source folders' }))
  }

  it('renders rule rows with kind badges and the locked workspace row', async () => {
    await openFolders()
    expect(await screen.findByText('.claude/skills')).toBeDefined()
    expect(screen.getByText('.agents/skills')).toBeDefined()
    const workspaceRow = screen.getByText(/workspace skills/i).closest('[data-rule], .space-y-1, div')
    expect(workspaceRow?.querySelector('button[aria-label*="remove" i], button[aria-label*="delete" i]')).toBeNull()
  })

  it('toggling a rule persists immediately via putSkillSources', async () => {
    await openFolders()
    const checkbox = await screen.findByRole('checkbox', { name: /enable \.agents\/skills/i })
    await click(checkbox)
    expect(mocked.putSkillSources).toHaveBeenCalledTimes(1)
    const rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string; enabled: boolean }[]
    expect(rules.find((rule) => rule.id === 'project-agents')?.enabled).toBe(false)
  })

  it('reorder buttons move a rule up and persist the swapped order', async () => {
    await openFolders()
    const up = await screen.findByRole('button', { name: /move \.agents\/skills up/i })
    await click(up)
    const rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string }[]
    expect(rules.map((rule) => rule.id)).toEqual(['project-agents', 'project-claude', 'workspace', 'user'])
  })

  it('remove deletes a rule and add appends a new one', async () => {
    await openFolders()
    await click(await screen.findByRole('button', { name: /remove \.agents\/skills/i }))
    let rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string }[]
    expect(rules.some((rule) => rule.id === 'project-agents')).toBe(false)
    await act(async () => {
      const kind = container!.querySelector('select[aria-label="New rule kind"]') as HTMLSelectElement
      kind.value = 'absolute'
      kind.dispatchEvent(new Event('change', { bubbles: true }))
      const pathInput = container!.querySelector('input[aria-label="New rule path"]') as HTMLInputElement
      pathInput.value = 'D:/shared-skills'
      pathInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(screen.getByRole('button', { name: /add rule/i }))
    rules = mocked.putSkillSources.mock.calls[1]?.[1] as readonly { id: string }[]
    expect(rules[rules.length - 1]).toMatchObject({ kind: 'absolute', path: 'D:/shared-skills', enabled: true })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/components/settings/skills-panel.spec.tsx`
Expected: FAIL — stub renders no rows.

- [ ] **Step 3: Implement `FoldersEditor`**

Replace the stub at the bottom of `SkillsPanel.tsx`:

```tsx
/** The ordered rule list; every mutation persists immediately (last-write-wins). */
function FoldersEditor(props: {
  readonly workspaceId: string
  readonly rules: readonly SkillRuleRow[]
  readonly onSaved: (saved: { readonly rules: readonly SkillRuleRow[] }) => void
  readonly setNotice: (notice: NoticeState) => void
  readonly busy: boolean
}): ReactNode {
  const [newKind, setNewKind] = useScopedState<'project' | 'absolute'>('project')
  const [newPath, setNewPath] = useScopedState('')
  const { run } = useActionRunner((text) => props.setNotice({ kind: 'bad', text }))

  const persist = (next: readonly SkillRuleRow[]): Promise<void> => run('sources', async () => {
    try {
      props.onSaved(await putSkillSources(props.workspaceId, next))
      props.setNotice({ kind: 'ok', text: 'Source folders saved.' })
    } catch (cause) {
      props.setNotice({ kind: 'bad', text: cause instanceof Error ? cause.message : String(cause) })
    }
  })

  const kindLabel = (kind: SkillRuleRow['kind']): string => kind === 'project' ? 'Project' : kind === 'absolute' ? 'Absolute' : 'Workspace'
  const rowLabel = (rule: SkillRuleRow): string => rule.kind === 'workspace' ? 'Workspace skills' : (rule.path ?? rule.id)

  const move = (index: number, delta: -1 | 1): void => {
    const next = [...props.rules]
    const [row] = next.splice(index, 1)
    if (row === undefined) return
    next.splice(index + delta, 0, row)
    void persist(next)
  }

  return (
    <div className="space-y-2">
      <ItemList label="Source folders">
        {props.rules.map((rule, index) => (
          <ItemRow key={rule.id}
            title={<><Badge tone={rule.kind === 'project' ? 'green' : rule.kind === 'absolute' ? 'gray' : 'blue'}>{kindLabel(rule.kind)}</Badge><span className="break-all font-mono text-[13px]">{rowLabel(rule)}</span></>}
            meta={rule.kind === 'workspace' ? 'The workspace's own skill folder — path is fixed.' : rule.kind === 'project' ? 'Relative to the bound project's folder.' : 'Absolute folder on this host.'}
            actions={<>
              <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted">
                <input type="checkbox" className="size-3.5 accent-primary" aria-label={`Enable ${rowLabel(rule)}`}
                  checked={rule.enabled} disabled={props.busy}
                  onChange={() => void persist(props.rules.map((candidate) => (candidate.id === rule.id ? { ...candidate, enabled: !candidate.enabled } : candidate)))} />
                Enabled
              </label>
              <IconButton label={`Move ${rowLabel(rule)} up`} disabled={props.busy || index === 0} onClick={() => move(index, -1)}><Icon name="chevronRight" size={13} className="rotate-[-90deg]" /></IconButton>
              <IconButton label={`Move ${rowLabel(rule)} down`} disabled={props.busy || index === props.rules.length - 1} onClick={() => move(index, 1)}><Icon name="chevronRight" size={13} className="rotate-90" /></IconButton>
              {rule.kind !== 'workspace' ? (
                <IconButton label={`Remove ${rowLabel(rule)}`} disabled={props.busy} onClick={() => void persist(props.rules.filter((candidate) => candidate.id !== rule.id))}>
                  <Icon name="trash" size={14} />
                </IconButton>
              ) : null}
            </>}
          />
        ))}
      </ItemList>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Kind">
          <select aria-label="New rule kind" className="rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5 text-[13px]"
            value={newKind} onChange={(e) => setNewKind(e.target.value as 'project' | 'absolute')}>
            <option value="project">Project folder</option>
            <option value="absolute">Absolute path</option>
          </select>
        </Field>
        <Field label={newKind === 'project' ? 'Relative folder (e.g. .claude/skills)' : 'Absolute folder (e.g. D:/shared-skills)'}>
          <TextInput mono aria-label="New rule path" value={newPath} placeholder={newKind === 'project' ? '.team/skills' : 'D:/shared-skills'} onChange={(e) => setNewPath(e.target.value)} />
        </Field>
        <Button variant="outline" size="sm" disabled={props.busy || newPath.trim() === ''}
          onClick={() => {
            const path = newPath.trim()
            if (path === '') return
            void persist([...props.rules, { id: `rule-${Math.random().toString(36).slice(2, 8)}`, kind: newKind, path, enabled: true }])
            setNewPath('')
          }}>
          <Icon name="plus" size={13} />Add rule
        </Button>
      </div>
      <p className="text-xs text-fg-faint">List order is precedence — the first folder holding a skill name wins. Absolute folders are protected from file-tool grants.</p>
    </div>
  )
}
```

Escape the apostrophes in `meta` strings correctly at write time (`workspace's` inside a
single-quoted JS string needs `\'` or use double quotes). Icon rotation classes: use
whatever chevron rotation classes already exist in the codebase (`rotate-90` etc.) — check
`Icon.tsx`'s available names and adjust.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/components/settings/skills-panel.spec.tsx web/components/settings/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/settings/SkillsPanel.tsx web/components/settings/skills-panel.spec.tsx
git commit -m "feat(web): skill source folders rule editor with immediate persistence"
```

---

### Task 8: Full verification, build, deploy, live check

**Files:**
- No source changes expected; fixes go into the files above.

- [ ] **Step 1: Typecheck + focused suites**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run tests/harness/skill-layers.spec.ts tests/harness/g3-context.spec.ts tests/web/server-skill-sources.spec.ts tests/web/server-g3.spec.ts tests/web/server.spec.ts web/components/settings/`
Expected: all PASS.

- [ ] **Step 2: Broader regression run**

Run: `npx vitest run tests/harness tests/web`
Expected: PASS; known unrelated failures (escaped Laragon Git Bash descendants, intermittent MCP stdio EPIPE after watchdog kill) are pre-existing — do not chase them.

- [ ] **Step 3: Build + deploy PM2**

Run: `npm run build:web && pm2 restart dnt-harness --update-env && sleep 2 && curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3082`
Expected: build succeeds; `200`.

- [ ] **Step 4: Live verify on :3082**

1. `curl -s http://127.0.0.1:3082/api/workspaces/<real-ws>/skills/sources` → default 4 rules.
2. In a project folder of the real workspace, create `.claude/skills/live-check/SKILL.md`, then
   `curl -s "http://127.0.0.1:3082/api/workspaces/<real-ws>/skills?projectId=<real-pid>"` → contains `live-check` with `source: project`.
3. Playwright click-through (script in repo root per convention): Settings → Skills —
   groups render, project group visible, detail preview shows, Source folders tab toggles a rule and persists; remove the `live-check` fixture afterwards.

- [ ] **Step 5: Final commit**

```bash
git add <files changed in this task, if any>
git commit -m "chore(skills): project skill layers verification fixes"
```

(If nothing changed, skip the commit.)

---

## Self-Review Notes

- Spec coverage: rules model (T1), service layer-awareness + sources store (T2), REST + protected roots (T3), injection + Skill tool (T4), web client (T5), two-pane Skills tab (T6), folders tab (T7), verification/deploy (T8). Settings UI Decision 5 (scan-all-projects, no selector) is implemented by the per-project listing loop in T6's `refresh`.
- Type consistency: `SkillLayer`/`SkillRule` names match across T1/T2/T3; `ruleId` flows T1→T2→server→`SkillRow.ruleId`→panel grouping; `FoldersEditor` props match between T6 stub and T7 implementation.
- Known risk: repo query conventions in web specs (`screen` vs container queries) and exact Icon names — the plan flags both inline to resolve against existing code at write time.
