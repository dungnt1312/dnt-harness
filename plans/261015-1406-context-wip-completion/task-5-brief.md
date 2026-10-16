# Task 5 — UI honesty and e2e assertions (D10, D15, D16, D17, D18)

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (after Tasks 0–4). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md` §9 (UI) and the plan's Task 7 text in `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/plan.md` (section "Task 7").

TDD for each item, using the existing jsdom mount helpers in the named spec files.

## D10 — Manifest ownership and error state (`web/App.tsx`)

Store the manifest together with its owner `{ workspaceId, sessionId }` and a status `'loading' | 'ready' | 'none' | 'error'`. On session switch, render `loading` synchronously; never render the previous owner's value. A 204 means `none` (no request yet). Any other HTTP failure means `error` (show "Context unavailable", not the no-request state). Keep the existing cancellation/currentRef guards and the 150 ms refresh debounce. Pass the status to `ContextMeter` and `ContextPanel`.

Test: deferred fetch for session A resolves after switching to B: B never shows A's numbers nor `0`; a 500 shows the error label.

## D15 — Compaction toast/chip respects measurement basis (`web/lib/format.ts`, `web/lib/project.ts`, compaction REST response)

`compactionTokenChange` must read `measurement.before.basis` / `measurement.after.basis` when present. When the bases differ (reported → estimated), show both numbers with their labels and no percent. When equal, keep today's percent. Old scalar-only events are labeled estimated. Carry `measurement` through the REST response and the chat projection.

## D16 — ContextMeter request details

Show "Last request" with the model of the measured manifest (`manifest.model`, not the current picker), the basis (reported / estimated), and the estimate total (`budget.usedTokens`) next to the reported total when both exist and differ.

## D17 — Policy pressure

When the manifest response carries `policy.automaticCompactionPressure`, show in the context details: the pressure ratio `(budget.preTrimTokens ?? budget.usedTokens) / budget.availableTokens` and the threshold, labeled as the auto-compact trigger. Hidden when `policy` is absent.

## D18 — Browser e2e really asserts

`tests/browser/context-accounting.e2e.ts`: assert the meter shows the estimated stage before the provider reports usage (hold the scripted provider's usage event behind a promise), then the reported stage; open the StepInspector for that step and assert it shows the same reported count; keep the compaction, reload and session-switch assertions.

## Verify and commit

```sh
pnpm exec vitest run web/components/composer/context-meter.spec.tsx web/components/chat/context-marker.spec.tsx web/components/workbench/step-inspector.spec.tsx web/lib --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
pnpm run build:web
pnpm exec playwright test tests/browser/context-accounting.e2e.ts --workers=1
```

If Playwright cannot start in this environment, report the exact error; do not claim it passed. Commit: `fix(web): context meter ownership, basis labels, policy pressure; e2e asserts estimate and inspector`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-5-report.md`. Return only status, commit hash(es), one-line test summary, concerns.
