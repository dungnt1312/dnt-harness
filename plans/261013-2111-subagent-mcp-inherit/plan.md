# Subagent MCP Inherit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subagents get the MCP tools their parent sees (Claude/ZCode parity) instead of requiring an explicit `grantTools` entry per tool.

**Architecture:** A new pure module computes a role's tool candidates (built-ins plus MCP names and `mcp__server__*` / `mcp__*` selectors), applies grants and `disallowedTools`. The host's admission authority expands selectors against the workspace's live MCP descriptors and filters through the unchanged `isToolExposed` predicate; the executor pins the result as before. Bundled `explorer` keeps zero MCP; an override `explorer.md` is an ordinary role.

**Tech Stack:** TypeScript (Node 24), vitest, pnpm.

**Spec:** `plans/261013-2111-subagent-mcp-inherit/spec.md`

## Global Constraints

- Grants only narrow; nothing widens a role. Mode exposure (`none | read-safe | all`), host `blockedTools`, server `enabled` + `allowedTools`, root approval policy and one-level delegation are unchanged.
- The ceiling is pinned at spawn admission; later root widening adds nothing.
- Bundled `explorer` (source `bundled`, or source unknown) never gets MCP. Any other `explorer` source is an ordinary role.
- Fail-fast only for concrete `mcp__s__t` names in `grantTools`; role-declared MCP narrows silently.
- Use pnpm. Affected tests first, then `pnpm test` and `pnpm run typecheck`.
- Commits use conventional commit messages.

## Review Focus

1. Plan-mode root spawning an inherit role: spawn must succeed with only the read-safe allowlisted MCP tools (no fail-fast) — pinned in Task 5.
2. MCP server not yet connected at spawn (first turn of a new session): admission must wait for the workspace connect, not pin an empty MCP set — pinned in Task 4 (`mcpToolNames` awaits connect) and Task 5 (spawn right after session creation).
3. Grant that lists only built-ins (`['Read']`) must not strip MCP from an inherit role — pinned in Task 1 and Task 5.
4. `disallowedTools: mcp__*` must strip every MCP tool even under an inherit role — pinned in Task 1.
5. Workspace override `explorer.md` with `mcp__fixture__*` gets MCP while bundled explorer with the same grant does not — pinned in Task 3 and Task 5.

---

## File Structure

- Create `src/harness/agents/mcp-candidates.ts` — pure functions: selector matching, role candidates, grant/disallowed filtering, missing-grant detection. One responsibility: tool-name set algebra for a child ceiling.
- Modify `src/harness/agents/definition-service.ts` — `mcpServers` field parse/serialize.
- Modify `src/web/execution-authority.ts` — selector expansion in `admissionCeiling`, bundled-only explorer refusal, `definitionSource` in scope.
- Modify `src/harness/agents/executor.ts` — use the new module, compute ceiling before commit, `SpawnError('mcp')`.
- Modify `src/web/server.ts` — wire `mcpToolNames`, pass `definitionSource`, `pinRole`, HTTP 400 for `mcp`.
- Modify `src/web/agent-delegation.ts` — dropped-grant note only for built-ins, tool description.
- Tests: `tests/harness/mcp-candidates.spec.ts` (new), `tests/harness/g4-agents.spec.ts`, `tests/web/permission-hardening.spec.ts`.
- Docs: `docs/capabilities.md`, `docs/claude-format.md`.

---

### Task 1: Pure candidate/grant module

**Files:**
- Create: `src/harness/agents/mcp-candidates.ts`
- Test: `tests/harness/mcp-candidates.spec.ts`

