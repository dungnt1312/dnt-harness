# Environment Panel + Background Processes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This session executes INLINE (user directive: no subagents, direct TDD).

**Goal:** Ship the dntspace-style Environment panel (git / subagents / background processes, pinned above the transcript) on top of a real background-process backend: `Bash run_in_background`, a host-owned ProcessRegistry, `BashOutput`/`KillShell` tools, durable `process/*` session events, and two REST routes.

**Architecture:** ProcessRegistry owns spawned children per session (caps, 64KB head-capped ring, tree-kill via the existing `killTree`); it fires `onStart`/`onExit` callbacks that the web server bridges into durable session events. The model reads/kills via two new closure-wired tools scoped by `exec.sessionId`. The panel derives its lists from the same session events the stream already carries and reconciles live state with one GET; Stop hits one POST.

**Tech Stack:** Node/TS (ESM, `.ts` imports, `exactOptionalPropertyTypes`), vitest, React 19 + Tailwind tokens, lucide icons via `web/components/common/Icon.tsx`.

**Spec:** `docs/superpowers/specs/2026-10-01-environment-panel-background-processes-design.md`

## Global Constraints

- Tool names are Claude-first, exact: `BashOutput`, `KillShell`; Bash arg exact: `run_in_background`.
- Caps: 8 running per session, 24 host-global; no queueing, actionable error strings.
- Ring buffer: 64,000 chars head-capped, stop-capture + truncation note (no unbounded growth).
- Background processes ignore `exec.signal` and `timeoutMs`; they still pass the full approval waterfall (no code change needed — same tool name `Bash`).
- No `ToolExecution` extension: tools close over the registry and scope by `exec.sessionId`.
- `process/exit.termination` vocabulary: `exited` (own exit) / `killed` (KillShell or operator Stop) / `failed` (child error event) / `interrupted` (found open at first read after a restart).
- REST: `GET …/processes` (live reconciliation), `POST …/processes/:id/stop` → 200 killed / 404 unknown session or id / 409 already ended.
- Web tsconfig has `exactOptionalPropertyTypes`: optional props use conditional spread `...(x !== undefined ? { x } : {})`, never `x={undefined}`.
- Semantic color tokens only (`text-ok`, `text-bad`, `text-warn`, `text-fg-muted`); UI primitives from `web/components/ui/` + `web/components/common/`.
- Tests: vitest (`npx vitest run <file>`); every task ends green before commit. Never `git add` files this plan didn't create/modify (the tree carries foreign WIP).
- Session delete kills the session's processes and emits NO exit events (the log is being deleted).

---

### Task 1: ProcessRegistry

**Files:**
- Create: `src/harness/processes/registry.ts`
- Modify: `src/capabilities/shell/bash.ts` (export `killTree`)
- Test: `tests/harness/processes/registry.spec.ts`

**Interfaces:**
- Produces: `class ProcessRegistry`, `type ProcessStatus`, `type ProcessTermination`, `interface ProcessSnapshot`; methods `tryRegister`, `read`, `kill`, `isRunning`, `runningCount`, `snapshot`, `dispose`, `disposeAll`. Consumed by Tasks 3, 4, 5.
- Consumes: `killTree(child, shell, treeTag)` from `bash.ts` (currently module-private — export it without changing its body).

- [ ] **Step 1: Write the failing test**

```ts
// tests/harness/processes/registry.spec.ts
import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { ProcessRegistry, type ProcessRecord } from '../../../src/harness/processes/registry.ts'

const SHELL = process.platform === 'win32' ? 'bash' : '/bin/sh'

/** A child that stays alive until killed; resolves on close. */
function spawnSleeper(): { child: ChildProcess; closed: Promise<void> } {
  const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'sleep 30'] : ['-c', 'sleep 30'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  return { child, closed }
}

function fakeSession(id: string): never {
  return id as never
}

describe('ProcessRegistry', () => {
  it('registers, exposes a snapshot, and finalizes on natural exit with termination exited', async () => {
    const exits: ProcessRecord[] = []
    const registry = new ProcessRegistry({ onExit: (record) => exits.push({ ...record }) })
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'echo hi'] : ['-c', 'echo hi'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'echo hi', cwd: process.cwd(), child, executable: SHELL, treeTag: 'tag-1' })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) throw new Error('unreachable')
    expect(registry.isRunning(fakeSession('s1'), admitted.record.id)).toBe(true)
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    await Promise.resolve()
    expect(exits.at(-1)?.status).toBe('exited')
    expect(exits.at(-1)?.exitCode).toBe(0)
    expect(registry.read(fakeSession('s1'), admitted.record.id)?.output).toContain('hi')
  })

  it('kill() tree-kills and reports termination killed', async () => {
    const exits: ProcessRecord[] = []
    const registry = new ProcessRegistry({ onExit: (record) => exits.push({ ...record }) })
    const { child, closed } = spawnSleeper()
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: 'tag-2' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    const outcome = await registry.kill(fakeSession('s1'), admitted.record.id)
    expect(outcome).toEqual({ outcome: 'killed' })
    await closed
    expect(exits.at(-1)?.status).toBe('killed')
  })

  it('kill on an ended process is already-ended, unknown id is not-found', async () => {
    const registry = new ProcessRegistry({})
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'true'] : ['-c', 'true'], { detached: true, stdio: 'ignore' })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'true', cwd: process.cwd(), child, executable: SHELL, treeTag: 'tag-3' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    await registry.kill(fakeSession('s1'), admitted.record.id).then((o) => expect(o).toEqual({ outcome: 'already-ended', status: 'exited' }))
    expect(await registry.kill(fakeSession('s1'), 'proc_missing')).toEqual({ outcome: 'not-found' })
  })

  it('enforces the per-session cap of 8 then rejects with an actionable error', () => {
    const registry = new ProcessRegistry({}, { perSession: 8, host: 24 })
    const kids: ChildProcess[] = []
    for (let i = 0; i < 8; i += 1) {
      const { child } = spawnSleeper()
      kids.push(child)
      expect(registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: `t-${i}` }).ok).toBe(true)
    }
    const ninth = spawnSleeper()
    const rejected = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child: ninth.child, executable: SHELL, treeTag: 't-9' })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('unreachable')
    expect(rejected.error).toContain('8')
    ninth.child.kill()
    for (const kid of kids) kid.kill()
    void registry.disposeAll()
  })

  it('enforces the host cap across sessions', () => {
    const registry = new ProcessRegistry({}, { perSession: 8, host: 2 })
    for (const session of ['s1', 's2']) {
      const { child } = spawnSleeper()
      expect(registry.tryRegister({ sessionId: fakeSession(session), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: `h-${session}` }).ok).toBe(true)
    }
    const third = spawnSleeper()
    const rejected = registry.tryRegister({ sessionId: fakeSession('s3'), command: 'sleep 30', cwd: process.cwd(), child: third.child, executable: SHELL, treeTag: 'h-3' })
    expect(rejected.ok).toBe(false)
    third.child.kill()
    void registry.disposeAll()
  })

  it('stops capturing output at the ring cap and marks truncation', async () => {
    const registry = new ProcessRegistry({}, { ringChars: 100 })
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'seq 1 200'] : ['-c', 'seq 1 200'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'seq 1 200', cwd: process.cwd(), child, executable: SHELL, treeTag: 't-cap' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const read = registry.read(fakeSession('s1'), admitted.record.id)
    expect(read?.output.length).toBeLessThanOrEqual(100)
    expect(read?.outputTruncated).toBe(true)
  })

  it('dispose kills running processes of the session and emits no exit callback', async () => {
    const exits: ProcessRecord[] = []
    const registry = new ProcessRegistry({ onExit: (record) => exits.push({ ...record }) })
    const { child, closed } = spawnSleeper()
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: 't-d' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await registry.dispose(fakeSession('s1'))
    await closed
    expect(exits).toHaveLength(0)
    expect(registry.runningCount(fakeSession('s1'))).toBe(0)
  })

  it('snapshot exposes derived durationMs and the ended shape', async () => {
    const registry = new ProcessRegistry({})
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'true'] : ['-c', 'true'], { detached: true, stdio: 'ignore' })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'true', cwd: process.cwd(), child, executable: SHELL, treeTag: 't-s' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const rows = registry.snapshot(fakeSession('s1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('exited')
    expect(typeof rows[0]?.durationMs).toBe('number')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness/processes/registry.spec.ts`
