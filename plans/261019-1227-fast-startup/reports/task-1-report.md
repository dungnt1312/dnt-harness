# Task 1 report: root-mode migration runs once

Status: DONE_WITH_CONCERNS (one design deviation, explained below)
Commit: e821302 `perf(modes): skip the root-mode migration scan for sessions a completed pass verified` (pushed fast-forward to origin/dev; push range 45da53f..e821302, so 724c387 went up with it)

## What changed
- `src/harness/modes/root-migration.ts`
  - `ROOT_MODE_MIGRATION_VERSION = 1`. The comment says to bump it whenever the decision logic changes.
  - After a pass finishes, it writes `<home>/root-mode-migration.json` atomically (`replaceFileAtomic`) with `{ version, completedAt, verified: [sessionIds] }`.
  - On the next boot a current marker's `verified` set is trusted. Sessions in the set are skipped with no read. Sessions outside it get the usual canonical read and migration.
  - The marker is ignored, which means a full scan, when it is missing, unparsable, has another version or has no `verified` array.
  - A pass that throws writes nothing. Any previous marker is left as it was, and it is still correct because it only lists sessions that were verified.
  - The marker is rewritten only when the set changed: no current marker, a new session examined, or a verified session gone. An unchanged boot does zero writes.
- `tests/web/root-mode-migration.spec.ts`: the existing test now deletes the marker before it simulates a legacy log, as real pre-upgrade data has no marker. Added 5 tests:
  - the marker is written with version 1, `completedAt` and the verified roots
  - a later boot makes zero `readCanonicalEvents` calls (spy on `SessionsService.prototype`)
  - a root created after the marker without a snapshot is read alone (the reads equal `[extra]`), gets stamped and is added to the marker
  - a failure part-way through (2nd read throws, so boot rejects) leaves no marker, and the next boot finishes the job
  - a missing, `version: 0` or garbage marker sends the boot back to a full scan and rewrites a v1 marker

## Deviation: a verified-id set, not just `{ version, completedAt }`
A bare completion flag would be wrong, because some creation paths make roots with no mode snapshot:
- Stamped: `createRootSession` in `src/web/server.ts` (~9654 `sessions.create`, then 9669 `deps.stampRootMode(session, mode)`).
- Not stamped:
  - legacy `POST /api/sessions` (`src/web/server.ts` ~6775)
  - the headless CLI (`src/bins/headless.ts:411`, only `session/project`)
  - `SessionsService.fork` of a legacy root (`src/harness/session/service.ts:347`, which copies events)
  - any root written by an older host after a downgrade
- The summary has no mode field. Adding one would need a new derived field, and older-format summaries would fall back to reads anyway.

The id set covers every case cheaply: only sessions not yet verified are read, which is once per new session. A downgrade followed by an upgrade is also safe, because roots made while downgraded are not in the set. Logs are append-only, so a mode fact or `child-meta` in a verified session cannot go away. The marker for about 1200 sessions is 30 KB.

## RED/GREEN evidence
- RED: 5 of 6 new or changed tests failed before the implementation (no marker file; 3 reads on the second boot).
- GREEN:
  - `npx vitest run tests/web/root-mode-migration.spec.ts`: 6/6
  - with `root-mode.spec.ts`: 9/9
  - `bun run typecheck`: clean
  - `bun run test --maxWorkers=3`: 374 files, 5167 passed, 2 skipped, exit 0 (244 s)

## Timings (APFS clone of real data, HOME=<scratch>/base, oauth/mcp-owner removed; clone deleted afterwards)
| Boot | Time to listener | Canonical reads, all | Canonical reads, migration |
|---|---|---|---|
| No marker | 16.1 s, 12.9 s | 2106 | 1200 |
| With marker | 4.1 to 5.5 s | 906 | 0 |

The 906 reads left over come from `childExecutor.recoverFromStorage()`, which is the next task. No processes were left running.

## Concerns
- The marker carries a `verified` id list beyond the brief's example shape (rationale above).
- Fresh data homes: the first boot writes a marker with an empty list, and new roots are verified on the following boot (one read each).

---

# Fix round 1

Status: DONE
Commit: 07d3b0b `fix(modes): re-verify shortened logs and stamp the mode on every new root` (pushed fast-forward, e821302..07d3b0b)

## Changes
1. **Log length is now part of trust.** The marker is now version 2: `verified: [{ id, lastSeq, child? }]`.
   - A verified entry is trusted only while `summary.lastSeq >= entry.lastSeq`. `SessionsService.boot()` reconciles the summary's lastSeq with the canonical tail, so a shorter log gets read again. That covers a log restored from a backup, a truncated log and a deleted log.
   - A version-1 marker, an entry that fails validation, or a garbage marker leads to a full scan, or a read of that one entry.
   - `lastSeq` is taken from the canonical events that were read. For a migrated root, it is taken from the loaded session after `durable()`.
2. **`skippedChildren`** now counts verified children too (entry `child: true`).
3. **A verified root whose events.jsonl is gone** still fails the boot, as it did before. The reason: the tail is 0, so the rebuilt summary has lastSeq 0, which is below the recorded value, so the log is re-read. The original path then fails on `fs.readFile(logPath)` with ENOENT. Before the marker, the error also came from that readFile, not from "no canonical log". A test covers this.
4. **Tests:** a child log is now part of the marker tests. `spyMigrationReads()` counts only reads whose stack includes root-migration, which excludes child-recovery reads. A direct `migrateRootModes` call asserts `{ migrated: 0, skippedChildren: 1 }` with zero reads.
5. **Mode stamped at creation.** New `src/harness/modes/root-mode-record.ts` holds `rootModeRecord(resolved, revision)`. Three places now share it: the server's `stampRootMode`, the migration and headless.
   - The legacy `POST /api/sessions` route stamps `controlsFor(wsId).modeDefinition` and calls `durable()`. If that fails, it deletes the session and returns 500, as `createRootSession` does.
   - `src/bins/headless.ts` stamps the resolved mode (revision 1) before `session/project`. Its context build now passes `modeRevision: 1`, the stamped revision, where it used to pass 0.

## RED/GREEN
- **RED:** 8 of 10 migration-spec tests failed before the change:
  - restore-from-backup: the root stayed without a mode
  - marker shape
  - the legacy route: no session/mode
  - the deleted-log case: the boot succeeded

  The headless test also failed before its fix (no session/mode record).
- **GREEN:** `root-mode-migration.spec.ts` 10/10. Together with `root-mode.spec.ts` and `tests/bins/headless.spec.ts`: 28/28. `bun run typecheck` is clean. `bun run test --maxWorkers=3`: 374 files, 5172 passed, 2 skipped, exit 0.

## Concerns
- Headless `modeRevision` in the context manifest changed from 0 to 1, to match the stamped record. No test depended on 0.
