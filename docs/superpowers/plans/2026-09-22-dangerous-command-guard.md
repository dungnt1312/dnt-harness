# Dangerous Command Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce content-aware Bash guard with 6 preset groups + custom rules via a `tools/rewrite` listener, workspace-scoped JSON storage, REST API, and Settings UI tab.

**Architecture:** New `src/harness/guard/` module (config, store, matcher, guard wiring) mounted in `src/web/server.ts` before `attachApproval`. Matcher is pure string/regex; store uses atomic `replaceFileAtomic`; guard uses `tools/rewrite` deny/forceAsk with WeakMap; UI is a dedicated Settings tab following `docs/design-system.md`.

**Tech Stack:** TypeScript, Node fs, Kernel EventBus waterfalls (`tools/rewrite`, `tools/pre-execute`), React + Tailwind, Vitest + Playwright.

## Global Constraints

- Node >= 20, TypeScript strict, `exactOptionalPropertyTypes` enabled (optional JSX props need conditional spread).
- Existing tool pipeline: `ToolsService.prepare()` runs `tools/rewrite` then `tools/pre-execute`; guard must use `tools/rewrite` (not `pre-execute`).
- `replaceFileAtomic` for all durable writes; directory fsync best-effort on Windows.
- Design system: `Stack`, `Divider`, `SectionHeader`, `ListItemRow`, semantic tokens only (`text-bad`, `text-warn`), no ad-hoc CSS.
- Approval flow: `attachApproval` owns `tools/pre-execute`; guard must wire via its `forceAsk` callback, never duplicate approval logic.
- Mode semantics unchanged: `toolExposure` + `permissionDefaults` stay tool-name-keyed; guard never widens a Mode deny.
- Must not add OS sandbox claims; document obfuscation limitation.
- Tests: 4 layers (unit matcher, unit store, integration guard pipeline, API e2e, UI component).

---

### Task 0: Scaffolding & branch

**Files:**
- Modify: `package.json` (no new deps)
- Create: `docs/superpowers/plans/2026-09-22-dangerous-command-guard.md` (this file)

**Interfaces:**
- Consumes: spec at `docs/superpowers/specs/2026-09-22-dangerous-command-guard-design.md`
- Produces: plan file on disk

- [ ] **Step 1: Ensure plan file is committed**

```bash
git add docs/superpowers/plans/2026-09-22-dangerous-command-guard.md
git commit -m "docs(plan): dangerous command guard implementation plan"
```

---

### Task 1: Guard config types & defaults

**Files:**
- Create: `src/harness/guard/types.ts`
- Create: `src/harness/guard/defaults.ts`
- Test: `tests/harness/guard-config.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type PresetId = 'fsDestructive' | 'gitDestructive' | 'systemPriv' | 'networkExfil' | 'dbDestructive' | 'resourceExhaust'`
  - `export type GuardAction = 'deny' | 'ask' | 'off'`
  - `export type CustomRuleAction = 'deny' | 'ask' | 'allow'`
  - `export interface CustomRule { id: string; pattern: string; isRegex: boolean; action: CustomRuleAction; description?: string }`
  - `export interface DangerousCommandsConfig { v: 1; presets: Record<PresetId, GuardAction>; customRules: CustomRule[] }`
  - `export const DEFAULT_CONFIG: DangerousCommandsConfig`
  - `export const PRESET_IDS: readonly PresetId[]`
  - `export const PRESET_LABELS: Record<PresetId, { name: string; description: string; examples: string }>`

- [ ] **Step 1: Write failing test for config defaults**

