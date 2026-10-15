# Task 5 report — UI honesty and e2e assertions (D10, D15, D16, D17, D18)

Worktree `.worktrees/ctx-task5`, branch `fix/ctx-task5`, commit `cab7825`
("fix(web): context meter ownership, basis labels, policy pressure; e2e asserts estimate and inspector").

## Changes
- **D10** `web/hooks/useContextManifest.ts` (new, used by `web/App.tsx`): state is `{owner:'ws:session', status, view}`. Any owner other than the open session reads as `loading` on the same render (no effect/flash, no stale or zero count). 204 → `none`, any other failure → `error`. Cancellation, workspace/session ref guards and the 150 ms refresh debounce (0 ms on a switch) are kept. `ContextMeter` and `ContextPanel` take `status` / `manifestStatus` and show "Loading context…" / "Context unavailable"; both default from the manifest, so old callers still work. Types: `ContextStatus` in `web/lib/types.ts`, re-exported from `api.ts`.
- **D15** `compactionTokenChange` (`web/lib/format.ts`) reads `measurement.before/after.basis`. Equal bases → `139k → 42k tokens`; different → `120k reported → 30k estimated tokens` (no percent). Scalar-only events count as estimated. `measurement` is carried through `CompactResult` (`web/lib/api.ts`), `compaction/end` events (`web/lib/types.ts`) and the chat projection (`web/lib/project.ts`). Server: one line in the compact route of `src/web/server.ts` (~7567) adds `end.measurement` to the REST response. `/manifest` is untouched.
- **D16** ContextMeter shows "Last request: reported|estimated", the measured manifest's `model` (not the picker), and "Estimate total" only when reported and `budget.usedTokens` differ. ContextPanel gets a `request` row with basis and model. Not shown for post-compaction.
- **D17** `policyPressure` / `formatPolicyPressure` (`format.ts`): `(preTrimTokens ?? usedTokens) / availableTokens` with the threshold, labeled "Auto-compact trigger" in the meter and "auto-compact" in the panel. Hidden when `policy` is absent.
- **D18** `tests/browser/context-accounting.e2e.ts`: the scripted provider holds the first usage event behind a promise. The test asserts the estimated stage (aria-label has no `120K`, API has no `usage.last`, panel says "Last request estimated"). It then releases the gate and asserts `120K / 256K` and "reported". It opens Trajectory → the step → the StepInspector and asserts `120k/256k tok` + `reported`. The compaction, reload and session-switch assertions are kept.

## Tests added
`web/hooks/useContextManifest.spec.tsx` (deferred fetch A resolving after switch to B shows neither A's numbers nor 0; 204 → none; 500 → error; 150 ms debounce), `context-meter.spec.tsx` (loading/error, request details, policy), `product-ui.spec.tsx` (panel states + pressure), `manifest-refresh.spec.ts` (basis labels), `project-compaction.spec.ts` (measurement carried into the row).

## Verification (all run in the worktree)
- `pnpm exec vitest run web/components/composer/context-meter.spec.tsx web/components/chat/context-marker.spec.tsx web/components/workbench/step-inspector.spec.tsx web/lib web/hooks --maxWorkers=1 --no-file-parallelism` → 59 files / 707 tests passed. (An earlier run showed 2 failures in `web/lib/api-stream.spec.ts` (`docListeners.get(...) is not a function`). That was caused by my stash incident (below) swapping files during the run; re-runs pass, 1/1 alone and in the full run.)
- `pnpm run typecheck` → exit 0.
- `pnpm run build:web` → exit 0.
- `pnpm exec playwright test tests/browser/context-accounting.e2e.ts --workers=1` → 1 passed (5.9 s).
- Not run: full `pnpm test`, and a server test for the REST `measurement` pass-through (the existing `tests/web/server-compaction.spec.ts` is touched by another task).

## Incident
While checking whether the `api-stream` failure was pre-existing, I ran `git stash -u` and `git stash pop` from the **main checkout** (Bash starts there, not in the worktree). The pop succeeded: 29 changed/untracked entries are back, the stash list holds only the two older stashes, and main HEAD is unchanged (709c562). File mtimes in main changed. Please check main's working tree if anything looks off.

## Concerns
- `ContextPanel`'s "request" row and the meter rows are plain text rows; the layout was not visually reviewed (the e2e only asserts text).
- The REST `measurement` carry-over has no direct test.

## Fix round 1

- F1 (Important): `web/hooks/useContextManifest.ts` returns `{ manifest: null, status: 'none' }` when workspace or session is null (home / unsent draft) instead of looping on `loading`. Test: `web/hooks/useContextManifest.spec.tsx` "no workspace or session … is none" (failed first with `loading`; also asserts no fetch).
- F2 (Important): `compactionTokenChange` in `web/lib/format.ts` now names equal bases (`139k → 42k estimated tokens`, `… reported tokens`); mixed bases unchanged. No percent was shown for equal bases. Test: `web/lib/manifest-refresh.spec.ts` asserts exact strings for scalar-only, both-estimated, both-reported, mixed.
- F3 (Minor): `tests/browser/context-accounting.e2e.ts` estimate-stage assertions wrapped in try/finally calling `releaseUsage()`.
- Commands: `pnpm exec vitest run web/hooks web/lib web/components/composer web/components/layout --maxWorkers=1 --no-file-parallelism` → 62 files / 769 tests pass; `pnpm run typecheck` → clean; `pnpm run build:web && pnpm exec playwright test tests/browser/context-accounting.e2e.ts --workers=1` → 1 passed.
