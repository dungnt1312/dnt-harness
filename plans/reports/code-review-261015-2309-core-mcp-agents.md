# Code review — MCP core + subagent orchestration (2026-10-15)

Scope: `src/harness/mcp/*.ts` (23 file), `src/harness/agents/*.ts` + `compatibility/**`,
`src/harness/child-env.ts`, consumers in `src/web/server.ts`, `src/web/agent-delegation.ts`,
`src/web/execution-authority.ts`, `src/web/mcp-oauth-connect.ts`, `src/harness/tools/service.ts`,
`src/harness/session/session.ts`, `src/harness/approval/policy.ts`, and the tests
`tests/harness/mcp-*.spec.ts`, `subagent-stability.spec.ts`, `executor-review-fixes.spec.ts`,
`mcp-desired-state.spec.ts`.

Method: read the code and existing tests; **no test run** (reviewer had no Bash). Every finding
below is "verified by reading code"; there are no "suspected" items.

## Summary

| # | Severity | File:line | Problem |
|---|---|---|---|
| H1 | high | `src/harness/mcp/oauth-discovery.ts:225-237`, `src/harness/mcp/oauth.ts:375-386`, `432-439` | Untrusted OAuth metadata may point token/registration endpoints at **loopback HTTP**; the client POSTs the authorization code, PKCE verifier and `client_secret` there |
| M1 | medium | `src/web/server.ts:4148`, `2561`, `8424-8428`, `8485` | A child session's approval/question has no principal → with `--auth`, any browser principal can answer it |
| M2 | medium | `src/harness/mcp/outbound-policy.ts:78-85`, `client.ts:527` | Hostname-only check: a DNS name resolving to private/link-local is still fetched (old P2, unpatched) |
| M3 | medium | `src/web/server.ts:827`, `src/harness/mcp/execution-coordinator.ts:35-36` | The audit-fault file is host-global: one workspace's journal failure blocks MCP in **every** workspace (old P2) |
| M4 | medium | `src/harness/mcp/client.ts:795-804` | A token obtained through `tokenSource` (managed OAuth) is missing from `recentStderr()`'s mask list |
| L1 | low | `src/harness/child-env.ts:19` | `PGPASSWORD` / `MYSQL_PWD` / `SSH_ASKPASS` do not match `SECRET_NAME` → leak into child Bash/hooks |
| L2 | low | `src/harness/mcp/client.ts:834` | `nextCursor` is cast to `string` without a type check → numeric/object cursors are sent back to the server |
| L3 | low | `src/harness/mcp/execution-journal.ts:111-113` | Up to 500 chars of remote result (and error message) written plaintext to the journal |
| L4 | low | `src/harness/mcp/mutation-store.ts:119` | A mutation log with no `\n` at all (crash on first write) → garbage parse, `recover()` fails, host does not boot |

## Findings in detail

**H1 — OAuth endpoints taken from metadata may be loopback HTTP (SSRF with credentials).**
`fetchLimitedJson` always uses `allowLoopbackHttp: true` (`oauth-discovery.ts:95`), and `endpoint()`
validates `authorization_endpoint` / `token_endpoint` / `registration_endpoint` with the same
`allowLoopbackHttp: true` (`:232`); `assertOauthUrl` in `oauth.ts:432-439` does the same. Trigger: an
operator configures a public `managed_oauth` MCP HTTP server; that server's PRM / RFC 8414 metadata
(or that of an `authorization_servers` entry it declares itself) sets
`token_endpoint: "http://127.0.0.1:<port>/anything"`. `exchange()` (`oauth.ts:375-386`) then POSTs
`grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri` — that is **both the code
and the verifier** — to an attacker-chosen loopback port, together with the `client_secret`
(client_secret_post) or a Basic `clientId:clientSecret` header (client_secret_basic),
`redirect: 'manual'`, 15s timeout. The DCR path (`oauth-registration.ts:50`) POSTs to loopback too.
Minimal fix: allow loopback only when `serverUrl` itself is loopback (fixtures), or require the
token/registration/revocation endpoint to share the `issuer` origin.

