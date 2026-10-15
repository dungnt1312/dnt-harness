# Task 0 — Checkpoint the WIP and merge `main`

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (branch `fix/context-accounting`, HEAD `9a616e3`). Run every command there.

## Context

The worktree holds ~40 uncommitted files implementing context accounting (usage on attempt facts, a reducer, `contextId`, a shared host preparation `prepareHostContext`, post-compaction preview, an SSE durability gate, UI labels). `main` (`709c562`) is 22 commits ahead and changed 16 of the same files, mainly compaction: `reconstructFromLog`, `retarget` in `compaction-host.ts`, `retryingCompactionStream`, condensed handoff, parallel fold, job totals, plus SendPreview, ApplyPatch, MCP settings, composer chip.

Both sides must survive. Nothing from `main` may be dropped; nothing from the WIP may be dropped.

## Steps

1. `git status --short` and confirm only WIP files are dirty. `plans/` holds an untracked ledger: leave it untracked and uncommitted.
2. Commit the WIP: `git add -A -- . ':!plans'` then `git commit -m "wip(context): context accounting tasks 1-7 (pre-merge checkpoint)"`.
3. `git merge main` (no fast-forward needed; a merge commit is fine).
4. Resolve every conflict. Rules:
   - `src/web/server.ts`: `main` turned the old `agent/context` listener body into `async function assembleRequest(input: { scope, projected, events?, sideEffects })` used by both the listener and `reconstructFromLog`. The WIP turned the same body into `prepareHostContext(projected, scope, preview?)` plus a listener that builds, stamps `contextId`, appends manifest/body and arms capture. Merge them into **one** function that keeps `main`'s `assembleRequest` signature and `sideEffects` semantics (`sideEffects: false` = no manifest append, no capture, no caches, no `contextId`, MCP failure throws) **and** the WIP's behavior (controls including command model resolved before build, `nativeVision`, `resolveModelBudget`, `contextId` only on dispatch, preview support used by WIP `measureCheckpoint`). The listener and `reconstructFromLog` both call it. Keep `reconstructFromLog` using no command model: pass a flag or rely on `scope.turnId` being absent, whichever the merged code makes simplest, and say which in the report.
   - Compaction windows: `main`'s `compactionWindowOf` and the WIP's `resolveModelBudget` call sites must end up as the WIP resolver (one resolver everywhere).
   - `src/web/compaction-host.ts`: keep `main`'s `retarget`, reconstruct path and job totals, and the WIP's async measure/validate changes.
   - Web files (`App.tsx`, `ContextMeter.tsx`, `ContextPanel.tsx`, `api.ts`, `project.ts`, `types.ts`): keep both sides' features.
   - Docs: keep both sides' text; where they describe the same thing differently, prefer the WIP's measurement wording and `main`'s compaction-path wording.
5. `pnpm install --frozen-lockfile` if the lockfile changed.
6. `pnpm run typecheck` must pass.
7. Run sequentially and make them pass:
   `pnpm exec vitest run tests/harness tests/web/server-compaction.spec.ts tests/web/compaction-host.spec.ts tests/web/server-compaction-effective.spec.ts tests/web/compaction-wiring.spec.ts tests/web/server-context-accounting.spec.ts tests/web/sse-resume.spec.ts tests/web/server-g3.spec.ts tests/web/server-models.spec.ts tests/web/server-native-vision.spec.ts tests/web/server-adaptive-vision.spec.ts tests/web/server-session-model.spec.ts --maxWorkers=1 --no-file-parallelism`
   Use the files that exist; if a named file does not exist after the merge, say so. If a test fails because the two sides' expectations conflict, fix the code (not the assertion) unless the assertion encodes behavior one side deliberately replaced — then explain in the report.
8. Commit the merge.

Do not fix the audited defects (D1–D18) in this task; only make the merged code correct and green. Do not delete `src/web/context-assembly.ts` here.

## Report

Write `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-0-report.md`: commits, every conflicted file and how it was resolved, how `reconstructFromLog` avoids the command model, test command + pass counts, typecheck result, anything you could not reconcile. Return only status (DONE / DONE_WITH_CONCERNS / BLOCKED), the two commit hashes, a one-line test summary, and concerns.
