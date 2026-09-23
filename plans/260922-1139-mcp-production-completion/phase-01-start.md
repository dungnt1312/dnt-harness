---
phase: 1
title: "Threat Model and Compatibility Baseline"
status: completed
priority: P1
effort: "3-4 days"
dependencies: []
---

# Phase 1: Threat Model and Compatibility Baseline

## Overview

Freeze exact wire, security, deployment, protocol, and cross-plan contracts before changing runtime behavior. Turn every production blocker into a failing test or named platform gate and define semantics that later phases cannot weaken.

## Requirements

- Preserve current G5 success paths and existing policy/mode/child/workspace behavior.
- Pin accepted MCP protocol to `2025-06-18` for this release; older/future versions fail as `unsupported_protocol_version` until separately added.
- Define single-host/single-process data-home ownership and minimum safe rollback version.
- Define structured tool outcomes and durable event/API/browser mirrors.
- Classify every REST/SSE/upgrade route and every client by auth method and owner.
- Treat server-provided tool names/descriptions/schemas/annotations as untrusted model-context data.

## Architecture

Freeze these shared contracts:

```ts
type ToolOutcome = "success" | "error" | "indeterminate" | "audit_fault";
interface ToolResult {
  ok: boolean;
  output: string;
  outcome?: ToolOutcome;
  invocationId?: string;
}
```

- `indeterminate`: request may have executed remotely; no automatic retry.
- `audit_fault`: remote outcome is known/available but terminal evidence failed; further MCP dispatch is blocked.
- Transport dispatch API exposes conservative `not_dispatched | possibly_dispatched` receipt semantics for stdio and HTTP before Phase 4 uses it.
- Model-facing MCP metadata retains provenance, bounded length/schema, and cannot lower approval requirements or masquerade as host policy.

## Related Code Files

- Modify: `src/harness/tools/types.ts`
- Modify: `src/harness/session/events.ts`
- Modify: `src/harness/agent/agent.ts`
- Modify: `src/harness/agent/types.ts` if execution metadata is needed
- Modify: `src/harness/mcp/client.ts`
- Modify: `src/harness/mcp/config.ts`
- Modify: `src/index.ts`
- Modify: `web/lib/types.ts`
- Modify: `web/lib/project.ts`
- Modify: `web/components/chat/MessageParts.tsx`
- Modify: `web/components/artifacts/artifact-projector.ts`
- Modify: `web/hooks/useSessionStream.ts`
- Modify: relevant existing tests
- Create: `tests/fixtures/mcp-adversarial-server.mjs`
- Create: `docs/decisions/mcp-production-boundaries.md`
- Modify: `docs/capabilities.md`
- Modify: `docs/harness.md`

## Implementation Steps

1. Publish a protocol/capability/version table with update/deprecation procedure, fixture-review requirement, and stable diagnostic categories.
2. Freeze the tool-result/session-event/API/browser fields for `indeterminate` and `audit_fault`; non-MCP tools continue omitting optional fields.
3. Define transport dispatch receipt semantics and no-replay rules for write callback/backpressure, HTTP fetch/redirect, cancellation, reconnect, re-auth, and process death.
4. Define model-context trust rules: server metadata is provenance-labeled untrusted data; bounded; never treated as policy; annotations never reduce approval.
5. Inventory all REST/SSE/upgrade routes and browser/CLI/headless/PM2/test consumers with public/authenticated, cookie/bearer, CSRF/origin, expected 401/403/409, and migration owner.
6. Define canonical local origin, cookie/bearer discrimination, single-owner deployment, ownership-lock failure behavior, and minimum safe binary/schema rollback floor.
7. Add failing/adversarial fixtures for lost response, audit fsync failure, malformed negotiation, redirects, metadata prompt injection, repeated cursor, oversized/decompressed data, SSE CRLF, listener leaks, process escape attempts, config/secret races, and auth bypass.
8. Add policy-overlay/modes-only, root/child repeat, terminal auth/non-interference, and workspace isolation compatibility fixtures.
9. Fix non-`ENOENT` config/hooks/secrets reads immediately and add EACCES/directory/malformed envelope/master-key failure tests.
10. Update threat wording: filesystem encryption/ACLs do not protect against same-user code; local auth does not protect against same-origin XSS/extensions; env minimization is not a sandbox.

## Success Criteria

- [x] Shared outcome/event/API/browser contracts compile and have projection tests.
- [x] The dispatch receipt contract exists before no-replay implementation.
- [x] Every privileged route/client has an authentication migration entry.
- [x] Protocol/version acceptance and upgrade policy are explicit.
- [x] Single-owner topology and minimum safe rollback floor are explicit.
- [x] Server metadata prompt-injection tests prove it cannot change host authorization semantics.
- [x] Only `ENOENT` defaults to missing; all other configuration/security reads fail closed.
- [x] Existing MCP, approval, mode, child, workspace, host-guard, terminal, and model tests remain green.
- [x] No later phase depends on ambiguous terms such as “failed,” “cancelled,” “connected,” “revoked,” or “production complete.”

## Risk Assessment

This phase must not become a partial implementation hidden as “types.” If the structured outcome cannot be carried through the existing agent/session/browser projection without breaking providers, resolve it here. Do not allow later phases to serialize `indeterminate` as a normal failure or claim exactly-once remote effects.
