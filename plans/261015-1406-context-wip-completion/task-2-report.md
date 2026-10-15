# Task 2 report — one final request, vision, handoff, window, legacy listener

Worktree `.worktrees/context-accounting`, branch `fix/context-accounting`. Status: **DONE**.
Commit: `98e6fb3` — `fix(context): one final request for capture and dispatch; vision-aware handoff and fallback` (parent `e792353`). Nothing under `plans/` is committed.

## Items

### 1. One final request (D4)
`assembleRequest` (`src/web/server.ts`, end of the function) now builds a single `request`: `projected` without its `tools`, then the controls and `contextId` (only when `sideEffects`), then `messages`, then `tools` only when the builder returned some. `captures.arm(...)` receives this same object, and it is what the function returns.
- RED: `server-compaction-effective.spec.ts` › "the capture is the dispatched request…": the sidecar request had no `model`/`providerName`, because the old arm was built from `{ ...projected, messages, tools }`.
- The test also covers a zero-tool mode with `history: compact`: the capture and the dispatched request both have `tools` undefined.

### 2. Vision fallback (D5, AC-16)
`textOnlyVisionFallback(messages, describeAvailable)` in `src/harness/llm/adaptive-vision.ts`:
- `true`: the text is unchanged.
- `false`: "This chat model cannot see image pixels, and no image-description tool is available in this request. If asked about the attached image, say that you cannot view the image." This text never names DescribeImage.

The builder (`builder.ts`, history step) sets `describeAvailable` from the final `schemas`, i.e. after the mode-disabled and native filters.
- RED: `adaptive-vision.spec.ts` (`false` branch) and `g3-context.spec.ts` › "names DescribeImage only when the request carries it". Both failed on the missing new text.

### 3. Compaction handoff (D6, AC-17)
`HostDeps.nativeVision: () => boolean` was added in `src/web/compaction-host.ts`. After `retarget`, a non-native target gets `textOnlyVisionFallback(messages, false)` applied to a **copy** of the request. The stored snapshot object and the sidecar on disk are not touched. A native target is unchanged.
- The server wires `compactionVisionOf(entry)`. It uses `supportsNativeVision(model, override)`, with the override from the target provider's `modelSettings[model].vision`: the same rule and lookup as chat.
- The adaptation sits in the host and applies to both the exact and reconstructed paths. It does not cover the precompute candidates (see Concerns).
- RED: `compaction-host.spec.ts` › "a non-native target gets the handoff without image parts…": the image part was forwarded.

### 4. One window (D12, AC-18)
In the `assembleRequest` budget, a model with no provider now gets `modelBudgetOf(undefined, model)`, which resolves to `resolveModelBudget({ model })`, the same function `compactionWindowOf` uses. `DEFAULT_BUDGET` is used only when there is no model. `validateProviderModel` still runs only for a full pair.
- RED: `server-compaction-effective.spec.ts` › "a session with a model and no provider…": the manifest had `contextLimitTokens` 256000, expected 200000 (glm-4.7). The test appends `session/model {provider:null, model:'glm-4.7'}` directly, because the REST routes refuse a half pair. It then reads the manifest after `/compact`, which is the post-compaction preview built by the same assembly.

### 5. Legacy `agent/request` listener — deleted
I deleted the server's `agent/request` listener and `adaptRequestVision`, and removed the import.

Evidence that no web agent request reaches `agent/request` without assembly:
- The only caller of the `agent/request` waterfall is `Agent.step` (`src/harness/agent/agent.ts:670-680`). It always runs `agent/context` first.
- Every agent in the web host (root, child, role) runs on `kernel.ctx`. The server's `agent/context` listener is registered unconditionally and always calls `assembleRequest(..., sideEffects: true)`, which sets controls and `contextId`. So the old short-circuit (`contextId !== undefined`) was always taken, and the rest of the listener was dead code.
- Other `ModelRequest`s (compaction, precompute, DescribeImage, commit message, summarizer) call `kernel.ctx.llm.stream` directly and never went through `agent/request`.
- Headless (`src/bins/headless.ts`) registers its own `agent/context` and never had this listener, so AC-22 is unaffected.

Callers of `adaptRequestVision` outside src: only the old `adaptive-vision.spec.ts` cases, which I replaced with a `withoutDescribeImage` case. `server-session-model`, `server-adaptive-vision`, `server-native-vision`, `server-models` and `server.spec` "switching the model stamps every request" all stay green.

Docs updated where they named `agent/request` as the stamping seam: `docs/harness.md` (two places), `docs/web.md` (two places). `docs/architecture.md` and `docs/decisions/plugin-platform.md` still list the hook itself, which remains correct. The old superpowers spec mention of `adaptRequestVision` is historical, and I left it.

### 6. Command model (AC-13, AC-20) — pinned in `tests/web/server-session-model.spec.ts`, describe "slash command model"
- AC-13: the workspace command `/small` with `model: glm-4.7` on a gpt-5.6 session gives a dispatched request, a manifest (`model`, `provider`, `budget.contextLimitTokens` 200000) and a sidecar capture that all name `alpha/glm-4.7`. `/broken` with `model: no-such-model` falls back to gpt-5.6 (1,048,576) on all three.
  - RED: the capture side failed (no model), the same root cause as item 1.
