---
phase: 7
title: "Desired-State Runtime Reconciliation"
status: in-progress
priority: P1
effort: "6-8 days"
dependencies: [3, 4, 5, 6]
---

# Phase 7: Desired-State Runtime Reconciliation

## Overview

Replace route-owned client maps with one supervisor per `(workspace, server)` while preserving global tool registration and workspace-dynamic descriptors. Config/secret mutations use the Phase 3 transaction kernel, fence old generations at a linearization point, and expose truthful desired/observed/ready/auth/audit state.

## Requirements

- Whole-workspace CAS/mutation queue prevents lost updates.
- Config/secrets/revocation tombstones/runtime fencing recover atomically through mutation intent/commit.
- After mutation acknowledgment, no new dispatch starts under old config/credential generation.
- In-flight work is only cancelled best effort and may complete remotely; this is surfaced truthfully.
- Secret deletion fences/removes local material; remote revocation is separate status.
- Failed activation remains durable after refresh/restart.
- Direct file drift fences execution and requires authenticated import.
- One global tool definition remains; workspace descriptor snapshots stay dynamic.

## Architecture

`McpRuntimeSupervisor` owns lifecycle. Routes mutate desired state only. Runtime status tracks:

```text
desiredRevision -> observedRevision -> readyRevision
credentialRevisionSet + immutable generation + ownership epoch
```

A mutation linearization point occurs under dispatch-admission lock after durable mutation intent and generation fence. Acknowledge only after desired state commit/fence durability; cleanup/reconciliation may continue with explicit status.

Secret state distinguishes missing env/header reference, external token required, managed OAuth auth-required, local revoked tombstone, remote revocation pending/failed/succeeded.

## Related Code Files

- Modify: `src/harness/mcp/config.ts`
- Create: `src/harness/mcp/runtime-supervisor.ts`
- Create: `src/harness/mcp/runtime-state.ts`
- Create: `src/harness/mcp/secret-dependencies.ts`
- Modify: `src/harness/mcp/mutation-store.ts`
- Modify: `src/harness/mcp/execution-coordinator.ts`
- Modify: `src/web/server.ts`
- Modify: `web/lib/api.ts`
- Modify: `web/lib/types.ts`
- Modify: `src/index.ts`
- Create: `tests/harness/mcp-runtime-supervisor.spec.ts`
- Create: `tests/web/mcp-config-concurrency.spec.ts`
- Modify: `tests/web/server-g5.spec.ts`
- Modify: docs

## Implementation Steps

1. Build supervisor keyed by workspace/server and migrate every lifecycle entry point. Add assertions preventing direct route mutation of client maps.
2. Preserve one global `mcp__server__tool` registration. Supervisor updates workspace descriptor rows; schema/execution resolves current workspace and generation at request/dispatch time.
3. Use workspace-wide mutation queue and whole-envelope CAS for create/update/import/activate/disable/reconnect/delete and secret changes.
4. Extract existing secret-reference scan and extend to env, headers, bearer/external token, managed OAuth metadata, and future credential fields.
5. Under mutation transaction: persist intent, fence generation under dispatch lock, write versioned artifacts/tombstones, commit pointer, then acknowledge. Recover incomplete transactions on startup.
6. Reconcile candidate generation; publish descriptors only if desired revision/ownership epoch remain current. Old health/recovery/list-change callbacks cannot resurrect state.
7. On config update failure, do not keep old runtime under new saved config. Expose stable failed/stale/auth/missing-secret categories and safe recovery action.
8. On secret deletion, guarantee no new old-generation dispatch after linearization, cancel in-flight best effort, remove/fence local material, and report remote revocation separately.
9. Persist/rebuild status with desired/observed/ready revisions, last handshake/error/attempt, breaker/next retry, auth/audit/containment state. Never infer “connecting” from missing client.
10. Verify config digest before dispatch and periodically. External drift or unreadable/invalid files fences all state whose effective config cannot be proven; require authenticated import.
11. Add same tool name/two workspace/different schema tests, generation rotation isolation, simultaneous server edits, config-versus-secret races, update during connect, disable during discovery, secret deletion during call, stale callbacks, failed activation across restart, mutation crash recovery, and drift tests.

