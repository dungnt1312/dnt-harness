# MCP OAuth: discovery, client registration, and Connect

Status: implemented 2026-10-12, then extended the same day (see "Revision:
other machines"). Analysis and probes:
`plans/reports/analysis-261012-1716-mcp-oauth-dcr.md`.

## Revision: other machines (user request, 2026-10-12)

The first version refused to start unless the app was open at a loopback
name. The user wanted OAuth to work from other machines too, so the
"Loopback only" decision below is replaced by three modes, chosen from the
request's `Host`:

| Mode | When | Redirect URI | Finishes |
|---|---|---|---|
| `loopback` | `127.0.0.1`, `localhost`, `[::1]` | `http://<host>:<port>/api/mcp/oauth/callback` | on its own |
| `origin` | `Host` matches a `--oauth-origin` (https origin; `DNT_HARNESS_OAUTH_ORIGINS` for pm2) | `<origin>/api/mcp/oauth/callback` | on its own |
| `paste` | any other name | `http://127.0.0.1:<bound port>/api/mcp/oauth/callback` | the person pastes the final address into the panel |

Consequences: `loopback_required` is gone; `begin` also returns
`redirectMode`; `complete` accepts `{ callbackUrl }` as an alternative to
`{ state }`. `ManagedOAuth.acceptCallbackUrl` reads `state` and `code` from the
pasted address and deposits them, and only for the pending sign-in of the same
person, workspace, and server, at its exact redirect address. The redirect is
built from the declared origin or the bound port, never from the text of the
`Host` header. An origin that is not an https origin with no path fails the
host's start. The sections below still describe the loopback mode; read
"Loopback only" as "loopback needs no declaration".

## Goal

A user adds a remote MCP server by URL, clicks **Connect**, signs in at the
provider, and the server runs with an OAuth token. No endpoint, client id, or
redirect URI is typed by hand when the provider supports dynamic client
registration. Providers without it work after the user pastes a client id and
secret they created.

Success, checked against live providers after implementation: Linear, Notion,
Atlassian, and Sentry connect with no manual client; GitHub connects with a
user-created OAuth app.

This unblocks the MCP catalog (`2026-10-12-mcp-catalog-design.md`), which
will add OAuth entries afterwards.

## Decisions

| Topic | Decision |
|---|---|
| Registration | Option A, in MCP spec priority order: a client the user entered, then dynamic client registration (RFC 7591), then ask the user for a client. Client ID Metadata Documents are not built. |
| Client type | Registered clients are public (`token_endpoint_auth_method: none`) with PKCE. Manual clients may be public or confidential (`client_secret_post` / `client_secret_basic`). |
| Where OAuth works | Loopback only. Connect refuses when the app was opened through any host other than `127.0.0.1`, `localhost`, or `[::1]`. |
| Finishing sign-in | Automatic. The callback page signals the app tab, which completes the exchange. A **Finish** button is the fallback. |
| `insufficient_scope` | No automatic step-up. The server shows **Needs sign-in** with the missing scope; **Reconnect** asks for it. |
| Protocol pin | Stays `2025-06-18`. Discovery follows that revision and the 2025-11-25 fallback order, which is a superset. |

## Current state this builds on

`ManagedOAuth` (`src/harness/mcp/oauth.ts`) already does authorization code +
PKCE S256, sends `resource` (RFC 8707), deposits the code through the public
callback without creating a session, completes only for the initiating
principal, stores tokens encrypted, refreshes under a lock with generation
fencing, and revokes locally first. `resolveMcpAuth` in `src/web/server.ts`
feeds tokens to the HTTP client and refreshes once on 401/403. That stays.

What is missing, and what this spec adds: discovery, registration, host-owned
endpoints and redirect URI, client secrets, the UI, and a visible
needs-sign-in state.

## Security fixes in scope

1. `POST …/oauth/begin` takes `authorizationEndpoint`, `tokenEndpoint`,
   `clientId`, and `redirectUri` from the request body. After this change the
   route accepts none of them. Endpoints come from validated discovery stored
   on the host, and the redirect URI is built by the host.
2. `POST …/oauth/revoke` takes `revocationEndpoint` from the body. It now uses
   the discovered `revocation_endpoint`.

No test calls these routes with a body today (`tests/` has no
`oauth/begin|complete|revoke` match); `tests/harness/mcp-oauth.spec.ts` calls
`ManagedOAuth` directly and keeps working.

## Configuration

`managed_oauth` in `mcp.json` changes as follows (`src/harness/mcp/config.ts`):

```ts
| {
    readonly type: 'managed_oauth'
    readonly provider: string                 // display label, unchanged
    readonly resource: string                 // unchanged
    readonly clientId?: string                // was required; absent = registered client
    readonly clientSecret?: string            // new: `${SECRET}` reference into secrets.json
    readonly tokenEndpointAuth?: 'none' | 'client_secret_post' | 'client_secret_basic'  // new, default 'none'
    readonly scopes?: readonly string[]       // unchanged; overrides discovered scopes
  }
```

Rules: `clientSecret` must be a `${NAME}` reference, like `auth.token` today.
A `tokenEndpointAuth` other than `none` requires both `clientId` and
`clientSecret`. Existing files with `clientId` stay valid.

Nothing discovered is written to `mcp.json`. Discovery and registration
results live in the encrypted `OAuthStore`:

```ts
interface OAuthServerRecord {          // file: server-<ws>-<server>.json
  readonly resource: string
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint?: string
  readonly scopes: readonly string[]   // scopes requested at the last connect
  readonly registration?: {            // present only for a registered client
    readonly clientId: string
    readonly redirectUri: string       // the URI it was registered with
    readonly issuedAt: number
  }
  readonly discoveredAt: number
}
```

The record is keyed by workspace and server, matching the token file. It is
deleted when the server is deleted. A registration is reused while its
`redirectUri` and `issuer` match the current ones; otherwise the next connect
registers again.

`OAuthTokens` gains `tokenEndpointAuth` so refresh authenticates the same way
as the original exchange. The secret is never stored with the tokens; it is
resolved from secrets.json at each exchange.

## Discovery (`src/harness/mcp/oauth-discovery.ts`)

Input: the server URL from `mcp.json`. Output: an `OAuthServerRecord` minus
registration, plus `challengeScope` when the 401 carried one.

1. Send an unauthenticated MCP `initialize` POST. A `401` with
   `WWW-Authenticate: Bearer` is expected. Parse `resource_metadata`, `scope`,
   and `error` from it. Any other status is a discovery error that names the
   status.
2. Protected Resource Metadata (RFC 9728): the `resource_metadata` URL when
   present, otherwise `/.well-known/oauth-protected-resource<path>` and then
   `/.well-known/oauth-protected-resource` at the server origin.
   After normalisation (scheme and host lowercased, default port and trailing
   slash removed), the document's `resource` must be on the same origin as the
   server URL and equal it or be a path prefix of it at a `/` boundary. Slack
   advertises `https://mcp.slack.com` for `https://mcp.slack.com/mcp`. Anything
   else fails. The `resource` sent in OAuth requests is the PRM value.
3. If no PRM exists, the server origin is treated as the authorization
   server and the server URL is the `resource`. This is the 2025-03-26
   fallback; Atlassian needs it (both of its well-known PRM paths return 404).
4. Authorization server metadata, for issuer `I`, tried in order:
   RFC 8414 with path insertion, OIDC with path insertion, OIDC with path
   appended, and for a path-less issuer the plain
   `/.well-known/oauth-authorization-server` and
   `/.well-known/openid-configuration`. The document's `issuer` must equal `I`.
   `code_challenge_methods_supported` must include `S256`.
5. Scopes, first match wins: the `scopes` in config; the 401 `scope`; the PRM
   `scopes_supported`; none (omit the parameter).

Every fetch uses `assertOutboundUrl` with `allowLoopbackHttp` (the existing
policy, which blocks private ranges), `redirect: 'manual'` (a 3xx fails),
a 10 s timeout, a 64 KiB body limit, and `accept: application/json`.

## Registration (`src/harness/mcp/oauth-registration.ts`)

Order for each connect:

1. `clientId` in config: use it with its `tokenEndpointAuth`. No registration.
2. A stored registration whose `issuer` and `redirectUri` match: reuse it.
3. AS metadata has `registration_endpoint`: POST RFC 7591 JSON
   `{ client_name: "dnt-harness", redirect_uris: [redirectUri],
   grant_types: ["authorization_code", "refresh_token"],
   response_types: ["code"], token_endpoint_auth_method: "none" }`.
   Accept `201` or `200` with a non-empty `client_id`. If the response returns
   a `client_secret` or a different auth method, the registration is refused
   (we only keep public clients). Same fetch limits as discovery.
4. Otherwise fail with `client_required`, which the UI turns into the manual
   client form. The error says whether the provider offers registration only
   for confidential clients (GitLab, Supabase) or not at all (GitHub, Slack).

## Redirect URI

Built by the host from the request that starts the connect:
`http://<loopback-host>:<bound-port>/api/mcp/oauth/callback`, where
`<loopback-host>` is the request's `Host` name when it is `127.0.0.1`,
`localhost`, or `[::1]`. Using the same host keeps the callback page
same-origin with the app tab, which the automatic finish needs. Any other
`Host` makes connect fail with `loopback_required` and a message telling the
user to open the app at `http://127.0.0.1:<port>`.

## Routes

All under the existing authenticated, CSRF-checked workspace prefix. The
callback stays public.

| Route | Change |
|---|---|
| `POST /api/workspaces/:id/mcp/:server/oauth/begin` | Body is ignored except optional `{ scopes?: string[] }` for Reconnect. Runs discovery and registration, saves the server record, starts `ManagedOAuth.begin`, returns `{ authorizationUrl, state }`. Errors: `400 { code: 'loopback_required' \| 'discovery_failed' \| 'client_required' \| 'registration_failed', error }`. |
| `POST …/oauth/complete` | Unchanged contract (`{ state }`), and on success reconnects the server when it is enabled. |
| `POST …/oauth/revoke` | Body ignored. Uses the stored `revocationEndpoint`. Deletes the stored registration only when the server is deleted, not on revoke. |
| `GET /api/mcp/oauth/callback` | Still deposits only. Responds with a small HTML page instead of plain text (below). |

`ROUTE_INVENTORY` gets an `mcp-oauth` entry for the three workspace routes.

The `GET …/mcp` list rows gain:

```ts
readonly oauth?: {
  readonly state: 'connected' | 'needs_sign_in' | 'not_connected'
  readonly missingScope?: string          // from insufficient_scope
  readonly clientSource?: 'registered' | 'manual'
}
```

`status` keeps its four values; the new field says why an enabled server is
failing.

## Finishing sign-in

The callback response is HTML with `content-security-policy: default-src
'none'; script-src 'nonce-<random>'` and one nonce'd inline script. After a
successful deposit the script posts `{ type: 'mcp-oauth', state }` on
`BroadcastChannel('dnt-harness-mcp-oauth')` and tries `window.close()`. The
visible text says sign-in finished and the tab can be closed. A failed
deposit shows the failure and posts nothing.

The app tab, while a connect is pending, listens on that channel. A message
whose `state` matches the pending one calls `complete`. The pending connect
also shows a **Finish** button that calls `complete` with the same state, for
browsers where the channel did not deliver. The state lives in memory only;
it expires with the 5-minute transaction.

The `state` is not a credential on its own: `complete` still requires the
initiating browser session, workspace, and server.

## `insufficient_scope` and needs-sign-in

In `client.ts`, a `403` whose `WWW-Authenticate` has
`error="insufficient_scope"` does not trigger a refresh. The client reports
it with the `scope` value. The host saves the token phase as `auth_required`
with `missingScope`, and the call fails with a clear tool error. A `401`
keeps today's single refresh; if that refresh ends in `auth_required`, the row
shows `needs_sign_in`.

**Reconnect** sends `scopes` = previous scopes ∪ the missing scope.

## UI (`web/components/settings/McpPanel.tsx`)

- Server form, HTTP transport: an **Authentication** choice of None, Bearer
  token (today's `${SECRET}` field), or **OAuth**. OAuth saves
  `{ type: 'managed_oauth', provider: <host of the URL>, resource: <URL> }`.
  An **Advanced** disclosure holds client id, client secret reference, and
  auth method for manual clients.
- Server rows with OAuth show a badge: **Connected**, **Needs sign-in**
  (with the missing scope when known), or **Not connected**, and a
  **Connect** / **Reconnect** / **Disconnect** action.
- Connect opens the `authorizationUrl` in a new tab synchronously from the
  click (so popup blockers allow it, by opening a blank tab first and setting
  its location after the response), then waits as described above. On
  `client_required` the row opens the edit form with the Advanced section
  expanded and the server's explanation.
- `loopback_required` shows the message with a link to the loopback URL.

## Error handling summary

| Failure | Where it shows |
|---|---|
| Server does not answer 401 with a Bearer challenge | `discovery_failed` with the status |
| PRM resource mismatch, issuer mismatch, no S256 | `discovery_failed` naming the check |
| Registration refused or returns a secret | `registration_failed` / `client_required` |
| Token exchange rejected | `complete` error, row stays Not connected |
| Refresh rejected, token revoked by provider | Row Needs sign-in |
| Provider unreachable during refresh | Existing temporary error; grant kept |

Errors never include tokens, codes, verifiers, or client secrets.

## Testing

Unit (`tests/harness/`), with a local fixture authorization server on
`127.0.0.1`:

- `mcp-oauth-discovery.spec.ts`: header-advertised PRM; well-known PRM with
  and without path; no-PRM fallback; RFC 8414 vs OIDC order with path issuer;
  issuer mismatch, resource mismatch, missing S256, 3xx, oversize body,
  private-range URL all fail; scope precedence.
- `mcp-oauth-registration.spec.ts`: manual client skips registration; stored
  registration reused; changed redirect re-registers; registration returning a
  secret is refused; no endpoint gives `client_required`.
- `mcp-oauth.spec.ts` additions: confidential exchange and refresh send the
  secret by post and by basic; the secret is not persisted in tokens.
- `mcp-config` validation: `clientSecret` must be a reference; non-`none`
  auth requires id and secret; old files still parse.

Web (`tests/web/`):

- `mcp-oauth-connect.spec.ts`: full flow against the fixture — begin ignores
  body endpoints and redirect; callback HTML has the nonce CSP and posts the
  state; complete stores tokens and the server turns `ready`; a non-loopback
  `Host` gets `loopback_required`; revoke uses the stored endpoint;
  `insufficient_scope` gives `needs_sign_in` with the scope and Reconnect
  requests the union.
- Existing `mcp-integration-review.spec.ts` OAuth cases keep passing.

Component (`web/components/settings/`): auth choice saves the right
`managed_oauth` shape; Connect opens a tab and completes on a channel message;
Finish fallback; badges per `oauth.state`.

Then `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`. A manual check
against Linear and GitHub is recorded in the final report.

Not yet verified, to settle during that manual check: whether a GitHub OAuth
app accepts the loopback callback on whatever port the host is bound to, and
that its token endpoint needs `client_secret_post`. If the port must be fixed,
the report says so and the GitHub entry in the catalog documents it.

## Documentation

Update the MCP section of `docs/capabilities.md` (OAuth connect, loopback
only, manual clients) and the OAuth line in
`docs/decisions/mcp-production-boundaries.md`, which still says a legacy
`oauth` block is an external token until a managed session exists.

## Out of scope

Client ID Metadata Documents; OAuth through non-loopback hosts; automatic
step-up mid-turn; OpenID Connect ID tokens; `private_key_jwt`; device code
flow; cleanup of registrations on the provider side; a protocol version bump.