**Interfaces:**
- Consumes: `AgentDefinition`, `AgentSource` from `src/harness/agents/definition-service.ts` (Task 2 adds `mcpServers?: readonly string[]`; this task reads it optionally so it compiles before Task 2 via `(definition as { mcpServers?: readonly string[] }).mcpServers` — replace with the typed field in Task 2).
- Produces:
  - `isMcpSelector(name: string): boolean`
  - `matchesMcpEntry(entry: string, tool: string): boolean`
  - `roleCandidates(definition: AgentDefinition, source: AgentSource | undefined): readonly string[]`
  - `isBundledExplorer(name: string, source: AgentSource | undefined): boolean`
  - `narrowCeiling(admitted: readonly string[], grant: readonly string[] | undefined, disallowed: readonly string[]): string[]`
  - `missingGrantedMcp(grant: readonly string[] | undefined, ceiling: readonly string[]): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/harness/mcp-candidates.spec.ts
import { describe, expect, it } from 'vitest'
import {
  isMcpSelector, matchesMcpEntry, roleCandidates, isBundledExplorer, narrowCeiling, missingGrantedMcp,
} from '../../src/harness/agents/mcp-candidates.ts'
import type { AgentDefinition } from '../../src/harness/agents/definition-service.ts'

const def = (over: Partial<AgentDefinition>): AgentDefinition => ({
  name: 'r', description: 'd', instructions: 'i', tools: ['Read', 'Grep'], disallowedTools: [], ...over,
})

describe('mcp selectors', () => {
  it('recognizes server and global selectors only', () => {
    expect(isMcpSelector('mcp__*')).toBe(true)
    expect(isMcpSelector('mcp__s__*')).toBe(true)
    expect(isMcpSelector('mcp__s__get')).toBe(false)
    expect(isMcpSelector('Read')).toBe(false)
  })
  it('matches exact, server and global entries', () => {
    expect(matchesMcpEntry('mcp__s__get', 'mcp__s__get')).toBe(true)
    expect(matchesMcpEntry('mcp__s__*', 'mcp__s__get')).toBe(true)
    expect(matchesMcpEntry('mcp__s__*', 'mcp__sx__get')).toBe(false)
    expect(matchesMcpEntry('mcp__*', 'mcp__any__thing')).toBe(true)
    expect(matchesMcpEntry('mcp__*', 'Read')).toBe(false)
  })
})

describe('roleCandidates', () => {
  it('inherit role gets every MCP tool', () => {
    expect(roleCandidates(def({ inheritsTools: true }), 'workspace')).toEqual(['Read', 'Grep', 'mcp__*'])
  })
  it('inherit role with mcpServers gets only those servers', () => {
    expect(roleCandidates(def({ inheritsTools: true, mcpServers: ['a', 'b'] }), 'workspace'))
      .toEqual(['Read', 'Grep', 'mcp__a__*', 'mcp__b__*'])
  })
  it('explicit role keeps only what it lists', () => {
    expect(roleCandidates(def({ tools: ['Read', 'mcp__s__*', 'mcp__t__get'] }), 'project'))
      .toEqual(['Read', 'mcp__s__*', 'mcp__t__get'])
  })
  it('bundled explorer (or unknown source) drops every MCP entry; an override keeps them', () => {
    const explorer = def({ name: 'explorer', tools: ['Read', 'mcp__s__*'] })
    expect(roleCandidates(explorer, 'bundled')).toEqual(['Read'])
    expect(roleCandidates(explorer, undefined)).toEqual(['Read'])
    expect(roleCandidates(explorer, 'workspace')).toEqual(['Read', 'mcp__s__*'])
    expect(isBundledExplorer('explorer', 'project')).toBe(false)
  })
})

describe('narrowCeiling', () => {
  const admitted = ['Read', 'Write', 'mcp__s__get', 'mcp__s__list', 'mcp__t__q']
  it('no grant keeps everything', () => {
    expect(narrowCeiling(admitted, undefined, [])).toEqual(admitted)
  })
  it('built-in-only grant narrows built-ins and keeps all MCP', () => {
    expect(narrowCeiling(admitted, ['Read'], [])).toEqual(['Read', 'mcp__s__get', 'mcp__s__list', 'mcp__t__q'])
  })
  it('a grant naming MCP keeps only the granted MCP', () => {
    expect(narrowCeiling(admitted, ['Read', 'mcp__s__*'], [])).toEqual(['Read', 'mcp__s__get', 'mcp__s__list'])
    expect(narrowCeiling(admitted, ['mcp__t__q'], [])).toEqual(['mcp__t__q'])
  })
  it('disallowed accepts exact, server and global selectors', () => {
    expect(narrowCeiling(admitted, undefined, ['Write', 'mcp__s__*'])).toEqual(['Read', 'mcp__t__q'])
    expect(narrowCeiling(admitted, undefined, ['mcp__*'])).toEqual(['Read', 'Write'])
  })
})

describe('missingGrantedMcp', () => {
  it('lists concrete granted MCP names absent from the ceiling; selectors never fail', () => {
    expect(missingGrantedMcp(['Read', 'mcp__s__get', 'mcp__x__y', 'mcp__z__*'], ['Read', 'mcp__s__get'])).toEqual(['mcp__x__y'])
    expect(missingGrantedMcp(undefined, [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/harness/mcp-candidates.spec.ts`
Expected: FAIL — cannot resolve `mcp-candidates.ts`.

- [ ] **Step 3: Implement**

