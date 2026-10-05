# ZCode-style Command Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt ZCode's single-spawn auto-background Bash, bounded watching, and child background lifetime/cancellation semantics.

**Architecture:** Extend the existing ProcessRegistry to own managed execution, waits, background commitment, and lifetime timers. Bash uses that registry in real hosts; a canonical-session event bridge and a child cancellation hook preserve durable ownership. Do not alter interactive PTY terminals.

**Tech Stack:** TypeScript, Node child_process, Vitest, existing kernel context and JSONL sessions.

**Spec:** `docs/superpowers/specs/2026-10-03-zcode-command-lifecycle.md`

## Global Constraints

- Default Bash foreground wait: 120000 ms; maximum request wait: 600000 ms.
- Match ZCode's `sleep` eligibility exception: ineligible foreground commands retain deadline termination.
- A child background process has a 3600000 ms maximum runtime measured from background commitment, including explicit background.
- BashOutput adds `block?: boolean` (default false) and `timeoutMs?: number` (default 30000, maximum 600000).
- Normal child completion does not kill or transfer ownership.
- BashOutput/KillShell remain strictly owner-session scoped, and role/mode/spawn grants still narrow access.
- No process re-adoption or execution resumption on restart.
- Preserve existing workspace changes; no blanket reset, clean, staging, or unrelated edits. Commits below are optional and only on user request because this workspace already has unrelated uncommitted changes.

## Review Focus

- Exit, abort, and foreground deadline race: one spawn, one terminal result, no double process events.
- Spawn rejection/concurrency cap: no untracked live process survives denied registration.
- Child cancellation after normal completion: owner processes remain explicitly stoppable; define behavior for cancel of an already-terminal child without changing its recorded result.
- Delayed event persistence and deletion: no session resurrection, ordering reversal, or unhandled rejection.
- Output pipes held by grandchildren: cancellation and bounded watch settle without inventing a successful exit.

---

### Task 1: Registry-backed single execution and bounded watch

**Files:**
- Modify: `src/harness/processes/registry.ts`
- Modify: `src/capabilities/shell/bash.ts`
- Modify: `src/capabilities/shell/background-tools.ts`
- Modify: `src/harness/limits.ts`
- Test: `tests/capabilities/bash.spec.ts`
- Test: `tests/harness/processes/registry.spec.ts`
- Test: `tests/harness/processes/bash-background.spec.ts`
- Test: `tests/harness/processes/background-tools.spec.ts`

**Interfaces:**
- Consumes: `ToolExecution.sessionId`, `signal`, `root`, `outputLimit`; existing registry ownership and process-tree kill.
- Produces: `ProcessRegistry.wait(sessionId: SessionId, processId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ReturnType<ProcessRegistry['read']>>`; deadline/abort end waiting only.
- Produces: `ProcessRegistry.commitBackground(sessionId: SessionId, processId: string, options?: { maxRuntimeMs?: number }): boolean`; atomic/idempotent commitment; false if terminal or foreign. Add `backgrounded: boolean` to internal ProcessRecord (do not break existing snapshot clients).
- Produces: `ProcessRegistry.cancelSession(sessionId: SessionId): Promise<void>`; kill and await owned live processes with exit callbacks, unlike silent deletion `dispose`.
- Produces: limits `toolTimeoutMs: 120000`, `bashMaxWaitMs: 600000`, `subagentBackgroundBashMaxMs: 3600000`. Document toolTimeoutMs's changed Bash meaning; no change to provider/delegation watchdogs.

