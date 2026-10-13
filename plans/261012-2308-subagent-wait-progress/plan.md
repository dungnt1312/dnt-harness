# Subagent Wait Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the root model from cancelling healthy subagents by letting `Agent wait` block for minutes and by telling it, for every running child, how long it has run, what it is doing and whether it is healthy.

**Architecture:** A pure function `describeProgress` derives a `ChildProgress` (elapsed time, step/tool counts, last activity, health) from a child's live session log and the harness stream limits. `ChildExecutor.withResult` attaches it to every running `ChildHandle`. The `Agent` tool raises its wait ceiling from 120 s to 30 min (default 5 min), rewrites its description to match the code, and turns the bare "call wait again" note into one derived from `progress.health`. No new abort path: the model-request watchdog already exists in `LogicalRequest` (`src/harness/agent/agent.ts:616`); this plan only makes its state visible.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Vitest, pnpm.

**Spec:** Conversation research of 2026-10-12 (no separate spec file). Evidence: `src/web/agent-delegation.ts:266-267,335,505,519`; `src/harness/agents/executor.ts:127-147,864-899,1496-1507`; `src/harness/limits.ts:65-85`. Reference designs: Codex `wait_agent` (`codex-rs/core/src/config/mod.rs:256-258`, min 10 s / default 30 s / max 1 h, "Prefer longer waits (minutes) to avoid busy polling"); ZCode `createSubagentActivityWatchdog` (`subagent/runner.ts:1194`, host decides inactivity, 600 s) and Agent tool `timeout: { kind: "none" }`.

## Global Constraints

- Use pnpm. Run affected tests first, then `pnpm test` and `pnpm run typecheck`. The web surface is not touched, so `pnpm run build:web` is not required.
- The HTTP lifecycle route `GET …/children/:id?waitMs=` keeps its 120 s cap (`src/web/server.ts:5099`); only the model-facing tool changes.
- `ChildHandle` changes are additive (new optional `progress`); `awaitingApproval` stays for existing consumers.
- No new auto-cancel or abort behavior. Health is advisory information for the model.
- Thresholds come from `HarnessLimits` (`streamFirstEventMs` 600 000, `streamIdleMs` 300 000, `bashMaxWaitMs` 600 000), resolved through `resolveLimits(ctx.get('limits'))` exactly like `Agent.limits()`.
- Tool wait constants: `DEFAULT_WAIT_MS = 300_000`, `MAX_WAIT_MS = 1_800_000`.

## Review Focus

1. A child still `queued`/`dispatching` (no events beyond spawn metadata) must report `lastActivity.kind: 'start'` and `health: 'active'`, not `stalled`. Pinned in Task 1.
2. A child running a long Bash or other tool (open `tool/call`, no `tool/result`) for 4 minutes must stay `active`, because tools are bounded by their own limits, not the stream idle limit. Pinned in Task 1.
3. A model request still waiting for its first token after 6 minutes is `slow`, not `stalled` (first-event limit is 10 min). Pinned in Task 1.
4. A wait with no `timeoutMs` must not block the model for 30 min; it uses the 5 min default, and a user Stop still ends it at once (existing signal path). Pinned in Task 3.
5. Completed, failed and cancelled handles must not carry `progress` (it would contradict the final status). Pinned in Task 2.

---

### Task 1: Pure progress derivation

**Files:**
- Create: `src/harness/agents/child-progress.ts`
- Test: `tests/harness/child-progress.spec.ts`

