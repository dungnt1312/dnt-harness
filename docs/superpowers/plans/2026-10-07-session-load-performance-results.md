# Session-load performance results

Implementation branch: `feat/session-load-perf`, isolated worktree `.worktrees/session-load-perf`.

## Changes
- Opt-in `?view=delegations` filters root snapshot and live events for the child Subagents surface; default replay unchanged.
- Explicit `?cursor=N` bootstrap; Last-Event-ID header takes precedence on automatic reconnect.
- Per-hook LRU retains at most 3 sessions and a 64 MiB UTF-16 JSON payload estimate (not a hard heap limit). Cache discarded for null selection; approvals are reconstructed from durable events, questions re-sent by server.
- Fresh snapshots replace compactor as well as projector. Cursor uses frame id even for empty/compacted snapshots.
- Derived gates reset on history identity, and Transcript scans no longer invalidate on every text batch.

## Reproducible profile
Run from either checkout: `node --import tsx <path-to>/scripts/profile-session-load.mjs` after `npm run build:web` in that checkout. Script imports server from current working directory, captures real API snapshots, seeds isolated memory sessions, mocks only workspace/list metadata, blocks every browser mutation. No transcript content stored in artifacts.

Single paired Chromium run at 1440×900 against baseline cb6e177 and changed build:

| Scenario | Before | After |
|---|---:|---:|
| Initial root | 1008 ms | 961 ms |
| Open child | 443 ms | 225 ms |
| Return root | 809 ms | 180 ms |
| Parent snapshot characters | 6,315,719 | 70,010 |
| Return-root replay characters | 19,651,204 | 29 |

0 browser mutations, 0 page errors in both runs. Readiness waits for authoritative replay plus transcript and two animation frames. One paired run is evidence, not statistical p95. Canonical disk cold loading is NOT measured: isolated host seeds memory from compacted real API snapshots. Initial root payload/render remains essentially unchanged.

## Verification
- Targeted API/UI tests: 49/49 passed; typecheck passed; build passed; diff check clean.
- Full baseline: 2108 passing, 1 failing, 1 skipped plus teardown failures in g4-agents/server-guard (ENOTEMPTY).
- Full changed suite: 2113 passing, 2 failing, 1 skipped plus g4-agents ENOTEMPTY. server-g1 cancellation/steer tests fail intermittently; isolated unchanged baseline also fails `input accepted during cancellation survives: nothing is lost, nothing auto-runs` (pendingInputs 2 vs 1). Do not claim full suite green.

## Scope decisions / remaining work
- Cache payload estimate increased from planned 32 MiB to 64 MiB to admit the measured 19.65-million-character root (~39.3 MiB UTF-16); objects/strings add heap overhead. Cost: more retained memory. Per-hook entries and admission remain bounded.
- Lazy tool output and cold-load summary optimization deferred: output consumers use full output to infer file/diff/status facts; an unreviewed trim could silently change behavior. Initial load still needs those changes or pagination.
- No deploy, production restart or merge. Main checkout acquired unrelated edits during this work; preserve them.
- Independent subagent review not run: user has not chosen model group; author self-review and regression evidence are not equivalent to fresh review.