Expected: FAIL — cannot resolve `../../../src/harness/processes/registry.ts`.

- [ ] **Step 3: Export killTree from bash.ts**

In `src/capabilities/shell/bash.ts` change the declaration only (body untouched):

```ts
/** Kill a spawned process tree. Best effort — the caller verifies through
 * the exit/close events, and the tool settles on `exit` after a kill so a
 * straggler grandchild holding the stdio pipes cannot stall the result.
 * Exported for the background-process registry, which owns long-lived trees. */
export function killTree(child: ChildProcess, shell: string, treeTag: string): void {
```

- [ ] **Step 4: Implement the registry**

```ts
// src/harness/processes/registry.ts
/**
 * Host-owned registry of background Bash processes, keyed by session. The
 * registry owns spawn-lifecycle bookkeeping only: caps, a head-capped output
 * ring, and tree kills through the shell capability's killTree. It knows
 * nothing about the web, SSE, or the session log — hosts bridge the
 * onStart/onExit callbacks to durable events. Processes outlive turns; only
 * a KillShell/operator stop, a child error, natural exit, or session delete
 * (dispose, which emits nothing — the log is going away) ends one.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killTree } from '../../capabilities/shell/bash.ts'
import type { SessionId } from '../../util/brand.ts'

export type ProcessTermination = 'exited' | 'killed' | 'failed' | 'interrupted'
export type ProcessStatus = 'running' | ProcessTermination

export interface ProcessRecord {
  readonly id: string
  readonly sessionId: SessionId
  readonly command: string
  readonly cwd: string
  readonly turnId?: string
  readonly startedAt: number
  status: ProcessStatus
  exitCode: number | null
  endedAt: number | null
  /** Combined stdout+stderr captured so far, head-capped. */
  output: string
  outputTruncated: boolean
  /** Set by dispose: exit listeners run but no callbacks fire. */
  suppressEvents: boolean
  /** True once a kill was requested, so close maps to `killed`. */
  killRequested: boolean
}

export interface ProcessSnapshot {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly status: ProcessStatus
  readonly startedAt: number
  readonly exitCode: number | null
  readonly durationMs: number
  readonly truncated: boolean
}

export interface RegisterInput {
  readonly sessionId: SessionId
  readonly command: string
  readonly cwd: string
  readonly turnId?: string
  readonly child: ChildProcess
  readonly executable: string
  readonly treeTag: string
}

export interface RegistryLimits { readonly perSession: number; readonly host: number; readonly ringChars: number }

const DEFAULT_LIMITS: RegistryLimits = { perSession: 8, host: 24, ringChars: 64_000 }

/** Kill-to-close grace: a straggler grandchild can outlive the tree walk. */
const KILL_SETTLE_MS = 5_000

export class ProcessRegistry {
  private readonly byId = new Map<string, ProcessRecord>()
  private readonly limits: RegistryLimits

  constructor(
    private readonly events: {
      readonly onStart?: (record: ProcessRecord) => void
      readonly onExit?: (record: ProcessRecord) => void
    } = {},
    limits: Partial<RegistryLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  tryRegister(input: RegisterInput): { ok: true; record: ProcessRecord } | { ok: false; error: string } {
    if (this.runningCount(input.sessionId) >= this.limits.perSession) {
      return { ok: false, error: `this session already has ${this.limits.perSession} background processes running; kill one (KillShell) or wait for it to exit before starting another` }
    }
    if (this.runningTotal() >= this.limits.host) {
      return { ok: false, error: `the host limit of ${this.limits.host} running background processes is reached; kill or wait for one before starting another` }
    }
    const record: ProcessRecord = {
      id: `proc_${randomUUID()}`,
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      endedAt: null,
      output: '',
      outputTruncated: false,
      suppressEvents: false,
      killRequested: false,
    }
    this.byId.set(record.id, record)
    this.watch(input, record)
    this.events.onStart?.({ ...record })
    return { ok: true, record }
  }

  private watch(input: RegisterInput, record: ProcessRecord): void {
    const capAt = (chunk: Buffer): void => {
      if (record.outputTruncated) return
      record.output += chunk.toString('utf8')
      if (record.output.length > this.limits.ringChars) {
        record.outputTruncated = true
        record.output = record.output.slice(0, this.limits.ringChars)
      }
    }
    input.child.stdout?.on('data', capAt)
    input.child.stderr?.on('data', capAt)
    const settle = (status: ProcessTermination, code: number | null): void => {
      record.status = status
      record.exitCode = code
      record.endedAt = Date.now()
      if (!record.suppressEvents) this.events.onExit?.({ ...record })
    }
    input.child.on('error', () => settle('failed', null))
    input.child.on('close', (code: number | null) => settle(record.killRequested ? 'killed' : 'exited', code))
  }

  read(sessionId: SessionId, processId: string): { output: string; outputTruncated: boolean; status: ProcessStatus; exitCode: number | null } | undefined {
    const record = this.byId.get(processId)
    if (record === undefined || record.sessionId !== sessionId) return undefined
    return { output: record.output, outputTruncated: record.outputTruncated, status: record.status, exitCode: record.exitCode }
  }

  isRunning(sessionId: SessionId, processId: string): boolean {
    const record = this.byId.get(processId)
    return record !== undefined && record.sessionId === sessionId && record.status === 'running'
  }

  runningCount(sessionId: SessionId): number {
    let count = 0
    for (const record of this.byId.values()) if (record.sessionId === sessionId && record.status === 'running') count += 1
    return count
  }

  private runningTotal(): number {
    let count = 0
    for (const record of this.byId.values()) if (record.status === 'running') count += 1
    return count
  }

  async kill(sessionId: SessionId, processId: string): Promise<{ outcome: 'killed' } | { outcome: 'already-ended'; status: ProcessStatus } | { outcome: 'not-found' }> {
    const record = this.byId.get(processId)
    if (record === undefined || record.sessionId !== sessionId) return { outcome: 'not-found' }
    if (record.status !== 'running') return { outcome: 'already-ended', status: record.status }
    record.killRequested = true
    const owned = this.owners.get(processId)
    if (owned !== undefined) killTree(owned.child, owned.executable, owned.treeTag)
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (record.status !== 'running') { clearInterval(poll); resolve() } }, 25)
      setTimeout(() => { clearInterval(poll); resolve() }, KILL_SETTLE_MS).unref?.()
    })
    return { outcome: 'killed' }
  }

  snapshot(sessionId: SessionId): readonly ProcessSnapshot[] {
    const rows: ProcessSnapshot[] = []
    for (const record of this.byId.values()) {
      if (record.sessionId !== sessionId) continue
      rows.push({
        id: record.id,
        command: record.command,
        cwd: record.cwd,
        status: record.status,
        startedAt: record.startedAt,
        exitCode: record.exitCode,
        durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
        truncated: record.outputTruncated,
      })
    }
    return rows
  }

  /** Kill every running process of the session. Emits nothing (log is going away). */
  async dispose(sessionId: SessionId): Promise<void> {
    const dying: Promise<void>[] = []
    for (const [id, record] of this.byId.entries()) {
      if (record.sessionId !== sessionId || record.status !== 'running') continue
      record.killRequested = true
      record.suppressEvents = true
      const owned = this.owners.get(id)
      if (owned !== undefined) {
        killTree(owned.child, owned.executable, owned.treeTag)
        dying.push(new Promise<void>((resolve) => {
          const poll = setInterval(() => { if (record.status !== 'running') { clearInterval(poll); resolve() } }, 25)
          setTimeout(() => { clearInterval(poll); resolve() }, KILL_SETTLE_MS).unref?.()
        }))
      }
    }
    await Promise.all(dying)
  }

  async disposeAll(): Promise<void> {
    for (const sessionId of new Set([...this.byId.values()].map((record) => record.sessionId))) await this.dispose(sessionId)
  }
}
```

