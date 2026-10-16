# Context accounting WIP completion + tool prompt contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task has its own brief file `task-N-brief.md` in this folder; read only your brief.

**Goal:** Finish the uncommitted context-accounting WIP (fix audited defects), complete Part B of the prompt-contract spec, then land Part A (prompt/tool wording).

**Architecture:** Work continues in the existing worktree `.worktrees/context-accounting` (branch `fix/context-accounting`). Task 0 checkpoints the WIP as a commit and merges current `main` so later tasks build on the compaction code (`reconstructFromLog`, `retarget`, `retryingCompactionStream`) that only exists on `main`. The host keeps one shared preparation path (`prepareHostContext` in `src/web/server.ts`).

**Tech Stack:** TypeScript, Node 24, Vitest, Playwright, pnpm. No new dependencies.

**Specs (authority, read the sections your brief names):**
- `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md` (context accounting)
- `/Users/dungnt/workspace/dnt-harness/plans/261015-1347-context-tool-prompt-contract/spec.md` (Part A = §4, Part B = §5)

**Audit that produced the defect IDs (D1–D18):** reviewer report in the controller ledger `progress.md` of this folder.

## Global Constraints

- Work only inside `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting`. Never edit the main checkout's source. Never push, never merge into `main`, never touch other worktrees.
- Commit each task on `fix/context-accounting` with a conventional message. Do not commit anything under `plans/`.
- Use pnpm. Run the tests your brief names with `--maxWorkers=1 --no-file-parallelism` when they touch the web server; always finish with `pnpm run typecheck`.
- Estimator stays `ceil(chars/4)`, image `1_200`; output reserve `4_096`, margin `1_024`; trim order, retention, retry budget, auto-compact thresholds and rollout flags (`compactionEffectiveEnabled`, `compactionPrecomputeEnabled`) unchanged.
- `budget.estimated` is always `true`; `windowSource` is `'override' | 'catalog' | 'family' | 'fallback'`.
- No paid provider calls, no live server restart, no new feature flags or settings.
- Do not weaken existing trust/ordering assertions in `tests/harness/g5-prompt-contract.spec.ts`; change a prompt test only where the spec changes the wording.
- Subagents never dispatch subagents.

## Review Focus

1. A session whose model has no provider: request budget and compaction window must be the same number (AC-18).
2. A non-native model receives an old snapshot containing images through the compaction handoff, which bypasses `agent/request` (AC-17).
3. An SSE client already subscribed when a successful `compaction/end` is appended but not yet durable must still receive it after commit (D2).
4. A new assembly B must never display reported usage that belongs to assembly A (D3).
5. Switching sessions must never render the previous session's context count, and an HTTP error must not render as "no request yet" (D10).

## Tasks

| # | Title | Difficulty → model | Brief |
|---|---|---|---|
| 0 | Checkpoint WIP and merge `main` | hard → opus | `task-0-brief.md` |
| 1 | Attempt accounting + event validation fixes (D1, D11, D13) | easy → sonnet | `task-1-brief.md` |
| 2 | Part B remainder: final request, vision fallback, handoff, window, legacy listener, reconstruction (D4, D5, D6, D12, AC-13..AC-21) | hard → opus | `task-2-brief.md` |
| 3 | Compaction safety: fail-closed fit, revision validation, candidate assessment (D7, D8, D9); remove unused `context-assembly.ts` | hard → opus | `task-3-brief.md` |
| 4 | SSE/API publication (D2, D3, D14) | hard → opus | `task-4-brief.md` |
| 5 | UI honesty + e2e assertions (D10, D15, D16, D17, D18) | easy → sonnet | `task-5-brief.md` |
| 6 | Preview regression matrix (R5) | easy → sonnet | `task-6-brief.md` |
| 7 | Part A: prompt and tool contract | easy → sonnet | `task-7-brief.md` |

Order is strict 0 → 7: tasks 2–4 share `src/web/server.ts`.

## Final gates (controller runs after Task 7)

```sh
pnpm run typecheck
pnpm test
pnpm run build:web
pnpm exec playwright test tests/browser/context-accounting.e2e.ts --workers=1
```

Known baseline flakes (from the WIP ledger): `server-g1` steer timing, `project-git-sync` beforeAll timeout, git-panel `CSS.escape` unhandled errors. Any failure must be reproduced alone before being called a flake.