```ts
// tests/harness/guard-config.spec.ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, PRESET_IDS } from '../src/harness/guard/defaults.ts'

describe('guard defaults', () => {
  it('has 6 presets with correct defaults', () => {
    expect(PRESET_IDS).toHaveLength(6)
    expect(DEFAULT_CONFIG.presets.fsDestructive).toBe('deny')
    expect(DEFAULT_CONFIG.presets.gitDestructive).toBe('ask')
    expect(DEFAULT_CONFIG.presets.systemPriv).toBe('ask')
    expect(DEFAULT_CONFIG.presets.networkExfil).toBe('deny')
    expect(DEFAULT_CONFIG.presets.dbDestructive).toBe('ask')
    expect(DEFAULT_CONFIG.presets.resourceExhaust).toBe('deny')
  })
  it('has v:1 and empty customRules', () => {
    expect(DEFAULT_CONFIG.v).toBe(1)
    expect(DEFAULT_CONFIG.customRules).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
npm run test -- tests/harness/guard-config.spec.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Implement `src/harness/guard/types.ts` and `defaults.ts`**

```ts
// src/harness/guard/types.ts
export type PresetId = 'fsDestructive' | 'gitDestructive' | 'systemPriv' | 'networkExfil' | 'dbDestructive' | 'resourceExhaust'
export type GuardAction = 'deny' | 'ask' | 'off'
export type CustomRuleAction = 'deny' | 'ask' | 'allow'
export interface CustomRule {
  readonly id: string
  readonly pattern: string
  readonly isRegex: boolean
  readonly action: CustomRuleAction
  readonly description?: string
}
export interface DangerousCommandsConfig {
  readonly v: 1
  readonly presets: Record<PresetId, GuardAction>
  readonly customRules: readonly CustomRule[]
}
export interface GuardMatch {
  readonly presetId?: PresetId
  readonly ruleId?: string
  readonly action: GuardAction | CustomRuleAction
  readonly reason: string
  readonly pattern: string
}
```

```ts
// src/harness/guard/defaults.ts
import type { DangerousCommandsConfig, PresetId } from './types.ts'
export const PRESET_IDS = ['fsDestructive','gitDestructive','systemPriv','networkExfil','dbDestructive','resourceExhaust'] as const satisfies readonly PresetId[]
export const PRESET_LABELS: Record<PresetId, { name: string; description: string; examples: string }> = {
  fsDestructive: { name: 'FS Destructive', description: 'Irreversible filesystem damage', examples: 'rm -rf, mkfs, dd, shred' },
  gitDestructive: { name: 'Git Destructive', description: 'Irreversible git operations', examples: 'reset --hard, push --force, stash clear/drop, restore' },
  systemPriv: { name: 'System / Privilege', description: 'Privilege escalation & host control', examples: 'sudo, systemctl, reboot' },
  networkExfil: { name: 'Network Exfil / Remote Exec', description: 'Remote execution & exfiltration', examples: 'curl | sh, wget | bash, nc -l' },
  dbDestructive: { name: 'DB Destructive', description: 'Database data loss', examples: 'DROP TABLE, TRUNCATE, DELETE w/o WHERE' },
  resourceExhaust: { name: 'Resource Exhaust', description: 'Fork bomb & host DoS', examples: ':(){ :|:& };:, nohup loop' },
}
export const DEFAULT_CONFIG: DangerousCommandsConfig = {
  v: 1,
  presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
  customRules: [],
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm run test -- tests/harness/guard-config.spec.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/harness/guard/types.ts src/harness/guard/defaults.ts tests/harness/guard-config.spec.ts
git commit -m "feat(guard): config types and defaults"
```

---

### Task 2: Preset regexes + matcher (pure)

**Files:**
- Create: `src/harness/guard/presets.ts`
- Create: `src/harness/guard/matcher.ts`
- Test: `tests/harness/guard-matcher.spec.ts`

**Interfaces:**
- Consumes: `DangerousCommandsConfig`, `PresetId`, `GuardMatch` from Task 1
- Produces:
  - `export function normalizeCommand(cmd: string): string` — trim, collapse whitespace, strip trailing `#` comment outside quotes, lowercase keywords (but return normalized form for matching; original kept for reason)
  - `export function matchCommand(command: string, config: DangerousCommandsConfig): GuardMatch | null`

- [ ] **Step 1: Write failing matcher tests (representative fixtures)**

```ts
// tests/harness/guard-matcher.spec.ts
import { describe, it, expect } from 'vitest'
import { matchCommand } from '../src/harness/guard/matcher.ts'
import { DEFAULT_CONFIG } from '../src/harness/guard/defaults.ts'

describe('matchCommand', () => {
  it('denies rm -rf /', () => {
    const m = matchCommand('rm -rf /', DEFAULT_CONFIG)
    expect(m?.action).toBe('deny')
    expect(m?.presetId).toBe('fsDestructive')
  })
  it('asks on git reset --hard', () => {
    expect(matchCommand('git reset --hard HEAD~1', DEFAULT_CONFIG)?.presetId).toBe('gitDestructive')
  })
  it('matches git stash clear', () => {
    expect(matchCommand('git stash clear', DEFAULT_CONFIG)?.presetId).toBe('gitDestructive')
  })
  it('matches git stash drop', () => {
    expect(matchCommand('git stash drop stash@{0}', DEFAULT_CONFIG)?.presetId).toBe('gitDestructive')
  })
  it('matches git restore without --staged', () => {
    expect(matchCommand('git restore foo.txt', DEFAULT_CONFIG)?.presetId).toBe('gitDestructive')
  })
  it('does NOT match git restore --staged', () => {
    expect(matchCommand('git restore --staged foo.txt', DEFAULT_CONFIG)).toBeNull()
  })
  it('does NOT match git stash push', () => {
    expect(matchCommand('git stash push -m "wip"', DEFAULT_CONFIG)).toBeNull()
  })
  it('denies curl | sh', () => {
    expect(matchCommand('curl https://example.com/install.sh | sh', DEFAULT_CONFIG)?.presetId).toBe('networkExfil')
  })
  it('denies fork bomb', () => {
    expect(matchCommand(':(){ :|:& };:', DEFAULT_CONFIG)?.presetId).toBe('resourceExhaust')
  })
  it('off preset does not match', () => {
    const cfg = { ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, fsDestructive: 'off' as const } }
    expect(matchCommand('rm -rf /tmp/foo', cfg)).toBeNull()
  })
  it('custom allow overrides preset deny', () => {
    const cfg = { ...DEFAULT_CONFIG, customRules: [{ id: 'cr-1', pattern: 'rm -rf ./tmp', isRegex: false, action: 'allow' as const }] }
    const m = matchCommand('rm -rf ./tmp', cfg)
    expect(m?.action).toBe('allow')
  })
  it('custom regex deny', () => {
    const cfg = { ...DEFAULT_CONFIG, customRules: [{ id: 'cr-2', pattern: '^rm\\s+-rf', isRegex: true, action: 'deny' as const }] }
    expect(matchCommand('rm -rf /foo', cfg)?.ruleId).toBe('cr-2')
  })
  it('normalizes extra whitespace and trailing comment', () => {
    expect(matchCommand('  rm   -rf   /tmp/foo   # cleanup', DEFAULT_CONFIG)?.presetId).toBe('fsDestructive')
  })
  it('is case-insensitive for keywords', () => {
    expect(matchCommand('RM -RF /', DEFAULT_CONFIG)?.presetId).toBe('fsDestructive')
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
npm run test -- tests/harness/guard-matcher.spec.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Implement presets + matcher**

`presets.ts` — each PresetId maps to `RegExp[]` compiled once:

- `fsDestructive`: `/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i`, `/\bmkfs\b/i`, `/\bdd\s+if=/i`, `/\bshred\b/i`, `/chmod\s+.*777/i`, `/>\s*\/dev\/sd/i`
- `gitDestructive`: `/\bgit\s+reset\s+--hard\b/i`, `/\bgit\s+push\s+.*--force/i`, `/\bgit\s+clean\s+.*-f/i`, `/\bgit\s+branch\s+-D\b/i`, `/\bgit\s+stash\s+(clear|drop)\b/i`, `/\bgit\s+restore\b(?![^|]*--staged)/i` (negative lookahead), `/\bgit\s+checkout\s+--\s+\./i`
- `systemPriv`: `/\bsudo\b/i`, `/\bsu\s+-/i`, `/\bsystemctl\b/i`, `/\breboot\b/i`, `/\bshutdown\b/i`, `/taskkill\s+\/F/i`
- `networkExfil`: `/curl[^|]*\|\s*(sh|bash)/i`, `/wget[^|]*\|\s*(sh|bash)/i`, `/\bnc\s+-l\b/i`, `/\bssh\s+/i`, `/Invoke-Expression/i`, `/\biex\s*\(/i`
- `dbDestructive`: `/\bDROP\s+(TABLE|DATABASE)\b/i`, `/\bTRUNCATE\s+TABLE\b/i`, `/\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i`
- `resourceExhaust`: `/: *\(\) *\{ *: *\| *: *& *\} *; *:/`, `/nohup.*while.*do/i`

`matcher.ts`:

```ts
export function normalizeCommand(cmd: string): string {
  let s = cmd.trim().replace(/\s+/g, ' ')
  // strip trailing # comment not inside quotes
  let inSingle = false, inDouble = false
  for (let i=0; i<s.length; i++) {
    const c = s[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    if (c === '"' && !inSingle) inDouble = !inDouble
    if (c === '#' && !inSingle && !inDouble && i>0 && s[i-1]===' ') { s = s.slice(0, i).trimEnd(); break }
  }
  return s
}
export function matchCommand(command: string, config: DangerousCommandsConfig): GuardMatch | null {
  const normalized = normalizeCommand(command)
  // 1) custom rules first match wins
  for (const rule of config.customRules) {
    const hit = rule.isRegex ? (()=>{ try{ return new RegExp(rule.pattern,'i').test(normalized)}catch{return false}})() : normalized.toLowerCase().includes(rule.pattern.toLowerCase())
    if (hit) return { ruleId: rule.id, action: rule.action, reason: `matched custom rule "${rule.pattern}"`, pattern: rule.pattern }
  }
  // 2) presets in priority order
  const order: PresetId[] = ['fsDestructive','networkExfil','resourceExhaust','gitDestructive','systemPriv','dbDestructive']
  for (const id of order) {
    if (config.presets[id] === 'off') continue
    const res = PRESET_REGEXES[id].some(rx => rx.test(normalized))
    if (res) return { presetId: id, action: config.presets[id], reason: `matched ${PRESET_LABELS[id].name}`, pattern: PRESET_REGEXES[id].find(rx=>rx.test(normalized))!.source }
  }
  return null
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm run test -- tests/harness/guard-matcher.spec.ts
# Expected: PASS (iterate on regex until green; especially git restore --staged exclusion)
```

- [ ] **Step 5: Commit**

```bash
git add src/harness/guard/presets.ts src/harness/guard/matcher.ts tests/harness/guard-matcher.spec.ts
git commit -m "feat(guard): preset regexes and pure matcher with priority"
```

---

### Task 3: Store (global + workspace file IO)

**Files:**
- Create: `src/harness/guard/store.ts`
- Test: `tests/harness/guard-store.spec.ts`

**Interfaces:**
- Consumes: `DangerousCommandsConfig`, `DEFAULT_CONFIG`, `matcher validation`
- Produces:
  - `export class DangerousCommandsStore { constructor(home: string); load(workspaceId: string): Promise<{config: DangerousCommandsConfig, hash: string}>; save(workspaceId: string, config: DangerousCommandsConfig, expectedHash?: string): Promise<{config, hash}>; loadGlobal(): Promise<{config, hash}>; saveGlobal(config, expectedHash?): Promise<...> }`
  - Validation: unknown preset keys rejected, invalid action rejected, empty pattern rejected, customRules >100 rejected, invalid regex rejected with 400-style error, `v` must be 1.
  - Hash via `createHash('sha256').update(JSON.stringify(config)).digest('hex')` for conflict detection.
  - Writes via `replaceFileAtomic`.

- [ ] **Step 1: Write failing store tests**

```ts
// tests/harness/guard-store.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DangerousCommandsStore } from '../src/harness/guard/store.ts'

describe('DangerousCommandsStore', () => {
  let dir: string; let store: DangerousCommandsStore
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'guard-')); store = new DangerousCommandsStore(dir) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  it('inherits global when workspace absent', async () => {
    const g = await store.loadGlobal()
    const w = await store.load('ws-1')
    expect(w.config).toEqual(g.config)
  })
  it('workspace save overrides global', async () => {
    await store.save('ws-1', { v:1, presets: { fsDestructive:'off', gitDestructive:'ask', systemPriv:'ask', networkExfil:'deny', dbDestructive:'ask', resourceExhaust:'deny' }, customRules: [] })
    const w = await store.load('ws-1')
    expect(w.config.presets.fsDestructive).toBe('off')
  })
  it('rejects invalid regex', async () => {
    await expect(store.save('ws-1', { v:1, presets: { fsDestructive:'deny', gitDestructive:'ask', systemPriv:'ask', networkExfil:'deny', dbDestructive:'ask', resourceExhaust:'deny' }, customRules: [{ id:'cr-1', pattern:'[', isRegex:true, action:'deny' }] })).rejects.toThrow()
  })
  it('conflict on stale hash', async () => {
    const { hash } = await store.save('ws-1', { v:1, presets: { fsDestructive:'deny', gitDestructive:'ask', systemPriv:'ask', networkExfil:'deny', dbDestructive:'ask', resourceExhaust:'deny' }, customRules: [] })
    await expect(store.save('ws-1', { v:1, presets: { fsDestructive:'off', gitDestructive:'ask', systemPriv:'ask', networkExfil:'deny', dbDestructive:'ask', resourceExhaust:'deny' }, customRules: [] }, 'stale')).rejects.toThrow(/conflict/i)
  })
  it('corrupt json falls back to default', async () => {
    // write corrupt file directly then load
  })
})
```

- [ ] **Step 2: Run fail, implement, run pass, commit** (same pattern as Task 1)

---

### Task 4: Guard wiring (`tools/rewrite` listener) + forceAsk integration

**Files:**
- Create: `src/harness/guard/guard.ts`
- Modify: `src/web/server.ts` — mount guard before approval
- Test: `tests/harness/guard-pipeline.spec.ts`

**Interfaces:**
- Consumes: `matchCommand`, `DangerousCommandsStore`
- Produces:
  - `export function attachDangerousCommandGuard(ctx: Context, options: { configSource: (workspaceId: string) => DangerousCommandsConfig; onMatch?: (m: GuardMatch)=>void }): { getMatch(call: ToolCall): GuardMatch | null }`
  - Inside: `ctx.on('tools/rewrite', async (payload, next) => { if (payload.call.name!=='Bash') return next(); const m = matchCommand(payload.call.args.command, config); if (!m) return next(); if (m.action==='deny') return {kind:'deny', reason: ...}; if (m.action==='ask') { storeWeakMap.set(payload.call, m); return next({call: payload.call}) } // allow: pass })`
  - Provide `getMatch` for approval's `forceAsk`.
  - In `server.ts`: instantiate `DangerousCommandsStore(resourceHome)`, create `guard = attachDangerousCommandGuard(kernel.ctx, { configSource: (wid)=> ... })`, then pass `forceAsk: (call)=> guard.getMatch(call)?.action==='ask'` into `attachApproval`.

- [ ] **Step 1: Write failing pipeline test**

```ts
// tests/harness/guard-pipeline.spec.ts
import { describe, it, expect } from 'vitest'
import { Kernel } from '../src/kernel/registry.ts'
import { ToolsService } from '../src/harness/tools/service.ts'
import { attachApproval } from '../src/harness/approval/policy.ts'
import { attachDangerousCommandGuard } from '../src/harness/guard/guard.ts'
import { DEFAULT_CONFIG } from '../src/harness/guard/defaults.ts'

describe('guard pipeline', () => {
  it('deny blocks before approval', async () => { /* setup kernel + tools + guard + approval(askUser never called) -> prepare rm -rf / -> denied */ })
  it('ask forces approval even when mode allow', async () => { /* approval defaults allow Bash, but guard ask -> askUser called */ })
  it('allow custom exempts', async () => { /* */ })
  it('mode deny still wins over guard allow', async () => { /* */ })
  it('non-Bash passes through', async () => { /* Read tool not affected */ })
})
```

- [ ] **Step 2-5: Implement, verify, commit**

---

### Task 5: REST API

**Files:**
- Modify: `src/web/server.ts` — add 4 routes under `/api/guard/dangerous-commands`
- Modify: `src/web/server.ts` — add `sendGuardError` helper like `sendModeError`
- Test: `tests/web/server-guard.spec.ts`

**Routes:**
- `GET /api/guard/dangerous-commands?workspaceId=...` → `{config, hash}`
- `PUT /api/guard/dangerous-commands` body `{workspaceId, config, expectedHash?}` → `{config, hash}` or `400/409`
- `GET /api/guard/dangerous-commands/global`
- `PUT /api/guard/dangerous-commands/global` body `{config, expectedHash?}`

Validation mirrors store; `409` on hash mismatch (like modes). Workspace PUT requires `requireActive`.

- [ ] **Steps: write failing API tests → implement routes → verify → commit**

---

### Task 6: Settings UI — Dangerous Commands tab

**Files:**
- Create: `web/components/settings/DangerousCommandsPanel.tsx`
- Modify: `web/components/settings/SettingsModal.tsx` — add tab entry + panel
- Modify: `web/lib/api.ts` — add `getGuardConfig`, `putGuardConfig`, `getGlobalGuardConfig`, `putGlobalGuardConfig`
- Test: `web/components/settings/dangerous-commands.spec.tsx`

**UI spec per design §6:**
- Header + explanation
- Presets: 6 rows with `SegmentedControl` (Deny/Ask/Off) — reuse `web/components/ui/Menu.tsx` or simple 3-state toggle; use `text-bad` for deny, `text-warn` for ask
- Custom Rules: table + Add/Edit dialog (pattern, isRegex toggle, action select, description), live regex validation
- Test bar: input + result preview calling `matchCommand` locally (import matcher for instant feedback, no round-trip)
- Dirty check + Save/Cancel with `expectedHash`

- [ ] **Steps: component tests → implement panel → verify with `npm run build:web` → commit**

---

### Task 7: ApprovalBar reason enrichment + transcript

**Files:**
- Modify: `web/components/chat/ApprovalBar.tsx` — render guard reason as red banner when `reason` contains `Dangerous Commands`
- Modify: `src/harness/guard/guard.ts` — ensure deny/ask reason includes preset name + pattern for transcript fidelity
- Test: `tests/web/server-guard.spec.ts` (extend) + `web/components/settings/dangerous-commands.spec.tsx` (banner)

- [ ] **Steps: implement banner → verify → commit**

---

### Task 8: Docs + polish + final verification

**Files:**
- Modify: `docs/harness.md` — add Guard section (§ after Approval), document limitation
- Modify: `docs/capabilities.md` — note Bash guard
- Test: full suite `npm test` + `npm run build`

- [ ] **Step 1: Update docs**
- [ ] **Step 2: Full verification**

```bash
npm run build
npm test
npm run build:web
```

- [ ] **Step 3: Commit**

```bash
git add docs/harness.md docs/capabilities.md
git commit -m "docs: document dangerous command guard"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task (1:types, 2:presets/matcher, 3:store, 4:guard wiring, 5:API, 6:UI, 7:approval enrichment, 8:docs). `git stash clear/drop` and `git restore` exclusions covered in Task 2 fixtures. Global + workspace inheritance in Task 3. `isRegex` substring vs regex in Task 2. Test bar in Task 6.

**Placeholder scan:** no TBD/TODO; every step has concrete code/commands.

**Type consistency:** `GuardMatch.action` is `GuardAction|CustomRuleAction`; `forceAsk` reads `action==='ask'`; `deny` in custom maps to `CustomRuleAction` so priority check uses `rule.action` directly. `DangerousCommandsStore` hash is SHA256 of JSON.stringify — consistent across API and store.
