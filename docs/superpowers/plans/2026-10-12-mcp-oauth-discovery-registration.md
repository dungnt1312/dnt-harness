# MCP OAuth discovery, registration and Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote MCP server added by URL can be connected with OAuth from Settings → MCP: the host discovers the authorization server, registers a public client (or uses one the user entered), runs the sign-in, and the server runs with the token.

**Architecture:** Two new pure-ish modules (`oauth-discovery.ts`, `oauth-registration.ts`) feed the existing `ManagedOAuth`. `OAuthStore` keeps the per-server discovery record and registration encrypted beside the tokens. `src/web/server.ts` owns the redirect URI (loopback only), the three workspace routes, the HTML callback page, and the row's `oauth` field. `McpPanel` gains an Authentication choice and Connect/Reconnect/Disconnect with BroadcastChannel completion.

**Tech Stack:** TypeScript (Node 24, ESM), node:http, vitest (node + jsdom), React 19.

**Spec:** `docs/superpowers/specs/2026-10-12-mcp-oauth-discovery-registration-design.md`

## Global Constraints

- OAuth only through `127.0.0.1`, `localhost`, or `[::1]`; any other `Host` → `400 { code: 'loopback_required' }`.
- Redirect URI: `http://<request Host>/api/mcp/oauth/callback`, built by the host. Request bodies never supply endpoints, client ids, or redirect URIs.
- Registered clients are public: `token_endpoint_auth_method: "none"`. A registration answer with a `client_secret` or another method is refused.
- `clientSecret` in `mcp.json` is a `${NAME}` reference only. Secrets and tokens never appear in responses, errors, or `mcp.json`.
- Every discovery/registration fetch: `assertOutboundUrl(url, { allowLoopbackHttp: true })`, `redirect: 'manual'` (3xx fails), 10 s timeout, 64 KiB body limit.
- PKCE S256 required (`code_challenge_methods_supported` must include `S256`).
- No automatic step-up; `insufficient_scope` → token phase `auth_required` with `missingScope`.
- Protocol pin stays `2025-06-18`.
- Error codes: `loopback_required | discovery_failed | client_required | registration_failed`.

## Review Focus

1. A server URL with a trailing slash or default port must still match its PRM `resource` (GitHub advertises `…/mcp/`) — discovery test pins it.
2. A server deleted and re-added under the same name with a different URL must not receive the old token — the host refuses tokens whose stored record names another server URL (Task 6 test).
3. The callback page must not echo an unvalidated `state` into script — it only posts after a successful deposit and JSON-escapes `<` (Task 6 test).
4. A popup blocker or missing BroadcastChannel must not strand the user — the Finish button completes with the pending state (Task 7 test).
5. Saving a server form that was switched from OAuth back to None must drop `managed_oauth` entirely rather than keep a stale client id (Task 7 test).

---

### Task 1: `managed_oauth` config shape

**Files:** Modify `src/harness/mcp/config.ts` (type at line 33, `parseAuth` managed branch at 257-276). Test: `tests/harness/mcp-oauth-config.spec.ts` (new).

**Produces:** `McpServerConfig['auth']` managed variant `{ type: 'managed_oauth'; provider: string; resource: string; clientId?: string; clientSecret?: string; tokenEndpointAuth?: TokenEndpointAuth; scopes?: readonly string[] }`, exported `type TokenEndpointAuth = 'none' | 'client_secret_post' | 'client_secret_basic'`.

- [ ] Write failing tests: parses without `clientId`; rejects plain `clientSecret` ("must reference"); rejects `client_secret_post` without id/secret; old `{clientId}` file still parses; unknown key still rejected.
- [ ] Run `pnpm vitest run tests/harness/mcp-oauth-config.spec.ts` → FAIL.
- [ ] Implement: allowed keys add `clientSecret`, `tokenEndpointAuth`; `clientId` optional non-empty string; `clientSecret` matches `/^\$\{[A-Za-z0-9_]+\}$/`; method enum; non-`none` requires both.
- [ ] Run → PASS. Commit `feat(mcp): managed_oauth accepts registered and confidential clients`.

### Task 2: Store records and client authentication in `ManagedOAuth`

**Files:** Modify `src/harness/mcp/oauth-store.ts`, `src/harness/mcp/oauth.ts`. Test: extend `tests/harness/mcp-oauth.spec.ts`.