The class keeps the spawned handles next to the records:

```ts
  /** Spawned handle per process id, for tree kills. Never serialized. */
  private readonly owners = new Map<string, { child: ChildProcess; executable: string; treeTag: string }>()
```

`tryRegister` populates it right after `this.byId.set(record.id, record)`:

```ts
    this.owners.set(record.id, { child: input.child, executable: input.executable, treeTag: input.treeTag })
```

and `watch()`'s close/error settle path also deletes the owner entry (`this.owners.delete(record.id)` inside `settle`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/harness/processes/registry.spec.ts`
Expected: PASS (9 tests). If the Windows Git Bash spawn path flakes, re-run once before investigating.

- [ ] **Step 6: Commit**

```bash
git add src/harness/processes/registry.ts src/capabilities/shell/bash.ts tests/harness/processes/registry.spec.ts
git commit -m "feat(harness): host-owned ProcessRegistry for background bash processes"
```

---

### Task 2: Durable process events + client shape

**Files:**
- Modify: `src/harness/session/events.ts` (union + every switch over it)
- Modify: `src/web/server.ts` ONLY where the SSE envelope projects fields (find the projection of `agent/child-spawn` / `context/manifest`; mirror it for `process/*`) — if projection is generic passthrough, no server change is needed here
- Modify: `web/lib/types.ts` (optional `SseEvent` fields)
- Test: `tests/harness/processes/process-events.spec.ts`

**Interfaces:**
- Produces (consumed by Tasks 5, 8): event types `'process/start' { processId, command, cwd, turnId? }` and `'process/exit' { processId, exitCode, termination, durationMs }` on `SessionEvent`; SseEvent optional fields `processId?: string; command?: string; cwd?: string; exitCode?: number | null; termination?: string; durationMs?: number`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/harness/processes/process-events.spec.ts
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../../src/harness/session/events.ts'

describe('process session events', () => {
  it('process/start carries identity and process/exit carries the termination contract', () => {
    const start = { type: 'process/start', processId: 'proc_1', command: 'npm run dev', cwd: 'C:/repo' } as const
    const exit = { type: 'process/exit', processId: 'proc_1', exitCode: 0, termination: 'exited', durationMs: 1200 } as const
    const events: readonly SessionEvent[] = [start, exit] as unknown as readonly SessionEvent[]
    expect((events[0] as { command?: string }).command).toBe('npm run dev')
    expect((events[1] as { termination?: string }).termination).toBe('exited')
  })
})
```

(The `as unknown as` cast is intentional: `SessionEventStamp` fields — `seq`, `ts` — are host-assigned at append time, so literals without them cannot type-check directly. The compile-time guarantee that matters — the `type` discriminants and field names exist on the union — still fails before Task 2's Step 3 and passes after.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness/processes/process-events.spec.ts`
Expected: FAIL — `'process/start' is not assignable to SessionEvent`.

- [ ] **Step 3: Extend the union and switches**

In `src/harness/session/events.ts`, after the `compaction/end` variant:

```ts
  // Background-process lifecycle, log-only (model projection ignores it):
  // a `Bash run_in_background` registration and its settled outcome. Pairs
  // are per process id; `interrupted` closes ids found open after a restart.
  | ({ readonly type: 'process/start'; readonly processId: string; readonly command: string; readonly cwd: string; readonly turnId?: TurnId } & SessionEventStamp)
  | ({ readonly type: 'process/exit'; readonly processId: string; readonly exitCode: number | null; readonly termination: 'exited' | 'killed' | 'failed' | 'interrupted'; readonly durationMs: number } & SessionEventStamp)
```

Then run `npx tsc --noEmit -p tsconfig.json` (or the repo typecheck script) and add the new cases to EVERY switch the compiler flags, classified exactly like `compaction/*` / `context/*` (log-only buckets: replay includes them, model projection skips them). In the switch around `events.ts:321-345` add:

```ts
      case 'process/start':
      case 'process/exit':
```

next to the compaction/context cases in the same bucket.

- [ ] **Step 4: Add SseEvent fields**

In `web/lib/types.ts` inside `SseEvent`, after `recovery?: true`:

```ts
  /** Background-process lifecycle (process/start, process/exit). */
  readonly processId?: string
  readonly command?: string
  readonly cwd?: string
  readonly exitCode?: number | null
  readonly termination?: string
  readonly durationMs?: number
```

Then locate the server's SSE envelope projection (search `src/web/server.ts` for where `agent/child-spawn` or `context/manifest` fields are copied into the client event). If projection is a generic field passthrough, nothing to do; otherwise mirror the child-spawn copy style for `processId/command/cwd/exitCode/termination/durationMs` on `process/start` and `process/exit`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/harness/processes/process-events.spec.ts` → PASS.
Run: `npx tsc --noEmit -p tsconfig.json` (and `-p web/tsconfig.json` if separate) → clean.

- [ ] **Step 6: Commit**

```bash
git add src/harness/session/events.ts web/lib/types.ts src/web/server.ts tests/harness/processes/process-events.spec.ts
git commit -m "feat(harness): durable process/start and process/exit session events"
```

---

### Task 3: Bash run_in_background

**Files:**
- Modify: `src/capabilities/shell/bash.ts`
- Test: `tests/harness/processes/bash-background.spec.ts`

**Interfaces:**
- Consumes: `ProcessRegistry` (Task 1).
- Produces: `BashToolOptions.processes?: ProcessRegistry`; arg `run_in_background: boolean`; result string `background process started: id=<id>; read output with BashOutput; kill with KillShell`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/harness/processes/bash-background.spec.ts
import { describe, expect, it } from 'vitest'
import { bashTool } from '../../../src/capabilities/shell/bash.ts'
import { ProcessRegistry } from '../../../src/harness/processes/registry.ts'
import type { ToolExecution } from '../../../src/harness/tools/types.ts'

const SHELL_CMD = process.platform === 'win32' ? 'echo bg-should-not-appear' : 'echo bg-should-not-appear'

function exec(sessionId: string, root: string): ToolExecution {
  return { root, sessionId: sessionId as never }
}