```ts
// src/harness/agents/mcp-candidates.ts
/**
 * Tool-name set algebra for a child's ceiling. MCP entries are exact
 * `mcp__server__tool` names or selectors (`mcp__server__*`, `mcp__*`);
 * the host expands selectors against live descriptors at admission.
 * Nothing here grants authority: mode/approval gates stay independent.
 */
import type { AgentDefinition, AgentSource } from './definition-service.ts'

const isMcp = (name: string): boolean => name.startsWith('mcp__')

export function isMcpSelector(name: string): boolean {
  return name === 'mcp__*' || (isMcp(name) && name.endsWith('__*') && name.split('__').length === 3)
}

export function matchesMcpEntry(entry: string, tool: string): boolean {
  if (!isMcp(tool)) return false
  if (entry === 'mcp__*') return true
  if (isMcpSelector(entry)) return tool.startsWith(entry.slice(0, -1))
  return entry === tool
}

/** Bundled explorer has zero MCP. Unknown source fails closed as bundled. */
export function isBundledExplorer(name: string, source: AgentSource | undefined): boolean {
  return name === 'explorer' && (source === undefined || source === 'bundled')
}

/** Built-ins plus MCP entries a role can ever hold (selectors unexpanded). */
export function roleCandidates(definition: AgentDefinition, source: AgentSource | undefined): readonly string[] {
  const builtIns = definition.tools.filter((tool) => !isMcp(tool))
  if (isBundledExplorer(definition.name, source)) return builtIns
  if (definition.inheritsTools !== true) return [...definition.tools]
  const servers = definition.mcpServers
  const mcp = servers !== undefined && servers.length > 0 ? servers.map((server) => `mcp__${server}__*`) : ['mcp__*']
  return [...builtIns, ...mcp]
}

/**
 * Grant and disallowed narrowing over an admitted (concrete) list. A grant
 * narrows built-ins always, and MCP only when it names at least one MCP entry.
 */
export function narrowCeiling(admitted: readonly string[], grant: readonly string[] | undefined, disallowed: readonly string[]): string[] {
  const grantMcp = grant?.filter(isMcp) ?? []
  const kept = admitted.filter((tool) => {
    if (grant === undefined) return true
    if (!isMcp(tool)) return grant.includes(tool)
    return grantMcp.length === 0 || grantMcp.some((entry) => matchesMcpEntry(entry, tool))
  })
  return [...new Set(kept)].filter((tool) =>
    !disallowed.some((entry) => entry === tool || matchesMcpEntry(entry, tool)))
}

/** Concrete `mcp__s__t` names the grant asked for that the ceiling lacks. */
export function missingGrantedMcp(grant: readonly string[] | undefined, ceiling: readonly string[]): string[] {
  return (grant ?? []).filter((tool) => isMcp(tool) && !isMcpSelector(tool) && !ceiling.includes(tool))
}
```

Note: `definition.mcpServers` is added in Task 2. If you run Task 1 alone, typecheck fails on that line only; run Task 2 before `pnpm run typecheck`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/harness/mcp-candidates.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/agents/mcp-candidates.ts tests/harness/mcp-candidates.spec.ts
git commit -m "feat(agents): add MCP candidate and grant narrowing for child ceilings"
```

---

### Task 2: `mcpServers` in agent definitions

**Files:**
- Modify: `src/harness/agents/definition-service.ts:34-59` (interface), `:83-87` (keys), `:189-225` (parse), `:505-521` (serialize); `src/harness/agents/executor.ts:183-189` (`snapshotSpawnRequest` copies `mcpServers`)
- Test: `tests/harness/g4-agents.spec.ts` (near the Claude-format parse test at ~line 140)

**Interfaces:**
- Produces: `AgentDefinition.mcpServers?: readonly string[]`; `serializeAgentDefinition` accepts and emits `mcpServers`.

- [ ] **Step 1: Failing test**

Add in `tests/harness/g4-agents.spec.ts`, inside the describe that holds the `security-auditor` parse test:

```ts
it('parses mcpServers and MCP selectors, and round-trips them', async () => {
  const { parseAgentDefinition, serializeAgentDefinition } = await import('dnt-harness')
  const parsed = parseAgentDefinition('scout', [
    '---',
    'description: scout',
    'mcpServers: codebase-retrieval, context7',
    'disallowedTools: mcp__context7__*',
    '---',
    'Find things.',
  ].join('\n'))
  expect(parsed.inheritsTools).toBe(true)
  expect(parsed.mcpServers).toEqual(['codebase-retrieval', 'context7'])
  expect(parsed.disallowedTools).toEqual(['mcp__context7__*'])
  expect(parsed.unsupported ?? []).not.toContain('mcpServers')
  expect(parseAgentDefinition('scout', serializeAgentDefinition(parsed))).toMatchObject({
    mcpServers: ['codebase-retrieval', 'context7'], disallowedTools: ['mcp__context7__*'], inheritsTools: true,
  })
  const explicit = parseAgentDefinition('explorer', '---\ndescription: e\ntools: Read, Grep, mcp__codebase-retrieval__*\n---\nGo.')
  expect(explicit.tools).toEqual(['Read', 'Grep', 'mcp__codebase-retrieval__*'])
})
```

Also update the existing `security-auditor` assertion if its frontmatter lists `mcpServers` (it does not today; leave unchanged).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/harness/g4-agents.spec.ts -t "mcpServers"`
Expected: FAIL — `mcpServers` undefined.

- [ ] **Step 3: Implement**

In the interface after `inheritsTools`:

```ts
  /**
   * `tools` was omitted (Claude: inherit every tool). `tools` then lists the
   * built-ins; the child also inherits every MCP tool the parent sees at
   * spawn (or only `mcpServers`' tools when that is set).
   */
  readonly inheritsTools?: boolean
  /** Claude `mcpServers`: limits an inheriting role's MCP to these servers. */
  readonly mcpServers?: readonly string[]
```

Keys:

```ts
const ENFORCED_KEYS = new Set(['name', 'description', 'tools', 'disallowedTools', 'skills', 'model', 'mcpServers'])
const UNSUPPORTED_KEYS = new Set([
  'permissionMode', 'hooks', 'memory', 'color', 'effort', 'isolation', 'background', 'maxTurns',
])
```