**Produces:**
- `OAuthServerRecord { serverUrl; resource; issuer; authorizationEndpoint; tokenEndpoint; revocationEndpoint?; scopes; registration?: { clientId; redirectUri; issuedAt }; discoveredAt }`.
- `OAuthStore.saveServerRecord(ws, server, record)`, `readServerRecord(ws, server)`, `deleteServer(ws, server)` (removes record and tokens).
- `OAuthTokens` gains optional `tokenEndpointAuth?: TokenEndpointAuth`, `missingScope?: string`; `OAuthTransaction` and `OAuthBegin` gain optional `tokenEndpointAuth`.
- `new ManagedOAuth(store, fetchImpl?, now?, secretFor?: (ws, server) => Promise<string | undefined>)`.
- `ManagedOAuth.markScopeRequired(ws, server, scope?: string): Promise<void>`; `ManagedOAuth.tokenState(ws, server): Promise<OAuthTokens | undefined>` (read-only passthrough).
- `ManagedOAuth.revoke(ws, server, endpoint?)` authenticates like the token endpoint.

- [ ] Failing tests: `client_secret_post` exchange sends `client_secret` in body and the token file lacks the secret; `client_secret_basic` sends `Authorization: Basic base64(id:secret)` and no `client_id` in body; refresh uses the stored method; `markScopeRequired` makes `accessToken` undefined and stores `missingScope`; `deleteServer` removes record and tokens.
- [ ] Implement: `exchange(endpoint, body, client: { id, method, secret })` applies auth; `complete`/`refresh` resolve the secret through `secretFor` when method ≠ `none` (missing secret → `OAuthFlowError('client secret is not available')`); tokens persist `tokenEndpointAuth`.
- [ ] Run `pnpm vitest run tests/harness/mcp-oauth.spec.ts tests/harness/mcp-resilience.spec.ts` → PASS. Commit.

### Task 3: Discovery

**Files:** Create `src/harness/mcp/oauth-discovery.ts`. Test: `tests/harness/mcp-oauth-discovery.spec.ts`.

**Produces:**
```ts
export type OAuthConnectCode = 'loopback_required' | 'discovery_failed' | 'client_required' | 'registration_failed'
export class OAuthConnectError extends Error { constructor(readonly code: OAuthConnectCode, message: string) }
export interface BearerChallenge { readonly resourceMetadata?: string; readonly scope?: string; readonly error?: string }
export function parseBearerChallenge(header: string | null): BearerChallenge | undefined
export function resourceCovers(serverUrl: string, resource: string): boolean
export interface DiscoveredOAuth {
  readonly resource: string; readonly issuer: string
  readonly authorizationEndpoint: string; readonly tokenEndpoint: string
  readonly revocationEndpoint?: string; readonly registrationEndpoint?: string
  readonly tokenEndpointAuthMethods: readonly string[]; readonly scopes: readonly string[]
}
export async function discoverOAuth(serverUrl: string, options?: { fetchImpl?: typeof fetch; scopes?: readonly string[] }): Promise<DiscoveredOAuth>
export async function fetchLimitedJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ status: number; body: unknown }>
```

- [ ] Failing tests against a loopback fixture: header PRM; well-known PRM with path then root; no PRM → origin issuer + server URL resource; RFC 8414 path-insert before OIDC for a path issuer; issuer mismatch, resource on another origin, no S256, 3xx, >64 KiB, 200 on initialize all → `discovery_failed`; trailing slash `…/mcp/` matches `…/mcp`; `https://h` covers `https://h/mcp`; scope precedence config > challenge > PRM; `parseBearerChallenge` handles quoted and unquoted params.
- [ ] Implement as specified. Run → PASS. Commit.

### Task 4: Client registration

**Files:** Create `src/harness/mcp/oauth-registration.ts`. Test: `tests/harness/mcp-oauth-registration.spec.ts`.

**Produces:**
```ts
export interface ResolvedClient { readonly clientId: string; readonly tokenEndpointAuth: TokenEndpointAuth; readonly registration?: OAuthServerRecord['registration'] }
export async function resolveClient(input: {
  readonly configured?: { readonly clientId?: string; readonly tokenEndpointAuth?: TokenEndpointAuth }
  readonly discovered: DiscoveredOAuth
  readonly redirectUri: string
  readonly previous?: OAuthServerRecord
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}): Promise<ResolvedClient>
```

