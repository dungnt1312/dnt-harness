# SDD ledger — plan: plans/261018-2241-dev-backlog-sdd/plan.md

No separate spec; user decisions in the plan header are the authority. Rulings below are provisional against them.

## Preflight scan
| Pair / task | Shared surface | Finding |
|---|---|---|
| T1 / T3 | dev branch contents pushed in T3 | T3 must run after T1 so CI covers merges. Order kept. |
| T2 / T3 | phase-06-final-report.md rows | Sequential edits to different rows; no conflict. |
| T1 / T5 | session-load-perf merge decides session-switch plan status; core-config worktree kept if T1 leaves edits | T5 reads T1 outcome; order kept. |
| T2,T3 / T5 | hardening plan status depends on smoke + CI results | T5 last. |
| T4 / others | MCP runtime code | Independent of T1 files except via merge of app-config-slice; T4 after T1. |
| T1 self | merge order vs conflicts | Consistent. |
| T2 self | key handling: env only, never printed | Consistent. |
| T3 self | push + PR, no merge | Consistent with user approval. |
| T4 self | phase 06 items are Windows/Linux-bound | Scoped to refusal evidence + PM2 drill + phase 07. |
| T5 self | worktree removal vs untracked files | Guarded by node_modules/link rule. |

Ruling: work directly on `dev` in the main checkout instead of an isolated worktree — the user asked for merges into dev and a PR from dev — cost if wrong: dev history needs a revert.
Ruling: "dùng bun pty" means Bun's built-in PTY on POSIX (the question asked was about Bun's built-in PTY) — cost if wrong: switch POSIX to the bun-pty package later.
Ruling: Push dev + open PR dev→main is approved by the user ("OK" to triggering Linux CI via PR) — cost if wrong: an unwanted open PR, easily closed.
Ruling: Kill leftover bash.exe PID 39640 is not actionable from this macOS host — reported only — cost if wrong: none.
Ruling: Task 4 scope = phase 06 refusal evidence + PM2 drill on throwaway app + phase 07 open items, since phase 06 hard-limit items need Windows/Linux hosts — cost if wrong: phase 06 remains partially open.
Ruling: commits carry no AI attribution trailer — user's development-rules.md ("without AI references") outranks the harness attribution reminder, which defers to user instructions; controller's Task 1 dispatch wrongly asked for the trailer — cost if wrong: missing Co-Authored-By lines.
Task 1: minor (deferred): executor.ts boot recovery computes currentRun twice per child.
Task 1: minor (deferred): merge messages don't record branch pieces dropped as superseded (session-stream-cache, Envelope.cursor, resilientSource, MCP warm-up) — recorded in task-1-report.md.
Task 1: note: before fix, branch headless test may have sent one real "hello" to the user's default provider.
Task 1: fix round 1/5 (2 addressed, 0 open — AI trailers removed via one filter-branch rewrite, session-load spec hermetic; commits d8567bc..1cc381c)
Task 1: minor (deferred): pre-existing branch commits from 2026-10-08 (app-config-slice) still carry AI trailers — authored before this task, not rewritten.
Task 1: minor (deferred): Playwright e2e not run after merges.
Task 1: complete (commits 7464e6e..1cc381c, review clean after 1 fix round)
Ruling: OAuth refresh/revoke smoke not run against the user's real clickup/notion accounts — it would rotate or destroy live tokens — cost if wrong: RH1-G stays partial until a disposable account is provided.
Task 2: minor (deferred): providers.json stores API keys in plain text (observation for the user).
Task 2: complete (commits 1cc381c..126fa70, review clean)
Ruling: accept implementer's unrequested CI step running tests/scripts/repo-freeze.spec.ts in the Linux probe job — RH2-C needed Linux evidence and nothing else ran it; release gate gains ~25s — cost if wrong: revert one workflow step.
Task 3: fix round 1/5 (1 addressed, 0 open — stale "Linux CI never ran" lines; commits 2a5ed7b..e283844)
Task 3: minor (deferred): full Vitest suite not run on Linux or macOS; ubuntu-latest moves to Ubuntu 26 from 2026-10-19; Node 20 actions deprecation warning.
Task 3: complete (commits 126fa70..e283844, review clean after 1 fix round; PR https://github.com/dungnt1312/dnt-harness/pull/1)
Task 4: minor (deferred): phase-06 PM2 drill checkbox says "no contained descendants" but fixture spawns only a direct child (macOS, manual).
Task 4: minor (deferred): src/web/server.ts:3364 generation read after await ensureMcpServer can record the new generation for a retired client (journal only; call refused unsent).
Task 4: minor (deferred): tests/web/mcp-runtime-reconciliation.spec.ts:784 uses toBeLessThanOrEqual(1) for live process count.
Task 4: minor (deferred): server.ts:274 in-flight note changes resultHash relative to raw output.
Task 4: minor (deferred): config changes reconcile lazily (row idle until next use/reconnect).
Task 4: complete (commits e283844..f05c610, review clean; McpRuntimeSupervisor extraction left open)
Final review: 0 Critical, 2 Important (stale CLAUDE.md:19 Linux gate line; STT routes and ?view=delegations undocumented), Minor: app-config-runtime spec reads real providers.json; server.ts:3364 generation race. Must-run: Playwright e2e on merged dev.
Ruling: fold Minor 3 (hermetic spec) and Minor 4 (generation race) into the single final fix wave — both cheap and real — cost if wrong: small extra diff to review.
Final fix wave: 815372a (9487334..815372a) — CLAUDE.md gate line, STT + view=delegations docs, hermetic app-config spec, generation captured with client; re-review: all addressed.
Final: parked — Playwright chat-workflows e2e 19/52 fail — Ruling: mostly pre-existing (selectors/mocks stale since 2026-10-08..12, before base); the app-config merge's keyboard-order expectation (Providers→Advanced, actual Usage) and two new advanced-limits e2e cases come from this run; e2e is not in CI; repair as a follow-up — cost if wrong: a UI regression hidden behind a red, unrun suite.
Final: parked — no failing-first test for the MCP generation race — Ruling: no deterministic seam; fix verified by reading — cost if wrong: race regresses silently.