**M1 — a child's approval is not bound to a principal.**
`principalId` comes from `sessionPrincipals.get(scope.sessionId)` (`server.ts:4148`, `2561`), but that
map is only populated for sessions that receive input from the user (`server.ts:9489`, root). A child
session created by the executor never gets an entry → `waiting.principalId === undefined` → the owner
check is skipped because of the `owner !== undefined && …` guard (`8424-8428`, and `8485` for
AskUserQuestion). Trigger: run with `--auth`, pair two browsers (two principals); principal B answers
`POST /api/approvals/:id` for an approval raised by A's subagent (SSE already routes that approval to
A's root — `10694-10698`, `10748-10772`) → allow runs Bash/Write for A's child. The reverse is also
wrong: setting the child's `principalId` makes the root's own browser get a 403. Minimal fix: resolve
the principal by `scope.rootSessionId ?? scope.sessionId` when writing the pending approval.

**M2 — DNS-rebinding SSRF (old P2).** `isProhibitedHost` returns `false` for every hostname that is
not an IP literal (`outbound-policy.ts:78-85`), so `https://metadata.internal/` (resolving to
169.254.169.254) or `https://x/` (resolving to 127.0.0.1) passes; `HttpTransport.post` also always
passes `allowLoopbackHttp: true` (`client.ts:527`), so a plain `http://127.0.0.1:<port>` in `mcp.json`
is fetched too. Trigger: `mcp.json` url is a domain pointing at the metadata service.

**M3 — shared audit-fault file.** `auditFaultFile = path.join(resourceHome, 'mcp-audit-fault.json')`
(`server.ts:827`); `dispatchToolCall` blocks while the file exists (`execution-coordinator.ts:36`).
Trigger: workspace A fails to write its journal (disk full) → every MCP call from **every** workspace
gets `AuditFaultBlock` until `repairAudit` runs from A (`4626-4663` checks ownership but still blocks
the whole host).

**M4 — managed OAuth token is not masked.** `recentStderr()` only masks `resolved.env`,
`resolved.headers`, `resolved.bearerToken` (`client.ts:797-803`); under managed OAuth `bearerToken` is
`undefined` and the token comes from `tokenSource` (`server.ts:2954-2965`). Trigger: the server echoes
its own `Authorization` header to stderr → the raw token appears in `stderrTail` in Settings
(`server.ts:6158`, `6178`).

**L1** `SECRET_NAME = /(^|_)(API_?KEY|…|PASSWORD|…)$/i` (`child-env.ts:19`) does not match
`PGPASSWORD`, `MYSQL_PWD`, `SSH_ASKPASS` (no separating `_`) → a child Bash/hook can read them.
**L2** `client.ts:834` casts `nextCursor` to `string`; cursor `5` slips past `assertCursor`
(`.length` is `undefined`) and is sent back as `{cursor:5}`; the page cap contains it, so this is
type-unsoundness rather than a live bug. **L3** `finish()` writes `detail.slice(0,500)` — the MCP
result JSON or error message — plaintext into `executions.jsonl` (`execution-journal.ts:111`).
**L4** `readLines()` returns `raw.slice(0,-1)` when the file has no `\n` at all → `JSON.parse` throws
→ the `await mutations.recover()` at boot (`server.ts:811`) fails.

## Re-confirmation of the recorded MCP resilience fixes (2026-10-08)

