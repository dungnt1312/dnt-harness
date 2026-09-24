---
phase: 5
title: "Protocol and Transport Hardening"
status: done
priority: P1
effort: "6-8 days"
dependencies: [1, 4]
---

# Phase 5: Protocol and Transport Hardening

## Overview

Make stdio and Streamable HTTP strict, bounded, cancellable, and compatible with the pinned profile. Consolidate discovery/reconnect paths, define safe outbound networking and redirects, and ensure no transport path can silently replay a call or leak credentials.

## Requirements

- Accept exactly MCP `2025-06-18` for this release and validate initialize/capabilities/envelopes/descriptors/cursors/session IDs.
- Bound application-controlled decoded bytes, headers, frames, pages, tools, descriptions, schemas, results, and notification churn.
- Clean timers/listeners/readers/pending maps on every terminal path.
- Complete LF/CRLF fragmented SSE behavior.
- Serialize connect/reconnect/cleanup and fence stale generations.
- Apply one outbound network policy to normal MCP HTTP and later OAuth endpoints.
- Model-visible server metadata is bounded, provenance-labeled untrusted data.

## Architecture

- `StdioTransport`: byte-counted decoder, pending lifecycle, dispatch receipt, child close/error propagation.
- `StreamableHttpTransport`: manual redirects, bounded decoded reader, compliant SSE, session handling, dispatch receipt, bounded DELETE.
- `OutboundRequestPolicy`: canonical URL, prohibited-address resolution, redirect-hop validation, proxy policy, DNS/connect/TLS/header/body/total deadlines, credential rules.
- `McpProtocolValidator`: initialize/JSON-RPC/tool descriptor/schema/cursor/session validation.
- `fetchAllTools()`: bounded pagination used for initial, health, list-change, recovery, and explicit refresh.
- `McpServerClient`: one connect/cleanup promise, one notification refresh in flight plus one coalesced follow-up.

## Related Code Files

- Modify: `src/harness/mcp/client.ts`
- Create: `src/harness/mcp/protocol.ts`
- Create: `src/harness/mcp/limits.ts`
- Create: `src/harness/mcp/sse-parser.ts`
- Create: `src/harness/mcp/outbound-policy.ts`
- Modify: `src/harness/mcp/config.ts`
- Modify: `src/web/server.ts`
- Modify: `src/index.ts`
- Modify: `package.json` and lockfiles if dependencies are introduced
- Modify: `tests/harness/g5-mcp.spec.ts`
- Create: `tests/harness/mcp-protocol.spec.ts`
- Create: `tests/harness/mcp-transport-limits.spec.ts`
- Modify: MCP fixture servers

## Implementation Steps

1. Define default/max limits for application buffers and decoded payloads; document runtime-owned header/buffer limits that cannot be fully controlled.
2. Replace unbounded concatenation with incremental byte-counted readers; disable unsupported compression or cap decompressed bytes to prevent gzip/brotli expansion.
3. Validate JSON-RPC, IDs, result/error exclusivity, exact protocol version, tools capability, server info, tool descriptors/schema depth/size/properties, annotations, cursors, cross-page duplicates, and bounded session ID.
4. Extract bounded `fetchAllTools()` for every discovery path. Debounce/rate-limit `tools/list_changed`; one refresh plus one coalesced follow-up.
5. Implement SSE for LF/CRLF, comments, multiline data, fragmentation, multiple/final events, and bounded frame/aggregate bytes.
6. Fix abort lifecycle: reject already-aborted, one listener/timer, cleanup in `finally`, no late cancellation for completed requests.
7. Add client connect/reconnect/cleanup single-flight; stale child close/error and recovery callbacks cannot publish state.
8. Set normal MCP HTTP `redirect: manual`. Never forward authorization, secret headers, or MCP session ID cross-origin; reserve security headers from user override. A post-dispatch redirect is indeterminate unless a tested protocol continuation exists.
9. Implement shared outbound policy: reject userinfo/fragments, HTTPS except explicit loopback fixture policy, prohibit private/link-local/metadata ranges by deployment policy, re-resolve and validate every hop, disable ambient proxies by default, and bound all stages.
10. Bound DELETE cleanup, include required same-origin custom auth headers, and serialize cleanup before half-open recovery.
11. Prevent SSE/reconnect from re-POSTing invocation. Cancellation remains best effort and never proves rollback.
12. Enforce model-context trust: bounded server descriptions/schema text retain provenance; readOnly/interaction annotations never reduce host approval.
13. Add tests for old/future/missing version, malformed capabilities/envelopes, CRLF SSE, decompression bomb, repeated cursor, notification storm, oversized data, stalled DELETE, already-aborted/listener growth, reconnect storm, redirects/credential leakage, DNS rebinding/IPv6/mapped IPv4/metadata/proxy injection, and metadata prompt injection.

## Success Criteria

- [x] Unsupported versions fail as `unsupported_protocol_version` before initialized notification.
- [x] Application-controlled decoded buffers never exceed documented hard limits. JSON responses are read through a decoded-byte counter (`readBoundedText`, `maxFrameBytes`); a ~20 MB gzip bomb in a few KB is refused mid-stream. Before this `response.json()` inflated and buffered all of it.
- [x] Every discovery path yields the same complete bounded tool set. One `fetchAllTools()` walk (cursor loop, page and tool caps, cross-page duplicates) now serves initial list, health check, breaker recovery, and `tools/list_changed`. Before this the last three fetched page one only, so a health check silently dropped later pages.
- [x] CRLF/fragmented SSE and notification storm tests pass. 200 `list_changed` notifications cost at most one refresh plus one coalesced follow-up (`tests/harness/mcp-transport-limits.spec.ts`); before, each one started its own refresh.
- [x] Redirects cannot leak credentials/session IDs or cause hidden call replay. A 307 on `tools/call` is `possibly_dispatched/redirect_followed`, the call is POSTed once, and the redirect target (which would have received the bearer) is never contacted.
- [x] Shared outbound policy blocks prohibited address/redirect/proxy cases.
- [x] Successful/failed/aborted calls leave no retained timer/listener/reader/pending entry. Measured for the abort listener on a long-lived turn signal (`getEventListeners` = 0 after success, HTTP 500, and a dead server); the HTTP path leaked it on every failure before. A turn already stopping now sends nothing (`not_dispatched/cancelled_before_send`) instead of being reported possibly dispatched. Readers release in `finally`; stdio pending entries and per-request timers are cleared in `finally` (by inspection, not a counter).
- [x] Concurrent reconnect triggers one transport generation. `ensureConnected` is single-flight: ten concurrent first calls build one transport and spawn one process. Before, each built its own; the overwritten ones leaked and the calls timed out.
- [x] Server metadata cannot alter approval/policy semantics.
- [x] Targeted tests and typecheck pass.

## Risk Assessment

Limits can reject legitimate large servers; expose bounded configuration with safe maxima and stable diagnostics. External parser/network dependencies must be pinned, licensed, vulnerability-reviewed, and included in clean-install/SBOM gates.
