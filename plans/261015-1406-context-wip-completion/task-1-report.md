# Task 1 report — D1, D11, D13 + reducer duplicate-attempt

Status: DONE. Commit `5b2f585` on `fix/context-accounting` (worktree `.worktrees/context-accounting`). Nothing under `plans/` committed.

## Per item (RED reason → fix)

| Item | File | RED reason | Fix |
|---|---|---|---|
| D1 | `src/harness/llm/request-lifecycle.ts` (`runAttempt` finally) | `expected [] to have a length of 1 but got +0`: only the `start` fact existed after a settled consumer return | `ended` flag set in `notify('end')`; settled branch now calls `notify('end')` once if no end was recorded. It records `end`, not `uncertain`; the ticket is still released first, so ownership is unchanged. |
| D11 | `src/harness/storage/events-jsonl.ts` (`validCompactionMetrics`) | 5 cases resolved instead of rejecting: no `history`, no `sources`, bad `history.setting`, `modeRevision` string, `omissions: [1]` | Require `modeId` string, `modeRevision` number, `history.setting` in none/recent/compact, `sources.toolNames` string[], `omissions` string[]. Existing rules are untouched. |
| D13 | `web/lib/manifest-refresh.ts` | `expected '1:0' to be '3:0'`: terminal measured attempt did not advance the key | New `isMeasurement`: type is `model/attempt`, `execution/uncertain` or `execution/reconciled`; `fact.state !== 'start'`; valid `contextId` and valid `usage`. Reuses `isValidContextId` / `isValidTokenUsage` from `context-metrics.ts`. |
| Reducer | `src/harness/context/context-state.ts` | `expected "warn" to be called 1 times, but got 0` | A repeated `attemptId` is still skipped, keeping the first. It now calls `console.warn('conflicting usage for repeated attempt')` when the usage differs (static message, no payload). |

## Tests added
- `tests/harness/request-lifecycle.spec.ts`: settled consumer-return.
- `tests/harness/attempt-events.spec.ts`: 5 reject cases, plus a test that a full valid `contextAfter` and a legacy row without one both load.
- `tests/harness/context-state.spec.ts`: duplicate attempt with different usage.
- `web/lib/manifest-refresh.spec.ts`: the brief's two assertions, plus usage-less, invalid-usage, `uncertain` and `reconciled` cases.

## GREEN
- The brief's 5-file vitest command: 5 files, 120 tests passed.
- Wider run `tests/harness tests/web web/lib`: 251 files, 3295 passed, 1 skipped.
- `pnpm run typecheck` (both tsconfigs): exit 0.

## Deviations
- The brief says the D11 test goes in `tests/harness/storage.spec.ts`. The existing `contextAfter` cases live in `tests/harness/attempt-events.spec.ts`, so the D11 tests are there. `storage.spec.ts` still ran green.
- `manifestRefreshKey` now takes `Pick<SseEvent, 'seq'|'type'|'fact'>`. Callers pass full `SseEvent`s, and typecheck is green.
- The worktree has an untracked `plans/261014-1328-context-accounting/progress.md`. I left it uncommitted.

## Concerns
- In `runAttempt`, a failure inside `notify('end')` in the finally block would surface to the consumer return. That matches how the `uncertain` branch treats a canonical sink failure.
- `pnpm test` full and `build:web` were not run. Only the harness, web-server and web/lib suites were.

## Fix round 1
Finding: `JSON.stringify` compare in `context-state.ts` warned on a repeated `attemptId` with equal usage but different key order.
- Fix: `src/harness/context/context-state.ts:97` compares `inputTokens`, `cachedInputTokens`, `outputTokens` by value.
- Covering test: `tests/harness/context-state.spec.ts` "does not warn when a repeated attemptId carries the same usage in a different key order". Same values in a different order → no warn; `cachedInputTokens` 4→5 → warns once. It failed before the fix (`expected "warn" to not be called`).
- Command: `pnpm exec vitest run tests/harness/context-state.spec.ts --maxWorkers=1 && pnpm run typecheck`
- Result: 1 file, 9 tests passed; typecheck (both tsconfigs) exit 0.
- Commit: `e792353` `fix(context): compare duplicate attempt usage by value`. `plans/` not committed.
