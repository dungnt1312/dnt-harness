# SDD ledger — plan: /Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/plan.md

User approval 2026-10-15 14:06: "Duyệt, implement theo SDD". Models: easy → cliproxy:claude-sonnet-5-5, hard → cliproxy:claude-opus-5-5, review → cliproxy:gpt-6.1-sol. User chose "continue on WIP" (context-accounting worktree) for Part B.

Worktree: /Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting, branch fix/context-accounting, HEAD 9a616e3 (22 commits behind main 709c562), 40 uncommitted WIP files from a prior native session (its ledger: .worktrees/context-accounting/plans/261014-1328-context-accounting/progress.md).

## Pre-flight facts
- WIP typecheck: pass. WIP affected tests: 17 files / 286 passed.
- 16 WIP files overlap files changed on main since 9a616e3 (server.ts, compaction-host.ts, builder.ts, compaction.ts, events.ts, web/App.tsx, ...). main adds reconstructFromLog, retarget, retryingCompactionStream, condense, parallel fold.

## Audit (gpt-6.1-sol, 2026-10-15) — defects
- D1 Important request-lifecycle.ts:266 settled consumer-return path drops terminal usage.
- D2 Important server.ts:10552 SSE gate never delivers the held compaction/end to an already-subscribed client.
- D3 Important server.ts:7453 fast display copies committed usage.last onto a new assembly.
- D4 Important server.ts:3760 capture spreads `projected` → loses controls, resurrects tools.
- D5 Important adaptive-vision.ts:11 fallback always names DescribeImage.
- D6 Important compaction-generator.ts:59 handoff forwards image parts regardless of target vision.
- D7 Important server.ts:1528 effective adoption can commit without full-fit when preparation throws.
- D8 Important server.ts:1528 preview lacks revision validation after awaits; legacy path passes no validate.
- D9 Important server.ts:1457 candidate assessment ignores fixed prompt/schemas/restoration/reserve.
- D10 Important web/App.tsx:1105 manifest lacks owning session; fetch error shown as no-request.
- D11 Important events-jsonl.ts:94 contextAfter validator accepts manifests missing history/sources/omissions.
- D12 Important server.ts:3513 model-without-provider uses DEFAULT_BUDGET, compaction uses catalog.
- D13 Important manifest-refresh.ts:11 terminal measurement facts do not change refresh key.
- D14 Minor server.ts:7443 GET manifest replays whole log, no incremental cache.
- D15 Minor format.ts:136 compaction formatter ignores measurement basis.
- D16 Minor ContextMeter.tsx:94 no Last request/model/basis, no separate estimate total.
- D17 Minor types.ts:162 policy.automaticCompactionPressure has no consumer.
- D18 Minor context-accounting.e2e.ts:103 does not assert estimate stage or StepInspector.
Audit also: legacy agent/request listener still resolves controls + adapts vision for requests without contextId; production reconstruction absent on WIP base (exists on main); context-assembly.ts unused by production.

## Rulings
Ruling: Checkpoint the WIP as a commit before merging main — a merge over 40 uncommitted files risks losing work; a commit is local, reversible, and the user authorized implementation — cost: one "wip" commit in branch history (squashable before merge).
Ruling: Delete unused src/web/context-assembly.ts and its unit test instead of wiring it — the WIP's prior ruling kept prepareHostContext as the single shared path; spec forbids a second pipeline/trivial wrapper; an unused module is dead code — cost: if a future preview needs the injected-loader seam it must be reintroduced.
Ruling: Part A (prompt-contract §4) lands on the same branch as Task 7 — user said "implement" the final spec, which has Parts A and B; one branch avoids a second merge over the same builder.ts — cost: larger final review.
Ruling: Ledger lives in plans/ (not .superpowers/sdd) — skill scripts are inside protected storage (denied); Markdown must stay under plans/ — cost: manual briefs/review packages.
Ruling: Prompt-contract Part A (now plan Task 7) treated as easy/sonnet; Task 0 merge treated as hard/opus — merge conflict resolution in server.ts requires judgment — cost: none significant.

