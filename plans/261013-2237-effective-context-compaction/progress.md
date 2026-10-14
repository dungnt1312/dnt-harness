# SDD ledger — plan: plans/261013-2237-effective-context-compaction/plan.md

## Execution identity

User approved execution 2026-10-13 22:52 +07:00, SDD, implement Sonnet 5.5; hard tasks GPT 6.1 Sol/Opus 5.5.
Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/effective-context-compaction`
Branch: `feat/effective-context-compaction`
Base: `7bef5dd75754fb68be2c82fbddd899d5234d6aa2`.
Baseline: pnpm frozen install succeeded; five affected suites, 110 tests passed (22:53:24).
Plan/spec remain in parent repository and are passed by absolute path; no product edits there.

## Rulings

Ruling: Ledger, briefs and reviews live under this plan's directory, not .superpowers scratch — user restricts Markdown to plans/docs, skill templates in protected storage were denied — costs loss of standard scripts but no implementation semantics.
Ruling: No commits until explicitly requested; review packages must compare per-task saved filesystem diff, not HEAD range — approved plan disallows commits and user authorized implementation, not git operations — costs snapshot/diff tracking overhead.
Ruling: PreparedSummary belongs to core snapshot/types module, generator re-exports it — Task 5 core must not import web types and Task 5 depends on Task 2 — costs naming deviation from Task 4 only.
Ruling: assessProjection receives final completed-turn assistant evidence at promotion, not treating the last request as covering an answer it has not seen — source cutoff includes final answer appended after request — costs an extra capture projection update at Task 3.

## Preflight per-task consistency

| Task | Checked | Result |
|---|---|---|
| 1 | typed losses, sources, policy/tests | assess final answer at promotion per ruling |
| 2 | schema/store/event reference/tests | optional model/input evidence types must be pinned before consumer |
| 3 | capture/drain/promotion/restart | strict tail EOF failure coverage specified |
| 4 | output cap/deadline/prefix | PreparedSummary core definition per ruling |
| 5 | old cutoff vs new turns, durability | old legacy rules retained; new proof required |
| 6 | config/fallback/routes/reservation | config off keeps legacy for rollback; effective on explicit recovery |
| 7 | restoration caps/IO/authority | current grants after waits; typed restoration losses may extend union |
| 8 | job state/priority/transport | no independent ownership runtime; reuse admission |
| 9 | trigger/adoption/hooks | safe closed boundaries, no speculation reservation |
| 10 | UI/metrics/quality/benchmark | paid benchmark pending permission; synthetic tests not LLM proof |

## Shared interface/file dependency scan

| Producers/consumers | Shared surface | Check/ruling |
|---|---|---|
| 1 → 2,3,4,7 | CompactionProjection/Eligibility | additive types; no omissions parsing |
| 2 → 3,4,5,8 | snapshot schema/store/PreparedSummary | core type ruling; source digest stable |
| 3 → 6,8,9 | capture snapshot/reconstruct | exact vs reconstructed path retained |
| 4 → 5,6,8 | generator output | types core; caps shared |
| 5 → 6,7,9 | adoption/proof/checkpoint recovery | restoration payload paired by transaction |
| 6 → 7,8,9,10 | host hooks/reservation/API | sequential editing only |
| 7 → 8,9,10 | post-context preview/fit | no tail trimming |
| 8 → 9,10 | candidate lifecycle/usage | speculation not working turn |
| 9 → 10 | accepted candidate/job events | metrics match actual operation identity |
| 1,2,5,7,10 | event union/projection/schema | typecheck exhaustive consumers each task |
| 3,6,7,9,10 | server.ts | single implementer at a time |
| 4,6,8 | limits/request lifecycle | optional fields ordinary behavior unchanged |
| 6,10 | web API | additive success fields, typed failure confirmation |

## Execution change

2026-10-13 23:16 the user stopped SDD and asked for TDD. From then on every task was done inline by the
controller with `superpowers:test-driven-development` (RED for the right reason, minimal GREEN, mutation
check). No subagent was dispatched, so the "implement Sonnet 5.5 / hard tasks GPT 6.1 Sol or Opus 5.5" routing
above never applied to any task.

## Later rulings

Ruling: Bash/BashOutput that succeeded and were read are safe to clear; Write/Edit/MCP/Agent/Skill/AskUserQuestion/TodoWrite and every error result are `unknown` — a lost result of those cannot be recovered from the log alone — costs: a long session that cleared many of them asks for slow recovery. Narrow `SAFE_CLEAR_TOOLS` if wrong.
Ruling: effective compaction is gated by `compactionEffectiveEnabled` (default false) and precompute by `compactionPrecomputeEnabled` (default false) — rollback is the old fold — costs: the feature does nothing until switched on.
Ruling: adoption requires the candidate's `seedHash` to equal the standing checkpoint — a summary that never saw the checkpoint would drop what it covers — costs: regenerating a candidate.
Ruling: after a restart the newest `context/snapshot` reference is reloaded and re-verified; a missing or altered sidecar asks for recovery instead of rebuilding — costs: slow recovery after losing the sidecar; `reconstruct` from the log is not implemented.
Ruling: `compaction/restoration` is written inside the adoption transaction before the success end and counts only for that end's cutoff and summary — a failed attempt's copy must never reach the model — costs: one more event per compaction.
Ruling: the browser gets restoration `sections`, never `body` — up to 25k tokens of file text per compaction on every fresh SSE connect — costs: the UI cannot show restored text.
Ruling: a background candidate runs under its own provider-ownership id (`<session>#candidate`) with `admissionPriority: 'low'` — the LLM service fences a session while one of its requests runs, and a background summary must not block the next chat turn — costs: its transport uncertainty is tracked separately.
Ruling: a ready candidate that is no longer adoptable (stale or no longer worth it) is replaced by a newer snapshot; a usable one is kept — otherwise it holds the slot forever — costs: at most one summary per session in flight.
Ruling: `measure`'s `tokensAfter` = provider-reported size − estimated saving of the new checkpoint + restoration; the old flat 20% is gone — costs: still an estimate (the next real request replaces it).
Ruling: `providerGeneration` is the constant 1 — the provider layer exposes no generation counter — costs: a provider reconfiguration does not invalidate a candidate by itself (model/mode/grants changes do).

## Tasks

Tasks 1–10: done in the worktree, nothing committed. Evidence and open items: `plans/reports/verification-261014-0821-effective-context-compaction.md`.