- [ ] Failing tests: configured id → no network; previous registration with same issuer+redirect reused; changed redirect re-registers; registration body has `token_endpoint_auth_method: 'none'` and the exact redirect; answer with `client_secret` → `registration_failed`; no endpoint → `client_required` whose message mentions confidential-only when `tokenEndpointAuthMethods` lacks `none`.
- [ ] Implement. Run → PASS. Commit.

### Task 5: `insufficient_scope` in the HTTP transport

**Files:** Modify `src/harness/mcp/boundaries.ts` (add `'insufficient_scope'` to `DispatchNotSentReason`), `src/harness/mcp/client.ts` (`TransportEvents.onInsufficientScope`, `McpServerClient` resolved option `onInsufficientScope?: (scope: string | undefined) => Promise<void> | void`, `HttpTransport.post` 403 branch). Test: `tests/harness/mcp-insufficient-scope.spec.ts`.

- [ ] Failing test: fixture answers 403 `WWW-Authenticate: Bearer error="insufficient_scope", scope="write"`; `listTools` rejects with receipt `not_dispatched/insufficient_scope`, the callback received `"write"`, and the token source was asked once (no refresh).
- [ ] Implement. Run with `tests/harness/mcp-protocol.spec.ts` → PASS. Commit.

### Task 6: Host routes, rows, callback page

**Files:** Modify `src/web/server.ts` (ManagedOAuth construction ~777, `resolveMcpAuth` 2285, OAuth routes 5130-5172, `handleOAuthDeposit` 4364, list rows 5252, DELETE 5286), `src/harness/mcp/route-inventory.ts`, `src/index.ts` exports. Test: `tests/web/mcp-oauth-connect.spec.ts`.

Behaviour:
- `begin`: server must be `http` + `managed_oauth` (else 400 `discovery_failed`); loopback check; discovery; record; client; scopes = dedupe(discovered ∪ previous record scopes when reconnecting ∪ stored `missingScope` ∪ body `scopes`); save record (with `serverUrl`); `oauth.begin(...)`; reply `{ authorizationUrl, state }`. `OAuthConnectError` → `400 { code, error }`.
- `complete`: unchanged check, then if enabled: `cancelMcpConnection`, `mcpCancelled.delete`, `ensureMcpServer` (errors reported as `{ connected: true, status: 'failed' }`).
- `revoke`: endpoint from record.
- DELETE server: `oauthStore.deleteServer`.
- `resolveMcpAuth` for managed: record present with `serverUrl` ≠ config url → `auth_required`; pass `onInsufficientScope`.
- Rows: `oauth: { state, missingScope?, clientSource? }` for managed servers.
- Callback: HTML, CSP `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'`, BroadcastChannel post only on success.

- [ ] Failing web tests with a loopback fixture provider (PRM + AS + register + token + MCP endpoint): full Connect → callback HTML → complete → row `connected`, server `ready`; begin body endpoints/redirect ignored (redirect in authorizationUrl is the host's); `Host: example.test` → `loopback_required` (with `allowedHosts`); no registration endpoint → `client_required`; disconnect calls fixture revocation; insufficient_scope → row `needs_sign_in` with scope and the next begin requests the union; deleted-and-readded server with new URL → `auth_required`.
- [ ] Implement. Run new spec + `tests/web/mcp-integration-review.spec.ts` + `tests/web/mcp-production-stack.spec.ts` → PASS. Commit.

### Task 7: Web UI

**Files:** Modify `web/lib/api.ts`, `web/lib/types.ts`, `web/components/settings/McpPanel.tsx`. Test: `web/components/settings/mcp-oauth-panel.spec.tsx`.

- [ ] Failing component tests: Authentication OAuth saves `{type:'managed_oauth', provider: host, resource: url}`; advanced client fields add `clientId`, `clientSecret`, `tokenEndpointAuth`; switching to None drops auth; row badges per state; Connect opens a tab, a BroadcastChannel message with the state calls complete; Finish calls complete; `client_required` opens the editor with client fields shown.
- [ ] Implement. Run new spec + `web/components/settings/settings-panels.spec.tsx` + `management.spec.tsx` → PASS. Commit.

### Task 8: Docs and full verification

**Files:** `docs/capabilities.md` (MCP section), `docs/decisions/mcp-production-boundaries.md` (OAuth sentence).

- [ ] Update docs.
- [ ] `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`.
- [ ] Live check: begin against Linear through the real host returns an `authorizationUrl` on `mcp.linear.app/authorize` with the registered client; record what could not be checked without a person signing in.
- [ ] Commit, report.
