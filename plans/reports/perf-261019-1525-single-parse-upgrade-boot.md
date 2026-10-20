# Single-parse first boot after upgrade

Status: DONE

## Change
- Session summaries project `modeFacts: { child, hasMode }` (whether the log holds a `session/child-meta` and a `session/mode` record). Boot rebuilds a summary that lacks it, in the same pass that adds `childRecovery`.
- `migrateRootModes` trusts an unloaded session's summary (`durableSummary`, reconciled with the canonical tail at boot) only when it says "child" or "has a mode". Both facts only ever turn true as an append-only log grows. A missing or negative fact, or a loaded session, still takes the canonical read, and only that path writes.
- The marker logic is unchanged; a missing, older or unreadable marker no longer forces a canonical read of every log, because verified summaries answer.

## Tests
- `tests/web/root-mode-migration.spec.ts`:
  - The equivalence test runs the migration on two copies of one home: one trusts summaries and one hides `durableSummary`. It covers stamped roots, a legacy root, a child with and without a mode, and a missing summary. The result, the marker entries and every log match. Only the legacy root is read through summaries.
  - The real-boot test strips `childRecovery` and `modeFacts` from `summary.json` and removes the marker. After boot it checks that each log is parsed exactly once and that both facts are rebuilt on disk.
  - The marker-fallback test is updated to the new semantics.
- Without the source change, these three tests fail.

## Measurement
Each run uses a fresh APFS clone (`cp -c -R`) of `~/.dnt-harness/data` (2.2 GB, 1202 sessions), with oauth and mcp-owner files removed. The clone is turned into an upgrade shape by stripping `childRecovery`/`modeFacts` from every summary and deleting the marker. The host runs with `HOME=<scratch>` on port 3099, and the timer stops at the `web: http` line. All clones were deleted, and nothing was left listening on 3099.

| Code | boot 1 (upgrade) | boot 2 | boot 3 |
|---|---|---|---|
| dev 5b14603 (baseline) | 20.1 s | 1.10 s | 0.31 s |
| this change, run A | 11.5 s | 0.30 s | 0.30 s |
| this change, run B | 12.6 s | 0.32 s | 0.26 s |
| this change, run C | 10.0 s | 0.31 s | 0.39 s |

## Trade-off
This loosens the "canonical reads decide" rule. A summary whose `lastSeq` matches the log tail is trusted for the two monotonic facts. A log replaced by a different log with the same final seq would go undetected, which is the same assumption child recovery already makes.