describe('Bash run_in_background', () => {
  it('returns immediately with a process id and does not wait for exit', async () => {
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry })
    const started = Date.now()
    const result = await tool.execute({ command: 'sleep 5', run_in_background: true }, exec('s1', process.cwd()))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toMatch(/background process started: id=proc_[0-9a-f-]+; read output with BashOutput; kill with KillShell/)
  })

  it('rejects background mode when the host wired no registry or the call has no session', async () => {
    const bare = bashTool({})
    expect(await bare.execute({ command: 'sleep 1', run_in_background: true }, exec('s1', process.cwd()))).toContain('error: background processes are not available')
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry })
    expect(await tool.execute({ command: 'sleep 1', run_in_background: true }, { root: process.cwd() })).toContain('error: background mode requires a session')
  })

  it('registry gains a running record whose output is readable and killable', async () => {
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry })
    const result = await tool.execute({ command: SHELL_CMD, run_in_background: true }, exec('s1', process.cwd()))
    const id = /id=(proc_[0-9a-f-]+)/.exec(result)?.[1]
    expect(id).toBeDefined()
    if (id === undefined) return
    expect(registry.isRunning('s1' as never, id)).toBe(true)
    const outcome = await registry.kill('s1' as never, id)
    expect(outcome).toEqual({ outcome: 'killed' })
  })

  it('foreground behavior is unchanged (no run_in_background arg)', async () => {
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry, timeoutMs: 10_000 })
    const result = await tool.execute({ command: SHELL_CMD }, exec('s1', process.cwd()))
    expect(result).toContain('bg-should-not-appear')
    expect(result).toContain('[exit code: 0]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness/processes/bash-background.spec.ts`
Expected: FAIL — `run_in_background` ignored → first test times out ~5s or returns foreground output without the marker.

- [ ] **Step 3: Implement the background branch**

In `src/capabilities/shell/bash.ts`:

```ts
import type { ProcessRegistry } from '../../harness/processes/registry.ts'
```

Extend options and the tool:

```ts
export interface BashToolOptions {
  readonly timeoutMs?: number
  readonly cwd?: string | (() => string)
  readonly executable?: string
  /** Background-mode owner: registers run_in_background children. */
  readonly processes?: ProcessRegistry
}
```

In the `parameters.properties` object add:

```ts
        run_in_background: { type: 'boolean', description: 'run the command in the background and return a process id immediately; read output with BashOutput, kill with KillShell. timeoutMs is ignored in background mode' },
```

At the top of `execute`, after the executable check and before the foreground promise:

```ts
      const background = args['run_in_background'] === true
      if (background) {
        if (options.processes === undefined) {
          return 'error: background processes are not available on this host'
        }
        if (exec.sessionId === undefined) {
          return 'error: background mode requires a session; it cannot run as a direct compatibility call'
        }
        if (exec.signal?.aborted === true) {
          return 'cancelled: stop requested before this command started'
        }
        const cwd = exec.root !== '' ? exec.root : fallbackCwd()
        let child: ChildProcess
        const treeTag = randomUUID()
        try {
          child = spawn(detection.executable, ['-lc', command], {
            cwd,
            detached: true,
            ...(process.platform === 'win32' ? { env: { ...process.env, [TREE_TAG_ENV]: treeTag } } : {}),
          })
        } catch (error) {
          return `error: bash spawn failed (${String(error)}); verify the shell at '${detection.hint}'`
        }
        const admitted = options.processes.tryRegister({
          sessionId: exec.sessionId,
          command,
          cwd,
          child,
          executable: detection.executable as string,
          treeTag,
        })
        if (!admitted.ok) {
          killTree(child, detection.executable as string, treeTag)
          return `error: ${admitted.error}`
        }
        return `background process started: id=${admitted.record.id}; read output with BashOutput; kill with KillShell`
      }
```

Note: no timeout timer and no `exec.signal` listener in this branch — the process must survive the turn.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/harness/processes/bash-background.spec.ts` → PASS. Then `npx vitest run tests/harness/agent-tools.spec.ts` (existing Bash coverage) → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/shell/bash.ts tests/harness/processes/bash-background.spec.ts
git commit -m "feat(shell): Bash run_in_background registers into the process registry"
```

---

### Task 4: BashOutput and KillShell tools

**Files:**
- Create: `src/capabilities/shell/background-tools.ts`
- Modify: `src/web/server.ts` (register, next to `bashTool` at ~line 889)
- Modify: `src/bins/headless.ts` (~line 140, same)
- Test: `tests/harness/processes/background-tools.spec.ts`

**Interfaces:**
- Consumes: `ProcessRegistry` (Task 1).
- Produces: `bashOutputTool(options: { processes: ProcessRegistry }): ToolDefinition`, `killShellTool(options: { processes: ProcessRegistry }): ToolDefinition` — names exact `'BashOutput'` / `'KillShell'`, no `requiresRoot`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/harness/processes/background-tools.spec.ts
import { describe, expect, it } from 'vitest'
import { bashTool } from '../../../src/capabilities/shell/bash.ts'
import { bashOutputTool, killShellTool } from '../../../src/capabilities/shell/background-tools.ts'
import { ProcessRegistry } from '../../../src/harness/processes/registry.ts'
import type { ToolExecution } from '../../../src/harness/tools/types.ts'

const exec = (sessionId: string): ToolExecution => ({ root: process.cwd(), sessionId: sessionId as never })

async function startBackground(registry: ProcessRegistry, command: string, sessionId = 's1'): Promise<string> {
  const tool = bashTool({ processes: registry })
  const result = await tool.execute({ command, run_in_background: true }, exec(sessionId))
  const id = /id=(proc_[0-9a-f-]+)/.exec(result)?.[1]
  if (id === undefined) throw new Error(result)
  return id
}

describe('BashOutput', () => {
  it('reads captured output and status while running, then the final exit', async () => {
    const registry = new ProcessRegistry({})
    const output = bashOutputTool({ processes: registry })
    const id = await startBackground(registry, 'echo out-from-bg')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const running = await output.execute({ processId: id }, exec('s1'))
    expect(running).toContain('[status: running]')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const done = await output.execute({ processId: id }, exec('s1'))
    expect(done).toContain('out-from-bg')
    expect(done).toContain('exit code: 0')
  })

  it('errors with the known id list on an unknown process', async () => {
    const registry = new ProcessRegistry({})
    const output = bashOutputTool({ processes: registry })
    const id = await startBackground(registry, 'sleep 5')
    const result = await output.execute({ processId: 'proc_missing' }, exec('s1'))
    expect(result).toContain('unknown processId')
    expect(result).toContain(id)
    await registry.kill('s1' as never, id)
  })

  it('rejects bad arguments and session-less calls', async () => {
    const registry = new ProcessRegistry({})
    const output = bashOutputTool({ processes: registry })
    expect(await output.execute({}, exec('s1'))).toContain("argument 'processId'")
    expect(await output.execute({ processId: 'proc_x' }, { root: process.cwd() })).toContain('error: no session')
  })
})

describe('KillShell', () => {
  it('kills a running process and confirms', async () => {
    const registry = new ProcessRegistry({})
    const kill = killShellTool({ processes: registry })
    const id = await startBackground(registry, 'sleep 30')
    const result = await kill.execute({ processId: id }, exec('s1'))
    expect(result).toContain('killed')
    expect(registry.isRunning('s1' as never, id)).toBe(false)
  })

  it('reports already-ended truthfully and unknown ids with the list', async () => {
    const registry = new ProcessRegistry({})
    const killTool = killShellTool({ processes: registry })
    const id = await startBackground(registry, 'true')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const ended = await killTool.execute({ processId: id }, exec('s1'))
    expect(ended).toContain('already ended')
    const unknown = await killTool.execute({ processId: 'proc_missing' }, exec('s1'))
    expect(unknown).toContain('unknown processId')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness/processes/background-tools.spec.ts`
Expected: FAIL — module `background-tools.ts` does not exist.

- [ ] **Step 3: Implement the tools**

```ts
// src/capabilities/shell/background-tools.ts
/**
 * The model's control surface over background Bash processes: read the
 * captured output of one it started, and kill one it started. Lookups are
 * scoped by the executing session — a process id from another session is
 * unknown here. Both are always allowed without approval: they only touch
 * processes the agent itself spawned, and neither needs a granted root.
 */
import type { ProcessRegistry } from '../../harness/processes/registry.ts'
import type { ToolDefinition, ToolExecution } from '../../harness/tools/types.ts'

const OUTPUT_CAP = 30_000

function knownIds(processes: ProcessRegistry, exec: ToolExecution): string {
  return processes.snapshot(exec.sessionId as never).filter((row) => row.status === 'running').map((row) => row.id).join(', ') || '(none running)'
}

export function bashOutputTool(options: { readonly processes: ProcessRegistry }): ToolDefinition {
  return {
    name: 'BashOutput',
    description: 'Read the captured stdout/stderr and status of one background process started with Bash run_in_background.',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'the process id returned by Bash run_in_background' },
      },
      required: ['processId'],
    },
    async execute(args, exec) {
      const processId = args['processId']
      if (typeof processId !== 'string' || processId === '') {
        return "error: argument 'processId' must be a non-empty string"
      }
      if (exec.sessionId === undefined) return 'error: no session scope for background processes'
      const read = options.processes.read(exec.sessionId, processId)
      if (read === undefined) {
        return `error: unknown processId '${processId}' in this session; running: ${knownIds(options.processes, exec)}`
      }
      const status = read.status === 'running' ? 'running' : `${read.status}${read.exitCode !== null ? ` (exit code: ${read.exitCode})` : ''}`
      const limit = exec.outputLimit ?? OUTPUT_CAP
      const body = read.output.length > limit ? `${read.output.slice(0, limit)}\n… [truncated ${read.output.length - limit} chars]` : read.output
      const truncated = read.outputTruncated ? '\n… [output truncated during capture]' : ''
      return `[status: ${status}]\n${body}${truncated}`
    },
  }
}

export function killShellTool(options: { readonly processes: ProcessRegistry }): ToolDefinition {
  return {
    name: 'KillShell',
    description: 'Kill one background process started with Bash run_in_background (whole process tree).',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'the process id returned by Bash run_in_background' },
      },
      required: ['processId'],
    },
    async execute(args, exec) {
      const processId = args['processId']
      if (typeof processId !== 'string' || processId === '') {
        return "error: argument 'processId' must be a non-empty string"
      }
      if (exec.sessionId === undefined) return 'error: no session scope for background processes'
      const outcome = await options.processes.kill(exec.sessionId, processId)
      if (outcome.outcome === 'not-found') {
        return `error: unknown processId '${processId}' in this session; running: ${knownIds(options.processes, exec)}`
      }
      if (outcome.outcome === 'already-ended') {
        return `process ${processId} already ended (status: ${outcome.status}); nothing to kill`
      }
      return `process ${processId} killed`
    },
  }
}
```

- [ ] **Step 4: Register in both hosts**

`src/web/server.ts` (~line 889) — create the registry once (exact wiring of the event bridge is Task 5; here only construction + registration):

```ts
  const processes = new ProcessRegistry({})
  kernel.ctx.tools.register(bashTool({ timeoutMs: limits.toolTimeoutMs, processes }))
  kernel.ctx.tools.register(bashOutputTool({ processes }))
  kernel.ctx.tools.register(killShellTool({ processes }))
