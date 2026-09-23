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
- [ ] Mutation acknowledgment defines a tested point after which no new dispatch uses old config/credential generation. Generation bumps on fence. A test that a call already in flight keeps the old generation is still open.
- [ ] In-flight and remote-revocation limitations are reported, never implied undone.
- [ ] Config command/URL/env/auth/transport/limits/allowlist changes reconcile to one current generation.
- [ ] Secret deletion produces stable local-fence and remote-revocation statuses with affected servers.
- [ ] Failed/auth-required/audit-fault/stale state survives refresh/restart. Stale is detected on the next read. Restart survival is not a separate test.
- [ ] Old callbacks cannot publish/reconnect removed generations.
- [ ] Global tool registration and two-workspace schema isolation remain correct.
- [x] External drift fences execution and cannot bypass CAS/audit.
- [ ] Existing permission/mode/child/workspace contracts remain green.

## Risk Assessment

The critical risk is dual ownership during migration. Convert all lifecycle entry points in one phase and retain focused assertions. Acknowledging before cleanup is acceptable only when the old generation is already durably fenced; do not claim in-flight remote effects were revoked.