## Success Criteria

- [x] Concurrent edits cannot silently overwrite each other.
- [x] Mutation acknowledgment defines a tested point after which no new dispatch uses old config/credential generation. The fence retires the old client before the write is saved and acknowledged; a call that has not been sent by then is refused unsent. A `hang` call in flight keeps its old generation in the journal and ends `indeterminate`; the first call after the acknowledgment carries the new generation and runs on a new process (`tests/web/mcp-runtime-reconciliation.spec.ts` "a call in flight keeps its old generation…"). The intent now records the generation of the runtime that carries the call, not the counter read at dispatch time.
- [x] In-flight and remote-revocation limitations are reported, never implied undone. A call cut by a fence tells the model it may already have run and was not undone or repeated (same test). Deleting a secret answers `localFence: 'fenced'` and `remoteRevocation: 'not_applicable'`; deleting a managed OAuth server answers `revocation: { local, remote }` (`tests/web/mcp-runtime-reconciliation.spec.ts` "MCP secret deletion").
- [x] Config command/URL/env/auth/transport/limits/allowlist changes reconcile to one current generation. Each change bumps the generation, drops the old client and its process, and a reconnect brings up exactly one runtime that only uses the new command/URL/token (`tests/web/mcp-runtime-reconciliation.spec.ts` "command, env, limits, allowlist, transport, URL and auth changes…").
- [x] Secret deletion produces stable local-fence and remote-revocation statuses with affected servers. `DELETE /secrets/:name` answers `{ deleted, localFence, affectedServers, remoteRevocation }`; the reading server's process is gone and its next start fails naming the secret. References are found anywhere in env, headers, static auth and a managed OAuth client secret (`src/harness/mcp/secret-dependencies.ts`, `tests/harness/mcp-secret-dependencies.spec.ts`); before this, rotation missed a reference embedded in a longer value.
- [x] Failed/auth-required/audit-fault/stale state survives refresh/restart. Two restarts of the same data home (`tests/web/mcp-runtime-reconciliation.spec.ts` "failed, auth-required, audit-fault and stale states read the same after the host restarts"). The audit fault and the unvalidated `mcp.json` are durable files; failed and auth-required are rebuilt by the reopen connect attempt from durable config, secrets and OAuth state, not read from a stored status record.
- [x] Old callbacks cannot publish/reconnect removed generations. A retired client's `tools/list_changed` refresh no longer calls back into the host (`tests/harness/mcp-client-fixes.spec.ts` "a tools/list_changed refresh in flight when the generation is retired…"; it called back before the fix). End to end, a save, a disable and a delete under a notification storm leave no listing, process, client or offered tool behind (`tests/web/mcp-runtime-reconciliation.spec.ts` "list-change refreshes of a fenced, disabled or deleted runtime…").
- [x] Global tool registration and two-workspace schema isolation remain correct. Two workspaces, one server name, different `query` schemas: each turn is offered one `mcp__fx__query` with its own schema, a call runs on its own workspace's process, and disabling one leaves the other ready (`tests/web/mcp-runtime-reconciliation.spec.ts` "one global tool name carries each workspace its own schema…").
- [x] External drift fences execution and cannot bypass CAS/audit.
- [x] Existing permission/mode/child/workspace contracts remain green. Full suite on 2026-10-18: 371 files, 5114 tests passed, 3 skipped (`bun run test -- --maxWorkers=3`), `bun run typecheck` clean.

Not done: implementation step 1 (one `McpRuntimeSupervisor` module owning lifecycle). Lifecycle, fencing and descriptor publication still live in `src/web/server.ts`; the criteria above are met through the existing generation counters and the per-workspace mutation queue. Extracting the supervisor is a refactor for a separate change.

## Risk Assessment

The critical risk is dual ownership during migration. Convert all lifecycle entry points in one phase and retain focused assertions. Acknowledging before cleanup is acceptable only when the old generation is already durably fenced; do not claim in-flight remote effects were revoked.
