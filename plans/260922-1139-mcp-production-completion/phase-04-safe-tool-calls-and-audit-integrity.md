---
phase: 4
title: "Safe Tool Calls and Audit Integrity"
status: done
priority: P1
effort: "5-7 days"
dependencies: [1, 3]
---

# Phase 4: Safe Tool Calls and Audit Integrity

## Overview

Remove automatic replay and add crash-durable MCP execution evidence under the proven single-owner lock. Preserve the agent’s existing durable canonical `tool/call` barrier, then add a second transport-dispatch journal immediately before bytes may be sent.

## Requirements

- At most one automatic application-level dispatch per invocation.
- Ambiguous post-dispatch outcomes become `indeterminate`.
- Known remote result plus journal failure becomes `audit_fault`, not false failure/indeterminate.
- Every possible dispatch has a synced intent first.
- Recovery is idempotent and never dispatches unresolved calls.
- Manual repeat is a new invocation with fresh current approval/policy identity.
- Journal operational lifecycle covers ACLs, quota, ENOSPC, corruption, repair, retention, backup, and key rotation.

## Architecture

Two durability boundaries remain distinct:

1. `Agent.step()` persists the final rewritten/authorized canonical `tool/call` and fsyncs the session log.
2. `McpExecutionCoordinator`, invoked from the workspace-aware MCP adapter in `src/web/server.ts`, checks current runtime generation, persists `dispatch_intent`, and calls the transport dispatch contract.

Journal path:

```text
<data-home>/workspaces/<workspace-id>/mcp/executions.jsonl
```

Use a dedicated codec/validator or extracted generic sequenced JSONL helper; do not reuse session-specific `readEventLog` unchanged. Records carry schema/canonical digest algorithm/key ID, invocation/attempt IDs, session/tool/workspace, config/secret revisions, generation, policy decision reference, timestamps, dispatch receipt, terminal/late evidence, and redacted diagnostics.

Same-user tamper resistance is out of scope; call this crash-durable evidence, not immutable audit.

## Related Code Files

- Create: `src/harness/mcp/execution-journal.ts`
- Create: `src/harness/mcp/execution-coordinator.ts`
- Modify or generalize: `src/harness/storage/events-jsonl.ts`
- Modify: `src/harness/agent/agent.ts`
- Modify: `src/harness/agent/types.ts`
- Modify: `src/harness/tools/service.ts`
- Modify: `src/harness/tools/types.ts`
- Modify: `src/harness/session/events.ts`
- Modify: `src/harness/mcp/client.ts`
- Modify: `src/web/server.ts`
- Modify: `src/index.ts`
- Modify: `web/lib/types.ts`
- Modify: `web/lib/project.ts`
- Modify: `web/components/chat/MessageParts.tsx`
- Modify: `web/components/artifacts/artifact-projector.ts`
- Modify: `web/hooks/useSessionStream.ts`
- Modify: `tests/harness/agent-loop.spec.ts`
- Modify: `tests/harness/storage.spec.ts`
- Modify: `tests/harness/g5-mcp.spec.ts`
- Modify: `tests/web/server-g5.spec.ts`
- Create: `tests/harness/mcp-execution-journal.spec.ts`

## Implementation Steps

1. Remove the generic three-attempt `tools/call` retry. Forbid hidden replay via redirect, reconnect, re-auth, cancellation recovery, or repeated JSON-RPC ID.
2. Implement dedicated journal codec, contiguous sequencing, torn-tail recovery, middle-corruption fail-closed, writer poisoning, close/flush, and owner-lock assertion.
3. Preserve the agent’s existing canonical tool-call durability barrier; pass final invocation/session/policy metadata to the MCP coordinator rather than reconstructing it.
4. Persist `dispatch_intent` and fsync before transport dispatch. Use the Phase 1 receipt contract conservatively; unknown write state is `possibly_dispatched`.
5. Enforce one terminal record per invocation. Startup recovery checks existing terminal/late evidence and idempotently terminalizes unresolved intents as indeterminate.
6. Implement `audit_fault` contract: remote result may be shown to the user with integrity warning but is not reported as durable normal success to the agent; block subsequent MCP dispatch until repaired.
7. Store full-length keyed digests with algorithm/canonicalization/key ID. Define key rotation and loss behavior without storing raw sensitive arguments/results.
8. Add journal quota/retention/export/compaction preserving invocation lineage; restrictive permissions; disk-space reserve/preflight; alert thresholds; read-only diagnostics during audit fault; operator repair workflow.
9. Manual repeat creates a new invocation linked to prior ID, displays duplicate-effect warning, re-enters rewrite/mode/child/policy/approval, and cannot inherit obsolete grants.
10. Add tests for lost response, one client dispatch, crash in each window, late response, already-cancelled, terminal fsync failure, ENOSPC, permission changes, locked file, torn tail, corrupt middle, sequence gap/repeat, simultaneous writer rejection, duplicate recovery, key rotation, backup restore, and shutdown flush.
11. Add child/root repeat tests and update generic UI copy that currently says retrying is always safe.

## Success Criteria

- [x] Lost-response fixture observes one dnt-harness dispatch and one fixture side effect; claim is explicitly host no-replay, not universal exactly-once. A real stdio fixture records each `tools/call` in `SIDE_EFFECT_FILE` before replying; `hang` never replies. `tests/harness/mcp-execution-journal.spec.ts` sees one send and one remote effect across a same-process repeat and a reopened journal.
- [x] Every ambiguous post-dispatch failure returns `indeterminate` and is never automatically repeated.
- [x] Every possible dispatch has a synced intent under the current ownership epoch. With a real `DataHomeLock`, a host whose data home was taken over (new epoch) writes no intent and sends nothing; every intent on disk carries the epoch live when written.
- [x] Restart recovery is idempotent and never sends unresolved calls.
- [x] Known remote outcome plus terminal persistence failure is `audit_fault` and blocks new dispatch.
- [x] Journal corruption/disk-full/permission faults fail closed with an operator recovery path. A real permission fault (read-only journal) refuses the intent and every later call without sending; a refused terminal record is an `audit_fault` that blocks the next dispatch. Recovery: `POST …/mcp/audit-repair` now reopens a faulted journal from disk — a transient fault (full disk, permission since fixed) recovers once the file validates, a corrupt one stays blocked. ENOSPC shares the same write-failure path; it is not produced on a real full disk.
- [x] Manual repeat gets new invocation ID and fresh current approval. `tests/web/server-g5.spec.ts` repeats an approved call — reusing the model's call id — and sees two approvals, two intents, two remote effects. Before this, `invocationId` was the model's call id, so a provider that reuses ids got a freshly approved call answered from the old record and never sent. It is now minted per execution.
- [x] Existing gate ordering and non-MCP tool behavior remain unchanged.
- [x] Journal contains no plaintext credentials/protected payloads and docs do not claim same-user tamper resistance.

## Risk Assessment

The unavoidable uncertainty window remains between durable intent and remote commitment. Conservative false uncertainty is accepted. If filesystem JSONL cannot satisfy one-owner durability and operational repair on supported deployments, change the storage engine before release rather than weakening pre-dispatch or recovery guarantees.
