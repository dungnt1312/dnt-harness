# SDD ledger — plan: /Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/plan.md

Spec: /Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md
Execution: Native approved 2026-10-14 16:09 +07:00.
Worktree: .worktrees/context-accounting, branch fix/context-accounting, BASE 9a616e3f5f5620fc2dc3809c8ced442193212f27.

## Setup and rulings

Ruling: Keep ledger under plans instead of protected skill scratch directory — user restricts Markdown to plans/docs and skill reference read was denied; do not bypass application-internal storage protection — cost: manual task bookkeeping rather than skill scripts.
Ruling: Read original approved plan/spec by absolute path rather than duplicate untracked artifacts — original files are accessible and authoritative, avoids divergent copies — cost: parent artifacts must remain present until completion.
Ruling: No commits, pushes or merges — plan explicitly requires user authorization; native is execution-method approval only — cost: preserve ledger/worktree with uncommitted changes at handoff.
Ruling: Start from current clean committed main HEAD 9a616e3, not earlier b8a32c1 — newer committed workbench changes are unrelated; all uncommitted main changes remain untouched — cost: verify affected baseline against this base.

## Pre-flight interfaces

1→2: contextId + final TokenUsage optional on AttemptFact; strict JSONL allowlist must expand before production emits fields. Compatible.
2→3: reducer needs matching manifest/request ID and effective controls; stamp each assembly fresh ID, not LogicalRequest owner. Compatible.
3→4: prepared BuildContextInput shared; prospective preview must not pretend canonical attestation. Compatible.
4→5: async full prospective preview + restoration into atomic end; final safety validation runs after await. Compatible.
2/5→6: API union from committed reducer state; unavailable intentionally removes required manifest fields; web consumers must be updated together with Task 7.
6→7: available-only contextFill; loading owner guard; durable SSE event must not advance cursor past held compact success.

## Verification

Setup: pnpm install --frozen-lockfile succeeded, no downloads, isolated node_modules.
Baseline: 4 files/80 tests passed, exit 0 (request-lifecycle, attempt-events, g3-context, context-meter).
Task 1: complete — RED 4 failures (missing terminal identity/usage and JSONL rejection); GREEN 3 files/86 tests including llm-review-regressions, typecheck exit 0. No commits. Static malformed-usage diagnostic observed as intended.
Task 2: complete — reducer RED 7 tests, metadata RED 5 tests; GREEN 3 files/70 tests (context-state, attempt-events, storage), typecheck exit 0 after exactOptionalPropertyTypes fix. No commits.
Task 3: core resolver/estimate honesty/vision/dispatch contextId + shared prepareHostContext green: 8 files/124 tests. Shared context-assembly coordinator unit added; final host coordinator integration still required. Typecheck then fixed a test cast; subsequent combined Task 4 run typecheck passed.
Task 4: core preview RED 3 tests → GREEN 5 files/79 tests, typecheck passed; extended canonical parity/attachments coverage still required.
Task 5: starting atomic measurement integration.
Ruling: Task 1 uses a static console warning instead of introducing a new observer diagnostic vocabulary — existing AttemptObserver only accepts AttemptFact; no raw payload is exposed — cost: warning not structured.
Task 5: complete — atomic async measurement (adoption 26 + host 43 + server-compaction 26/26). /manifest reconciles committed reducer vs live manifest by contextId and keeps the post-compaction preview until a request is assembled beyond the checkpoint.
Task 6: complete — kernel event `session/durable` (storage.spec 38/38); server SSE holds an uncommitted successful compaction/end and all events behind it, drains in seq order on commit, drops the hold on a failed end, and cuts snapshot/resume replay (cursor = last included seq). sse-resume 4/4 incl. parked-flush and rejected-flush cases.
Task 7: complete — labels (Last request / Estimated source tokens / Session average cache hit rate), docs/harness.md Measurement + prompt-contract.md budget section, e2e tests/browser/context-accounting.e2e.ts (1 passed against built web-dist, real SSE).
Gates: typecheck 0; build:web 0; playwright e2e 1/1; pnpm test: 4236 passed on first full run with 2 failures (server-compaction automatic-pressure assertion reading the post-compaction preview — test fixed to read the durable pre-compaction manifest; server-g1 steer — timing, passes alone 3x). Second full run: 3 different failures + 1 hook timeout (project-git-sync beforeAll 10s), all pass when the four files are run sequentially (65/65) — load-related flakes under parallel files, not reproducible alone.
Ruling: Not wired through prepareContextAssembly — the server keeps prepareHostContext (already shared by dispatch and preview); the standalone coordinator in src/web/context-assembly.ts stays unit-tested but unused by the host. Cost: a duplicated, unused module to remove or adopt in a follow-up.
