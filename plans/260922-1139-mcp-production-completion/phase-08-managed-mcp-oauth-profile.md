---
phase: 8
title: "Managed MCP OAuth Profile"
status: in-progress
priority: P1
effort: "7-12 days"
dependencies: [2, 5, 7]
---

# Phase 8: Managed MCP OAuth Profile

## Overview

Implement a deliberately bounded MCP OAuth compatibility profile, separate from local browser authentication. Support authorization-code + PKCE against pinned protected-resource/authorization-server metadata behavior, crash-safe token rotation, local-first revocation, and clear auth-required recovery without claiming universal provider interoperability.

## Requirements

- Release profile: authorization code + PKCE S256, high-entropy single-use state, protected-resource and authorization-server discovery as pinned by fixtures, static/manual client registration first.
- Dynamic client registration and provider-specific quirks are deferred unless a named required server demands and tests them.
- Shared outbound request policy from Phase 5 applies to every metadata, authorization, token, revocation, and optional registration endpoint.
- Tokens are encrypted, revisioned, never exposed in API/logs/traces/metrics, and updated through crash-safe credential state machine.
- Callback is bound to initiating authenticated principal, workspace/server, issuer, redirect URI, resource, and PKCE verifier.
- Revocation immediately fences locally; remote revocation is bounded best effort and reported separately.

## Architecture

Credential state:

```text
active -> refresh_in_progress -> replacement_persisted
-> generation_fenced -> active
active -> local_revoked_tombstone -> remote_revocation_pending
-> revoked | remote_revocation_failed
```

The authenticated initiator creates a one-time transaction. Because `SameSite=Strict` may omit the browser session on the cross-site redirect, the callback is a narrowly public deposit endpoint authenticated only by high-entropy single-use state transaction data; it atomically stores the code after validating issuer/server/resource/redirect/PKCE binding, then the original authenticated browser session completes token exchange. The callback never creates a local login session or exposes transaction status. Do not use OIDC nonce unless an actual ID-token profile is added.

Authorization servers may differ in origin from resource servers only through the validated metadata trust chain. Tokens bind to validated resource/audience; credentials never follow arbitrary redirects.

## Related Code Files

- Modify: `src/harness/mcp/config.ts`
- Create: `src/harness/mcp/oauth.ts`
- Create: `src/harness/mcp/oauth-store.ts`
- Modify: `src/harness/mcp/outbound-policy.ts`
- Modify: `src/harness/mcp/runtime-supervisor.ts`
- Modify: `src/harness/mcp/mutation-store.ts`
- Modify: `src/web/server.ts`
- Modify: `web/lib/api.ts`
- Modify: `web/lib/types.ts`
- Modify: `src/index.ts`
- Modify: package/lockfiles if dependency is selected
- Create: `tests/fixtures/mcp-oauth-server.mjs`
- Create: `tests/harness/mcp-oauth.spec.ts`
- Create: `tests/web/mcp-oauth.spec.ts`
- Modify: docs

## Implementation Steps

1. Freeze OAuth mini-spec: exact callback path/redirect URI, metadata documents, static/manual registration, PKCE/state, resource binding, scopes, token schema, time-skew policy, refresh backoff/budget, and supported fixture profiles.
2. Extend auth config to `none`, `bearer_ref`, `external_token`, `managed_oauth`; legacy OAuth ref stays external token.
3. Implement bounded metadata discovery through shared outbound policy: canonical URL, prohibited IP ranges, per-hop re-resolution, no ambient proxy, HTTPS except explicit loopback fixture, size/time/decompression limits, trusted issuer/resource chain.
4. Implement authenticated initiation and a high-entropy one-time state transaction bound to principal/workspace/server/issuer/resource/redirect/PKCE. Add the narrowly exempt callback deposit endpoint: it accepts no cookie authority, login, CORS, redirect, or status read; atomically consumes valid state and deposits the code for the initiating authenticated session to complete. Reject unsolicited/mismatched/expired/replayed callbacks before token exchange.
5. Exchange/store encrypted access/refresh token with credential revision. Persist refresh replacement before dispatchable publication; fence old generation before activating new token.
6. Serialize per-server refresh across runtime and ownership epoch; handle provider outage, backoff exhaustion, invalid_grant, time skew, token-store corruption, callback collision, user cancellation, and restart of unfinished authorization.
7. Implement local revocation tombstone first; fence dispatch immediately. Remote revocation uses bounded best effort, cannot delay local safety, never reactivates token, and reports unavailable/failed/succeeded.
8. Redact token/authorization values from errors, cause chains, HTTP diagnostics, audit, metrics, Playwright artifacts, and logs.
9. Add tests for success, denial, state mismatch/replay, PKCE failure, principal/workspace/server swap, issuer/resource mismatch, callback collision, refresh rotation crash at every state, concurrent refresh, provider outage, invalid_grant, token corruption, remote revocation absence/failure, SSRF/redirect/proxy attempts, and no leakage.
10. Publish an explicit support matrix naming fixtures/providers tested and marking dynamic registration/provider quirks unsupported.

## Success Criteria

- [x] Managed OAuth completes only for the documented compatibility profile.
- [x] Public callback deposit cannot create a local session or reveal state, and cannot bind to a different principal/workspace/server/resource/issuer; completion requires the initiating authenticated session.
- [ ] Refresh-token rotation is crash-recoverable and never allows old/new concurrent dispatch generations. Not covered by the current fixture.
- [x] Local revoke fences immediately; remote revocation status is truthful and bounded.
- [ ] Provider outage/backoff/time-skew/corruption transitions to actionable auth-required/failed state. Not covered.
- [ ] Shared outbound policy blocks SSRF, unsafe redirects, proxy injection, decompression, and credential forwarding. SSRF and userinfo are blocked. Proxy injection and decompression are not separately tested.
- [ ] Tokens never appear in API/UI/log/audit/metrics/test artifacts. The token file test asserts the secrets are absent. UI and log artifacts are not scanned.
- [x] Unsupported providers/features are not advertised as generally compatible.

## Risk Assessment

OAuth interoperability is broad. One local fixture cannot justify universal support, so the release claim stays profile-based. Dynamic registration remains follow-up unless a concrete target requires it. Same-user malware remains able to access user-level process memory and is outside token-at-rest protection claims.
