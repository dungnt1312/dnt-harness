# Task 3 — Compaction safety: fail-closed fit, revision validation, candidate assessment

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (after Tasks 0–2). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md` §7 and §8. Read Task 0 and Task 2 reports in `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/` for the current shape of `assembleRequest` and `measureCheckpoint`.

TDD for each item.

## D7 — Effective adoption can commit without a full fit

In `src/web/server.ts` the measure path (`measureCheckpoint` and its caller wiring) prepares the preview outside the `try` that records `compactFitFailures`; `validateFit` only checks that map. If preparation throws on the first preview, `adoptPreparedCompaction` swallows it as telemetry and the fit check sees no failure, so adoption commits unverified.

Fix: for **effective adoption**, a successful full preview plus fit is required evidence. Preparation/preview failure must make validation throw, so the end event is failed and no success is appended. Legacy compaction keeps today's behavior (success with `contextEffect: 'replaced'` and unavailable measurement).

Test (compaction-adoption / server-compaction-effective suites): inject a preparation failure (e.g. an attachment loader that throws) during effective adoption; expect a failed end, no successful `compaction/end`, no `contextAfter`. Same failure on legacy: success with unavailable measurement.

## D8 — No revision validation after preview awaits

Preview awaits loaders; meanwhile the model pair, `contextTokens` override, mode, grants, system prompt override or workspace instructions can change, and success is still published with the stale estimate. Legacy compaction passes no `validate`.

Fix: compute a revision string when the preview inputs are prepared — hash of provider, model, thinking level, `contextTokens`, mode id + revision, grant roots, prompt override texts, workspace instructions hash, and the skill-sources revision — using existing hashing helpers (search for `sha256` in `src/web`). Before the success append, recompute and compare; on mismatch throw `context revision changed`. Wire it for both legacy and effective paths.

Test: deferred preview (gate the measure with a promise as in the existing adoption tests), change the operator `contextTokens` while it waits, release; expect failure with `context revision changed` and no success event. An unchanged revision commits normally.

## D9 — Candidate assessment uses the wrong size

The precompute candidate assessment compares only the conversation estimate with `window − compactionOutputTokens`. It must use the same next-request estimate the builder would produce after the checkpoint (fixed prompt + schemas + restoration + history) against the same budget (`resolveModelBudget`, reserve and margin). Reuse the preview path from D7/D8; do not write a second estimator.

`compactionPrecomputeEnabled` stays off by default; this is correctness for when it is on. If making `assess` async ripples into `src/web/compaction-precompute.ts`, update its callers to await and re-check the captured job identity and abort after each await (see existing `jobs` map handling). Keep minimum gain 256 estimated tokens.

Test (`tests/web/compaction-precompute.spec.ts`): a candidate whose summary+tail fits the conversation-only check but whose full next request exceeds the budget is refused as `no-fit`.

## Remove the unused coordinator

Delete `src/web/context-assembly.ts` and `tests/web/context-assembly.spec.ts`. First grep for imports; if any production import exists, stop and report. Move any test case in that spec that covers `resolveModelBudget` (override / NaN / 0 / negative) into `tests/harness/g3-context.spec.ts` or a budget test file so AC-19 coverage remains.

## Verify and commit

```sh
pnpm exec vitest run tests/harness/compaction-adoption.spec.ts tests/harness/g3-compaction.spec.ts tests/harness/compaction-reliability.spec.ts tests/harness/g3-context.spec.ts tests/web/server-compaction.spec.ts tests/web/server-compaction-effective.spec.ts tests/web/server-compaction-precompute.spec.ts tests/web/compaction-precompute.spec.ts tests/web/compaction-host.spec.ts --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
```

Use the files that exist. Commit: `fix(compaction): fail closed on unverified fit, validate context revision, size candidates like the builder`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-3-report.md`. Return only status, commit hash(es), one-line test summary, concerns.