**Interfaces:**
- Consumes: `SessionEvent` from `src/harness/session/events.ts`; `HarnessLimits` from `src/harness/limits.ts`.
- Produces:
  ```ts
  export type ChildHealth = 'active' | 'slow' | 'stalled' | 'awaiting-approval'
  export interface ChildActivity { readonly kind: 'start' | 'model' | 'tool' | 'approval'; readonly name?: string; readonly sinceMs: number }
  export interface ChildProgress { readonly elapsedMs: number; readonly steps: number; readonly toolCalls: number; readonly lastActivity: ChildActivity; readonly health: ChildHealth }
  export type ProgressLimits = Pick<HarnessLimits, 'streamFirstEventMs' | 'streamIdleMs' | 'bashMaxWaitMs'>
  export function describeProgress(events: readonly SessionEvent[], startedAt: number, now: number, limits: ProgressLimits): ChildProgress
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/harness/child-progress.spec.ts
import { describe, expect, it } from 'vitest'
import { describeProgress } from '../../src/harness/agents/child-progress.ts'

const limits = { streamFirstEventMs: 600_000, streamIdleMs: 300_000, bashMaxWaitMs: 600_000 }
const MIN = 60_000
let seq = 0
const ev = (timestamp: number, body: Record<string, unknown>) => ({ v: 1, seq: ++seq, timestamp, ...body }) as never

describe('describeProgress', () => {
  it('a child with no work yet is active from its start', () => {
    const p = describeProgress([], 0, 30_000, limits)
    expect(p).toMatchObject({ elapsedMs: 30_000, steps: 0, toolCalls: 0, lastActivity: { kind: 'start', sinceMs: 30_000 }, health: 'active' })
  })

  it('counts steps and tool calls and names an open tool', () => {
    const events = [
      ev(1_000, { type: 'step/start', turnId: 't', stepId: 's1' }),
      ev(2_000, { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Grep', args: {} } }),
      ev(3_000, { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: '' }),
      ev(4_000, { type: 'step/start', turnId: 't', stepId: 's2' }),
      ev(5_000, { type: 'tool/call', stepId: 's2', call: { id: 'c2', name: 'Bash', args: {} } }),
    ]
    const p = describeProgress(events, 0, 5_000 + 4 * MIN, limits)
    expect(p.steps).toBe(2)
    expect(p.toolCalls).toBe(2)
    // A long tool is bounded by its own limits, not the stream idle limit.
    expect(p.lastActivity).toEqual({ kind: 'tool', name: 'Bash', sinceMs: 4 * MIN })
    expect(p.health).toBe('active')
  })

  it('a model request waiting for its first token is judged against the first-event limit', () => {
    const events = [ev(0, { type: 'model/attempt', fact: { state: 'start' } })]
    expect(describeProgress(events, 0, 4 * MIN, limits).health).toBe('active')
    expect(describeProgress(events, 0, 6 * MIN, limits)).toMatchObject({ lastActivity: { kind: 'model', sinceMs: 6 * MIN }, health: 'slow' })
    expect(describeProgress(events, 0, 11 * MIN, limits).health).toBe('stalled')
  })

  it('a streaming model request is judged from its last chunk against the idle limit', () => {
    const events = [
      ev(0, { type: 'model/attempt', fact: { state: 'start' } }),
      ev(10 * MIN, { type: 'assistant/chunk', stepId: 's', delta: 'x' }),
    ]
    expect(describeProgress(events, 0, 11 * MIN, limits)).toMatchObject({ lastActivity: { kind: 'model', sinceMs: MIN }, health: 'active' })
    expect(describeProgress(events, 0, 13 * MIN, limits).health).toBe('slow')
    expect(describeProgress(events, 0, 16 * MIN, limits).health).toBe('stalled')
  })

  it('a closed model attempt no longer counts as model activity', () => {
    const events = [
      ev(0, { type: 'model/attempt', fact: { state: 'start' } }),
      ev(MIN, { type: 'model/attempt', fact: { state: 'end' } }),
    ]
    expect(describeProgress(events, 0, 2 * MIN, limits).lastActivity).toEqual({ kind: 'start', sinceMs: MIN })
  })

  it('an undecided approval wins over everything else', () => {
    const events = [
      ev(0, { type: 'tool/call', stepId: 's', call: { id: 'c', name: 'Bash', args: {} } }),
      ev(MIN, { type: 'approval/request', approvalId: 'a1', call: { id: 'c', name: 'Bash', args: {} } }),
    ]
    expect(describeProgress(events, 0, 20 * MIN, limits)).toMatchObject({ lastActivity: { kind: 'approval', name: 'Bash' }, health: 'awaiting-approval' })
    const decided = [...events, ev(2 * MIN, { type: 'approval/decision', approvalId: 'a1', decision: 'allow' })]
    expect(describeProgress(decided, 0, 3 * MIN, limits).health).toBe('active')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/harness/child-progress.spec.ts`