| Item | Verdict | Evidence |
|---|---|---|
| stdio crash → reconnect | **Holds** | `client.ts:1023-1029` onDead → `state='failed'`; `ensureConnected` also checks `transport.state` (`:1001`); a watchdog kill is sticky (`resourceKilled`, `:1013`, `:986-991`); tests `mcp-resilience.spec.ts:42-54`, `292-298` |
| pre-step skips a broken server | **Holds** | `server.ts:3246-3258` (per-server catch, records `mcpConnectFailures` + 30s backoff at `:255-256`); a *file* config error disables MCP for the whole turn via `disableMcpForTurn` (`:1978-1986`, `2073-2075`); tool-name filter `:3116` + `:5282-5286` |
| OAuth tokenSource | **Holds** | `client.ts:445`, `533-543` (`rejectedToken` is replayed only to the source), `581-586` (401/403 → `auth_rejected`, not_dispatched); server `2954-2966`; test `mcp-resilience.spec.ts:194-221` |
| HTTP 2025-06-18 | **Holds** | `mcp-protocol-version` header after initialize (`client.ts:556`), 404 + session id → `session_expired` + markDead (`:587-594`), 202/204 for notifications (`:519-523`, test `:140`), `insufficient_scope` (`:567-579`) |
| tool-name filter | **Holds** | `PROVIDER_TOOL_NAME` `:262`; skip `__`/unknown names at registration `:3116`; Settings `unusableTools` `:6156`; `mcpModelSchema` `:5282-5286` |
| `vettedTool`/`maxSchemaDepth` unused (P2) | **Closed** | `vettedTool` used at `client.ts:718`; depth check `protocol.ts:59`; test `mcp-client-fixes.spec.ts:311-316` |

Confirmed **still open** P2 items, by code: the journal does not rotate (`execution-journal.ts:203-226`,
append-only); the audit-fault file is host-global (M3); `secretRevision: 1` is hardcoded
(`server.ts:3189`); DNS-rebinding SSRF (M2); only protocol `2025-06-18` is accepted
(`boundaries.ts:47-52`) although `oauth-discovery.ts:3` already references the fallback order
`2025-11-25` — docs and code disagree on versions.

## Domains read as clean (no invented findings)

- **SSE framing** (`sse-parser.ts`): splitting frames on `\r?\n\r?\n` preserves boundaries across a
  cut chunk, multiple `data:` lines are joined with `\n` per spec, comments/`event:`/`id:`/`retry:`
  are dropped correctly, `maxSseBytes` is enforced after decode (`:16-19`), the reader is `cancel()`ed
  once a result exists (`client.ts:630-635`).
- **JSON-RPC correlation / id reuse** (`client.ts:284-342`): monotonic ids, `pending.delete` in
  `finally`, an unknown response id is dropped, a frame over `maxFrameBytes` fails the whole transport
  and kills the tree; `StringDecoder` handles a split multi-byte character; tests
  `mcp-resilience.spec.ts:89-108`, `mcp-client-fixes.spec.ts:300-309`.
- **Tool ceiling / normalizeBrief / MCP selector** (`mcp-candidates.ts`, `executor.ts:614-690`):
  ceiling = admission ∩ role − disallowed, narrowed by the grant; `missingGrantedMcp` fails the spawn
  when a granted MCP cannot be honoured; `isMcpSelector`/`matchesMcpEntry` behave as documented (server
  `s` does not capture `s__x` tools); tests `mcp-candidates.spec.ts`.
- **Journal integrity** (`execution-journal.ts`): seq/digest, torn-tail drop, corrupt middle → poison
  and no call sent (`dispatchToolCall` with `claim==='integrity'|'in-flight'|'terminal'`).
- **Child cancel/wait/join + restart recovery** (`executor.ts`): the reservation is released only after
  a terminal canonical fact exists; `settlements` is single-flight; `joinTurnChildren` does not
  busy-loop (the `approval/request` listener only fires for new events) and Stop does not cancel; tests
  `subagent-stability.spec.ts:351-405`, `executor-review-fixes.spec.ts`.

## Not verified

- No `pnpm vitest run` / `pnpm run typecheck` / real-process test was run (no Bash tool), so there is
  no runtime evidence beyond reading code and existing tests.
- The `ApprovePatch`/writer-lease branch and the web UI (`web/components/settings/McpPanel.tsx`) were
  out of scope.
- Risk framing: H1 is only exploitable when the operator adds a `managed_oauth` MCP HTTP server with
  malicious metadata; M1 only matters with `--auth` and ≥2 browser principals. If neither is in the
  threat model, H1 drops to medium and M1 to low.