Parse, after `const skills = toolList(...)`:

```ts
  const mcpServers = toolList(frontmatter['mcpServers'], 'mcpServers', invalid)
```

Return object, after the `skills` spread:

```ts
    ...(mcpServers !== undefined && mcpServers.length > 0 ? { mcpServers } : {}),
```

Serialize: add `'mcpServers'` to the `Pick<...>` union and, after the `skills` line:

```ts
    ...(definition.mcpServers !== undefined && definition.mcpServers.length > 0 ? [`mcpServers: ${definition.mcpServers.join(', ')}`] : []),
```

In `executor.ts` `snapshotSpawnRequest`, after the `skills` copy:

```ts
    ...(request.definition.mcpServers !== undefined ? { mcpServers: [...request.definition.mcpServers] } : {}),
```

In `mcp-candidates.ts`, `definition.mcpServers` now type-checks directly.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/harness/g4-agents.spec.ts tests/harness/mcp-candidates.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/agents/definition-service.ts src/harness/agents/executor.ts tests/harness/g4-agents.spec.ts
git commit -m "feat(agents): enforce Claude mcpServers frontmatter"
```

---

### Task 3: Authority — selector expansion and bundled-only Explorer refusal

**Files:**
- Modify: `src/web/execution-authority.ts:31-38` (`ExposureScope.childOf`), `:75-80` (`ExposureDeps`), `:131` (Explorer refusal), `:190-195` and `:240-244` (`admissionCeiling`)
- Test: `tests/web/permission-hardening.spec.ts:148-153` and the resolver-contract describe (~line 165)

**Interfaces:**
- Consumes: `isBundledExplorer`, `isMcpSelector`, `matchesMcpEntry` from Task 1; `AgentSource` type.
- Produces:
  - `ExposureScope.childOf.definitionSource?: AgentSource | undefined`
  - `ExposureDeps.mcpToolNames?: (workspaceId: string) => Promise<readonly string[]>` — live, provider-valid, allowlist-exposed MCP names.
  - `admissionCeiling(input: { workspaceId; rootSessionId; definition; definitionSource?: AgentSource; candidates })` — candidates may contain selectors; returns concrete names only.

- [ ] **Step 1: Failing tests**

Replace the test at lines 148-153:

```ts
  it('bundled Explorer gets no MCP even when the ceiling lists it; an override explorer is an ordinary role', () => {
    const state = snap(FULL, [server('s', true, ['get_item'])])
    for (const definitionSource of ['bundled', undefined] as const) {
      const scope: ExposureScope = { ...ROOT, sessionId: 'c', childOf: { definition: 'explorer', definitionSource, toolCeiling: ['Read', 'mcp__s__get_item'] } }
      expect(exposureRefusal(state, scope, 'mcp__s__get_item')).toMatch(/Explorer/)
      expect(isToolExposed(state, scope, 'Read')).toBe(true)
    }
    const override: ExposureScope = { ...ROOT, sessionId: 'c', childOf: { definition: 'explorer', definitionSource: 'workspace', toolCeiling: ['Read', 'mcp__s__get_item'] } }
    expect(exposureRefusal(state, override, 'mcp__s__get_item')).toBeUndefined()
  })
