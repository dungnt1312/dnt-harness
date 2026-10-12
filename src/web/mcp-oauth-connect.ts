/**
 * Host-side OAuth Connect for one MCP server: loopback-only redirect URI,
 * discovery, client resolution, the per-server record, the row state, and
 * the HTML callback page. Endpoints, client ids, and redirect URIs never
 * come from a request body; they come from discovery or `mcp.json`.
 */
import { randomBytes } from 'node:crypto'
import type { McpServerConfig } from '../harness/mcp/config.ts'
import { discoverOAuth, OAuthConnectError } from '../harness/mcp/oauth-discovery.ts'
import { resolveClient } from '../harness/mcp/oauth-registration.ts'
import type { ManagedOAuth } from '../harness/mcp/oauth.ts'
import type { OAuthServerRecord, OAuthStore } from '../harness/mcp/oauth-store.ts'

export const OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback'
export const OAUTH_CHANNEL = 'dnt-harness-mcp-oauth'

type ManagedAuth = Extract<NonNullable<McpServerConfig['auth']>, { type: 'managed_oauth' }>

export function managedAuthOf(server: McpServerConfig | undefined): ManagedAuth | undefined {
  return server?.transport === 'http' && server.auth?.type === 'managed_oauth' ? server.auth : undefined
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The redirect URI for a connect started by this request. The request's own
 * `Host` keeps the callback page same-origin with the app tab, so the
 * BroadcastChannel reaches it. Anything but loopback is refused.
 */
export function loopbackRedirectUri(hostHeader: string | undefined): string {
  const raw = (hostHeader ?? '').trim().toLowerCase()
  let parsed: URL | undefined
  try { parsed = raw === '' ? undefined : new URL(`http://${raw}`) } catch { parsed = undefined }
  const hostname = parsed?.hostname.replace(/^\[|\]$/g, '')
  if (parsed === undefined || hostname === undefined || !LOOPBACK.has(hostname)) {
    throw new OAuthConnectError('loopback_required', 'OAuth sign-in works only when dnt-harness is opened at http://127.0.0.1 or http://localhost on this machine. Open it there and connect again.')
  }
  return `http://${parsed.host}${OAUTH_CALLBACK_PATH}`
}

export interface BeginConnectResult {
  readonly authorizationUrl: string
  readonly state: string
}

/**
 * Discover, resolve the client, save the record, and start the grant.
 * `extraScopes` comes from Reconnect; the stored missing scope and the
 * previous scopes are added so a reconnect never asks for less.
 */
export async function beginConnect(input: {
  readonly oauth: ManagedOAuth
  readonly store: OAuthStore
  readonly workspaceId: string
  readonly server: string
  readonly config: McpServerConfig
  readonly principalId: string
  readonly hostHeader: string | undefined
  readonly extraScopes: readonly string[]
  readonly fetchImpl?: typeof fetch
}): Promise<BeginConnectResult> {
  const auth = managedAuthOf(input.config)
  const url = input.config.url
  if (auth === undefined || url === undefined) {
    throw new OAuthConnectError('discovery_failed', `server '${input.server}' is not an HTTP server set to OAuth`)
  }
  const redirectUri = loopbackRedirectUri(input.hostHeader)
  const discovered = await discoverOAuth(url, {
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    ...(auth.scopes !== undefined && auth.scopes.length > 0 ? { scopes: auth.scopes } : {}),
  })
  const stored = await input.store.readServerRecord(input.workspaceId, input.server)
  const previous = stored?.serverUrl === url ? stored : undefined
  const tokens = await input.oauth.tokenState(input.workspaceId, input.server)
  const client = await resolveClient({
    configured: { clientId: auth.clientId, tokenEndpointAuth: auth.tokenEndpointAuth },
    discovered,
    redirectUri,
    previous,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  })
  const reconnecting = input.extraScopes.length > 0 || tokens?.missingScope !== undefined
  const scopes = unique([
    ...discovered.scopes,
    ...(reconnecting && previous !== undefined ? previous.scopes : []),
    ...splitScopes(tokens?.missingScope),
    ...input.extraScopes,
  ])
  const record: OAuthServerRecord = {
    serverUrl: url,
    resource: discovered.resource,
    issuer: discovered.issuer,
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    ...(discovered.revocationEndpoint !== undefined ? { revocationEndpoint: discovered.revocationEndpoint } : {}),
    scopes,
    ...(client.registration !== undefined ? { registration: client.registration } : {}),
    discoveredAt: Date.now(),
  }
  await input.store.saveServerRecord(input.workspaceId, input.server, record)
  return input.oauth.begin({
    workspaceId: input.workspaceId,
    server: input.server,
    principalId: input.principalId,
    resource: discovered.resource,
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    clientId: client.clientId,
    redirectUri,
    scopes,
    tokenEndpointAuth: client.tokenEndpointAuth,
  })
}

function splitScopes(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter((scope) => scope !== '')
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))]
}