```

`src/bins/headless.ts` (~line 140):

```ts
  const processes = new ProcessRegistry({})
  kernel.ctx.tools.register(bashTool({ timeoutMs: DEFAULT_LIMITS.toolTimeoutMs, processes }))
  kernel.ctx.tools.register(bashOutputTool({ processes }))
  kernel.ctx.tools.register(killShellTool({ processes }))
```

If `deps` is the only object in scope at the route handlers, ALSO add `processes` to the deps construction so Task 5 can reach it (one line, note the location in the commit body).

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/harness/processes/background-tools.spec.ts` → PASS; `npx vitest run tests/harness/agent-tools.spec.ts tests/harness/g4-subagent-contract.spec.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/shell/background-tools.ts src/web/server.ts src/bins/headless.ts tests/harness/processes/background-tools.spec.ts
git commit -m "feat(shell): BashOutput and KillShell tools over the process registry"
```

---

### Task 5: Server wiring — event bridge, delete dispose, restart reconcile, REST routes

**Files:**
- Modify: `src/web/server.ts` (bridge callbacks, DELETE dispose at ~line 3057, first-read reconcile in `streamEvents`, routes before `wsSessionMatch` at ~line 3004)
- Test: `tests/harness/processes/server-processes.spec.ts` (new, boots the web server harness the way `tests/web/server.spec.ts` does — copy its boot helper imports/pattern into this new file; do not edit `server.spec.ts`)

**Interfaces:**
- Consumes: `ProcessRegistry` (Task 1), `process/*` events (Task 2), registry instance from Task 4.
- Produces (consumed by Task 8): `GET /api/workspaces/:ws/sessions/:sid/processes` → `ProcessSnapshot[]`; `POST /api/workspaces/:ws/sessions/:sid/processes/:procId/stop` → `200 {stopped: true, processId}` / `404 {error}` / `409 {error, status}`.

- [ ] **Step 1: Write the failing test**

Boot pattern: copy the minimal server-boot + session-create + tool-execute flow from `tests/web/server.spec.ts` (it already creates a workspace, session, and drives the agent loop with a fake LLM). The new spec asserts:

```ts
// tests/harness/processes/server-processes.spec.ts
// Reuse the same imports/helpers as tests/web/server.spec.ts (startServer harness).
describe('background process routes', () => {
  it('GET lists an empty snapshot for a fresh session', async () => {
    const { ws, sessionId, fetch } = await boot()
    const res = await fetch(`/api/workspaces/${ws}/sessions/${sessionId}/processes`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST stop on an unknown id is 404; on a session it does not know, 404', async () => {
    const { ws, sessionId, fetch } = await boot()
    expect((await fetch(`/api/workspaces/${ws}/sessions/${sessionId}/processes/proc_missing/stop`, { method: 'POST' })).status).toBe(404)
  })

  it('a background Bash tool call appends process/start and appears in GET', async () => {
    const { ws, sessionId, fetch, events } = await boot()
    await runToolCall('Bash', { command: 'sleep 10', run_in_background: true }) // helper drives the agent loop like server.spec does
    const rows = await (await fetch(`/api/workspaces/${ws}/sessions/${sessionId}/processes`)).json()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('running')
    expect(events.some((event: { type: string }) => event.type === 'process/start')).toBe(true)
    const stop = await fetch(`/api/workspaces/${ws}/sessions/${sessionId}/processes/${rows[0].id}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    expect(events.some((event: { type: string; termination?: string }) => event.type === 'process/exit' && event.termination === 'killed')).toBe(true)
    // stopping again → 409 already ended
    expect((await fetch(`/api/workspaces/${ws}/sessions/${sessionId}/processes/${rows[0].id}/stop`, { method: 'POST' })).status).toBe(409)
  })

  it('deleting a session kills its processes without exit events', async () => {
    const { ws, sessionId, fetch, events } = await boot()
    await runToolCall('Bash', { command: 'sleep 10', run_in_background: true })
    const rows = await (await fetch(`/api/workspaces/${ws}/sessions/${sessionId}/processes`)).json()
    await fetch(`/api/workspaces/${ws}/sessions/${sessionId}`, { method: 'DELETE' })
    expect(events.filter((event: { type: string }) => event.type === 'process/exit')).toHaveLength(0)
    expect(rows).toHaveLength(1)
  })
})
```

Write the helpers (`boot`, `runToolCall`) by copying the harness from `tests/web/server.spec.ts` verbatim (its fake-LLM agent step executor), adapting only names. If that file's harness is not reusable as-is, boot the real server via its exported factory with `--data-dir` in a temp folder (see `scripts/live-ui-smoke.mjs` for the pattern) and drive `POST …/messages` with a scripted fake provider registered through the providers API.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness/processes/server-processes.spec.ts`
Expected: FAIL — 404 on `/processes` (no route).

- [ ] **Step 3: Implement the wiring**

(a) Event bridge — replace the Task 4 constructor call in `src/web/server.ts`:

```ts
  const processes = new ProcessRegistry({
    onStart: (record) => {
      const owner = deps.sessions.get(record.sessionId)
      owner?.session.append({ type: 'process/start', processId: record.id, command: record.command, cwd: record.cwd, ...(record.turnId !== undefined ? { turnId: record.turnId as never } : {}) })
    },
    onExit: (record) => {
      const owner = deps.sessions.get(record.sessionId)
      owner?.session.append({ type: 'process/exit', processId: record.id, exitCode: record.exitCode, termination: record.status as 'exited' | 'killed' | 'failed' | 'interrupted', durationMs: (record.endedAt ?? record.startedAt) - record.startedAt })
    },
  })
```

If `deps` is not in scope where the registry is constructed, construct where `deps` is built and assign `deps.processes = processes` (add the field to the deps type).

(b) DELETE dispose — in the session DELETE handler (server.ts ~3057, right before `await deps.childExecutor.cancelAllOfRoot(...)`):

```ts
          await processes.dispose(entry.session.id)
``

(c) Restart reconcile — first read per session per boot. Add near the registry:

```ts
  const processReconciled = new Set<SessionId>()
```

In `streamEvents` (find its definition; it loads the session's events to snapshot), after the events array is available and BEFORE the snapshot is sent, call:

```ts
  reconcileInterruptedProcesses(entry, events, processes, processReconciled)
```

with helper (module scope):

```ts
/**
 * Close `process/start` events left open by a server restart. Sessions load
 * lazily, so this runs on the FIRST read of each session after boot, before
 * any client can see its events: an open id the live registry does not own
 * gets one synthetic durable `process/exit { interrupted }`. Orphaned OS
 * processes are not re-adopted; KillShell/BashOutput on the id answer
 * unknown truthfully.
 */
