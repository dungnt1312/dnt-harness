# Effective-context compaction: verification report

Date: 2026-10-14. Worktree: `.worktrees/effective-context-compaction`, branch `feat/effective-context-compaction`, base `7bef5dd`. Nothing is committed.

## Outcome

All ten tasks of `plans/261013-2237-effective-context-compaction/plan.md` are implemented and tested in the worktree, behind two switches that are off by default (`compactionEffectiveEnabled`, `compactionPrecomputeEnabled`). With both off, behavior is the old fold, unchanged.

What has **not** been shown is the thing that started this work: that a real compaction is faster. The only evidence is a scripted provider. That proves the number of model requests (the old fold needs at least 7 for the benchmark session, the new path needs 1, and 0 when a background summary is ready). It proves nothing about seconds. No live run was done because the plan requires approved spend; the live gate is **pending, not passing**.

## Verification

| Check | Result |
|---|---|
| `pnpm run typecheck` | clean |
| `pnpm run build:web` | succeeds (the existing chunk-size warning remains; `web-dist` is gitignored) |
| Full `pnpm exec vitest run` | 307 files, about 3847 tests. Nine runs on the branch (six before the progress/Stop work, three after). Two of the nine were fully green; the other seven had 1 to 5 failures each, all in the tests listed below |
| New and changed compaction specs | all pass: adoption 25, projection 27, snapshot 16, restoration-context 10, capture 14, generator 33, host 43, source 13, wiring 11, restart 7, restoration 17, precompute 33, benchmark 3, server-effective 9, server-precompute 7, server-progress 6, web `api-compact` 7, `project-compaction` 24, `session-derived` 2, plus `request-lifecycle` (35) and `product-ui` (181) |
| Existing `tests/web/server-compaction.spec.ts` | passes unchanged (the old fold is not regressed) |

### Failing tests in the full runs, by name

Nine full runs on the branch produced these failures, never more than five in one run:

- `server-g1 > input acceptance over REST > steer > delivery:steer stops the running turn and runs the old queue plus the new message`, `… > POST /steer runs input a stop left queued …`, `… > a queued input can be edited and deleted until a turn claims it`
- `server-g5 > G5 web MCP + hooks > MCP schema and execution are isolated per workspace even with the same public name` (3 of 9)
- `path-scope-guard > executions sharing a model call id keep separate matches` (2 of 9)
- `server-g4 > the model delegates for itself: two children run at once …` (2 of 9)
- `project-git-sync.spec.ts` failed to load once (1 of 9)

Every one of them passed when its file was run alone (`server-g5` 22/22 three times, `server-g1` 18/18 twice, `path-scope-guard` 3/3 three times).

**Baseline comparison.** I ran the same full suite on a clean checkout of `7bef5dd` seven times. Four of the seven had failures, and one of them (run 7) had seven at once: `server-g1` steer tests (three different ones), `path-scope-guard`, `server-g2 > two workspaces on different providers never cross streams`, `server.spec > per-session folders > scopes filesystem tools to each session folder`, `server-g4 > the model delegates for itself`, and `project-git-sync.spec.ts`. So the `server-g1` and `path-scope-guard` failures pre-date this branch.

The baseline also showed `server-g4 > the model delegates for itself` and `project-git-sync.spec.ts` failing, so those two are not new either.

One point I cannot close: `server-g5 > … isolated per workspace` failed on the branch in 3 of 9 full runs and in 0 of 7 baseline full runs. In isolation it passed 12 of 12 on the branch and on the baseline, under heavy CPU load. The test sleeps a fixed 250 ms before asserting, so it is timing sensitive, and I found no code path in this work that touches MCP tool exposure. But 0 of 7 against 3 of 9 is not proof of equal flakiness. Treat it as unresolved until it is run more times or the test is made deterministic.

## What was built

| Task | Delivered |
|---|---|
| 1 | Typed projection and source policy (`compaction-projection.ts`) |
| 2 | Snapshot schema, sidecar store, `context/snapshot` event |
| 3 | Capture at the `llm/stream` seam, promotion at `agent/turn-settled` |
| 4 | Single-request generator with output cap, one deadline, one re-ask |
| 5 | Adoption of a summary whose cutoff is older than the newest turn, with a proof in the log |
| 6 | Foreground host, rollout limits, slow recovery that needs confirmation, reload after restart |
| 7 | `compaction/restoration` (task list, running work, skills, current files) within the caps in the spec |
| 8 | Low-priority provider admission and the candidate manager |
| 9 | Background trigger after a turn settles, guarded adoption, hook once, delete and shutdown cancel |
| 10 | UI confirmation for slow recovery, no restoration text on the wire, docs, benchmark and fixture. **Added after review (10:13):** durable `compaction/job` progress events (preparing, generating, applying, ended), one transcript row per operation with the stage and a live elapsed time, Stop that cancels a compaction in flight (including the model request) and a "Stop compaction" button in the composer; a cancelled compaction is reported as cancelled, not as a failure. The first version of this report called Task 10 done without these; that was incomplete |

