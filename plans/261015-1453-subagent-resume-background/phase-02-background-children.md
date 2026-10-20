---
phase: 2
title: Background children
status: completed
---

# Phase 2: Background children

## Files
- `src/harness/agents/definition-service.ts`: parse/enforce `background` boolean.
- `src/harness/agents/executor.ts`: `background` on `SpawnRequest`/`InternalChild`/snapshot; skip in
  `turnChildren` and `resolveForRootCompletion`; owed background reports per root; watcher count in `wait`;
  Stop suppression; `onBackgroundSettled` option.
- `src/web/server.ts`: generalize `queueHookRewake` to take the origin; wire the executor callback.
- `src/harness/agent/agent.ts`, `src/harness/agent/types.ts`: `'child'` origin admitted as `continuation`.
- `web/lib/project.ts`: hide queued `origin: 'child'` like hook rewakes.
- `src/web/agent-delegation.ts`: `background` spawn param.

## Steps
1. Tests first (`tests/harness/subagent-background.spec.ts` + a server-level wake test): AC6–AC8.
2. Executor and definition changes.
3. Host wiring and origin plumbing.
4. Web projection; build:web.

## Done when
AC6–AC8 pass, full suite and typecheck clean, web build passes.