Expected: FAIL, cannot resolve `../../src/harness/agents/child-progress.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/harness/agents/child-progress.ts
/**
 * What a running child is doing, derived from its live log alone. Advisory:
 * the parent model reads it to tell a slow child from a stuck one. Stream
 * thresholds mirror the limits the request watchdog (`LogicalRequest`)
 * already enforces, so `stalled` means "about to be aborted by the host".
 */
import type { SessionEvent } from '../session/events.ts'
import type { HarnessLimits } from '../limits.ts'

export type ChildHealth = 'active' | 'slow' | 'stalled' | 'awaiting-approval'
export interface ChildActivity { readonly kind: 'start' | 'model' | 'tool' | 'approval'; readonly name?: string; readonly sinceMs: number }
export interface ChildProgress {
  readonly elapsedMs: number
  readonly steps: number
  readonly toolCalls: number
  readonly lastActivity: ChildActivity
  readonly health: ChildHealth
}
export type ProgressLimits = Pick<HarnessLimits, 'streamFirstEventMs' | 'streamIdleMs' | 'bashMaxWaitMs'>

export function describeProgress(events: readonly SessionEvent[], startedAt: number, now: number, limits: ProgressLimits): ChildProgress {
  let steps = 0
  let toolCalls = 0
  let lastAt = startedAt
  const openTools = new Map<string, { name: string; at: number }>()
  const pendingApprovals = new Map<string, string>()
  let model: { startedAt: number; progressAt?: number } | undefined
  for (const event of events) {
    lastAt = Math.max(lastAt, event.timestamp)
    switch (event.type) {
      case 'step/start': steps++; break
      case 'tool/call': toolCalls++; openTools.set(event.call.id, { name: event.call.name, at: event.timestamp }); break
      case 'tool/result': openTools.delete(event.callId); break
      case 'model/attempt': model = event.fact.state === 'start' ? { startedAt: event.timestamp } : undefined; break
      case 'assistant/chunk': if (model !== undefined) model.progressAt = event.timestamp; break
      case 'approval/request': pendingApprovals.set(event.approvalId, event.call.name); break
      case 'approval/decision': pendingApprovals.delete(event.approvalId); break
      default: break
    }
  }
  const elapsedMs = Math.max(0, now - startedAt)
  const base = { elapsedMs, steps, toolCalls }
  const approval = [...pendingApprovals.values()].at(-1)
  if (approval !== undefined) {
    return { ...base, lastActivity: { kind: 'approval', name: approval, sinceMs: now - lastAt }, health: 'awaiting-approval' }
  }
  let lastActivity: ChildActivity
  let threshold: number
  const tool = [...openTools.values()].at(-1)
  if (tool !== undefined) {
    lastActivity = { kind: 'tool', name: tool.name, sinceMs: now - tool.at }
    threshold = limits.bashMaxWaitMs
  } else if (model !== undefined) {
    lastActivity = { kind: 'model', sinceMs: now - (model.progressAt ?? model.startedAt) }
    threshold = model.progressAt === undefined ? limits.streamFirstEventMs : limits.streamIdleMs
  } else {
    lastActivity = { kind: 'start', sinceMs: now - lastAt }
    threshold = limits.streamIdleMs
  }
  const health: ChildHealth = lastActivity.sinceMs >= threshold ? 'stalled' : lastActivity.sinceMs >= threshold / 2 ? 'slow' : 'active'
  return { ...base, lastActivity, health }
}
```

If typecheck reports that a narrowed event type lacks a field used above (for example `approval/decision` or `assistant/chunk`), read its declaration in `src/harness/session/events.ts` and use the declared field names; do not cast to `any`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/harness/child-progress.spec.ts && pnpm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/harness/agents/child-progress.ts tests/harness/child-progress.spec.ts
git commit -m "feat(agents): derive running-child progress and health from its log"
```

---

### Task 2: Attach progress to running child handles

**Files:**
- Modify: `src/harness/agents/executor.ts` (imports near line 17-24; `ChildHandle` at 127-147; `withResult` return object at 1496-1507; add a private `limits()` helper in `ChildExecutor`)
- Modify: `src/index.ts:243` (the barrel that re-exports `ChildHandle`), to also export `ChildProgress`, `ChildHealth` from `./harness/agents/child-progress.ts`
- Test: `tests/harness/child-progress-executor.spec.ts`

**Interfaces:**
- Consumes: `describeProgress`, `ChildProgress` from Task 1; `resolveLimits`, `HarnessLimits` from `src/harness/limits.ts`.
- Produces: `ChildHandle.progress?: ChildProgress`, present only when `status === 'running'`.

- [ ] **Step 1: Write the failing test**

Reuse the boot pattern of `tests/harness/executor-review-fixes.spec.ts:44-87` (a `Read` tool that blocks until aborted keeps the child running).

```ts
// tests/harness/child-progress-executor.spec.ts
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentsService, ChildExecutor, Kernel, LlmService, ToolsService, WorkspaceService, bundledDefinition, fileSessions } from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

