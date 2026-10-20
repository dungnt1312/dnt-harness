# SDD ledger — plan: plans/261019-0608-release-readiness/plan.md

Authority: docs/release-checklist.md + user decisions in the plan header; no separate spec.

## Preflight scan
| Pair / task | Shared surface | Finding |
|---|---|---|
| T1/T2/T3/T4 | .github/workflows/*.yml | Sequential; each later task builds on pinned runners/actions from T1. |
| T2/T3/T4/T8 | docs/release-checklist.md | Different sections; T8 does the final consolidation. |
| T6/T8 | hardening final report + plan status | T8 last. |
| T5 / T7 | none | Independent. |
| T8 self | worktree removal vs node_modules hook | find -type l at depth 1 avoids naming the dir; git does not follow symlinks on macOS. |
| T3 self | headless chat needs provider | Replaced by local fake OpenAI server — keeps CI secret-free. |

Controller (done): environment `release` created — required reviewer dungnt1312, prevent_self_review false, deployment limited to tag pattern v*; tag ruleset `release-tags` (id 25362958) blocks create/update/delete of refs/tags/v* except Admin/Maintain roles.
Ruling: prevent_self_review off — repo has a single maintainer, with it on nobody could approve publish — cost if wrong: a maintainer can approve their own release (acceptable for a solo repo).
Ruling: npm trusted publisher stays a user step (needs npmjs.com login) — cost if wrong: none.
Ruling: implementer reports live in the SDD workspace and are copied to plans/261019-0608-release-readiness/reports/ at the end — cost if wrong: none.
Task 1: minor (deferred): release.yml jobs on new artifact/setup-node majors unexercised until a release-like run — T8 to add a non-publishing dry-run path if cheap.
Task 1: complete (commits f7c487b..a439826, review clean)
Task 2: minor (deferred → T7): src/web/terminals.ts:696 and post-runTeardown comment still describe the old macOS tty snapshot model.
Task 2: minor (deferred → T7): terminals.ts:669-675 comment should say macOS relies on getsid (lstart non-numeric).
Task 2: minor (deferred): terminals.ts:634-636 lstart 1 s resolution identity window — disclosed, acceptable.
Task 2: minor (deferred → T7): macOS CI login-shell probe ran bash -l -i for both shells (runner login shell is bash); zsh login path proven locally only — make the probe force zsh -l -i in CI.
Task 2: minor (deferred → T8): release.yml job id linux-runtime-probes now gates macOS too — rename with checklist.
Task 2: minor (deferred → T8, release-blocking docs): release-checklist.md and guides.md still say gates "pending their first green CI run".
Task 2: complete (commits a439826..65fa752, review clean)
Ruling: Windows smoke triggered on pull_request (every PR push) instead of workflow_dispatch — dispatch 404s until the file is on main — cost if wrong: ~3.5 min CI per PR push.
Task 3: minor (deferred → T8): checklist links Windows runs on 1f8be0c/4b1ee46, not the final head.
Task 3: minor (deferred → T7): scripts/pm2-smoke-windows.mjs:648-650 survivor check may extend 5 s past the 15 s budget.
Task 3: minor (deferred → T7): windows-smoke.yml:227,231 headless chat check merges stderr into stdout.
Task 3: minor (deferred): pm2-smoke alive() PID reuse can flake (never false pass); pm2 installed without lockfile; DLL hashes duplicated in workflow and checklist.
Task 3: complete (commits 65fa752..7346497, review clean)
Task 4: minor (deferred → T8): linux-suite.yml has no push:main trigger, so a tag cut from main gets no Linux suite run — add trigger or checklist dispatch step.
Task 4: minor (deferred → T8): verify CLAUDE.md Linux/macOS gate lines are current (reviewers disagree).
Task 4: minor (deferred): 28-file deterministic-suites list never run as one invocation on Linux (tag-only workflow).
Task 4: complete (commits 7346497..cf8275d, review clean)
Task 5: minor (deferred → T7): chat-workflows.e2e.ts ~267 composer touch check relaxes all composer buttons to 36 px; assert 36 only for [data-compact-control], 44 for the rest.
Task 5: minor (deferred): Skills/Memory trees lack aria-level/setsize and arrow-key navigation (pre-existing, axe passes).
Ruling: hooks settings `validateHooksSection` dropping unknown keys (if, async, asyncRewake) on save is user data loss — added to T7 as must-fix before release — cost if wrong: small extra change.
Task 5: complete (commits cf8275d..9a25e35, review clean)
Task 6: fix round 1/5 (7 addressed, 0 open — attribution and prose-line checks, missing tests, tighter fact, scope caveats; commits 4aa86d6..41830d0)
Ruling: the absence-case FAIL (run 4) is a recorded finding, not a release blocker — the spec requires the eval to exist and be run with recall+tool count; diagnose with 5 more samples and local-only answer capture in T7 (item H); no base-prompt change this release without the user — cost if wrong: a real model habit of mis-citing stays unaddressed.
Task 6: complete (commits 9a25e35..41830d0, review clean after 1 fix round)
Ruling: hook entries the server cannot run (type prompt/agent, unknown events) are preserved verbatim on write and shown as kept-but-not-run; a group with only such hooks must not block Save — same no-data-loss principle as item A, merge-back is the least surprising choice — cost if wrong: users may expect the editor to clean up unsupported entries.
Task 7: minor (deferred): compaction-benchmark spec now skips any unparsable line, not only the trailing one.
Task 7: fix round 1/5 (3 addressed, 0 open — non-command hooks/unknown events kept on save, scorer negation anchored, Windows smoke waits for prompt; commits 3ababf1..b7f7aa0)
Task 7: minor (deferred): an invalid command hook (e.g. `if` on Stop) blocks every hooks save, including the disable-all switch, until fixed; error is actionable.
Task 7: minor (deferred): misspelled hook type badge could use warning colour.
Task 7: complete (commits 41830d0..b7f7aa0, review clean after 1 fix round)
Task 8: minor (deferred): .github/workflows/release.yml:6-8 header still says "Prevent self-review" on.
Task 8: minor (deferred): checklist doesn't list "merge PR #1" and "push v0.3.0 tag" explicitly as user-owned steps.
Task 8: minor (deferred): CHANGELOG claim "Bun built-in PTY on POSIX" not source-verified by reviewer.
Task 8: complete (commits b7f7aa0..009bd03, review clean)
Final review: 0 Critical, 1 Important (release.yml `npm version patch` would publish 0.3.1), minors; fix wave 009bd03..d4a986f, re-review all addressed except README link text (minor).
Ruling: add Task 9 for the 24 Playwright failures outside chat-workflows (unmocked /api/model-aliases etc.) plus README link text and checklist evidence refresh — the user's goal is a fully clean release and these are new findings, not a second fix wave — cost if wrong: extra CI cycle.
Task 9: minor (deferred): route mock block duplicated across 4 browser specs; Playwright suite not run in CI.
Task 9: complete (commits d4a986f..62c6e2b, review clean)
