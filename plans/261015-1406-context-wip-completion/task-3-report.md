# Task 3 report — fail-closed fit, context revision, builder-sized candidates, coordinator removal

Worktree `.worktrees/context-accounting`, branch `fix/context-accounting`. Status: **DONE**.

## Commits
- `1ee650a` — `refactor(context): delete unused context-assembly coordinator; keep AC-19 budget cases in g3-context` (parent `f525b88`)
- `b14f922` — `fix(compaction): fail closed on unverified fit, validate context revision, size candidates like the builder`

Nothing under `plans/` is committed.

## Unused coordinator
- I grepped `src`, `tests`, `web` and `docs` first. The only importer of `src/web/context-assembly.ts` was its own spec, and there are no production imports.
- Deleted `src/web/context-assembly.ts` and `tests/web/context-assembly.spec.ts`.
- Moved the `resolveModelBudget` cases into `tests/harness/g3-context.spec.ts`, describe "model context budget (AC-19)":
  - override with `windowSource: 'override'`, reserve 4_096 and margin 1_024;
  - NaN, 0 and -1 overrides fall back to 256_000 with `windowSource: 'fallback'`;
  - namespaced catalog family limit.
- `estimated: true` is a field of the manifest budget, not of `ResolvedBudget`. The existing g3-context test "estimate honesty" already covers it, so I did not add it to the moved cases.
- I dropped the preview-prefix case, because it only tested the deleted coordinator.

## D7: effective adoption needs positive evidence
`src/web/server.ts`:
- `compactFitFailures` is replaced by `compactFits: Map<SessionId, { revision, fit?: coversSeq, error? }>`. `measureCheckpoint` clears the entry first, then records the revision, and sets `fit` only after the full preview built and fit.
  - A failure during preparation (attachments, sources) or during the build is now recorded too, because the whole `previewCompaction(...)` call sits inside the try.
  - A mode whose history is not `compact` records `fit` with `contextEffect: 'unchanged'`, because the checkpoint does not change the next request.
- `assembleRequest` no longer records anything itself. The preview branch is just `buildContextPreview(buildInput, preview)`.
- `checkCompactionContext(entry, cutoff?)` throws `compaction fit not verified[: cause]` unless `fit === cutoff`. It consumes the record.
- The host's `validateFit` is now `(cutoff) => …`. `src/web/compaction-host.ts` passes `prepared.cutoff` and documents the type change.
- Legacy behaviour is unchanged. `compactSession` still catches the measure error and writes `measurement.unavailableReason: 'preview-failed'`. The legacy `validate` passes no cutoff, so it does not require a fit.

## D8: context revision
- `contextRevision(entry)` is a sha256 (`createHash`, as used elsewhere in server.ts) of JSON with:
  - provider, model, thinkingLevel;
  - the operator `contextTokens` for that pair;
  - mode id and revision;
  - `effectiveGrants(...)`;
  - the base and child prompt override texts (only when overridden);
  - the sha256 of the rendered workspace instructions;
  - `skills.sourcesStore.revision(workspaceId)`.
- It is computed at the start of `measureCheckpoint`, before any preview await. Before the success append, `checkCompactionContext` recomputes it and throws `context revision changed` on a mismatch.
- It is wired for effective (host `validateFit`) and for legacy (new `validate` in the `compactSession` options).

## D9: candidates sized like the builder
- The server's precompute `assess` is now async.
  - The 256 minimum-gain check is unchanged.
  - The fit check is now `restorationFor(entry, cutoff)` + `previewCompaction(entry, {summary, coversSeq: cutoff}, restored)`. That is the same `assembleRequest` preview path as D7, using the builder's fixed prompt, schemas, restoration, kept tail, `resolveModelBudget`, reserve and margin. A throw returns `no-fit`. I wrote no second estimator.