let home = ''
beforeAll(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-child-progress-')) })
afterAll(async () => { await fs.rm(home, { recursive: true, force: true }) })

async function boot() {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  const ws = new WorkspaceService(home)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm([{ toolCalls: [{ name: 'Read', args: {} }] }, { text: 'done' }]))
  kernel.ctx.tools.register({
    name: 'Read', description: 'gate', requiresRoot: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, exec) {
      await new Promise<void>((resolve) => {
        if (exec.signal?.aborted === true) resolve()
        else exec.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'read'
    },
  })
  const root = kernel.ctx.sessions.create(ws.defaultWorkspace)
  return { kernel, executor: new ChildExecutor(kernel.ctx), workspaceId: ws.defaultWorkspace as never, rootSessionId: root.id as never }
}

describe('running child handles carry progress', () => {
  it('reports the open tool while running and drops progress once settled', async () => {
    const h = await boot()
    const worker = bundledDefinition('worker')
    const spawned = await h.executor.spawn({
      workspaceId: h.workspaceId, parentSessionId: h.rootSessionId, parentTurnId: 'turn-1',
      definition: worker, exposureCeiling: worker.tools,
      packet: { prompt: 'Inspect the repository.', requiredResult: 'a short answer' },
    })
    let [running] = await h.executor.wait(h.workspaceId, [spawned.childSessionId], { timeoutMs: 50 })
    for (let i = 0; i < 40 && running?.progress?.lastActivity.kind !== 'tool'; i++) {
      ;[running] = await h.executor.wait(h.workspaceId, [spawned.childSessionId], { timeoutMs: 25 })
    }
    expect(running?.status).toBe('running')
    expect(running?.progress).toMatchObject({ toolCalls: 1, lastActivity: { kind: 'tool', name: 'Read' }, health: 'active' })
    expect(running?.progress?.elapsedMs).toBeGreaterThanOrEqual(0)

    const cancelled = await h.executor.cancel(h.workspaceId, spawned.childSessionId)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.progress).toBeUndefined()
  })
})
```

If `FakeScriptedLlm`'s step shape differs from `{ toolCalls }` / `{ text }`, copy the exact shape used in `tests/harness/executor-review-fixes.spec.ts:137` and `tests/support/fake-llm.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/harness/child-progress-executor.spec.ts`
Expected: FAIL, `running.progress` is `undefined`.

- [ ] **Step 3: Implement**

In `src/harness/agents/executor.ts`:

```ts
// imports
import { describeProgress, type ChildProgress } from './child-progress.ts'
import { resolveLimits, type HarnessLimits } from '../limits.ts'
```

In `interface ChildHandle`, after `awaitingApproval`:

```ts
  /**
   * Running children only: elapsed time, step/tool counts, last activity and
   * advisory health, so a caller can tell a slow child from a stuck one.
   */
  readonly progress?: ChildProgress
```

In `class ChildExecutor`, add next to the other private helpers:

```ts
  private limits(): HarnessLimits {
    return resolveLimits((this.ctx.get('limits') ?? {}) as Partial<HarnessLimits>)
  }
```

In `withResult`'s returned object, after the `awaitingApproval` line:

```ts
      ...(child.status === 'running' ? { progress: describeProgress(child.events, child.startedAt, Date.now(), this.limits()) } : {}),
```

Re-export `ChildProgress` and `ChildHealth` from the same barrel that exports `ChildHandle`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/harness/child-progress-executor.spec.ts tests/harness/executor-review-fixes.spec.ts tests/harness/g4-subagent-contract.spec.ts tests/harness/subagent-stability.spec.ts && pnpm run typecheck`
Expected: PASS. If a snapshot or `toEqual` on a running handle now fails because of the new `progress` field, change that assertion to `toMatchObject` rather than stripping the field.

