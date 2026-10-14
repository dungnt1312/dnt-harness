/**
 * Host-side OAuth Connect for one MCP server: the redirect URI, discovery,
 * client resolution, the per-server record, the row state, and the HTML
 * callback page. Endpoints, client ids, and redirect URIs never come from a
 * request body; they come from discovery, `mcp.json`, or the host's own
 * configuration (`--oauth-origin`).
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
 * Validate the origins `--oauth-origin` declares. Each must be an https
 * origin (scheme, host, optional port): MCP requires an OAuth redirect to be
 * localhost or HTTPS, and loopback needs no declaration. The host cannot see
 * a proxy's scheme, so the operator states the whole origin.
 */
export function parseOAuthOrigins(values: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of values) {
    const text = raw.trim()
    if (text === '') continue
    let url: URL
    try { url = new URL(text) } catch { throw new Error(`oauth origin '${text}' is not a URL; use https://host[:port]`) }
    if (url.protocol !== 'https:') throw new Error(`oauth origin '${text}' must use https (loopback needs no declaration)`)
    if (url.username !== '' || url.password !== '') throw new Error(`oauth origin '${text}' must not carry credentials (userinfo)`)
    if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') throw new Error(`oauth origin '${text}' must be an origin only, with no path, query, or fragment`)
    if (!out.includes(url.origin)) out.push(url.origin)
  }
  return out
}

/**
 * How a sign-in started by this request returns:
 * - `loopback`: the app is open at a loopback name; the callback page is
 *   same-origin with the app tab and completes on its own.
 * - `origin`: the app is open at a declared https origin; same, over HTTPS.
 * - `paste`: any other name. The redirect is the host's own loopback port,
 *   the provider's final redirect lands on the person's machine (usually an
 *   error page), and they paste that address back into the app.
 * The redirect is built from the declared origin or the bound port, never
 * from the `Host` header's text.
 */
export type RedirectMode = 'loopback' | 'origin' | 'paste'

export function resolveRedirect(hostHeader: string | undefined, boundPort: number, origins: readonly string[]): { readonly mode: RedirectMode; readonly redirectUri: string } {
  const raw = (hostHeader ?? '').trim().toLowerCase()
  let parsed: URL | undefined
  try { parsed = raw === '' || /[\s/\\@?#]/.test(raw) ? undefined : new URL(`http://${raw}`) } catch { parsed = undefined }
  const hostname = parsed?.hostname.replace(/^\[|\]$/g, '')
  if (parsed !== undefined && hostname !== undefined && LOOPBACK.has(hostname)) {
    return { mode: 'loopback', redirectUri: `http://${parsed.host}${OAUTH_CALLBACK_PATH}` }
  }
  if (parsed !== undefined) {
    // `Host` has no scheme; a declared origin matches by host and port, with 443 implied.
    const match = origins.find((origin) => {
      const declared = new URL(origin)
      return declared.hostname === parsed.hostname && (declared.port === '' ? '443' : declared.port) === (parsed.port === '' ? '443' : parsed.port)
    })
    if (match !== undefined) return { mode: 'origin', redirectUri: `${match}${OAUTH_CALLBACK_PATH}` }
  }
  return { mode: 'paste', redirectUri: `http://127.0.0.1:${boundPort}${OAUTH_CALLBACK_PATH}` }
}

export interface BeginConnectResult {
  readonly authorizationUrl: string
  readonly state: string
  /** `paste`: the person must paste the final address back; see {@link RedirectMode}. */
  readonly redirectMode: RedirectMode
}

/**
 * Discover, resolve the client, and stage the record with the pending grant.
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
  /** The port this host is bound to, for the paste-back redirect. */
  readonly boundPort: number
  /** Validated `--oauth-origin` values. */
  readonly oauthOrigins: readonly string[]
  readonly extraScopes: readonly string[]
  readonly fetchImpl?: typeof fetch
}): Promise<BeginConnectResult> {
  const auth = managedAuthOf(input.config)
  const url = input.config.url
  if (auth === undefined || url === undefined) {
    throw new OAuthConnectError('discovery_failed', `server '${input.server}' is not an HTTP server set to OAuth`)
  }
  const { mode: redirectMode, redirectUri } = resolveRedirect(input.hostHeader, input.boundPort, input.oauthOrigins)
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
  const started = await input.oauth.begin({
    serverRecord: record,
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
  return { ...started, redirectMode }
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
  if (record === undefined || record.serverUrl !== server.url || tokens === undefined || tokens.resource !== record.resource || tokens.phase === 'local_revoked') {
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
  if (record === undefined) return true
  if (record.serverUrl !== server.url) return false
  const tokens = await store.readTokens(workspaceId, server.name)
  return tokens === undefined || tokens.resource === record.resource
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