```

Add to the resolver-contract describe:

```ts
  it('admissionCeiling expands MCP selectors against live tools, then applies the shared predicate', async () => {
    const authority = createExecutionAuthority({
      blockedTools: [],
      modeOf: () => ({ mode: FULL, revision: 1 }),
      loadMcp: async () => config([server('s', true), server('off', false)]),
      mcpToolNames: async () => ['mcp__s__get_item', 'mcp__s__delete_item', 'mcp__off__get_item'],
    })
    const input = { workspaceId: 'w', rootSessionId: 'r', definition: 'worker', definitionSource: 'workspace' as const }
    expect(await authority.admissionCeiling({ ...input, candidates: ['Read', 'mcp__*'] }))
      .toEqual(['Read', 'mcp__s__get_item', 'mcp__s__delete_item'])
    expect(await authority.admissionCeiling({ ...input, candidates: ['mcp__s__*'] }))
      .toEqual(['mcp__s__get_item', 'mcp__s__delete_item'])
    expect(await authority.admissionCeiling({ ...input, definition: 'explorer', definitionSource: 'bundled', candidates: ['Read', 'mcp__*'] }))
      .toEqual(['Read'])
  })

  it('admissionCeiling under Plan keeps only read-safe allowlisted MCP', async () => {
    const authority = createExecutionAuthority({
      blockedTools: [],
      modeOf: () => ({ mode: PLAN, revision: 1 }),
      loadMcp: async () => config([server('s', true, ['get_item', 'delete_item'])]),
      mcpToolNames: async () => ['mcp__s__get_item', 'mcp__s__delete_item'],
    })
    expect(await authority.admissionCeiling({ workspaceId: 'w', rootSessionId: 'r', definition: 'scout', definitionSource: 'workspace', candidates: ['Read', 'mcp__*'] }))
      .toEqual(['Read', 'mcp__s__get_item'])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/web/permission-hardening.spec.ts -t "Explorer|admissionCeiling"`
Expected: FAIL (override still refused; selectors not expanded).

- [ ] **Step 3: Implement**

Imports at the top of `execution-authority.ts`:

```ts
import type { AgentSource } from '../harness/agents/definition-service.ts'
import { isBundledExplorer, isMcpSelector, matchesMcpEntry } from '../harness/agents/mcp-candidates.ts'
```

`ExposureScope.childOf`:

```ts
  readonly childOf?: {
    readonly definition: string
    /** Provenance; only the bundled explorer is MCP-free. Unknown = bundled. */
    readonly definitionSource?: AgentSource | undefined
    readonly toolCeiling?: readonly string[] | undefined
  } | undefined
```

`ExposureDeps`:

```ts
  /**
   * Live MCP tool names for selector expansion at spawn admission. Absent:
   * selectors expand to nothing (fail-closed).
   */
  readonly mcpToolNames?: (workspaceId: string) => Promise<readonly string[]>
```

Line 131:

```ts
    if (scope?.childOf !== undefined && isBundledExplorer(scope.childOf.definition, scope.childOf.definitionSource)) return 'Explorer exposes zero MCP tools'
```

Interface `admissionCeiling` input gains `readonly definitionSource?: AgentSource | undefined`. Implementation:

```ts
    async admissionCeiling({ workspaceId, rootSessionId, definition, definitionSource, candidates }) {
      const scope: ExposureScope = { workspaceId, sessionId: rootSessionId, rootSessionId, childOf: { definition, definitionSource } }
      const selectors = candidates.filter(isMcpSelector)
      const live = selectors.length > 0 && deps.mcpToolNames !== undefined ? await deps.mcpToolNames(workspaceId) : []
      const expanded = [...new Set([
        ...candidates.filter((name) => !isMcpSelector(name)),
        ...live.filter((name) => selectors.some((selector) => matchesMcpEntry(selector, name))),
      ])]
      const resolved = await snapshot(scope, workspaceId, expanded.some((name) => name.startsWith('mcp__')))
      return expanded.filter((name) => isToolExposed(resolved, scope, name))
    },
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/web/permission-hardening.spec.ts -t "Explorer|admissionCeiling|resolver contract|Plan MCP"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/execution-authority.ts tests/web/permission-hardening.spec.ts
git commit -m "feat(authority): expand MCP selectors at admission; Explorer refusal only for bundled"
```

---

### Task 4: Executor + host wiring

**Files:**
- Modify: `src/harness/agents/executor.ts:65-71` (`SpawnAdmissionInput`), `:162-181` (`SpawnError`, remove local `roleCandidates`), `:655-666` (admission), `:790-802` (ceiling)
- Modify: `src/web/server.ts:2093`, `:2687-2700`, `:3680-3685` (`pinRole`), `:4196`, `:5071`, `:5094-5095`
- Modify: `src/web/agent-delegation.ts:349`, `:393`, `:456-461`
- Test: `tests/harness/g4-subagent-contract.spec.ts` (executor-level), `tests/web/server-g4.spec.ts` unaffected

**Interfaces:**
- Consumes: Task 1 `roleCandidates`, `narrowCeiling`, `missingGrantedMcp`; Task 3 `admissionCeiling({ ..., definitionSource })`, `ExposureDeps.mcpToolNames`.
- Produces: `SpawnAdmissionInput.definitionSource?: AgentSource`; `SpawnError` code `'mcp'`; `admissionExposureCeiling(rootSessionId, workspaceId, definition, candidates, definitionSource?)`.

- [ ] **Step 1: Failing executor tests**

Add to `tests/harness/g4-subagent-contract.spec.ts` inside `describe('child identity and admission ceiling', ...)`:

```ts
  it('inherit role keeps admitted MCP under a built-in-only grant; a missing granted MCP name fails before commit', async () => {
    const harness = await boot(['done'])
    let captured: readonly string[] | undefined
    const service = harness.kernel.ctx.agents
    const create = service.create.bind(service)
    service.create = ((session, identity) => {
      captured = (identity as { childOf?: { toolCeiling?: readonly string[] } } | undefined)?.childOf?.toolCeiling
      return create(session, identity)
    }) as typeof service.create
    const inherit: AgentDefinition = { ...worker, name: 'scout', tools: ['Read', 'Grep'], inheritsTools: true }
    const seen: string[][] = []
    const resolver = async (input: { candidates: readonly string[] }) => {
      seen.push([...input.candidates])
      return ['Read', 'Grep', 'mcp__s__get']
    }
    const handle = await harness.executor.spawn(request(harness, inherit, { exposureCeiling: undefined, admissionResolver: resolver, grantTools: ['Read'] }))
    await settle(harness, handle.childSessionId)
    expect(seen[0]).toEqual(['Read', 'Grep', 'mcp__*'])
    expect(captured).toEqual(['Read', 'mcp__s__get'])

    const before = harness.kernel.ctx.sessions.list?.().length
    await expect(harness.executor.spawn(request(harness, inherit, { exposureCeiling: undefined, admissionResolver: resolver, grantTools: ['mcp__x__y'] })))
      .rejects.toMatchObject({ name: 'SpawnError', code: 'mcp' })
    if (before !== undefined) expect(harness.kernel.ctx.sessions.list?.().length).toBe(before)
    await harness.kernel.stop()
  })
```

(If `sessions.list` does not exist on the harness, drop the two `before` lines; the `rejects` assertion is the requirement.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/harness/g4-subagent-contract.spec.ts -t "inherit role keeps"`
Expected: FAIL — candidates lack `mcp__*`, MCP dropped without grant, no `'mcp'` error.

- [ ] **Step 3: Implement executor**

Imports: `import { roleCandidates, narrowCeiling, missingGrantedMcp } from './mcp-candidates.ts'` and `type AgentSource` from `./definition-service.ts` (already imported types there; add if missing).

`SpawnAdmissionInput` add:

```ts
  /** Provenance of the definition: only the bundled explorer is MCP-free. */
  readonly definitionSource?: AgentSource | undefined
```

`SpawnError` code union: `'capacity' | 'depth' | 'packet' | 'inherit' | 'ownership' | 'mcp'`.

Delete the local `roleCandidates` function (lines 172-181).

Admission (replace lines 655-666):

```ts
    const exposureCeiling = request.admissionResolver !== undefined
      ? await request.admissionResolver({
          workspaceId: request.workspaceId,
          parentSessionId: request.parentSessionId,
          definition: request.definition.name,
          ...(request.definitionSource !== undefined ? { definitionSource: request.definitionSource } : {}),
          candidates: roleCandidates(request.definition, request.definitionSource),
        })
      : request.exposureCeiling
    if (exposureCeiling === undefined) {
      throw new SpawnError('ownership', 'trusted spawn admission authority is required')
    }
    // Ceiling = admission exposure (role candidates, selectors expanded by the
    // host) ∩ grant − disallowed. Computed before any durable state so a
    // missing explicitly-granted MCP tool fails cleanly.
    const toolCeiling = narrowCeiling(exposureCeiling, request.grantTools, request.definition.disallowedTools)
    const missing = missingGrantedMcp(request.grantTools, toolCeiling)
    if (missing.length > 0) {
      throw new SpawnError('mcp', `granted MCP tools are not available to '${request.definition.name}': ${missing.join(', ')} (the role does not list them, the mode does not expose them, or the server is disabled, disconnected or allowlisted out)`)
    }
```

Replace lines 790-802 (the old ceiling block) with nothing — `toolCeiling` is already in scope; keep the `try {` and the `identity` construction that uses it. Update the comment above `identity` to drop "MCP always requires an explicit spawn grant".

Fixture path: callers passing `exposureCeiling: definition.tools` keep working (no selectors there).

- [ ] **Step 4: Implement host wiring (`server.ts`)**

`createExecutionAuthority` deps (line ~2694), add:

```ts
    mcpToolNames: async (workspaceId) => {
      // Spawn admission waits for this workspace's MCP connect, like a root
      // turn's pre-step: a child must not pin an empty set because the
      // servers were still starting.
      await connectWorkspaceMcp(workspaceId as WorkspaceId).catch(() => {})
      const prefix = `${workspaceId}:`
      return [...mcpDescriptors.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    },
```

`admissionExposureCeiling` (line 2698) and its dep type (line 4196):

```ts
  async function admissionExposureCeiling(rootSessionId: SessionId, workspaceId: WorkspaceId, definition: string, candidates: readonly string[], definitionSource?: AgentSource): Promise<readonly string[]> {
    return executionAuthority.admissionCeiling({ workspaceId, rootSessionId, definition, ...(definitionSource !== undefined ? { definitionSource } : {}), candidates })
  }
```

```ts
  readonly admissionExposureCeiling: (rootSessionId: SessionId, workspaceId: WorkspaceId, definition: string, candidates: readonly string[], definitionSource?: AgentSource) => Promise<readonly string[]>
```

Both resolvers (lines 2093 and 5071):

```ts
admissionResolver: ({ parentSessionId, workspaceId, definition, definitionSource, candidates }) => admissionExposureCeiling(parentSessionId, workspaceId, definition, candidates, definitionSource),
```
(and `deps.admissionExposureCeiling(...)` at 5071).

`pinRole` (lines 3680-3685):

```ts
    // A role run has no spawn grant: its ceiling is admission ∩ role
    // candidates − disallowed, the same rule a spawn without a grant gets.
    const exposed = await admissionExposureCeiling(rootId, workspaceId, definition.name, roleCandidates(definition, resolved.source), resolved.source)
    const toolCeiling = narrowCeiling(exposed, undefined, definition.disallowedTools).filter((tool) => tool !== 'Agent')
```

Import `roleCandidates`, `narrowCeiling` from `../harness/agents/mcp-candidates.ts` and `type AgentSource` if not already imported.

HTTP mapping (line 5095):

```ts
send(error.code === 'capacity' ? 429 : error.code === 'packet' || error.code === 'inherit' || error.code === 'mcp' ? 400 : 404, { error: error.message })
```

- [ ] **Step 5: Implement `agent-delegation.ts`**

Lines 456-461:

```ts
  // A built-in grant the role lacks is reported, never silently dropped. MCP
  // names are checked at admission (a missing one fails the spawn).
  const dropped = grantTools?.filter((tool) => !tool.startsWith('mcp__') && !resolved.definition.tools.includes(tool)) ?? []
```

Line 349 sentence end: `'... grantTools only narrows the role, never widens it; roles that inherit tools also get this conversation\'s MCP tools unless grantTools names specific MCP tools.'`

Line 393 description: `'spawn: narrows the role\'s tools; never widens them. Naming any mcp__ tool limits MCP to those names'`

- [ ] **Step 6: Run affected tests**

Run: `pnpm vitest run tests/harness/g4-subagent-contract.spec.ts tests/harness/g4-agents.spec.ts tests/harness/mcp-candidates.spec.ts tests/harness/executor-review-fixes.spec.ts tests/harness/child-progress-executor.spec.ts tests/harness/subagent-stability.spec.ts tests/web/server-g4.spec.ts`
Expected: PASS. If an existing assertion encoded "MCP requires a grant", update it to the new rule and note it in the commit body.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/harness/agents/executor.ts src/web/server.ts src/web/agent-delegation.ts tests/harness/g4-subagent-contract.spec.ts
git commit -m "feat(agents): children inherit parent MCP tools; fail fast on missing granted MCP"
```

---

### Task 5: Real-host end-to-end coverage

**Files:**
- Modify: `tests/web/permission-hardening.spec.ts:482-603`

**Interfaces:**
- Consumes: everything above through the real `createWebServer`; fixture MCP server `tests/fixtures/mcp-stdio-server.mjs` exposes `query` (readOnlyHint), `interactive`, `explode`, `hang`.

- [ ] **Step 1: Extend `runChild`**

Add role fixtures next to `MCP_WORKER_ROLE`:

```ts
const SCOUT_ROLE = ['---', 'description: "Inherits every tool"', '---', 'Find things.'].join('\n')
const EXPLORER_OVERRIDE_ROLE = ['---', 'description: "Explorer with the fixture MCP"', 'tools: Read, Glob, Grep, mcp__fixture__*', '---', 'Explore.'].join('\n')
const NO_MCP_ROLE = ['---', 'description: "Inherits but refuses MCP"', 'disallowedTools: mcp__*', '---', 'Work.'].join('\n')
const ROLE_FILES: Record<string, string> = {
  'mcp-worker': MCP_WORKER_ROLE, scout: SCOUT_ROLE, explorer: EXPLORER_OVERRIDE_ROLE, 'no-mcp': NO_MCP_ROLE,
}
```

Change the signature and import step:

```ts
async function runChild(options: {
  rootMode: string
  role: 'mcp-worker' | 'explorer' | 'scout' | 'no-mcp'
  /** Import the explorer override instead of using the bundled role. */
  overrideExplorer?: boolean
  grantTools?: string[]
  calls: { id: string; name: string; args: Record<string, unknown> }[]
  switchRootTo?: string
  allowedTools?: string[]
  expectStatus?: number
}): Promise<ChildRun & { status: number; error?: string }> {
```

- `bootPlan(provider, options.allowedTools, ...)`.
- Import when `options.role !== 'explorer' || options.overrideExplorer === true`: `post(.../agents/${options.role}/import, { dialect: 'dnt-harness', content: ROLE_FILES[options.role] })` expecting 201.
- Spawn body: `...(options.grantTools !== undefined ? { grantTools: options.grantTools } : {})`.
- If `spawned.status !== 202`: return `{ schemas: [], outputs: {}, effects: '', status: spawned.status, error: (await spawned.json()).error }` (assert `expectStatus` in the test).
- Otherwise return the existing result with `status: 202`.

Existing three tests: add nothing but keep passing (explorer test uses bundled; `grantTools` still passed).

- [ ] **Step 2: Add tests**

```ts
  it('inherit role, no grant, full access: the child sees and runs the parent MCP tool', async () => {
    const run = await runChild({ rootMode: 'full-access', role: 'scout', calls: [QUERY_CALL] })
    expect(run.schemas).toContain('mcp__fixture__query')
    expect(run.outputs['fab-mcp']).toMatch(/result:x/)
  }, 40_000)

  it('inherit role with a built-in-only grant keeps MCP', async () => {
    const run = await runChild({ rootMode: 'full-access', role: 'scout', grantTools: ['Read'], calls: [QUERY_CALL] })
    expect(run.schemas).toContain('mcp__fixture__query')
    expect(run.schemas).not.toContain('Write')
  }, 40_000)

  it('a grant naming one MCP tool keeps only that MCP tool', async () => {
    const run = await runChild({ rootMode: 'full-access', role: 'scout', grantTools: ['Read', 'mcp__fixture__explode'], calls: [QUERY_CALL] })
    expect(run.schemas).toContain('mcp__fixture__explode')
    expect(run.schemas).not.toContain('mcp__fixture__query')
    expect(run.outputs['fab-mcp']).toMatch(/^denied: agent 'scout' does not expose 'mcp__fixture__query' \(definition ceiling\)/)
  }, 40_000)

  it('Plan root: inherit role spawns with only read-safe allowlisted MCP and widening does not add more', async () => {
    const run = await runChild({
      rootMode: 'plan', role: 'scout', allowedTools: ['query', 'explode'],
      calls: [{ id: 'fab-explode', name: 'mcp__fixture__explode', args: {} }], switchRootTo: 'full-access',
    })
    expect(run.status).toBe(202)
    expect(run.schemas).toContain('mcp__fixture__query')
    expect(run.schemas).not.toContain('mcp__fixture__explode')
    expect(run.outputs['fab-explode']).toMatch(/definition ceiling/)
  }, 40_000)

  it('explorer override with mcp__fixture__* gets MCP; disallowedTools mcp__* strips it', async () => {
    const override = await runChild({ rootMode: 'full-access', role: 'explorer', overrideExplorer: true, calls: [QUERY_CALL] })
    expect(override.schemas).toContain('mcp__fixture__query')
    expect(override.schemas).not.toContain('Write')
    const refused = await runChild({ rootMode: 'full-access', role: 'no-mcp', calls: [QUERY_CALL] })
    expect(refused.schemas.some((name) => name.startsWith('mcp__'))).toBe(false)
  }, 60_000)

  it('a granted MCP name the child cannot get fails the spawn with 400', async () => {
    const run = await runChild({ rootMode: 'full-access', role: 'mcp-worker', grantTools: ['Read', 'mcp__fixture__explode'], calls: [] })
    expect(run.status).toBe(400)
    expect(run.error).toMatch(/granted MCP tools are not available to 'mcp-worker': mcp__fixture__explode/)
  }, 40_000)
```

Update the existing Plan test (line 580) expectation: with `grantTools: ['Read', 'mcp__fixture__query']` and no allowlist under Plan, `query` is not admitted, so the spawn now fails fast. Change it to:

```ts
  it('Plan root: an explicit MCP grant the mode does not expose fails the spawn instead of pinning a ceiling without it', async () => {
    const run = await runChild({ rootMode: 'plan', role: 'mcp-worker', grantTools: ['Read', 'mcp__fixture__query'], calls: [QUERY_CALL] })
    expect(run.status).toBe(400)
    expect(run.error).toMatch(/mcp__fixture__query/)
  }, 40_000)
```

The widening-after-pin invariant stays covered by the new Plan test above.

- [ ] **Step 3: Run**

Run: `pnpm vitest run tests/web/permission-hardening.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/web/permission-hardening.spec.ts
git commit -m "test(agents): real-host coverage for inherited subagent MCP"
```

---

### Task 6: Docs, full verification

**Files:**
- Modify: `docs/capabilities.md:254-268`, `docs/claude-format.md:173-178`, comments in `src/harness/agent/scope.ts:44`, `src/web/server.ts:3037-3040`

- [ ] **Step 1: `docs/capabilities.md`** — replace the "No authority gained" bullet's ceiling sentence with:

```md
- **No authority gained**: a child's own calls re-enter the owning root's live
  mode exposure and approval policy. Its immutable admission ceiling is pinned
  at spawn as admission exposure ∩ role tools − `disallowedTools`, narrowed by
  the spawn grant; later mode widening cannot add tools, while later narrowing
  denies unstarted calls.
- **MCP in children**: a role that omits `tools` (or uses `*`) inherits every
  MCP tool the parent sees at spawn, limited by `mcpServers` when set. A role
  with explicit `tools` gets only the `mcp__server__tool` / `mcp__server__*`
  entries it lists. `grantTools` narrows MCP only when it names an MCP tool;
  a concrete granted MCP name the child cannot get fails the spawn.
  `disallowedTools` accepts `mcp__server__*` and `mcp__*`. The bundled
  Explorer has no MCP; override it with an `explorer.md` that lists the MCP
  tools it may use (for example `mcp__codebase-retrieval__*`).
```

- [ ] **Step 2: `docs/claude-format.md`** — replace "MCP tools still need an explicit spawn grant, which such a role accepts." with "such a role also inherits the parent's MCP tools (`mcpServers` limits them to named servers)." and add a bullet: ``- `mcpServers`: comma string or list of server names; limits an inheriting role's MCP tools.``

- [ ] **Step 3: Comments** — `scope.ts:44`: `/** Hard ceiling: admission exposure ∩ role candidates − disallowed, narrowed by the spawn grant. */`. `server.ts:3037-3040`: `// (zero-exposure modes none; Plan read-safe allowlist only; bundled Explorer none; children limited to their pinned ceiling).`

- [ ] **Step 4: Full verification**

Run: `pnpm test`
Expected: all pass, except tests already listed as flaky in project memory (`core-review-fixes-2026-10-08`); report any failure with its name.

Run: `pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/capabilities.md docs/claude-format.md src/harness/agent/scope.ts src/web/server.ts
git commit -m "docs(agents): document inherited subagent MCP"
```