- [ ] **Step 1: Write failing tests.** Add named cases `auto_background_preserves_single_execution` (short test wait, command appends once to a temp marker then remains running; returned proc ID later reaches exit 0; marker has one append), `sleep_retains_foreground_deadline`, `background_watch_timeout_does_not_kill`, `background_watch_abort_does_not_kill`, `foreign_session_cannot_watch_or_stop`, `background_max_runtime_kills_once`, `exit_deadline_abort_race_emits_one_terminal`, and `rejected_registration_leaves_no_live_process`. Assert default/max constants equal 120000/600000/3600000. Use deterministic child fixtures/handshakes rather than assertions about a fast echo still running. Keep session-less foreground compatibility tests.
- [ ] **Step 2: Verify RED.** Run `npx vitest run tests/capabilities/bash.spec.ts tests/harness/processes/registry.spec.ts tests/harness/processes/bash-background.spec.ts tests/harness/processes/background-tools.spec.ts`; failures must name missing APIs/new lifecycle expectations, not fixture errors.
- [ ] **Step 3: Implement the interfaces.** Use one managed spawn for session-scoped Bash. Race completion, foreground abort, and deadline with an explicit state transition; detach the foreground abort listener only after background commitment. Ineligible `sleep` and calls lacking registry/session retain bounded foreground execution. Validate/clamp wait arguments to finite positive values. Clear listeners/timers on terminal state, make registry settlement idempotent, and preserve capture/kill/env/cwd behavior. Background maximum cancels the process tree rather than ending the watcher. If pipe closure is delayed, do not report confirmed cleanup while the record remains running.
- [ ] **Step 4: Verify GREEN.** Rerun the command above; all new lifecycle cases pass. Update older timeout tests only where managed-session semantics intentionally changed. Repair the existing echo-is-running fixture in background-tools with a handshake or genuinely long-running fixture.
- [ ] **Step 5: Commit if requested.** Stage only this task's specific hunks, commit `feat: add registry-backed Bash auto-background and watch`.

### Task 2: Host ownership, persistence, and child cancellation