export interface OAuthRowState {
  readonly state: 'connected' | 'needs_sign_in' | 'not_connected'
  readonly missingScope?: string
  readonly clientSource?: 'registered' | 'manual'
}

/**
 * The row's OAuth state. A grant counts only for the URL it was obtained
 * for: a server re-pointed to another URL is not connected.
 */
export async function oauthRowState(oauth: ManagedOAuth, store: OAuthStore, workspaceId: string, server: McpServerConfig): Promise<OAuthRowState | undefined> {
  const auth = managedAuthOf(server)
  if (auth === undefined) return undefined
  const [record, tokens] = await Promise.all([
    store.readServerRecord(workspaceId, server.name),
    oauth.tokenState(workspaceId, server.name),
  ])
  if (record === undefined || record.serverUrl !== server.url || tokens === undefined || tokens.phase === 'local_revoked') {
    return { state: 'not_connected' }
  }
  const clientSource = auth.clientId !== undefined ? 'manual' as const : 'registered' as const
  if (tokens.phase === 'auth_required') {
    return { state: 'needs_sign_in', ...(tokens.missingScope !== undefined ? { missingScope: tokens.missingScope } : {}), clientSource }
  }
  return { state: 'connected', clientSource }
}

/** Whether the stored grant may be used for this server's current URL. */
export async function grantMatchesServer(store: OAuthStore, workspaceId: string, server: McpServerConfig): Promise<boolean> {
  const record = await store.readServerRecord(workspaceId, server.name)
  // Grants from before records existed (fixture profile) have no record and stay usable.
  return record === undefined || record.serverUrl === server.url
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

/**
 * The page the provider redirects to. On success it tells the app tab over
 * BroadcastChannel (same origin) and tries to close itself. The state is
 * JSON-encoded with `<` escaped, so it cannot end the script element.
 */
export function callbackPage(result: { readonly ok: true; readonly state: string } | { readonly ok: false; readonly reason: string }): { readonly html: string; readonly csp: string } {
  const nonce = randomBytes(16).toString('base64')
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  const style = '<style>body{font:15px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem;color:#222}h1{font-size:1.2rem}</style>'
  if (!result.ok) {
    return {
      csp,
      html: `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>${style}</head><body><h1>Sign-in was not completed</h1><p>${escapeHtml(result.reason)}</p><p>Close this tab and try Connect again in dnt-harness.</p></body></html>`,
    }
  }
  const message = JSON.stringify({ type: 'mcp-oauth', state: result.state }).replace(/</g, '\\u003c')
  const script = `try{var c=new BroadcastChannel(${JSON.stringify(OAUTH_CHANNEL)});c.postMessage(${message});c.close()}catch(e){}setTimeout(function(){try{window.close()}catch(e){}},300)`
  return {
    csp,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>${style}</head><body><h1>Sign-in finished</h1><p>dnt-harness is completing the connection. You can close this tab.</p><script nonce="${nonce}">${script}</script></body></html>`,
  }
}

export { OAuthConnectError }
