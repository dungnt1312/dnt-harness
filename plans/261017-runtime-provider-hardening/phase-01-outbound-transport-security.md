# Phase 01 — Outbound transport security

## Context Links

- Spec §4 RH-1.
- Code: `src/harness/mcp/{outbound-policy,client,oauth,oauth-discovery}.ts`, `src/harness/tools/image-tools.ts`.

## Overview

- Priority: P1.
- Status: Implemented, committed `075c50c` (+ `529264a` OAuth-after-shutdown fix). RH1-A..F pass on Node + Bun probe. Pending gates: RH1-G live HTTPS smoke, Linux CI DNS probe run.
- Make policy-owned HTTP enforce connection-time DNS policy under production Bun.

## Key Insights

- Bun native fetch ignores Undici dispatcher.
- Under Bun 1.4.3, `import { fetch, Agent } from 'undici'` resolves to Bun's native shim: native fetch, Agent without `dispatch`, blocked lookup bypassed.
- Importing the npm package's real entry by resolved path loaded real Undici; blocked lookup prevented server access. Same probe streamed basic SSE and handled caller abort.
- OpenCode has no equivalent DNS-pinning implementation to copy.

## Requirements

- Load real Undici explicitly; never rely on bare `undici` specifier under Bun.
- Startup/runtime assertion: imported fetch is not native and dispatcher has callable `dispatch`; otherwise outbound policy transport is unavailable and fails closed.
- Use one long-lived policy dispatcher pool per policy mode.
- MCP/OAuth reject redirects; foreign media follows bounded validated redirects.
- Preserve configured same-origin media exception; strip credentials from foreign hops.
- Preserve caller signal and internal deadline through body consumption.
- Cancel/dispose bodies on every non-success path.
- Remove `fetchImpl === fetch` as a security switch. Inject only a low-level sender **under** the policy envelope; production modules cannot pass a raw fetch that bypasses validation/dispatcher. Add a test/lint check for production `fetchImpl` wiring.
- Enumerate and migrate every policy-owned call: MCP POST, SSE GET, `stop()` session DELETE, OAuth discovery/challenge/PRM/AS metadata, dynamic client registration, token/refresh/revoke, `src/web/mcp-oauth-connect.ts` paths, foreign media.
- Image same-origin exception applies only when the **initial** URL is same-origin. After any foreign hop, every later hop, including the configured origin, must pass public-only policy.
- Do not apply this transport to operator-configured LLM gateways.

## Architecture

- `outbound-http.ts` owns real-Undici loading, validation envelope, dispatcher selection, and narrow transport type.
- `outbound-policy.ts` owns IP/DNS checks.
- Callers own response semantics.

## Related Code Files

- Add: `src/harness/mcp/outbound-http.ts`.
- Modify: `src/harness/mcp/outbound-policy.ts`, `client.ts`, `oauth.ts`, `oauth-discovery.ts`.
- Modify: `src/harness/tools/image-tools.ts`.
- Add/Modify: outbound/MCP/OAuth/image tests and Bun runtime probes.

## Implementation Steps

1. Add failing Bun probe counting socket hits through bare specifier, then real-entry loader.
2. Add real-entry loader and fail-closed capability check.
3. Validate HTTPS/TLS, keep-alive, SSE, abort under Bun before migrating callers.
4. Migrate MCP POST/SSE GET and session-termination DELETE.
5. Migrate OAuth discovery, registration, token/refresh/revoke and web connect paths.
6. Migrate foreign media with per-hop policy, first-hop-only exception and credential stripping.
7. Remove production identity-check bypasses.
8. Run Node tests and Bun mock-free production-module probes for every caller; live smoke is additional evidence, not a substitute.

## Todo List

- [x] Real-Undici loader and capability guard.
- [ ] Bun TLS/SSE/abort spike. (SSE + abort proven on Bun; HTTPS/TLS against a real cert still needs RH1-G smoke — not run)
- [x] MCP migrated.
- [x] OAuth migrated.
- [x] Media migrated.
- [x] RH1 tests pass on Node and Bun (probe: scripts/outbound-http-probe.mjs). Report: reports/phase-01-outbound-transport.md

## Success Criteria

- RH1-A through RH1-F pass on Node and Bun; Bun probe imports production `outbound-http.ts` without Vitest/mocks/aliases and covers every caller. RH1-G has recorded smoke evidence before release.
- Bare-specifier regression test proves Bun shim is not used.
- Foreign media redirect to configured private origin is rejected.
- Private and rebinding destinations receive zero requests.

## Risk Assessment

- Real Undici incompatible with Bun TLS/SSE: stop phase and decide alternative connect-time enforcement; do not fallback to native fetch.
- Package resolution changes with bundling/global install: test source tree and installed package path.
- Pool closure on shutdown: explicit owner and close test.

## Security Considerations

- Fail closed if real dispatcher unavailable.
- Reject mixed public/private DNS answers.
- Keep TLS verification enabled.

## Next Steps

- Release blocker until complete.