## Execution
Task 0: implementer opus session-mv97l0qfidbuak DONE — WIP 69bbc2d, merge 2779275; typecheck ok; 1641 tests/111 files + 691 web tests pass. prepareHostContext folded into assembleRequest (+preview arg, commitPrefix); reconstructFromLog avoids command model via sideEffects=false. Review dispatched (gpt-6.1-sol session-mv98boedph7wbs).
Task 0: review ✅ Approved, no defects. Controller verified ⚠️ items: merge parents 69bbc2d+709c562, WIP commit has no plans/ files, lockfile identical to main.
Task 0: complete (commits 9a616e3..2779275, review clean)
Task 1: BASE 2779275, dispatching sonnet.
Task 1: implementer DONE 5b2f585 (5-file 120 pass; wider 3295 pass; typecheck 0). D11 tests placed in attempt-events.spec.ts (where contextAfter cases live). Review: spec ❌ only for Minor JSON.stringify key-order false warning (context-state.ts:97).
Task 1: fix round 1/5 dispatched (sonnet) for key-order comparison.
Task 1: fix round 1/5 (1 addressed, 0 open; commits 5b2f585..e792353)
Task 1: complete (commits 2779275..e792353, review clean)
Task 2: BASE e792353, dispatching opus.
Task 2: implementer DONE_WITH_CONCERNS 98e6fb3 (16 files/335 pass; typecheck 0; full 4377 pass, 1 fail server-g5 MCP isolation — passes alone 3/3). Deleted legacy agent/request listener + adaptRequestVision; compactionVisionOf; textOnlyVisionFallback(messages, describeAvailable). Concerns: precompute generateCompaction not vision-adapted; AC-20 test stubs TurnCommandGrants.prototype.clear. Review dispatched (gpt-6.1-sol).
Task 2: gpt-6.1-sol reviewer failed 3× (~75–90 s each, no output), and trivial health checks on gpt-6.1-sol and gpt-6-sol also failed after ~90 s → GPT provider outage, not prompt size.
Ruling: Use cliproxy:claude-opus-5-5 as task reviewer while GPT reviewers fail; retry gpt-6.1-sol for the final whole-branch review — user asked for gpt-sol-6.1 reviews, but stalling the run on a provider outage buys nothing — cost: per-task reviews by a different model family than requested; same family as Task 2's implementer (less independent).
Task 2: review (opus) spec ✅, quality Approved; 1 Important: precompute candidate streams to the captured command model while identity/usage/fit use the session model (compaction-precompute.ts:140, compaction-generator.ts:61-68, server.ts:1858) — exposed, not regression.
Task 2: minor (deferred): handoff to non-native target still forwards DescribeImage tool + prior fallback text naming it (compaction-host.ts:192).
Task 2: minor (deferred): AC-13/item-1 tests don't assert thinkingLevel equality capture vs dispatch — folded into fix round 1.
Task 2: minor (deferred): no server-level test for non-native handoff via compactionVisionOf (server.ts:1520).
Task 2: minor (deferred): AC-20 test stubs TurnCommandGrants.prototype.clear (server-session-model.spec.ts:110).
Task 2: minor (deferred): stale test name "stamps every request through agent/request" (tests/web/server.spec.ts:136).
Task 2: minor (deferred, pre-existing): captures.arm runs before agent/request waterfall; a plugin rewriting the request there would diverge from capture.
Task 2: fix round 1/5 dispatched (opus, fresh — no resume API) for the Important + thinkingLevel assertions.
Task 2: fix round 1/5 (2 addressed, 0 open; commits 98e6fb3..f525b88). gpt-6.1-sol re-review failed again; opus re-reviewed.
Task 2: minor (deferred): precompute nativeVision reads current session model, retarget uses identity model; a model switch between capture and candidate only wastes one request (candidate discarded as stale) (server.ts:1524).
Task 2: minor (deferred): startCandidate fit check measures stored snapshot (with images) before handoffSnapshot — conservative (server.ts:1834).
Task 2: complete (commits e792353..f525b88, review clean)
Task 3: BASE f525b88, dispatching opus.
User 16:35: "continue, no GPT any more, spawn in parallel where possible".
Ruling: Reviews switch to cliproxy:claude-opus-5-5 for the rest of the run — user instruction — cost: same model family as implementers.
Ruling: Parallelise Tasks 5, 6, 7 in separate worktrees from f525b88 (.worktrees/ctx-task5|6|7, branches fix/ctx-task5|6|7) while Task 3 runs in the main WIP worktree; Task 4 stays serial after Task 3 (both edit server.ts compaction/manifest regions). File overlap check: T5 = web/** + tests/browser + small server REST field for compaction measurement; T6 = tests/harness/context-preview.spec.ts (+builder only if a bug); T7 = builder prompt text, bash.ts, background-tools.ts, bundled.ts, todo.ts, Skill description in server.ts, docs. Conflicts expected only in small, distinct server.ts hunks; resolved by cherry-pick in order 3,4,5,6,7 — cost: possible small rebase conflicts.
Task 7: implementer DONE 84899ab on fix/ctx-task7 (1622 pass; typecheck 0). Review dispatched (opus).
Task 6: implementer DONE 5d647b5 on fix/ctx-task6 (tests only; 86 pass). Reports suspected compaction seedHash bug in adoptionProven (cutoff between standing coversSeq and its own compaction events). Review dispatched (opus) incl. bug assessment.
Task 5: implementer DONE cab7825 on fix/ctx-task5 (707 vitest, typecheck, build:web, Playwright 1/1). INCIDENT: implementer ran `git stash -u` / `git stash pop` in the MAIN checkout. Controller check: main HEAD 709c562 unchanged, stash list unchanged (2 old entries), 29 dirty entries present incl. user-owned WIP (sidebar compacting, grants, chip-clipboard); mtimes all 16:49:59. Report to user. Review dispatched (opus).
Task 7: review ✅ Approved; 4 minors (KillShell param text, Write/Edit/ApplyPatch "Read first" wording, no test for Skill hint, root-role MCP order not asserted) — folded into fix round 1 (sonnet) since cheap.
Task 6: review ✅ Approved; Important: restoration-replacement case never proves RESTORED_OLD visible first (context-preview.spec.ts:162); minors: `as never` fixture cast (spec:88), redundant assertion (spec:132), Kernel not closed (spec:73). Fix round 1 (sonnet) for the Important + redundant assertion.
Task 6: seed bug assessment (opus): rule mismatch real (adopt seed = standing checkpoint compaction.ts:409; recovery seed = checkpoint at cutoff compaction.ts:74). Production effect: snapshot with cutoff between standing.coversSeq and standing's own compaction events → /compact spends a model call then throws "compaction seed changed" (compaction-host.ts:225), repeats until a new turn closes; precompute discards as seed-changed. No data loss, no phantom checkpoint.
Ruling: Park the seed-rule mismatch as a separate follow-up, not in this plan — pre-existing on main, outside both specs, needs its own design choice (accept seed-at-cutoff vs exclude such snapshots) — cost: the wasted /compact call remains until fixed.
Task 5: review ❌ spec (D15 legacy label), Changes requested. Important: owner=null stays 'loading' forever (useContextManifest.ts:51); legacy/equal-basis compaction counts unlabeled (format.ts ~145). Minors: e2e lacks try/finally release (folded in); StrictMode double effect delays first fetch 150ms; refreshKey churn prolongs loading; workspace switch flashes "Context unavailable"; meter trigger lacks loading/error a11y text; ContextPanel pressure text repetition. Fix round 1 (sonnet).
Task 5: fix round 1/5 (3 addressed, 0 open; commits cab7825..7503a13; 769 vitest, typecheck, Playwright 1/1)
Task 5: minor (deferred): StrictMode double effect delays first fetch 150ms; refreshKey churn prolongs loading; workspace switch flashes "Context unavailable"; meter trigger lacks loading/error a11y text; pressure text repetition.
Task 5: complete (commits f525b88..7503a13 on fix/ctx-task5, review clean)
Task 6: fix round 1/5 (2 addressed, 0 open; commits 5d647b5..1be1a04)
Task 6: minor (deferred): `as never` fixture cast (context-preview.spec.ts:88); Kernel not closed per test (spec:73).
Task 6: complete (commits f525b88..1be1a04 on fix/ctx-task6, review clean)
Task 7: fix round 1/5 (4 addressed, 0 open; commits 84899ab..e0106a3)
Task 7: minor (deferred): BashOutput processId param text still "returned by Bash" (background-tools.ts:25); child-inherited observation not mentioned in Bash description.
Task 7: complete (commits f525b88..e0106a3 on fix/ctx-task7, review clean)
Task 3: first implementer (session-mv9bnkqjusssnt) was cancelled when the controller's turn closed at 16:35, ~22 min in; worktree had no changes left and no report. Re-dispatching opus from f525b88.
Task 3: implementer DONE 1ee650a, b14f922 (12 files/265 pass; full pnpm test 4386 pass, 2 skipped; typecheck 0). Concerns: revision hashes CLAUDE.md even when mode excludes it (safe side); assess cost with precompute on; D9 test placed in server-compaction-precompute.spec.ts. Review dispatched (opus).
Ruling: Start Task 4 in parallel on .worktrees/ctx-task4 (branch fix/ctx-task4 from b14f922) while Task 3 is under review — Task 4 touches SSE gate and /manifest only, disjoint from Task 3's compaction fit/revision code — cost: if Task 3 review forces changes in server.ts, Task 4 must rebase.
Task 3: review (opus) ✅ Approved, no Critical/Important.
Task 3: minor (deferred, user-visible → final review must triage): readWorkspaceInstructions/systemPrompts.load errors swallowed to ''/undefined inside revision hash → transient read error gives spurious `context revision changed` 409 (server.ts:1566-1567).
Task 3: minor (deferred, user-visible → final review must triage): revision hashes CLAUDE.md even when mode disables workspaceInstructions → editing CLAUDE.md during compaction fails it (server.ts:1563-1578).
Task 3: minor (deferred): revision omits memory/skill catalog content and exposed MCP schema set (server.ts:1563-1578).
Task 3: minor (deferred): takeReady deletes job before await; Stop during assess drops a valid candidate without `discarded` report (compaction-precompute.ts:~200,263).
Task 3: minor (deferred): assess maps every error to 'no-fit' (server.ts:1495); restorationFor in assess uses candidateLifetime.signal not caller's (server.ts:1493); small TOCTOU after final revision await (server.ts:1584).
Task 3: complete (commits f525b88..b14f922, review clean)
Task 4: implementer DONE 1671d75, 2132a09, a17e896 on fix/ctx-task4 (6 files/86 pass; full pnpm test 4391 pass; typecheck 0). Review dispatched (opus).
Task 4: review (opus) ✅ Approved, no Critical/Important.
Task 4: minor (deferred): failed-end-while-held drops held success permanently if it later commits — unreachable today due to inFlight (server.ts:10737).
Task 4: minor (deferred, pre-existing): unbounded hold queue if a barrier hangs without poisoning (server.ts:10747); live /manifest branch lacks `display` field; unavailable committed view hides newer live assembly (server.ts:7590).
Task 4: minor (deferred): liveIsNewer still scans log per GET on post-compaction (server.ts:7584); GET/DELETE race can re-add one contextReducers entry (server.ts:7575); D14 test doesn't cover reset path.
Task 4: complete (commits b14f922..a17e896 on fix/ctx-task4, review clean)
Integration: merging fix/ctx-task4, ctx-task5, ctx-task6, ctx-task7 into fix/context-accounting (order 4,5,6,7).
Integration: ff a17e896, merges ebb679c (t5), 53cc5cb (t6), f542ed6 (t7), no conflicts.
Gates on f542ed6: typecheck 0; build:web 0; pnpm test 343 files / 4410 pass / 2 skipped, exit 1 only from the 3 known pre-existing CSS.escape unhandled errors in git-panel-split/git-panel-entries specs (project memory). Playwright e2e passed on fix/ctx-task5 (7503a13); not rerun on merged head yet.
Final review dispatched (opus, session-mv9g2oqou224i0).
Playwright context-accounting e2e on f542ed6: 1 passed.
Final review: Ready after fixes. Important: previewCompaction scope lacks roleIdentityOf (server.ts:1596) → role sessions' post-compact preview/fit/assess measure a different request; docs/web.md:29-30,188 contradict new /manifest and /compact shapes. Minors: MCP config error makes preview throw (no per-turn fence); live /manifest lacks display; dead code (resolveContextLimit import, recordUsage, sessionUsage, unused measureCheckpoint params); docs/capabilities.md:407 DescribeImage wording; request-lifecycle late end append after turn/end.
Ruling: Final fix wave includes the Important, both docs fixes, dead code, capabilities.md wording, and the two Task 3 revision minors (swallowed read errors; CLAUDE.md hashed when mode excludes it) — reviewer called them cheap and user-visible (spurious 409) — cost: slightly larger final wave. Everything else stays deferred per the reviewer's triage.
Final fix wave: fe9b987 (8 files/169 pass; typecheck 0; pnpm test 343 files / 4414 pass / 2 skipped, only the 3 known CSS.escape errors; server-g5 and project-git-ops failed once in a first full run, passed 3/3 alone and in the second full run).
Final re-review (opus): all 5 ADDRESSED, no new Critical/Important. Minor (deferred): an I/O error on system-prompts.json between measure and validate surfaces as a raw I/O error (fail-closed) (server.ts:1592).
Cleanup: removed worktrees ctx-task4..7 (branches kept, all merged into fix/context-accounting). Branch fix/context-accounting HEAD fe9b987, not pushed, not merged into main. Main checkout untouched by this run except the Task 5 stash/pop incident (verified intact).