- I extracted `restorationFor` from the host's inline `restore` closure. The host now calls it, with the same behaviour.
- `src/web/compaction-precompute.ts`:
  - `assess` may return a Promise.
  - `start` and `takeReady` are async.
  - New `verdict(job, prepared)` does staleness, then assess, then staleness again. A failing assess counts as `no-fit`.
  - `takeReady` claims (deletes) the job before awaiting.
  - After the await, `start` re-checks that the same job is still in `jobs`, the manager is not closed, `parent` is not aborted, and the session is not blocked.
  - `waitPending` awaits `takeReady` and then calls `caller.throwIfAborted()`.
- `startCandidate` runs `assertFitsWindow` on `handoffSnapshot(snapshot, identity, compactionVisionOf(entry))`, i.e. the request actually sent, and handles `start` as fire-and-forget with `.catch`.
- `compactionPrecomputeEnabled` is still off by default.

## Tests (RED reason recorded)
- `tests/web/server-compaction-effective.spec.ts`, describe "compaction fails closed…". The attachment loader is stubbed through `vi.spyOn(AttachmentStore.prototype, 'load')`.
  - effective, preparation throws → 409, no successful end, failed end, no `contextAfter`. **RED: 200, adopted unverified.**
  - legacy, preparation throws → 200, `contextEffect: 'replaced'`, `unavailableReason: 'preview-failed'`, no `contextAfter`. This was green before and stays green.
  - effective and legacy: the preview is gated, the operator `contextTokens` is PATCHed through `/api/providers/scripted` while it waits, then released → 409 `context revision changed`, no successful end. The unchanged run returns 200. **RED (both): 200.**
- `tests/web/compaction-precompute.spec.ts`:
  - Calls were updated to await the now-async `start`/`takeReady`.
  - New: an async `no-fit` verdict refuses the candidate, and the job is claimed while the assess is pending.
  - New: a source change during the awaited assess wins (`source-changed`).
  - New: `start` does not discard a job that was invalidated during its await.
- `tests/web/server-compaction-precompute.spec.ts`: "a candidate whose summary+tail passes the conversation-only check but whose full next request exceeds the budget is refused as no-fit".
  - Setup: 100k window override and a large workspace CLAUDE.md. The test asserts that `summary + tail < window − compactionOutputTokens`, then that compaction requests a fresh handoff instead of adopting.
  - **RED was confirmed by temporarily restoring the old conversation-only check:** "expected 1 to be greater than 1", i.e. the candidate was adopted.
  - Placement note: the brief named `compaction-precompute.spec.ts` for this test. That file uses a stubbed `assess`, so it cannot exercise the builder sizing. The builder case is therefore in the server-level file, and the unit file covers the async verdict.

## Verification
- Brief list plus `context-preview`, `server-context-accounting` and `compaction-wiring`: `pnpm exec vitest run … --maxWorkers=1 --no-file-parallelism` → **12 files, 265 tests passed**.
- `pnpm run typecheck` → passed (both tsconfigs).
- `pnpm test` (full) → **342 files passed, 4386 tests passed, 2 skipped**.
- Not run: `pnpm run build:web` (no web UI change), browser e2e.

## Unchanged
Estimator, reserve 4_096, margin 1_024, trim order, retention, min gain 256 and rollout flags are all unchanged. No new dependencies, flags or settings. No paid calls.

## Concerns
1. The revision is broader than the builder's actual use: workspace instructions are hashed even when the mode excludes them. Editing CLAUDE.md during a compaction therefore fails it, which is a conservative false positive.
2. If `contextRevision` itself threw in legacy, there would be no record and validation would pass. Every input inside it is caught or synchronous, so I treat this as theoretical.
3. When precompute is on, each `assess` (in `start` displacement and in `takeReady`) now costs one restoration build plus a full preview assembly, which means file reads. This is acceptable while the flag is off; measure it before enabling precompute.
4. D9's covering test is in `server-compaction-precompute.spec.ts`, not `compaction-precompute.spec.ts` (reason above).
