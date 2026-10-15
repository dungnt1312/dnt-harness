# Task 4 — SSE and manifest API publication (D2, D3, D14)

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (after Tasks 0–3). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md` §4 (invariants 1, 3, 7) and §6.

TDD for each item.

## D2 — Live SSE client never receives the held compaction/end

The SSE path in `src/web/server.ts` (search for the durability gate that holds an uncommitted successful `compaction/end`; it listens to `session/durable`) starts holding **after** the success event, so the success event itself is not queued. A client that was already subscribed when the success was appended never receives it after commit. Existing tests in `tests/web/sse-resume.spec.ts` open a new reader only after release, so they miss this.

Fix: the event that opens the hold is queued first; every later event is queued behind it; on `session/durable` covering it, drain in seq order; on a failed end, drop the hold and deliver nothing for the uncommitted success. Snapshot/resume cursors must still name the last included seq.

Test (`tests/web/sse-resume.spec.ts`, using its deferred-flush fixture): subscribe a reader **before** the compaction runs; park the flush; append success; assert the reader has not received it; release the flush; assert the reader receives the success exactly once, followed by later events in seq order. Rejected flush: the reader never receives the success.

## D3 — New assembly shows the previous assembly's reported usage

The `/manifest` handler's fast display for a live manifest that is not yet durable copies `committedView.usage` including `usage.last` from the committed assembly A onto the new assembly B. That breaks "usage pairs only with its own `contextId`".

Fix: when the displayed manifest's `contextId` differs from the committed view's, drop `usage.last`; keep session cache totals.

Test (`tests/web/server-context-accounting.spec.ts`): after request A reports usage, hold B's manifest before the barrier (use the existing deferred-store pattern); GET `/manifest` shows B's estimate with no `usage.last`, and the totals equal A's.

## D14 — GET replays the whole log

Each GET `/manifest` replays the full committed log through the reducer. Keep one incremental reducer per session (`createContextReducer(session.id)` from `src/harness/context/context-state.ts`) with the last applied seq; on GET apply only the committed suffix. Reset when the session instance changes or the event prefix is replaced (compare the session object identity and a check that the stored last seq still exists with the same type). Delete the cache entry when a session (or its children) is deleted.

Test: replay-from-scratch equals incremental application for the same events (pure test in `tests/harness/context-state.spec.ts` if not already present), and a server test that two GETs around a new terminal fact give the same result as a fresh server reading the same home.

## Verify and commit

```sh
pnpm exec vitest run tests/web/sse-resume.spec.ts tests/web/server-context-accounting.spec.ts tests/harness/context-state.spec.ts tests/harness/storage.spec.ts tests/web/server-g3.spec.ts tests/web/server-usage.spec.ts --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
```

Use the files that exist. Commit: `fix(web): deliver held compaction to live SSE clients; pair usage by context id; incremental manifest state`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-4-report.md`. Return only status, commit hash(es), one-line test summary, concerns.