function reconcileInterruptedProcesses(entry: { session: { append(event: never): void; id: SessionId } }, events: readonly { type: string; processId?: string }[], processes: ProcessRegistry, reconciled: Set<SessionId>): void {
  if (reconciled.has(entry.session.id)) return
  reconciled.add(entry.session.id)
  const closed = new Set<string>()
  for (const event of events) if (event.type === 'process/exit' && event.processId !== undefined) closed.add(event.processId)
  for (const event of events) {
    if (event.type !== 'process/start' || event.processId === undefined) continue
    if (closed.has(event.processId) || processes.isRunning(entry.session.id, event.processId)) continue
    entry.session.append({ type: 'process/exit', processId: event.processId, exitCode: null, termination: 'interrupted', durationMs: 0 })
  }
}
```

Adapt the `entry` parameter type to the real `streamEvents` entry type rather than the structural sketch above; keep the logic identical. Add a unit test for this helper inside `server-processes.spec.ts` (pure function: two starts, one closed, one running in a fake registry → exactly one interrupted append via a spy).

(d) Routes — insert immediately BEFORE the `wsSessionMatch` block (~line 3004):

```ts
    const wsProcessesMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/processes(?:\/([^/]+)\/stop)?$/.exec(pathname)
    if (wsProcessesMatch !== null) {
      const wsId = decodeURIComponent(wsProcessesMatch[1] ?? '') as WorkspaceId
      const processId = wsProcessesMatch[3] !== undefined ? decodeURIComponent(wsProcessesMatch[3] ?? '') : undefined
      const entry = await findSession(decodeURIComponent(wsProcessesMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) { send(404, { error: 'no such session' }); return }
      if (deps.unavailableSessions.has(entry.session.id)) { send(503, { error: 'session unavailable after durable storage failure' }); return }
      if (processId === undefined) {
        if (req.method === 'GET') { send(200, processes.snapshot(entry.session.id)); return }
        send(405, { error: 'method not allowed' }); return
      }
      if (req.method === 'POST') {
        const outcome = await processes.kill(entry.session.id, processId)
        if (outcome.outcome === 'not-found') { send(404, { error: `no such process '${processId}'` }); return }
        if (outcome.outcome === 'already-ended') { send(409, { error: `process '${processId}' already ended`, status: outcome.status }); return }
        send(200, { stopped: true, processId }); return
      }
      send(405, { error: 'method not allowed' }); return
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/harness/processes/server-processes.spec.ts` → PASS; `npx vitest run tests/web/server.spec.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts tests/harness/processes/server-processes.spec.ts
git commit -m "feat(web): process routes, durable event bridge, delete dispose, restart reconcile"
```

---

### Task 6: Bundled mode exposure

**Files:**
- Modify: `src/harness/modes/bundled.ts` (3 modes that expose `Bash`: `ask-before-changes` ~line 24, `edit-automatically` ~line 39, full-access ~line 68)
- Test: extend the first spec in `tests/harness/processes/mode-exposure.spec.ts`

**Interfaces:**
- Produces: `BashOutput`/`KillShell` exposed + `allow` in every bundled mode whose `toolExposure` contains `Bash`. Plan mode untouched (no Bash).

- [ ] **Step 1: Write the failing test**

```ts
// tests/harness/processes/mode-exposure.spec.ts
import { describe, expect, it } from 'vitest'
import { BUNDLED_MODES } from '../../../src/harness/modes/bundled.ts'

describe('bundled modes expose the background process tools with Bash', () => {
  it.each(BUNDLED_MODES.map((mode) => [mode.id, mode] as const))('%s', (_id, mode) => {
    if (!mode.toolExposure.includes('Bash')) return
    expect(mode.toolExposure).toContain('BashOutput')
    expect(mode.toolExposure).toContain('KillShell')
    expect(mode.permissionDefaults?.BashOutput).toBe('allow')
    expect(mode.permissionDefaults?.KillShell).toBe('allow')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness/processes/mode-exposure.spec.ts`
Expected: FAIL (toolExposure lacks the new names).

- [ ] **Step 3: Edit the three modes**

In each of the three `toolExposure` arrays change `'Bash',` to `'Bash', 'BashOutput', 'KillShell',` and add to that mode's `permissionDefaults`:

```ts
      BashOutput: 'allow', KillShell: 'allow',
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/harness/processes/mode-exposure.spec.ts tests/harness/g1-lifecycle.spec.ts` → PASS (if a g1/g3 spec asserts exact exposure lists, update those assertions to the new expected arrays — they live in the spec files, and this is the intended contract change).

- [ ] **Step 5: Commit**

```bash
git add src/harness/modes/bundled.ts tests/harness/processes/mode-exposure.spec.ts
git commit -m "feat(modes): expose BashOutput and KillShell wherever Bash is exposed"
```

---

### Task 7: Git ahead/behind

**Files:**
- Modify: `src/web/project-git.ts` (`GitStatusReport` + `gitStatus` header parse)
- Test: `tests/web/project-git-sync.spec.ts`

**Interfaces:**
- Produces: `GitStatusReport.ahead?: number; behind?: number` (additive; the `/git` route returns `gitStatus()` directly so the panel gets them with no route change).

- [ ] **Step 1: Write the failing test**

```ts
// tests/web/project-git-sync.spec.ts
import { describe, expect, it } from 'vitest'
import { parseAheadBehind } from '../../src/web/project-git.ts'

describe('porcelain branch header ahead/behind', () => {
  it('parses ahead, behind, both, and none', () => {
    expect(parseAheadBehind('## main...origin/main')).toEqual({})
    expect(parseAheadBehind('## main...origin/main [ahead 1]')).toEqual({ ahead: 1 })
    expect(parseAheadBehind('## main...origin/main [behind 2]')).toEqual({ behind: 2 })
    expect(parseAheadBehind('## main...origin/main [ahead 3, behind 4]')).toEqual({ ahead: 3, behind: 4 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/project-git-sync.spec.ts`
Expected: FAIL — no exported `parseAheadBehind`.

- [ ] **Step 3: Implement**

In `src/web/project-git.ts`:

```ts
/** Ahead/behind from a `git status -b` header; absent when there is no upstream. */
export function parseAheadBehind(header: string): { ahead?: number; behind?: number } {
  const match = /\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/.exec(header)
  if (match === null) return {}
  const result: { ahead?: number; behind?: number } = {}
  if (match[1] !== undefined) result.ahead = Number(match[1])
  if (match[2] !== undefined) result.behind = Number(match[2])
  if (match[3] !== undefined) result.behind = Number(match[3])
  return result
}
```

Add to `GitStatusReport`:

```ts
  /** Commits ahead of the upstream, when the branch tracks one. */
  readonly ahead?: number
  /** Commits behind the upstream, when the branch tracks one. */
  readonly behind?: number
```

And in `gitStatus`'s return:

```ts
  return {
    branch,
    truncated,
    ...parseAheadBehind(header),
    changes: …unchanged…
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/web/project-git-sync.spec.ts tests/web/server.spec.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/project-git.ts tests/web/project-git-sync.spec.ts
git commit -m "feat(web): ahead/behind counts in the git status report"
```

---

### Task 8: Web derive lib + EnvironmentPanel

**Files:**
- Create: `web/lib/processes-view.ts` (pure derivation: rows from events)
- Create: `web/components/chat/EnvironmentPanel.tsx`
- Test: `web/lib/processes-view.spec.ts`, `web/components/chat/environment-panel.spec.tsx`

**Interfaces:**
- Consumes: `SseEvent.processId/command/cwd/exitCode/termination/durationMs` (Task 2), routes (Task 5), `GitStatusReport` JSON (Task 7).
- Produces: `processRows(events)`, `subagentRows(events)`; `<EnvironmentPanel workspaceId sessionId project events connected onOpenView />` consumed by Task 9.

- [ ] **Step 1: Write the failing derive-lib test**

```ts
// web/lib/processes-view.spec.ts
import { describe, expect, it } from 'vitest'
import { processRows, subagentRows } from './processes-view.ts'
import type { SseEvent } from './types.ts'

const ev = (type: string, fields: Record<string, unknown>): SseEvent => ({ type, seq: 0, ...fields }) as SseEvent

describe('processRows', () => {
  it('starts running and settles on exit', () => {
    const rows = processRows([
      ev('process/start', { processId: 'p1', command: 'npm run dev', cwd: 'C:/x' }),
      ev('process/exit', { processId: 'p1', exitCode: 0, termination: 'exited', durationMs: 50 }),
    ])
    expect(rows).toEqual([{ id: 'p1', command: 'npm run dev', status: 'exited', exitCode: 0, startedAt: 0, durationMs: 50 }])
  })
  it('keeps running rows without exit', () => {
    const rows = processRows([ev('process/start', { processId: 'p2', command: 'sleep 5', cwd: 'C:/x' })])
    expect(rows[0]?.status).toBe('running')
  })
  it('later start with same id wins (restart replay safety)', () => {
    const rows = processRows([ev('process/start', { processId: 'p1', command: 'a', cwd: 'x' }), ev('process/start', { processId: 'p1', command: 'b', cwd: 'x' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.command).toBe('b')
  })
})

describe('subagentRows', () => {
  it('derives running and finished children', () => {
    const rows = subagentRows([
      ev('agent/child-spawn', { childSessionId: 'c1', definition: 'researcher' }),
      ev('agent/child-spawn', { childSessionId: 'c2', definition: 'coder' }),
      ev('agent/child-result', { childSessionId: 'c2', status: 'completed' }),
    ])
    expect(rows).toEqual([
      { childSessionId: 'c1', definition: 'researcher', running: true },
      { childSessionId: 'c2', definition: 'coder', running: false, status: 'completed' },
    ])
  })
})
```

- [ ] **Step 2: Implement processes-view.ts**

```ts
// web/lib/processes-view.ts
/** Pure derivation of Environment-panel rows from the session event log. */
import type { SseEvent } from './types.ts'

export interface ProcessRow {
  readonly id: string
  readonly command: string
  readonly status: 'running' | 'exited' | 'killed' | 'failed' | 'interrupted'
  readonly exitCode: number | null
  readonly startedAt: number
  readonly durationMs: number
}

export function processRows(events: readonly SseEvent[]): readonly ProcessRow[] {
  const rows = new Map<string, ProcessRow>()
  for (const event of events) {
    if (event.type === 'process/start' && event.processId !== undefined) {
      rows.set(event.processId, { id: event.processId, command: event.command ?? '', status: 'running', exitCode: null, startedAt: event.timestamp ?? 0, durationMs: 0 })
    } else if (event.type === 'process/exit' && event.processId !== undefined) {
      const row = rows.get(event.processId)
      if (row === undefined) continue
      rows.set(event.processId, { ...row, status: (event.termination as ProcessRow['status']) ?? 'exited', exitCode: event.exitCode ?? null, durationMs: event.durationMs ?? 0 })
    }
  }
  return [...rows.values()]
}

export interface SubagentRow {
  readonly childSessionId: string
  readonly definition: string
  readonly running: boolean
  readonly status?: string
}

export function subagentRows(events: readonly SseEvent[]): readonly SubagentRow[] {
  const rows = new Map<string, SubagentRow>()
  for (const event of events) {
    if (event.type === 'agent/child-spawn' && event.childSessionId !== undefined) {
      rows.set(event.childSessionId, { childSessionId: event.childSessionId, definition: event.definition ?? 'subagent', running: true })
    } else if (event.type === 'agent/child-result' && event.childSessionId !== undefined) {
      const row = rows.get(event.childSessionId)
      if (row === undefined) continue
      rows.set(event.childSessionId, { ...row, running: false, status: event.status ?? 'finished' })
    }
  }
  return [...rows.values()]
}
```

NOTE: `agent/child-spawn` fields (`childSessionId`, `definition`, `status`) must exist on `SseEvent` — check `web/lib/types.ts`; if absent, add optional `childSessionId?: string; definition?: string; status?: string` the same way Task 2 added process fields (and confirm the server projection copies them — the AgentRuns panel already consumes them, so they exist).

Run: `npx vitest run web/lib/processes-view.spec.ts` → PASS. Commit:

```bash
git add web/lib/processes-view.ts web/lib/processes-view.spec.ts
git commit -m "feat(web): derive process and subagent rows from session events"
```

- [ ] **Step 3: Write the failing panel test**

Mirror the boot/render pattern of `web/components/chat/live-markdown.spec.tsx` (testing-library render). Cases:

```tsx
// web/components/chat/environment-panel.spec.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EnvironmentPanel } from './EnvironmentPanel.tsx'
import type { SseEvent } from '../../lib/types.ts'

const ev = (type: string, fields: Record<string, unknown>): SseEvent => ({ type, seq: 0, ...fields }) as SseEvent
const base = { workspaceId: 'ws', sessionId: 's1', project: { id: 'p1', name: 'repo', path: 'C:/repo' }, events: [], connected: true, onOpenView: vi.fn() }

describe('EnvironmentPanel', () => {
  it('renders collapsed chips with git, process, and subagent counts', () => {
    render(<EnvironmentPanel {...base} events={[ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' }), ev('agent/child-spawn', { childSessionId: 'c1', definition: 'r' })]} />)
    expect(screen.getByRole('button', { name: /environment/i })).toBeInTheDocument()
    expect(screen.getByText(/1 process/i)).toBeInTheDocument()
    expect(screen.getByText(/1 subagent/i)).toBeInTheDocument()
  })

  it('auto-expands exactly once per session scope and a user collapse sticks', () => {
    const { rerender } = render(<EnvironmentPanel {...base} events={[ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' })]} />)
    expect(screen.getByText('dev')).toBeInTheDocument()
    rerender(<EnvironmentPanel {...base} events={[ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' })]} />)
    // user collapses
    screen.getByRole('button', { name: /collapse environment/i }).click()
    expect(screen.queryByText('dev')).not.toBeInTheDocument()
    // a NEW start does not reopen (auto-open fired once for this scope)
    rerender(<EnvironmentPanel {...base} events={[ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' }), ev('process/start', { processId: 'p2', command: 'build', cwd: 'x' })]} />)
    expect(screen.queryByText('build')).not.toBeInTheDocument()
  })

  it('resets auto-open for a new session scope', () => {
    const { rerender } = render(<EnvironmentPanel {...base} sessionId="s1" events={[ev('agent/child-spawn', { childSessionId: 'c1', definition: 'r' })]} />)
    rerender(<EnvironmentPanel {...base} sessionId="s2" events={[ev('agent/child-spawn', { childSessionId: 'c9', definition: 'q' })]} />)
    expect(screen.getByText('q')).toBeInTheDocument()
  })

  it('stop button posts to the process stop route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<EnvironmentPanel {...base} events={[ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' })]} />)
    screen.getByRole('button', { name: /stop dev/i }).click()
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws/sessions/s1/processes/p1/stop', expect.objectContaining({ method: 'POST' }))
    vi.unstubAllGlobals()
  })

  it('git row click opens the git workbench view', () => {
    render(<EnvironmentPanel {...base} events={[]} />)
    screen.getByRole('button', { name: /open git/i }).click()
    expect(base.onOpenView).toHaveBeenCalledWith('git')
  })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run web/components/chat/environment-panel.spec.tsx`
Expected: FAIL — no `EnvironmentPanel` module.

- [ ] **Step 5: Implement EnvironmentPanel.tsx**

Structure (use existing primitives: `web/components/ui/` Button/IconButton if fitting, otherwise plain buttons with the Tailwind token classes used across `web/components/chat/`):

- Props: `{ workspaceId: string | null; sessionId: string | null; project: { id: string; name: string; path: string } | null; events: readonly SseEvent[]; connected: boolean; onOpenView: (view: 'git' | 'agents') => void }`
- State: `{ scope, expanded, autoOpened }` keyed by `sessionId`; collapsed = `!expanded`.
- Chips row (collapsed): `<button aria-label="Environment" aria-expanded>` header + chips: git `branch +a −r ↑n ↓m` (from a `useEnvGitSummary` fetch), `N process` (running count, `text-warn` when >0), `N subagent` (running count). Only render the panel at all when `sessionId !== null`.
- Expanded sections:
  - **Git**: one row button `aria-label="Open git panel"` → `onOpenView('git')`; content `branch · +a −r · ↑n ↓m · clean` (fetches `GET /api/workspaces/${workspaceId}/projects/${project.id}/git` on mount and whenever a `turn/end` count changes; hidden when `project === null` or branch null; while loading show the project name).
  - **Processes**: `processRows(events)`; each row: command truncated (`title` = full), status chip (`running` → `text-warn` + Spinner 12, terminal states → `text-fg-muted`, `killed/failed/interrupted` → `text-bad`), live duration for running rows via a 1s `setInterval` tick when any running; Stop button (`aria-label="Stop {command}"`, hidden unless running) → `POST` the stop route, optimistic pending state, on 409/404 just refetch nothing (events will carry truth).
  - **Subagents**: `subagentRows(events)`; row → `onOpenView('agents')`, spinner while `running`, definition as label, terminal `status` chip.
- Auto-open: `useEffect` on first `process/start`/`agent/child-spawn` in `events` — if `!autoOpened && scope === sessionId`, set `expanded = true, autoOpened = true`. Scope change resets `expanded = false, autoOpened = false`.
- Live reconciliation: on mount AND whenever `connected` transitions to `true`, `GET /api/workspaces/${workspaceId}/sessions/${sessionId}/processes` and merge: a GET row `running` whose event-row is settled (or missing) re-marks running — implement as: overlay map `liveOverride: Map<id, 'running'>` from GET running ids, cleared for ids the GET does not list.
- Container classes: `shrink-0 px-3 pt-2 sm:px-6` outer, inner `mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface px-3 py-2 flex flex-col gap-2` (match neighboring composer card styling in `App.tsx`).
- Accessibility: header button `aria-expanded`, `aria-controls="environment-panel-body"`; sections as `<section aria-label="Git"|"Processes"|"Subagents">`.
- `exactOptionalPropertyTypes`: conditional spread for every optional prop.

- [ ] **Step 6: Run tests**

Run: `npx vitest run web/components/chat/environment-panel.spec.tsx web/lib/product-ui.spec.tsx` → PASS.

- [ ] **Step 7: Commit**

```bash
git add web/components/chat/EnvironmentPanel.tsx web/components/chat/environment-panel.spec.tsx
git commit -m "feat(web): environment panel with git, subagents, and background processes"
```

---

### Task 9: App wiring

**Files:**
- Modify: `web/App.tsx` (mount the panel above the Transcript in the `current !== null` branch; pass an `onOpenView` that switches the workbench tab and opens the dock)
- Test: extend `web/lib/product-ui.spec.tsx` if it asserts chat-column composition; otherwise add the mount assertion to `web/components/chat/environment-panel.spec.tsx` via an App-level render smoke only if an existing App harness exists — if none, verify via `npm run build:web` + the live check in Task 10.

**Interfaces:**
- Consumes: `EnvironmentPanel` (Task 8), `inspectorTab`/`patchPreferences` + `onWorkbenchOpenChange` already in App.

- [ ] **Step 1: Wire the mount**

In `web/App.tsx`, import the panel and add a callback near the other workbench helpers:

```tsx
import { EnvironmentPanel } from './components/chat/EnvironmentPanel.tsx'
```

```tsx
  const openEnvironmentView = useCallback((view: 'git' | 'agents') => {
    patchPreferences({ inspectorTab: view })
    onWorkbenchOpenChange(true)
  }, [patchPreferences, onWorkbenchOpenChange])
```

In the `current !== null` branch, immediately BEFORE the `events.length === 0 ? … : <Transcript …>` expression (so it sits between the chat header and the transcript, outside the transcript's own scroller):

```tsx
              <EnvironmentPanel
                workspaceId={activeWs}
                sessionId={current}
                project={currentProject !== null && currentProject !== undefined ? { id: currentProject.id, name: currentProject.name, path: currentProject.path } : null}
                events={events}
                connected={stream !== 'reconnecting'}
                onOpenView={openEnvironmentView}
              />
```

(Adapt `currentProject` to the variable App actually uses for the open session's project — inspect the surrounding code; the Workbench receives `project={workbenchProject}` so mirror its source.)

- [ ] **Step 2: Typecheck + build + focused tests**

Run: `npx tsc --noEmit -p web/tsconfig.json` (or repo equivalent) → clean; `npm run build:web` → succeeds; `npx vitest run web/components/chat/environment-panel.spec.tsx web/components/chat/message-memo.spec.tsx` → PASS (memoization regressions would surface here).

- [ ] **Step 3: Commit**

```bash
git add web/App.tsx
git commit -m "feat(web): pin the environment panel above the transcript"
```

---

### Task 10: Docs, spec amendment, full verification, deploy

**Files:**
- Modify: `docs/harness.md` (background processes section)
- Modify: `docs/superpowers/specs/2026-10-01-environment-panel-background-processes-design.md` (boot-scan amendment)
- Deploy: PM2 restart + live verify on :3082

- [ ] **Step 1: Amend the spec**

Replace the restart paragraph's first sentence "at boot, the host scans each session log" with: "on the FIRST read of each session after boot (sessions load lazily; a boot-time sweep would force-load every log), the host scans that session's events". Behavior is unchanged: before any client can see the session's events, open ids are closed with synthetic `interrupted` exits.

- [ ] **Step 2: Document in docs/harness.md**

Add a "Background processes" section: `Bash run_in_background` contract (immediate id, no timeout, survives the turn, approval unchanged), `BashOutput`/`KillShell`, caps (8/session, 24 host), 64KB head-capped ring, durable `process/start`/`process/exit` vocabulary, restart semantics (first-read synthetic `interrupted`, no re-adopt), session delete kills silently, REST routes.

- [ ] **Step 3: Full suite**

Run: `npm test` → all green except the two known unrelated Windows flakes (escaped Laragon Git Bash descendants, MCP stdio EPIPE after watchdog kill) — if ONLY those fail, note and proceed; anything else fails, fix first.

- [ ] **Step 4: Build + deploy**

Run: `npm run build:web`, then restart the exact PM2 process (`pm2 ls` → identify `mini-dsh` by name AND script path; `pm2 restart <id>`; never `dsh-web`). Verify port 3082 answers.

- [ ] **Step 5: Live verify (per the live tool-row recipe)**

On :3082: open/create a project-scoped session, send a message asking the agent to run `sleep 30` in the background; confirm the panel auto-expands with a running process row; click Stop; confirm the row settles to `killed`. Then check the git row shows the real branch and opens the Git tab.

- [ ] **Step 6: Commit docs**

```bash
git add docs/harness.md docs/superpowers/specs/2026-10-01-environment-panel-background-processes-design.md
git commit -m "docs: background-process contract and the environment panel spec amendment"
```

---

## Self-Review (completed during planning)

- **Spec coverage**: registry+caps+ring (T1), durable events + restart semantics + delete dispose + bridge (T2/T5), Bash background + no-timeout/no-abort (T3), BashOutput/KillShell + no-requiresRoot (T4), REST GET reconcile + POST stop 200/404/409 (T5), modes exposure (T6), git row incl. ahead/behind (T7/T8), panel chips + auto-open-once + sticky collapse + sections + Stop (T8), placement above transcript (T9), docs + live verify (T10). Session-media and Tasks sections: out of scope per spec.
- **Type consistency**: `ProcessRecord.id`/`sessionId`, `ProcessSnapshot` fields, route paths, and `ProcessRow` shapes cross-checked; `kill()` outcome union used identically in T4/T5.
- **Placeholders**: the registry kill/dispose internals, the process-events test scaffold, and `parseAheadBehind` were rewritten in full during self-review — no sketch blocks or TBDs remain. The one instructed adaptation left to execution is wiring `reconcileInterruptedProcesses`'s `entry` parameter to the real `streamEvents` entry type (exact logic given).