- [ ] **Step 5: Commit**

```bash
git add src/harness/agents/executor.ts src/index.ts tests/harness/child-progress-executor.spec.ts
git commit -m "feat(agents): attach progress and health to running child handles"
```

---

### Task 3: Long waits, honest description, progress-driven note in the Agent tool

**Files:**
- Modify: `src/web/agent-delegation.ts` (constants at 265-267; description at 335 and 337; `timeoutMs` parameter at 391; `wait` note at 512-522)
- Modify: `docs/capabilities.md:192`, `docs/harness.md:816`
- Test: `tests/harness/subagent-stability.spec.ts` (extend `describe('the Agent tool wait')` at 440-495)

**Interfaces:**
- Consumes: `ChildHandle.progress` from Task 2.
- Produces: tool constants `DEFAULT_WAIT_MS = 300_000`, `MAX_WAIT_MS = 1_800_000`; exported pure `runningNote(running: readonly ChildHandle[]): string` (exported for tests).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('the Agent tool wait', …)` in `tests/harness/subagent-stability.spec.ts`:

```ts
  const running = (progress: Record<string, unknown>) => ({ ...done, status: 'running', result: undefined, progress })

  it('uses a five minute default and a thirty minute ceiling', async () => {
    const seen: number[] = []
    const tool = toolWith({
      runningChildrenOfRoot: () => ['child-1'],
      wait: async (_ws: string, _ids: unknown[], options: { timeoutMs: number }) => { seen.push(options.timeoutMs); return [] },
    })
    await inTurn(() => tool.execute({ action: 'wait' }, {} as never))
    await inTurn(() => tool.execute({ action: 'wait', timeoutMs: 99 * 60_000 }, {} as never))
    expect(seen).toEqual([300_000, 1_800_000])
  })

  it('tells the model a healthy running child is normal and should be waited on', async () => {
    const tool = toolWith({
      runningChildrenOfRoot: () => ['child-1'],
      wait: async () => [running({ elapsedMs: 14 * 60_000, steps: 9, toolCalls: 21, lastActivity: { kind: 'model', sinceMs: 40_000 }, health: 'active' })],
    })
    const out = JSON.parse(String(await inTurn(() => tool.execute({ action: 'wait' }, {} as never))))
    expect(out.note).toMatch(/making progress/)
    expect(out.note).toMatch(/do not cancel/i)
    expect(out.children[0].progress.health).toBe('active')
  })

  it('names a stalled child and leaves the decision to the model', async () => {
    const tool = toolWith({
      runningChildrenOfRoot: () => ['child-1'],
      wait: async () => [running({ elapsedMs: 30 * 60_000, steps: 3, toolCalls: 2, lastActivity: { kind: 'model', sinceMs: 9 * 60_000 }, health: 'stalled' })],
    })
    const out = JSON.parse(String(await inTurn(() => tool.execute({ action: 'wait' }, {} as never))))
    expect(out.note).toMatch(/child-1/)
    expect(out.note).toMatch(/no progress for 9m/)
  })

  it('keeps the approval note when a child is parked on an approval', async () => {
    const tool = toolWith({
      runningChildrenOfRoot: () => ['child-1'],
      wait: async () => [{ ...running({ elapsedMs: 0, steps: 1, toolCalls: 1, lastActivity: { kind: 'approval', name: 'Bash', sinceMs: 0 }, health: 'awaiting-approval' }), awaitingApproval: true }],
    })
    const out = JSON.parse(String(await inTurn(() => tool.execute({ action: 'wait' }, {} as never))))
    expect(out.note).toMatch(/waiting for the user to answer an approval/)
  })

  it('describes the real wait contract', () => {
    const tool = toolWith({ runningChildrenOfRoot: () => [] })
    const description = inTurn(() => (tool.schema?.() as { description: string }).description)
    expect(description).not.toMatch(/blocks until they settle/)
    expect(description).toMatch(/prefer long waits/i)
  })
```

`ToolDefinition.schema` is optional (`src/harness/tools/types.ts:110`), hence the `?.()`; the Agent tool always defines it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/harness/subagent-stability.spec.ts -t "Agent tool wait"`
Expected: the new cases FAIL (default 30 000, ceiling 120 000, old note and description).

