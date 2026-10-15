# Task 4 report — SSE held compaction, usage pairing, incremental /manifest

Status: DONE. Worktree `.worktrees/ctx-task4`, branch `fix/ctx-task4`, base b14f922.

## Commits
- `1671d75` D2: deliver a held compaction success to already-subscribed SSE clients once durable
- `2132a09` D3: never pair a new assembly with the previous assembly's usage.last on /manifest
- `a17e896` D14: incremental per-session context reducer for GET /manifest

(The brief named a single commit message. I split the work into three commits, one per item, so each RED/GREEN pair stays reviewable.)

## Changes
- `src/web/server.ts`, `streamEvents` (~L10655–10730):
  - The live `session/event` listener now puts the uncommitted successful `compaction/end` at the head of the hold queue. Before, it opened the hold without queueing the success.
  - A stream that opens while a hold is active seeds its queue with the held success and the tail already appended behind it. Its snapshot/resume replay still stops at `heldSeq - 1`, so the cursor still names the last included seq.
  - On a failed end, the queue head (the uncommitted success) is dropped, the events queued behind it are released, and then the failed end is sent.
  - Added a shared `toFrame` helper.
- `src/web/server.ts`, `/manifest` handler (~L7573–7587): when the live manifest's `contextId` differs from the committed view's, the response now carries only `cacheableInputTokens`/`cachedInputTokens`. `usage.last` is dropped.
- `src/web/server.ts`, reducer cache:
  - New `contextReducers: Map<SessionId, ContextReducerCache>` in the server state, `HandlerDeps` and the deps object.
  - New `committedContextView()`, placed just above `forgetSessionState`. It resets when the session object identity changes, or when the remembered last `{seq,type}` is no longer at `events[seq-1]`. Otherwise it applies only `committedEvents.slice(last.seq)`.
  - `forgetSessionState` deletes the entry for the session and for each of its children.
  - The `deriveContextState` call at ~L1628 (compaction code) is unchanged.
- Tests:
  - `tests/web/sse-resume.spec.ts`: added an `openReader` helper and two tests. (1) A reader subscribed before the compaction, with the flush parked, gets nothing; after release it gets the success exactly once, then `session/pinned` after it, with seqs strictly increasing and no duplicates. (2) A reader subscribed before a rejected flush never receives the success.
  - `tests/web/server-context-accounting.spec.ts`: added the D3 test. The flush is parked only once a second `context/manifest` is in the log. GET returns B's contextId, has no `usage.last`, and its totals equal A's. Also added the D14 server test: two GETs around a new turn's terminal fact equal what a freshly booted server returns from the same home.
  - `tests/harness/context-state.spec.ts`: added a test that incremental application at every split of every prefix equals replay from scratch.

## RED reasons
- D2: `expected [] to have a length of 1 but got +0`. The live reader never received the success after commit.
- D3: `expected { inputTokens: 120000, … } to be undefined`. B showed A's `usage.last`.
- D14: no RED. This is a performance change and behaviour is identical. Both the pure test and the server test passed before the cache was added and still pass after. They guard equivalence; they do not prove the bug existed.

## Verification
- Brief command (6 files, `--maxWorkers=1 --no-file-parallelism`): 6 files, 86 tests passed.
- `pnpm run typecheck`: passed.
- `pnpm test`: 342 files, 4391 passed, 2 skipped.
- `pnpm run build:web`: not run (no web changes).

## Concerns
- When a failed end arrives, the events queued behind the dropped success are released, then the failed end is sent. In practice the success path does not append a failed end itself; a rejected barrier leaves the hold open. So on a poisoned session, the live stream stays held until reconnect. That matches the earlier behaviour for already-held streams.
- The cache's reset check assumes `seq === index + 1`, which holds because `Session.append` sets it. A replaced prefix of identical length with the same type at the last seq would not be detected; the session-identity check covers reloads.
