# Task 1 — Attempt accounting and event validation fixes (D1, D11, D13)

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (branch `fix/context-accounting`, after Task 0's merge). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md` §5.2 and §6.

TDD for each item: write the failing test, run it and see it fail for the stated reason, fix, run green.

## D1 — Settled consumer-return drops terminal usage

`src/harness/llm/request-lifecycle.ts`, `runAttempt`: when the provider has called `onTransportSettled()` and yielded a `usage` event, and the consumer then calls `return()` on the iterator before EOF, the code takes the "settled" branch, releases the ticket and never records the terminal attempt fact, so the log keeps only the `start` fact and the usage is lost.

Fix: on that branch, record the terminal fact (state `end`) carrying `contextId` and the last valid usage, exactly once, without producing a false `uncertain` fact and without changing transport-ownership semantics.

Test (in `tests/harness/request-lifecycle.spec.ts`, using its existing helpers): provider stream calls `onTransportSettled()`, yields `{ type: 'usage', usage: { inputTokens: 10, cachedInputTokens: 4 } }`, then the consumer returns immediately after reading the usage event. Assert exactly one terminal fact with that usage and `contextId`, and no `uncertain` fact.

## D11 — `contextAfter` validator too weak

`src/harness/storage/events-jsonl.ts`: the `compaction/end.contextAfter` validator accepts an object with only `budget`/`breakdown`. Require the manifest shape consumers read: `modeId` (string), `modeRevision` (number), `budget` (existing numeric checks), `breakdown` (existing sum check), `history.setting` in `'none' | 'recent' | 'compact'`, `sources.toolNames` (string array), `omissions` (string array). Keep the existing rules (no `contextId`, no usage, finite safe numbers, breakdown sum equals `usedTokens`). Legacy logs without `contextAfter` must still load.

Test (in `tests/harness/storage.spec.ts` next to the existing contextAfter cases): a `contextAfter` missing `history` is rejected; one missing `sources` is rejected; a full valid one loads.

## D13 — Terminal measurement does not trigger a manifest refresh

`web/lib/manifest-refresh.ts`, `manifestRefreshKey`: a terminal `model/attempt` fact (state `end`), or `execution/uncertain` / `execution/reconciled`, that carries a valid `usage` and `contextId` must advance the key. `start` attempts, attempts without usage, and `assistant/chunk` must not.

Use the event shapes already defined in `src/harness/session/events.ts`; find the attempt fact field names there, do not invent them.

Test (in `web/lib/manifest-refresh.spec.ts`; create it next to the module if absent, following sibling `*.spec.ts` style):

```ts
expect(manifestRefreshKey([manifestEvent, terminalWithUsage], 0)).toBe(`${terminalWithUsage.seq}:0`)
expect(manifestRefreshKey([manifestEvent, attemptStart, assistantChunk], 0)).toBe(`${manifestEvent.seq}:0`)
```

## Also (reducer, from the plan's Task 2)

`src/harness/context/context-state.ts`: when the same `attemptId` arrives twice with **different** usage, keep the first, do not count twice, and emit a `console.warn` with a static message (no raw payload). Add one test in `tests/harness/context-state.spec.ts`.

## Verify and commit

```sh
pnpm exec vitest run tests/harness/request-lifecycle.spec.ts tests/harness/storage.spec.ts tests/harness/context-state.spec.ts tests/harness/attempt-events.spec.ts web/lib/manifest-refresh.spec.ts --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
```

Commit: `fix(context): persist settled usage, validate contextAfter, refresh on measurement`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-1-report.md` (RED output reason per item, GREEN counts, typecheck). Return only status, commit hash, one-line test summary, concerns.