- AC-20: `TurnCommandGrants.prototype.clear` is stubbed so the `/small` grant stays active after its turn. Then the mode switches to `plan`, which retires the capture, and `/compact` runs. The result is `path: reconstructed`, the handoff goes to `gpt-5.6`, and the image from turn 1 is still present. A glm-4.7 (text-only) build would have replaced it with text.
  - This passed before my changes, as the brief expected: `sideEffects=false` already excludes the command model. I made no design change.

## Verification
- `pnpm exec vitest run` on the brief's 12 files plus `server.spec`, `slash-commands`, `compaction-generator` and `compaction-precompute`, with `--maxWorkers=1 --no-file-parallelism`: **16 files, 335 tests passed**.
- `pnpm run typecheck`: passed (both tsconfigs).
- `pnpm test` (full): 342/343 files, 4377 passed, 2 skipped, 1 failed. The failure was `server-g5.spec.ts` › "MCP schema and execution are isolated per workspace…". Re-runs:
  - that test alone, with my change: passed 3/3
  - that test without my change (stash): passed
  - the whole `server-g5.spec.ts` file: 22/22 passed

  I treat it as a load-dependent flake that my change did not cause. It was not reproduced in isolation.
- `g5-prompt-contract.spec.ts`: unchanged and green.
- Not run: `pnpm run build:web` (no web UI change), browser e2e.

## Unchanged (as required)
Estimator, reserve 4_096, margin 1_024, trim order, retention, rollout flags, `budget.estimated` true. No new deps, flags or settings. No paid calls.

## Concerns
1. **Precompute candidates** (`compaction-precompute.ts`, gated behind `compactionPrecomputeEnabled`) call `generateCompaction(snapshot)` without the host's retarget and vision adaptation. The capture is now vision-correct for the model at capture time, and a candidate is discarded when the identity (model) changes, so a mismatch should not reach the provider. Still, the candidate path never calls `nativeVision()`. I left it out of scope; say so if you want it covered.
2. The AC-20 test relies on a prototype stub of `TurnCommandGrants.clear` to keep a grant active across turns. That is test-only, but it is coupled to the class name.
3. The full-suite flake in `server-g5` (above).

## Fix round 1

Commit: `f525b88` — `fix(compaction): precompute summarises with the session pair and target vision` (parent `98e6fb3`).

### Finding 1 (Important): precompute uses the session pair and the target's vision
- `src/web/compaction-host.ts`: new exported `handoffSnapshot(snapshot, now, nativeVision)`. It wraps the existing private `retarget` and then the `textOnlyVisionFallback(..., false)` step. The host now calls this function instead of its inline copy. It behaves exactly as before, and there is still only one retarget.
- `src/web/compaction-precompute.ts`: `PrecomputeDeps.nativeVision(sessionId)` was added. `run` now generates from `handoffSnapshot(snapshot, snapshot.identity, deps.nativeVision(sessionId))`. As a result, the candidate request uses the identity's provider, model and thinkingLevel, which are the same values the checkpoint, usage, staleness and fit check use. The stored snapshot and the job's `snapshot` are unchanged.
- `src/web/server.ts`: the precompute wiring passes `nativeVision: (id) => compactionVisionOf(entry)`. A session that is gone gets `false`.
- Covering tests are in `tests/web/compaction-precompute.spec.ts`:
  - "summarises with the identity pair, not the model the capture was dispatched to (a slash-command turn)".
    - RED: the request was `glm-4.7`/`low` where the identity names `gpt-5.6`/`high`.
  - "a non-native identity model receives no image parts; the stored snapshot is untouched".
    - RED: the image part was forwarded.
    - With a native target, the image is kept.

### Finding 2 (Minor): thinkingLevel on capture equals dispatch
- `tests/web/server-session-model.spec.ts` AC-13: the workspace thinking level is set to `high`. The test asserts that the dispatched request carries `high`, and that the capture's `thinkingLevel` equals the dispatched one for both `/small` and `/broken`.
  - First RED: the fixture passed `thinkingLevel` to `PUT …/model`, which ignores it. I moved it to `PUT …/thinking`. This was a fixture issue, not a product bug.
- `tests/web/server-compaction-effective.spec.ts` "the capture is the dispatched request…": the session model PUT now uses `thinkingLevel: 'high'`. The test asserts that the dispatched request has `high` and that the capture equals it.
  - This was green on first run, because item 1 of Task 2 already made capture and dispatch the same object.

### Verification
- `pnpm exec vitest run tests/web/compaction-precompute.spec.ts tests/web/server-compaction-precompute.spec.ts tests/web/compaction-host.spec.ts tests/web/server-compaction-effective.spec.ts tests/web/server-session-model.spec.ts tests/web/server-compaction.spec.ts --maxWorkers=1 --no-file-parallelism`: **6 files, 163 tests passed**.
- `pnpm run typecheck`: passed (both tsconfigs).
- Not run: the full `pnpm test` suite.
- No flags or defaults changed. `compactionPrecomputeEnabled` is still off by default.