Also changed along the way: `tokensAfter` in `compaction/end` is now the reported size minus the estimated saving plus the restoration, instead of a flat 20%.

## Mutation checks

After each task I broke the code on purpose and confirmed a test failed. Some survived at first and led to new tests: the 256-token minimum gain had no server-level test; the "question must not reappear after the turn ends" case in the UI; the "failed end must not carry a restoration" cases; and a ready candidate that held the slot forever. All of those are now caught. Mutations on `compaction-restoration.ts` covered the grant check, the success filter and the total cap; I did not mutate the per-file and per-skill caps individually.

## Rulings I made

Each is also in `progress.md`. If one is wrong, the cost is stated.

1. Ledger and briefs live under the plan directory, because Markdown is restricted to `plans/` and `docs/`. Cost: no standard scripts.
2. Nothing is committed. Cost: the work exists only in the worktree.
3. Switched from SDD to TDD on your instruction; no subagent was used, so the Sonnet 5.5 and GPT 6.1 Sol or Opus 5.5 routing you set earlier never applied.
4. Safe-to-clear tools are `Read`, `Glob`, `Grep`, `Bash`, `BashOutput` when successful and already read. Everything else, and every error result, counts as unknown loss. Cost if too strict: sessions with many `Write`, `Edit` or MCP calls that were cleared from the request fall back to slow recovery. It is one list, `SAFE_CLEAR_TOOLS`.
5. Both switches default to off. Cost: nothing changes until someone turns them on.
6. Adoption requires the candidate's seed to equal the standing checkpoint. Cost: a candidate written before another compaction is regenerated.
7. After a restart the newest snapshot reference is reloaded and re-verified. If the sidecar is missing or altered, the server asks for recovery. It does not rebuild from the log. Cost: slow recovery after losing the sidecar.
8. `compaction/restoration` counts only for the successful end with the same cutoff and summary. Cost: one more event per compaction.
9. The browser receives the status of each restored item, never the restored text. Cost: the UI cannot show it.
10. A background candidate runs under its own ownership id and low priority, so it cannot fence the next chat turn. Cost: its stuck transport is tracked separately.
11. A finished candidate that is stale or no longer worth adopting is replaced by a newer snapshot; a usable one is kept. Cost: at most one background summary per session.
12. `providerGeneration` is the constant 1, because the provider layer exposes no generation. Cost: reconfiguring a provider alone does not discard a candidate (model, mode and grant changes do).
13. The composer `/compact` command never confirms a slow recovery; it tells the user to open the Context panel. Cost: one extra step.
14. Memory notes about this work are in the harness memory folder outside the repository, which the Markdown-only-in-`plans/`-and-`docs/` rule does not cover. I created them; delete them if you do not want them.

## Known gaps

- **No live measurement.** See Outcome. The procedure to run it is in `docs/harness.md` under *Effective compaction → Verifying*.
- **`reconstruct` from the log is not implemented.** A session whose sidecar is gone, or that was produced before the switch was on, answers `409` with a recovery fingerprint instead of compacting in one request.
- **A session that never captured a snapshot cannot be manually compacted in one request** until its next completed turn. Before that, the first compaction asks for recovery.
- **Automatic compaction when recovery is required** was read, not tested: the automatic path throws `CompactionRecoveryRequired`, which the existing handler logs as a failed automatic compaction and does not fold. It is noisy rather than unsafe, but there is no test for it.
- **Adoption proof across a restart** is covered by reading and by the same-process tests. There is no test that restarts the server and then checks that `recoverCanonicalCheckpoint` still accepts an adopted checkpoint read back from disk.
- **`tokensAfter` is still an estimate** (a character-based token count).
- **Task 1 has no independent review**; SDD review stages were dropped when you switched to TDD.
- **Restoration reads files with a size guard of about 80 KB** and treats anything larger as a reference. That guard is a number I chose, not one from the spec.

## Unresolved questions

1. Do you want a live benchmark, and on which provider and model? Without it the 70% generation-time target cannot be claimed.
2. Should `reconstruct` from the log be built, or is "ask for recovery" acceptable for sessions that predate the switch?
3. Is it acceptable that the new `server-g5` failure stays unexplained, or should I run it more times and, if needed, make that test deterministic?
4. Merge route: the parent branch `feat/subagent-mcp-inherit` has unrelated uncommitted changes (including `src/web/server.ts`). Committing this branch and merging will need those resolved first. How do you want to proceed?
