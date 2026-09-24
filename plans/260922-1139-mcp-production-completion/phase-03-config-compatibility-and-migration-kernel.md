---
phase: 3
title: "Config Compatibility and Migration Kernel"
status: done
priority: P1
effort: "4-6 days"
dependencies: [1, 2]
---

# Phase 3: Config Compatibility and Migration Kernel

## Overview

Implement compatibility and recovery before changing configuration defaults. Add v1/v2 readers, versioned config/revision envelopes, explicit omitted-enabled quarantine, migration/backup journal, ownership lock, mutation transaction primitives, and an enforced minimum safe rollback floor.

## Requirements

- Existing v1 files remain readable without changing activation behavior until migrated.
- v2 requires explicit activation state and supports CAS revision/hash.
- Legacy omitted `enabled` is classified/quarantined, never silently activated by v2.
- Legacy OAuth access-token references become `external_token`, not managed sessions.
- One data-home owner is proven before journal/runtime writers start.
- Migration and rollback are crash-recoverable and preserve ACLs/key compatibility.
- Unsafe old binaries refuse migrated data.

## Architecture

Create a versioned desired-state envelope and migration journal:

```text
validated -> backup_written -> backup_verified -> mutation_started
-> artifacts_committed -> migration_committed
```

Use a unique protected backup ID/manifest/checksum. A durable compatibility marker records minimum safe binary/schema version. Rollback means deploying a known-safe compatibility build or disabling new features while retaining the safety kernel; rollback below no-replay/journal/fencing support is prohibited.

Implement one data-home ownership lock with owner ID and fencing epoch covering every workspace/runtime/journal under that data home, using heartbeat/lease or OS lock semantics appropriate to the filesystem, crash takeover rules, and startup refusal on split-brain. PM2 remains single fork instance; the lock still protects against accidental second hosts.

Config/secret/revocation changes use a mutation intent/commit pointer so multi-file changes recover deterministically; independent atomic renames alone are insufficient.

## Related Code Files

- Modify: `src/harness/mcp/config.ts`
- Create: `src/harness/mcp/config-v2.ts`
- Create: `src/harness/mcp/migration.ts`
- Create: `src/harness/mcp/mutation-store.ts`
- Create: `src/harness/mcp/ownership-lock.ts`
- Create: `src/bins/migrate-mcp.ts`
- Modify: `src/bins/web.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Create: `tests/harness/mcp-migration.spec.ts`
- Create: `tests/harness/mcp-ownership-lock.spec.ts`
- Create: `tests/fixtures/mcp-config-v1/`
- Modify: `tests/web/server-g5.spec.ts`
- Modify: `docs/guides.md`

## Implementation Steps

1. Define v1 and v2 schemas, exact version markers, revision/hash semantics, downgrade floor, and stable diagnostics.
2. Build a v1 compatibility reader and v2 writer. Do not reinterpret omitted `enabled` until explicit migration; v2 never allows omitted activation.
3. Implement authenticated dry-run migration: no config/secret/network/OAuth/process/runtime mutation; only an explicitly requested protected report is written.
4. Create unique restrictive backups and migration journal. Preserve ownership/mode/ACLs, encrypted secret/key compatibility, checksums, and non-overwrite behavior.
5. Implement restart recovery at every migration durable boundary and termination tests after each step.
6. Map legacy explicit enable/disable; quarantine omitted-enabled entries disabled with review reason; map old OAuth refs to `external_token`.
7. Add compatibility marker/startup gate so an unsafe old binary fails before runtime start. Test downgrade-read/refusal behavior.
8. Implement ownership lock/fencing epoch and PM2 single-owner prerequisites. Test concurrent startup, holder SIGKILL, takeover, split-brain rejection, and lock loss fencing.
9. Implement mutation intent/commit abstraction for config/secrets/revocation tombstones/revisions. Recovery completes or rolls back incomplete mutations deterministically.
10. Add workspace-wide config mutation queue and whole-envelope CAS, following `ModesService` rather than weaker per-file patterns.
11. Define direct file edits as unsupported live API: digest mismatch fences affected runtimes; authenticated import/migration is required. No `fs.watch` subsystem in the production milestone.
12. Add disk-space preflight, timeout/abort, permission errors, partial/torn backup, key mismatch, interrupted rollback, and stale revision tests.

## Success Criteria

- [x] v1 is readable and v2 is writable before any default changes land.
- [x] Omitted-enabled legacy entries are quarantined and cannot auto-start.
- [x] Legacy token references are accurately classified as external tokens.
- [x] Migration dry-run performs no network/process/token/runtime mutation.
- [x] Backup/migration is idempotent, non-overwriting, restrictive, checksum-verified, and crash-recoverable. `tests/harness/mcp-migration.spec.ts` kills the run after every durable step; `recoverMigrations` (run at host start and by `migrate-mcp --apply`) restores the verified v1 bytes or marks an untouched run abandoned, twice-safe, and refuses a backup that fails its checksum. The marker now lands before the target changes, and the target is replaced atomically. Backup directories are unique (`mkdir` without `recursive`, random suffix). ACL preservation beyond `0o600`/`0o700` modes is not claimed on Windows.
- [x] Unsafe older binaries refuse migrated data before opening MCP runtimes.
- [x] Exactly one data-home owner can write/reconcile; lock loss fences dispatch.
- [x] Multi-file desired-state mutation has durable intent/commit recovery. Secrets now go through `MutationStore` like config; `tests/web/mcp-desired-state.spec.ts` leaves both intents open and proves restart restores both, keeps a committed sibling, and is idempotent.
- [x] Concurrent config/secret mutations cannot silently overwrite one another. Every config and secret write runs load → transform → save inside one per-workspace queue (`updateMcpConfig`/`updateMcpSecrets`), with the revision check inside the turn. Before this, 10 concurrent secret PUTs returned 9×500 and lost keys, an interleaved delete/disable/save dropped a server, and two saves on one stale revision both returned 201.
- [x] Direct external edits cause drift/fencing and require authenticated import.

## Risk Assessment

Ownership semantics on network filesystems may be unreliable; production support should require a local filesystem unless a tested distributed lease is introduced. Migration cannot promise downgrade to the current unsafe binary; enforce the minimum safe floor technically rather than relying on operator discipline.
