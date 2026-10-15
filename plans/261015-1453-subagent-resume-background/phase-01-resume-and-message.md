---
phase: 1
title: Resume and message
status: in-progress
---

# Phase 1: Resume and message

## Files
- `src/harness/session/events.ts`: extend `session/child-meta` (snapshot fields), `agent/child-result.runId?`,
  new `agent/child-resume`, `input/queued.origin` gains `'parent' | 'child'` and `resume?: true`; exhaustive switch.
- `src/harness/agents/executor.ts`: persist snapshot at spawn; `message()`; shared launch; run-scoped digest,
  reconstruct, recover, reconcile; `currentChildResult`.
- `src/web/agent-delegation.ts`: `message` action + parameters + description.
- Other exhaustive readers of the event union (grep `assertNever`).

## Steps
1. Tests first (`tests/harness/subagent-resume.spec.ts`): AC1–AC5.
2. Event types and snapshot write.
3. `ChildExecutor.message()` under `withAdmission(root)`: ownership, state branch, durable child input, parent
   resume record via `reconcileParentAppend`, fresh `InternalChild`, counters, launch with `adoptPending`.
4. Run-scoped readers (`runEvents`, `currentChildResult`) used by `withResult`, `reconstruct`,
   `recoverFromStorage`, `reconcileOne`.
5. Tool action, then affected tests and typecheck.

## Done when
AC1–AC5 pass, existing g4/subagent specs pass, typecheck clean.
