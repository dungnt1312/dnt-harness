---
phase: 0
title: "Harden the child lifecycle boundary"
status: todo
priority: P1
effort: "5h"
dependencies: []
---

# Phase 0: Harden the child lifecycle boundary

## Overview

Make the existing delegation lifecycle safe enough for the new prompt and result contracts to rely on. A child must remain a child on every execution path, a spawn must belong to the parent workspace and project, failed pre-launch work must not leave a durable orphan, and process-memory indexes must not grow forever.

<!-- Updated: Validation Session 1 - added as the prerequisite selected during validation -->

## Requirements

Functional:

- Reject direct message/run requests for a session carrying `session/child-meta`. A child session is driven only by `ChildExecutor`; this plan does not add resume.
- Before creating or mutating child state, `ChildExecutor.spawn()` resolves the parent and verifies that its workspace and project match `SpawnRequest.workspaceId` and `projectId`.
- Keep capacity reservation atomic after asynchronous ownership/depth preflight: once capacity checks begin, no `await` may occur between checking and incrementing the active counters.
- Move every failure-prone dependency check that can run before persistence ahead of child-session creation.
- If child metadata becomes durable but the parent relationship does not, compensate by deleting the newly-created child session. If the parent relationship is already durable, later launch failure becomes a settled failed child with a durable error rather than an orphaned session.
- Recovery ignores and reports child metadata whose parent is missing or whose workspace/project ownership is inconsistent.
- Active children stay in the in-memory executor map. Settled handles remain queryable by reconstructing their result from durable child events, using the same code path as restart recovery, rather than retaining every settled child forever.
- Per-turn reservation keys are removed when the parent turn reaches its terminal lifecycle hook. Root/session deletion clears any remaining executor indexes and cached manifests for that root.

Non-functional:

- Preserve old logs: recovery must continue reading current `session/child-meta` and `agent/child-spawn` events.
- Do not introduce child resume, nesting, worktrees, or a child whole-run/turn-level
  writer lease; the existing registered-root turn lease remains unchanged.
- Cleanup must not make a settled child disappear from `list`, `wait`, the Workbench panel, or chat delegation detail.

## Architecture

### Child-only execution boundary

The session message route currently loads any stored session and can create a normal Agent without `childOf`. Add a guard after session resolution and before agent creation/message acceptance: when the session log contains `session/child-meta`, return a conflict response explaining that child sessions are executor-managed and cannot be resumed directly.

This is enforcement, not documentation. It preserves the definition snapshot, tool ceiling, skill preload, approval metadata, and no-nesting identity installed by `ChildExecutor`.

### Spawn ownership and compensation

`ChildExecutor.spawn()` performs this order:

1. Resolve the parent session and verify workspace/project ownership.
2. Check that the parent is not itself a child.
3. Preflight the agent service and other launch dependencies.
4. Reserve active/per-turn capacity synchronously, with no `await` between check and increment.
5. Create the child session and append `session/child-meta` durably.
6. Append the parent `agent/child-spawn` relationship durably.
7. Construct/register the child agent and launch it.

Rollback rules:

- Failure before step 5: release reservations only.
- Failure after step 5 but before step 6: delete the newly-created child session, then release reservations.
- Failure after step 6: keep the relationship and settle the child as failed with a durable terminal record and explicit `failure`; release active capacity, but keep the per-turn attempt charged until the parent turn's terminal cleanup hook.

### Bounded indexes

Factor the existing recovery reconstruction into a reusable loader that can derive a settled `ChildHandle` from durable child events. `children` remains the active-process index, not permanent history. Query methods merge active handles with durable reconstructed handles for the requested root.

A reconstructed handle reports the same fields an active one does: `result` and `failure` come from the phase 2 result contract (`withResult`), so a settled child's card looks identical whether its entry is live or reconstructed.

Delete `spawnedPerTurn` entries from the root terminal-turn hook (the `agent/turn-settled` hooks in `src/web/server.ts`) and clear root-scoped executor/manifest state when a session is deleted. Tests assert behavior through public list/wait/spawn operations; no production-only debug accessor is added.

## Related Code Files

- Modify: `src/harness/agents/executor.ts` — ownership checks, spawn ordering, compensation, durable handle reconstruction, bounded indexes
- Modify: `src/harness/session/events.ts` only if an explicit failed-launch terminal event is required; prefer existing compatible terminal events
- Modify: `src/harness/session/service.ts` / session service implementation — safe deletion of a newly-created orphan when needed
- Modify: `src/web/server.ts` — block direct child messages, root terminal/delete cleanup hooks, manifest cleanup
- Modify: `src/web/agent-delegation.ts` — consume reconstructed settled handles without changing the public async action shape
- Modify: `tests/harness/g4-agents.spec.ts`
- Modify: `tests/web/server-g4.spec.ts`
- Modify: `docs/harness.md`, `docs/capabilities.md`, `docs/web.md`

## Implementation Steps

1. Add failing tests for foreign-workspace/project spawn requests, direct child-session messages, child-meta persistence followed by parent-durability failure, post-relationship launch failure, and settled-handle retrieval after in-memory eviction.
2. Add parent ownership validation and move dependency preflight before child session persistence.
3. Implement the two compensation paths. Before the parent relationship commit, rollback
   both active and per-turn reservations exactly once; after the commit, settle the child
   as failed, release active capacity only, and leave the spawn attempt charged to the
   per-turn quota until the terminal-turn cleanup hook.
4. Extract durable handle reconstruction from restart recovery; use it for list/wait/cancel lookups after settled entries are evicted.
5. Evict settled active-map entries only after their terminal state is durable. Clear per-turn/root indexes at existing root lifecycle hooks.
6. Add the direct child-session route guard before a normal Agent can be created.
7. Make recovery skip and log missing/foreign parent relationships.
8. Update documentation with the executor-only child boundary and the fact that resume remains unsupported.

## Success Criteria

- [x] Direct POST/message execution against a child session is rejected before a normal Agent is created.
- [x] `ChildExecutor.spawn()` rejects a parent whose workspace or project differs from the request before creating child state.
- [x] A failure before the parent relationship becomes durable leaves no child session on disk.
- [x] A failure after the parent relationship becomes durable produces a queryable failed child with an explicit error.
- [x] A settled child remains visible through list/wait and both UI surfaces after its active-map entry is evicted.
- [x] Recovery does not register a child whose parent is missing or belongs to a different workspace/project.
- [x] Capacity check-and-reserve remains synchronous after asynchronous preflight.
- [x] Per-turn/root indexes and last-manifest entries are cleared at their lifecycle boundary.
- [x] Existing approval relay, model pinning, child result recovery, and one-level delegation tests remain green.
- [x] `npm run typecheck` and the targeted G4 harness/web suites pass.

## Risk Assessment

**Eviction can make historical children disappear.** *Signal:* list/wait or a delegation card loses a settled child after eviction. *Response:* do not evict until durable reconstruction passes the same contract tests as restart recovery.

**Compensation can delete a legitimate session.** *Signal:* deletion occurs after the parent relationship is durable or for a session not created by the current spawn attempt. *Response:* retain the newly-created session id as a local transaction token; deletion is allowed only before the parent relationship commit point.

**Route blocking accidentally blocks root sessions.** *Signal:* a normal session with no `session/child-meta` receives the child-only error. *Response:* derive the guard from durable child metadata, not URL shape or in-memory executor membership.

**Reservation races return.** *Signal:* four concurrent spawns pass a limit of three. *Response:* asynchronous ownership/depth checks may precede reservation, but the check-and-increment block itself must contain no `await`; keep the concurrency regression test.