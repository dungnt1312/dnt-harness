# Session switch patch SDD completion

## Scope and constraints

User chose independent review and completion of the existing session-switch performance patch, not full virtualization. Use zpro:glm-5.3 for delegates. Preserve unrelated dirty agent/MCP changes. No commit, push, restart or deploy. Work in the current checkout for review; ask before relocating or overwriting existing work. Reports stay under plans/. Language Vietnamese; cwd /Users/dungnt/workspace/dnt-harness, timezone Asia/Saigon.

Specification: scope-safe transcript output; bounded recent-history cache (four inactive sessions and conservative 16 MB payload budget per hook); immediate cached paint with delta cursor synchronization; valid native reconnect header precedence and full snapshot fallback; no missing or duplicate projected events; pending actions remain authoritative; reference-sensitive gates do not rerun irrelevant full-log derivations; viewport-sized initial tail (30–100 blocks) with older items accessible.

## Tasks

1. Independently review existing patch for spec compliance and correctness/performance defects. Inspect new tests, hook lifecycle, React concurrency/StrictMode, cursor compaction and replay, pending approvals/questions, cache memory bounds, derived invalidation and transcript window.
2. Fresh implementer fixes confirmed findings with regression tests and scoped verification; task reviewer checks amended code. No controller source edits.
3. Final independent scoped integration review, affected tests, typecheck, web build and full suite if behavior changes. Record limitations and unresolved findings.

## Preflight

| Tasks | Interface | Result |
|---|---|---|
| 1 → 2 | Findings with reproducible evidence | Reviewer read-only; implementer owns source edits |
| 2 → 3 | Source/tests and verification report | Sequential edits, reviewer reads final revision |
| 1 | Existing patch, not new scope | Consistent |
| 2 | Fixes require covering tests | Consistent |
| 3 | Checks must distinguish existing failures | Consistent |
