# Task 2 report: child recovery reads only unsettled children

Status: DONE_WITH_CONCERNS (one-time rebuild cost on first upgraded boot; corrupt-log divergence noted below)
Commit: 0606b40 `perf(agents): index settled children from session summaries at boot` (pushed fast-forward, 07d3b0b..0606b40)

## What changed
- `src/harness/storage/file-session-store.ts`: new optional summary field `childRecovery: ChildRecoveryFacts`
  - `meta?: { background, projectId: string|null } | null` (newest `session/child-meta`; null = none)
  - `boundProjectId?: string | null` (newest `session/project`; null = unbound/never)
  - `children: Record<childId, 'open'|'settled'|'reported'>` for every spawn this log committed, judged on the current run (newest result after newest spawn/resume; `reported` = a child-origin `input/queued` after that result)
  - A key is omitted when the log value is malformed in a way the canonical read would judge differently (e.g. child-meta `projectId: null`, non-string project) → unknown → canonical path.
  - `readSummary` validates the shape; an invalid field makes the summary invalid → boot rebuild (existing pattern).
- `src/harness/session/child-recovery-facts.ts` (new): one forward pass deriving the facts; mirrors `currentRun`, `reportQueuedAfter`, `childMetaOf`, `boundProject`.
- `src/harness/session/service.ts`:
  - `summarize` and `rebuildSummary` both project `childRecovery`, so every append path (persistSummary after durable) and every boot rebuild keep it current.
  - `boot()` rebuilds a summary missing `childRecovery` (same as the other projected fields), and still rebuilds on lastSeq ≠ canonical tail.
  - New `durableSummary(id)`: the persisted summary of a stored session that is **not loaded/loading** (boot-verified against the tail; nothing appends to an unloaded session). Loaded sessions return undefined because their live summary may include non-durable appends.
- `src/harness/agents/executor.ts` `recoverFromStorage()`:
  - Per parent, compute verdicts from `durableSummary` facts. Settled = well-formed child meta, same workspace, parent facts present with a binding that matches meta.projectId (when set), and parent state `reported`, or `settled` for a non-background child.
  - Settled children: `indexChild` + count only, no reads. The parent log is read (once, at group start as before) only when at least one child is unsettled. Unsettled/unknown children go through the unchanged canonical code (warnings, owed background, reconcile).
  - `SessionsLike.durableSummary` is optional; without it everything takes the canonical path.
- `tests/harness/storage.spec.ts`: a stub store's summary now includes `childRecovery`. Otherwise boot rebuilds it, and that test's gated `read` deadlocks.

## Tests (`tests/harness/child-recovery-summaries.spec.ts`, 6)
- **Equivalence:** one fixture store is copied twice. One copy runs the canonical algorithm: `durableSummary` is mocked to undefined, which is the unchanged old code. The other copy runs the new algorithm. The fixture covers:
  - settled children (plain, project-bound, reported background, resumed then settled)
  - a crash after spawn with an open turn, and one with no turn
  - an owed background report
  - a resumed run that crashed
  - an uncertain child (terminal turn, no result)
  - a missing parent, a foreign workspace, an uncommitted spawn, a project mismatch
  - an old-format summary (`childRecovery` stripped from summary.json)

  The two runs give identical results for the recovered count, the per-root index, the owed sets, the reconcile calls in order, the skip warnings, and the parent result records afterwards. The canonical verdicts are also pinned explicitly (10 recovered, 3 reconciles, 4 warnings).
- **Read counts:** settled children are never read through `readCanonicalEvents`, and a parent whose children are all settled is not read either. Unsettled and skipped children are read.
- **Next boot:** after reconcile, crashed children become settled with zero reads. Only the owed, uncertain and skipped children and their root are read.
- **Old summary:** boot rebuilds it and the facts are written to disk. The root's per-child states are as expected.
- **Loaded session:** `durableSummary` is undefined.
- **Facts unit:** a result before the spawn, reset on resume, a report before the result, a non-terminal status, malformed values left out.

RED: 4/4 failed before the implementation (no `durableSummary`; the settled children were read).
GREEN:
- the new spec: 6/6
- related specs (storage, session, g1-lifecycle, g4-agents, g4-subagent-contract, subagent-background/resume, root-mode-migration): pass
- `bun run typecheck`: clean
- `bun run test --maxWorkers=3`: 375 files, 5178 passed, 2 skipped, exit 0 (241 s)

## Timings (APFS clone of real data, oauth/mcp-owner removed, Bun 1.4.3; clones deleted)
Scratch script (`scratchpad/t2/measure-recovery.ts`): sessions.boot + recoverFromStorage, 1200 sessions.
| Mode | sessions.boot | recovery | reads | recovered |
|---|---|---|---|---|
| canonical (old), boot 1 | 10.1 s* | 4.5 s | 906 | 837 |
| canonical (old), boot 2 | 0.27 s | 3.8 s | 906 | 837 |
| summaries, boot 1 (old summaries rebuilt) | 10.1 s* | 2 ms | 0 | 837 |
| summaries, boot 2/3 | 0.29 / 0.16 s | 1 ms | 0 | 837 |

\*In both modes, boot 1 rebuilds every summary that lacks `childRecovery`. This is a one-time full read of each log. Note that the canonical clone also ran new code, so it rebuilt as well.

Web host on the clone (`HOME=<clone> bun src/bins/web.ts --port 3999`), time until the first HTTP response:
- run 1: 7.8 s. This includes the one-time root-mode migration scan, because the real home has no marker since the live host runs older code. The summaries were already rebuilt by the script.
- runs 2 and 3: 0.61 s and 0.36 s, against 4–5.5 s after Task 1.

Every host process was stopped, port 3999 is free, and the clones are deleted.

## Concerns
- First boot after upgrading rebuilds every pre-existing summary once (about 10 s on real data, the same pattern as earlier projected fields). Without it, untouched settled children would never get facts and would never get faster.
- Corrupt-log divergence: a log whose tail line is valid but which has a corrupt record in the middle keeps a trusted summary. The old path's read would throw and silently skip that child, or warn "parent missing" for an unreadable parent. The new path indexes a settled child from its summary. This is the same trust class as the deferred Task 1 note on replaced logs. Recovery only indexes ids, and reading the child later still surfaces the error.
- Summaries now carry a per-child state map on parents. It is small, and the listing API copies explicit fields only, so nothing new reaches clients.
