---
phase: 2
title: "Local Control-Plane Authentication"
status: in-progress
priority: P1
effort: "6-9 days"
dependencies: [1]
---

# Phase 2: Local Control-Plane Authentication

## Overview

Protect the entire privileged local REST/SSE/upgrade surface before adding new mutation APIs. Introduce default-deny browser sessions, CSRF/origin enforcement, scoped CLI bearer credentials, approval binding, deterministic pairing, and client migration across sessions, agents, hooks, providers, secrets, terminals, and MCP.

## Requirements

- Public surface is limited to static assets, minimal liveness, pairing exchange, and the narrowly specified OAuth callback code-deposit endpoint from Phase 8; none may grant a local session except pairing exchange.
- Browser uses opaque server-side sessions; unsafe cookie mutations require CSRF and exact canonical Origin.
- CLI/headless uses separate scoped bearer credentials; mixed bearer/cookie modes are rejected.
- SSE and any upgrade handlers authenticate before replay/subscription and are fenced by session generation.
- Approval visibility/answers bind authenticated principal + workspace/session, not only UUID.
- Non-loopback remains refused without a separately configured authenticated TLS profile.

## Architecture

Add central pre-routing `ControlPlaneAuthService` and one browser `apiFetch()` seam. Pairing uses at least 256-bit random single-use credentials, stores only a keyed verifier, and consumes atomically through a fixed-size loopback POST. Credentials never appear in URL, process args, logs, traces, videos, HAR, screenshots, or browser console.

Browser cookie: host-only, `HttpOnly`, `SameSite=Strict`; `Secure` only where HTTPS makes it valid. Canonical allowed origin comes from trusted startup config, never request headers. Cookie mutations reject missing/null/multiple/foreign Origin and require CSRF; bearer requests may omit Origin but never fall back to cookies.

SSE streams bind principal/session generation/workspace; revocation increments generation and closes streams. `Last-Event-ID` cannot cross principal scope.

## Related Code Files

- Create: `src/web/control-plane-auth.ts`
- Create: `src/web/csrf.ts`
- Create: `src/bins/pair.ts`
- Modify: `src/web/server.ts`
- Modify: `src/bins/web.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `web/lib/api.ts`
- Modify: `web/App.tsx`
- Create: `web/components/auth/PairingGate.tsx`
- Modify: `web/hooks/useSessionStream.ts`
- Modify: service-worker behavior if needed
- Create: `tests/web/control-plane-auth.spec.ts`
- Create: `tests/browser/control-plane-auth.e2e.ts`
- Modify: `tests/web/server-host-guard.spec.ts`
- Modify: terminal/agent/hooks/provider/secrets route tests
- Modify: `docs/web.md`
- Modify: `docs/guides.md`

## Implementation Steps

1. Add centralized route classification/default-deny middleware before routing; public health exposes liveness only. Cover HTTP, SSE, and upgrades explicitly.
2. Implement protected session store, expiry, rotation, logout/revocation, rate limits, and audit. Pairing verifier is constant-time checked and atomically consumed.
3. Add pairing CLI and first-run browser gate. Pairing POST accepts no cookie/query/redirect/CORS, sets `Cache-Control: no-store`, rotates session ID, and invalidates credential in the same serialized operation.
4. Add `apiFetch()` to inject same-origin credentials, CSRF on unsafe methods, and consistent 401/403 behavior. Migrate every REST call and add a static test preventing direct internal API `fetch()` outside wrapper/stream helpers.
5. Authenticate native EventSource via same-origin cookie. Enforce session generation before stream creation and every event write; revoke closes streams and old reconnects fail before replay.
6. Bind approval creation/answer and pending-event projection to authenticated identity plus session/workspace. Approval UUID is not a bearer capability.
7. Add scoped CLI tokens with protected storage, rotation/revocation, explicit scopes, and no browser-cookie fallback. Reject simultaneous/mixed credential modes.
8. Preserve Host/DNS-rebinding and origin guards as defense in depth. Reject untrusted forwarded host/proto. Use `Sec-Fetch-*` as defense in depth, not sole authorization.
9. Migrate terminal, agents, hooks, providers, secrets, MCP, workspaces, sessions, and streams. Add upgrade test from pre-auth persisted data and an operator recovery path if pairing state is lost.
10. Add test-only bootstrap via protected stdin/temp file/IPC on random loopback and isolated data only. Assert unavailable in production and absent from Playwright artifacts/logs.
11. Add terminal compatibility tests: authenticated loopback succeeds; unauthenticated/foreign-origin fails; non-loopback remains denied; MCP lifecycle does not dispose PTYs; shutdown owns namespaces independently.
12. Add revocation/write/reconnect races, pairing replay/expiry/brute-force, cookie fixation, CSRF, foreign/null Origin, bearer scope, and approval hijack tests.

## Success Criteria

- [x] Every privileged REST/SSE/upgrade request is default-denied without valid auth.
- [x] Pairing is high-entropy, atomic single-use, rate-limited, and never leaked to logs/artifacts/URLs.
- [x] Browser mutations require valid CSRF plus canonical Origin; bearer clients are separately authenticated.
- [x] Logout/revocation closes live streams; reconnect/Last-Event-ID cannot cross session generation or principal.
- [x] Approval UUID alone cannot view or approve a call.
- [ ] All web REST callers use `apiFetch()` and auth failures are actionable. REST goes through `apiFetch()`; a static ban on direct `fetch()` and the browser e2e are still open.
- [ ] Existing terminal/session/agent/hooks/provider flows work for paired users and fail closed otherwise. Unauthenticated routes fail closed; the paired-user browser pass is still open.
- [ ] Test bootstrap cannot exist in production profile.
- [x] Non-loopback startup remains blocked absent an authenticated TLS profile.

## Risk Assessment

This is a whole-product migration. Ship no new privileged mutation surface before this middleware is active. Plain HTTP loopback cookies have known limitations and do not protect against same-user malware or same-origin XSS; product wording must remain qualified.