- [ ] **Step 3: Implement**

Constants (replace lines 265-267):

```ts
/**
 * Longest a single model-facing `wait` may block. Long on purpose: a wait
 * returns as soon as its children settle, and short caps teach the model to
 * poll and then cancel healthy work. The HTTP route keeps its own 120 s cap.
 */
const MAX_WAIT_MS = 30 * 60_000
const DEFAULT_WAIT_MS = 5 * 60_000
```

Description: replace the sentence at line 335 with:

```ts
      'spawn returns immediately, so several children run at the same time. wait blocks until the named children settle or timeoutMs passes (default 5 min, max 30 min), whichever is first; prefer long waits over repeated short ones. A wait that times out only means the work is not finished: each running child reports progress (elapsed time, steps, last activity, health). Reviews and research often take 10 to 30 minutes. Cancel only a child whose health is "stalled" or whose work you no longer need; cancelling and respawning loses its context.',
```

Parameter (line 391):

```ts
    timeoutMs: { type: 'number', description: `wait: longest to block in ms; returns early when the children settle. Default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}. Prefer minutes to avoid busy polling.` },
```

Note helper (add above `async function wait`):

```ts
const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}m`

/** The note a wait returns while children are still running, from their health. */
export function runningNote(running: readonly ChildHandle[]): string {
  if (running.some((child) => child.awaitingApproval === true)) {
    return 'a child is waiting for the user to answer an approval; wait again or cancel it'
  }
  const stalled = running.filter((child) => child.progress?.health === 'stalled')
  if (stalled.length > 0) {
    return stalled
      .map((child) => `${child.childSessionId} shows no progress for ${minutes(child.progress!.lastActivity.sinceMs)} (${child.progress!.lastActivity.kind}); the host aborts a stalled model request and retries on its own`)
      .join('; ') + '. Wait once more; cancel only if it is still stalled or no longer needed.'
  }
  return 'still running and making progress; this is normal for long tasks. Do not cancel: wait again with a longer timeoutMs, or keep working and the reports will arrive when your turn would close.'
}
```

In `wait`, replace the conditional note (lines 515-521) with:

```ts
    ...(running.length > 0 ? { note: runningNote(running) } : {}),
```

Docs: in `docs/capabilities.md:192` and `docs/harness.md:816`, replace "capped at 120 s" with "default 5 min, capped at 30 min; running children report `progress` with an advisory `health`; the HTTP route keeps a 120 s cap". Keep the rest of each sentence.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/harness/subagent-stability.spec.ts tests/web/agent-tool-ownership.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts tests/web/server-model-alias-spawn.spec.ts tests/web/manual-delegation-turn.spec.ts && pnpm run typecheck`
Expected: PASS. A test that calls `wait` without `timeoutMs` against a child that never settles would now block 5 minutes; if one times out, give that call an explicit small `timeoutMs`, do not lower the default.

- [ ] **Step 5: Full verification and commit**

Run: `pnpm test && pnpm run typecheck`
Expected: PASS, apart from the known pre-existing flaky tests recorded in project memory `core-review-fixes-2026-10-08.md`; report any other failure.

```bash
git add src/web/agent-delegation.ts tests/harness/subagent-stability.spec.ts docs/capabilities.md docs/harness.md
git commit -m "feat(agent-tool): long waits and progress-driven notes for running children"
```

---

## Out of scope (follow-ups)

- Warning or policy when the model cancels a child whose health is `active` (proposal P4), plus telemetry of such cancels.
- Showing elapsed time and last activity on the web "Agent · wait" row (proposal P5).
- Steering a running child with a message instead of cancel-and-respawn (ZCode `SendMessage`, Codex `send_message`/`interrupt_agent`).
- Returning from `wait` when the first of several children settles (Codex mailbox semantics).

## Unresolved questions

1. Is 30 min the right ceiling, or should it match `delegationJoinMs` from the resolved limits (also 30 min by default, but user-configurable)?
2. Is there a host-level per-tool timeout that would cut a 30 min `Agent wait` short? A search of `src/kernel` found none, and the Agent tool receives only the Stop signal, but Task 3 should confirm this with a real long wait during manual testing.
