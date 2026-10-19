# SDD ledger — plan: plans/261019-1227-fast-startup/plan.md

## Preflight scan
| Pair / task | Shared surface | Finding |
|---|---|---|
| T1/T2 | session summaries / boot order in src/web/server.ts | T1 touches root-migration + marker; T2 touches executor recovery + summary projection. If T1 needs summary fields too, T2 builds on them. Sequential. |
| T2/T3 | measurement depends on both | T3 last. |
| T1 self | marker vs downgrade/upgrade | Versioned marker + creation-path check. |
| T2 self | settledness from derived data | Fallback to canonical read for old summaries. |
Ruling: run boot-path changes as two separate tasks with an opus implementer each — correctness of crash recovery outweighs speed — cost if wrong: extra review cycle.
Ruling: accept marker as verified-id list `{id,lastSeq,child}` instead of a plain done flag — legacy POST route, headless, forks and downgrades can create roots without a snapshot — cost if wrong: ~30 KB marker.
Task 1: fix round 1/5 (5 addressed, 0 open — lastSeq guard for restored logs, child count, missing-log failure kept, scoped read test, stamping at creation; commits e821302..07d3b0b)
Task 1: minor (deferred): marker trusts a replaced log of equal or greater length; missing-log failure now surfaces as readFile ENOENT instead of "no canonical log".
Task 1: complete (commits 724c387..07d3b0b, review clean after 1 fix round)
Task 2: minor (deferred): a log with a corrupt middle record but valid tail keeps a trusted summary — settled child indexed without the boot warning (next real read still errors).
Task 2: minor (deferred → T3 CHANGELOG): first boot after upgrade rebuilds every summary once (~10 s on real data).
Task 2: minor (deferred): old-format-summary path during recovery covered only via mock; equivalence reference is the new function with lookup mocked.
Task 2: complete (commits 07d3b0b..0606b40, review clean)
Task 3: fix round 1/5 (1 addressed — CHANGELOG rebuild time corrected to 20–25 s; commit 5a937cb)
Task 3: note: commit 247f0e7 carries a Co-Authored-By trailer (pushed; not force-pushed).
Ruling: leave the 247f0e7 trailer in history rather than force-push the shared PR branch — force-push needs the user's say-so — cost if wrong: one commit with an attribution line unless squash-merged.
Task 3: complete (commits 0606b40..5a937cb; clone steady state 0.36–0.68 s, first upgrade boot 20–24 s; PM2 2nd restart 1.48 s)
Final review: ship in v0.3.0; 0 Critical/Important; CHANGELOG note added (7295a63).