**Files:**
- Create: `src/harness/processes/session-event-bridge.ts`
- Modify: `src/harness/agents/executor.ts`
- Modify: `src/web/server.ts`
- Modify: `src/bins/headless.ts`
- Modify: `src/harness/tools/types.ts`
- Modify: `src/harness/tools/service.ts`
- Test: `tests/harness/processes/process-events.spec.ts`
- Test: `tests/harness/processes/server-processes.spec.ts`
- Create: `tests/web/child-process-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Task 1 registry APIs and limit fields; kernel sessions `load`, `has`, `durable`; trusted `agentScope.childOf`.
- Produces: `createProcessSessionEventBridge(sessions: { has(id: SessionId): boolean; load(id: SessionId): Promise<{ append(event: unknown): unknown; durable(): Promise<void> }> }): { onStart(record: ProcessRecord): void; onExit(record: ProcessRecord): void; flush(sessionId: SessionId): Promise<void> }`. Serialize writes per session, latch failures for flush, never load an absent/deleted session.
- Produces: optional trusted ToolExecution metadata `turnId?: string`, `subagentBackgroundBashMaxMs?: number`, stamped by ToolsService from current scope/limits (not model arguments). Bash passes turnId to registry and child maximum on background commitment.
- Produces: kernel context services `processes` and `process-events` mounted in both hosts. Executor uses them to cancel owner processes and flush event bridge before advertising child cancellation.

- [ ] **Step 1: Write failing host tests.** In `child-process-lifecycle.spec.ts`, run real Bash through a scripted child model and assert: explicit background plus normal completion remains running and owner is child; cancellation with a Bash-only grant kills it before cancel resolves; child log has ordered process/start and exactly one process/exit; foreign/root direct tool use cannot read/kill child IDs while authorized child-session routes can; short configured child max kills but equivalent root command survives. Add `cancel_terminal_child_cleans_process_without_rewriting_result`: cancel already-completed child performs process cleanup but preserves its recorded completed handle. Add bridge tests for start+immediate exit ordering, persistence rejection surfaced by flush, and delete during queued append with no recreation. Add restart-interrupted child log case without re-spawn.
- [ ] **Step 2: Verify RED.** Run `npx vitest run tests/web/child-process-lifecycle.spec.ts tests/harness/processes/process-events.spec.ts tests/harness/processes/server-processes.spec.ts`; confirm failures are new behavior gaps.
- [ ] **Step 3: Wire hosts and executor.** Provide registry/bridge in kernel context; replace root-only callback lookup with canonical session bridge. Stamp child limits/turn identity in execution context. Await `cancelSession` and bridge flush in child cancellation including already-terminal child cleanup, without rewriting the child result. A normally completed child remains untouched; keep existing no-restart/no-message behavior. Use silent dispose only for actual session deletion; ensure shutdown kills host processes. Failure to confirm cleanup/persistence must surface rather than advertise clean cancellation. Do not introduce parent ownership or broader tool authority.
- [ ] **Step 4: Verify GREEN.** Rerun Step 2 plus `npx vitest run tests/harness/g4-subagent-contract.spec.ts tests/web/server-subagents.spec.ts`; lifecycle, durability, and delegated result tests pass. Add/check a foreground abort fixture with grandchild-held pipes and prove bounded wait does not fake exit success.
- [ ] **Step 5: Commit if requested.** Commit only task hunks as `fix: preserve child process ownership and cancellation evidence`.

### Task 3: Role contracts, access regression, and docs

**Files:**
- Modify: `src/harness/agents/definition-service.ts`
- Modify: `tests/harness/g4-agents.spec.ts`
- Modify: `tests/web/child-process-lifecycle.spec.ts`
- Modify: `docs/capabilities.md`
- Modify: `docs/harness.md`
- Modify: `tests/harness/processes/mode-exposure.spec.ts` only if assertions need new BashOutput parameters

**Interfaces:**
- Consumes: Task 1 command/watch contract and Task 2 session ownership.
- Produces: verifier tools `['Read', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell']`; worker retains existing shell set. Role reports never interpret a running task as a completed check.

- [ ] **Step 1: Write failing tests.** Assert verifier exact lifecycle tools. Add host Worker cases: allowed Bash performs a temp-file side effect; `grantTools: ['Read']` denies it and file is absent; Plan mode and explicit policy deny also produce denial with file absent. Require tests to inspect actual tool denial/results, not merely completed child status. Existing explorer/reviewer read-only sets remain unchanged.
- [ ] **Step 2: Verify RED.** Run `npx vitest run tests/harness/g4-agents.spec.ts -t 'agent definitions'` and the new host cases; verifier set assertion fails before edits.
- [ ] **Step 3: Update roles/docs.** Give verifier lifecycle tools, explain foreground auto-background and BashOutput bounded waits to worker/verifier, and require incomplete checks to be reported as incomplete. Explain root Stop versus child cancel, retained child ownership, 1-hour child background maximum, sleep/session-less exceptions, configurable 120s/600s waiting, and unchanged PTY semantics. Preserve unrelated doc hunks.
- [ ] **Step 4: Verify integration.** Run `npm run typecheck`, `npx vitest run tests/capabilities/bash.spec.ts tests/harness/processes tests/harness/g4-agents.spec.ts tests/harness/g4-subagent-contract.spec.ts tests/web/child-process-lifecycle.spec.ts tests/web/server-subagents.spec.ts`, then `npm test` and `git diff --check`. Record non-green results honestly; known observations before this work include g4 cleanup ENOTEMPTY and TS2379 in unrelated `web/lib/ansi.ts`, but do not assume any new failure is baseline without checking. Request an independent reviewer for state races, cleanup durability, and access regression before completion.
- [ ] **Step 5: Commit if requested.** Commit only task hunks as `docs: document ZCode-style command lifecycle and roles`.

## Self-review

Spec coverage: all command paths, waiting, owner scope, child cancellation/normal completion/max runtime, event persistence, limits, compatibility, and non-goals map to tasks 1–3. Interfaces use one registry and one canonical bridge; no ownership transfer is introduced. Review Focus cases are assigned to explicit tests above. Runtime/background output storage redesign and interactive PTY modifications are deliberately excluded.
