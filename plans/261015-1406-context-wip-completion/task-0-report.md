# Task 0 report — checkpoint WIP + merge `main`

Worktree: `.worktrees/context-accounting`, branch `fix/context-accounting`. Status: **DONE**.

## Commits
- WIP checkpoint: `69bbc2d` — `wip(context): context accounting tasks 1-7 (pre-merge checkpoint)` (parent `9a616e3`; `plans/` excluded).
- Merge: `2779275` — `Merge branch 'main' into fix/context-accounting` (parents `69bbc2d`, `709c562`).
- `plans/` diff between `main` and the merge commit is empty: the only `plans/` paths in the merge are files `main` already had. WIP ledger `plans/261014-1328-context-accounting/progress.md` is still untracked.
- `pnpm-lock.yaml` did not change between `9a616e3` and `main`, so I skipped `pnpm install`.

## Conflicted files and how I resolved them
Git auto-merged these files cleanly: `docs/harness.md`, `builder.ts`, `llm/types.ts`, `session/events.ts`, `compaction-host.ts`, `request-lifecycle.spec.ts`, `server-compaction.spec.ts`, `App.tsx`, `context-meter.spec.tsx`, `api.ts`, `project.ts`, `types.ts`. Only four files had conflicts.

1. `src/harness/context/compaction.ts` (`CompactionOptions`): kept the WIP's async `measure` (returns `CompactionMeasurement`, may be a Promise) and `validate`, **and** `main`'s `onProgress`.
2. `web/components/composer/ContextMeter.tsx` imports: kept the WIP's `isAvailableContext` and `ContextView` (rename of `ContextManifestView`), plus `main`'s `composerFocusClass`.
3. `web/components/layout/ContextPanel.tsx` imports: used `main`'s import list (no `CompactionRecoveryNeeded`/`CompactionRecovery`) with the WIP's `ContextView`. `main` deliberately removed the recovery path ("/compact always runs"), and the WIP had only renamed the type on that line. The body had already auto-merged without recovery usage.
4. `src/web/server.ts`:
   - Imports: `main`'s `MAX_PARALLEL` plus the WIP's `resolveModelBudget`, `BuildContextInput`, `CompactionMeasurement`, `Restored`, `deriveContextState`/`isAvailableContext` and `isValidTokenUsage`. I added `PreviewCompaction`. I dropped the `RecoveryConfirmation` import because `main` removed it and nothing uses it.
   - **One window resolver.** I replaced `main`'s `contextWindowOf(provider, model)` with `modelBudgetOf(provider | undefined, model): ResolvedBudget`, a thin wrapper over the WIP's `resolveModelBudget` that adds the operator `contextTokens` lookup. `compactionWindowOf(entry)` (main) now returns `modelBudgetOf(...).contextLimitTokens`. All three compaction sites use `compactionWindowOf`: precompute `assess`, host `contextWindowTokens`, and `startCandidate`. The builder budget in assembly uses `modelBudgetOf`. The WIP's three inlined `resolveModelBudget(...)` copies are gone.
   - Host deps: `contextWindowTokens: () => compactionWindowOf(entry)`, plus the WIP's `measure(next, standing, restored)` and `validateFit`.
   - **Merged assembly = `assembleRequest`** (`main`'s signature) with an added optional `preview?: PreviewCompaction`. It returns `{ assembled, request, commitPrefix }`. `prepareHostContext` no longer exists.
     - WIP behaviour kept: command model resolved before the build, `nativeVision` on the build input, `thinkingLevel` fallback from model settings, budget from the single resolver, preview prefix-snapshot key (`preview.checkpoint.coversSeq`), and `commitPrefix` (used by the `compaction/end` durability listener).
     - With `sideEffects: true` (listener): `contextId = randomUUID()` goes on the manifest, and the request carries controls (`model`, `providerName`, `thinkingLevel`) plus `contextId`, so the WIP's `agent/request` short-circuit still applies. Manifest/body append, meter reset, prefix bookkeeping and capture arming are all gated on `sideEffects`, as on `main`.
     - With `sideEffects: false` (reconstruct, preview): no `contextId` and no controls on the request, no manifest append, no capture, no session cache writes, and an MCP failure throws (`main`'s rule).
     - Prefix snapshot. A reconstruction (`sideEffects: false`, no preview) reads a matching session copy but never creates one (`main`). A preview gets a private copy (`{ ...current }` or a fresh one), which it may fill with skill catalog and memory indexes. `commitPrefix` installs that copy only after the checkpoint is durable (WIP). New local: `fillsSnapshot = sideEffects || preview !== undefined`.
     - The preview build uses `buildContextPreview(buildInput, preview)`. If that build throws, the error goes into `compactFitFailures` and is re-thrown, so the host's `validateFit` refuses the checkpoint. An assembly error before the build propagates without being recorded as a fit failure. This keeps the WIP's split, where `prepareHostContext` sat outside the try.
   - `measureCheckpoint` (WIP) now calls `assembleRequest({ scope, projected, sideEffects: false, preview: { checkpoint, restoration?, protectUncoveredHistory } })` and reads `prepared.assembled.manifest` as `contextAfter`. Its other logic is unchanged.
   - `reconstructFromLog` (main) is unchanged.

## How `reconstructFromLog` avoids the command model
**It relies on the `sideEffects` flag, not on `turnId`.** In `assembleRequest`:
`const commandModel = sideEffects && scope?.childOf === undefined ? turnCommandGrants.model(scope?.sessionId) : undefined`.
`reconstructFromLog` and `measureCheckpoint` both pass `sideEffects: false`, so neither picks up a command model. Only the dispatching `agent/context` listener does. `turnCommandGrants.model` is keyed by session, not turn, so testing `scope.turnId` would not have been reliable.

## Docs
None of the doc files conflicted (`docs/harness.md` auto-merged; `main`'s `capabilities.md`, `design-guidelines.md` and `web.md` came in clean). No doc mentions `prepareHostContext`, `assembleRequest` or `compactionWindowOf`, so I made no wording changes.

## Verification
- `pnpm run typecheck`: passed (both tsconfigs).
- `pnpm exec vitest run tests/harness tests/web/server-compaction.spec.ts tests/web/compaction-host.spec.ts tests/web/server-compaction-effective.spec.ts tests/web/compaction-wiring.spec.ts tests/web/server-context-accounting.spec.ts tests/web/sse-resume.spec.ts tests/web/server-g3.spec.ts tests/web/server-models.spec.ts tests/web/server-native-vision.spec.ts tests/web/server-adaptive-vision.spec.ts tests/web/server-session-model.spec.ts --maxWorkers=1 --no-file-parallelism`: **111 files, 1641 tests passed**. Every named file exists.
- Extra check, because I resolved the web files by hand: `pnpm exec vitest run web/components/composer web/components/layout web/lib --maxWorkers=1 --no-file-parallelism`: 53 files, 691 tests passed.
- I edited no assertions.

## Not run / open
- Not run: full `pnpm test`, `pnpm run build:web`, browser e2e (`tests/browser/context-accounting.e2e.ts`).
- I did not touch `src/web/context-assembly.ts`, as the brief required. It has its own `commitPrefix` model and is not wired into `server.ts`.
- I made no fixes for D1–D18.
- `measureCheckpoint` keeps its unused `_standing` and `_loaded` parameters (WIP signature). Legacy fold still calls `measureCheckpoint(entry, next, seed, loaded)`.
