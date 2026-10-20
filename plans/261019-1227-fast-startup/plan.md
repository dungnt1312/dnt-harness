---
title: "Fast web startup"
status: completed
branch: dev
created: 2026-10-19
---

# Fast web startup

Measured on a clone of the real data home (2.2 GB, 1200 sessions, 837 children): the web host takes ~19 s to listen. A CPU profile puts ~14 s in `readEventLog` (JSON parse of full logs). Two boot steps read full canonical logs every time:

- `migrateRootModes` (`src/harness/modes/root-migration.ts`) reads every session's full log on every boot, although the migration is one-off.
- `childExecutor.recoverFromStorage()` (`src/harness/agents/executor.ts` ~450) reads the parent log and every child log (~906 reads, 7.5 M events, ~5.5 s) even for children that settled long ago.

User decision (2026-10-19): fix it now and ship it in v0.3.0. The migration records that it finished and stops rescanning; recovery uses summaries and only reads children that are not settled yet.

## Global Constraints

- Branch `dev` in `/Users/dungnt/workspace/dnt-harness`; PR https://github.com/dungnt1312/dnt-harness/pull/1 is open (dev → main). Push fast-forward to `origin dev` when checks pass; never force-push, never merge the PR, never tag.
- Behavior must be identical to today's boot for every case the existing code handles: children are still indexed, interrupted children are still reconciled exactly once, owed background reports are still restored, skipped-child warnings still fire, root-mode snapshots are still added to roots that lack one. Logs remain canonical; summaries/markers are derived and rebuildable — a missing, stale or older-format summary/marker must fall back to the canonical read, never to a wrong verdict.
- No data migration of user logs. New derived fields/markers only. A downgrade followed by an upgrade must not leave a root without a mode snapshot or a crashed child unreconciled (version the marker; fall back when unsure).
- Use Bun 1.4.3; `bun run test` (not `bun test`), `bun run typecheck`; Node >= 22.19 first on PATH for Vitest; local full suite `--maxWorkers=3`.
- Conventional commits, no AI references, no Co-Authored-By trailer, no plan/task IDs in code, test names or commit messages.
- Never run a second web host against the real `~/.dnt-harness` (data-home lock, live MCP/OAuth). Measure on an APFS clone (`cp -c -R ~/.dnt-harness/data <scratch>/base/.dnt-harness/data`, remove `oauth`, `oauth.master.key`, `mcp-owner.*` from the clone, run with `HOME=<scratch>/base`), in the scratchpad `/private/tmp/claude-501/-Users-dungnt-workspace-dnt-harness/312b8751-1cd0-4e4e-bf3b-051e0f7d182e/scratchpad`; delete the clone afterwards. Stop every process you start.
- A shell hook blocks commands containing `node_modules` or `dist`; don't bypass it.

## Tasks

### Task 1: Root-mode migration runs once

- After a complete, successful `migrateRootModes` pass, persist a versioned completion marker in the data home (e.g. `root-mode-migration.json` with `{ version, completedAt }`). On later boots with a current marker, skip the full scan.
- Keep correctness for sessions that could still lack a snapshot: confirm new roots always get a mode snapshot at creation (cite the code); if any creation path can produce a root without one, handle it cheaply (e.g. from the summary) instead of a full scan.
- A failed/partial pass writes no marker. Bump the marker version if the migration's logic ever changes (document in a comment).
- Tests: marker written after success; second boot does not read canonical logs (spy/count); partial failure leaves no marker; old/missing marker triggers the scan.

Acceptance: second boot performs zero canonical reads in the migration; tests above pass.

### Task 2: Child recovery reads only unsettled children

- Use session summaries to decide which children need canonical reads. A child is settled when the parent has recorded a terminal result for the child's current run and no background report is still owed. Make that decidable from derived data: add the minimal fields to the summary projection(s) (child and/or parent) that the summary rebuild derives from canonical events, so an old summary without the fields falls back to the canonical read and the next rebuild fills them.
- Settled children are indexed from summaries alone (ids only, as today). Unsettled or unknown ones go through the existing canonical path unchanged (skip warnings, owed background, reconcile).
- Tests: equivalence — for a fixture store covering settled, interrupted (crash after spawn), owed-background, resumed child, missing parent, foreign workspace, old-format summary, the recovered index/owed set/reconcile calls equal the previous algorithm's; settled children cause no canonical read (count).

Acceptance: equivalence tests pass; settled children trigger zero canonical reads.

### Task 3: Measure, verify, roll out

- On a fresh APFS clone of the real data, measure time-to-listen before (current `origin/dev` before Task 1, via `git stash`-free means: run the old commit from a temporary `git worktree` only if dependencies resolve; otherwise use the numbers in this plan: ~19 s) and after; run twice (first boot fills new summary fields/marker, second boot is the steady state). Target steady state < 3 s; report both boots and a CPU profile summary if above target.
- Full suite, typecheck, push; PR runs (Linux suite, runtime probes, Windows smoke, release dry run) green.
- Add a CHANGELOG line under 0.3.0.
- Restart the user's PM2 app `dnt-harness` (it runs from this checkout) only after CI is green, and record its time-to-health for the first and a second restart.

Acceptance: steady-state boot on the clone under target (or explained), CI green, PM2 app healthy, CHANGELOG updated.
