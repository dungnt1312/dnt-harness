/**
 * OAuth discovery for a remote MCP server (MCP authorization, 2025-06-18,
 * with the 2025-11-25 fallback order):
 *
 * 1. An unauthenticated `initialize` must answer 401 with a Bearer challenge.
 * 2. Protected Resource Metadata (RFC 9728): the challenge's
 *    `resource_metadata`, else the well-known paths. Without PRM the server
 *    origin is the authorization server (2025-03-26 fallback).
 * 3. Authorization server metadata: RFC 8414, then OpenID Connect discovery,
 *    with path insertion for an issuer that has a path. `issuer` must match.
 *
 * Every URL here comes from a remote server, so every hop goes through the
 * outbound policy, never follows a redirect, and reads a bounded body.
 */
import { MCP_ACCEPTED_PROTOCOL_VERSION as MCP_PROTOCOL_VERSION } from './boundaries.ts'
import { assertOutboundUrl, OutboundPolicyError } from './outbound-policy.ts'

export type OAuthConnectCode = 'discovery_failed' | 'client_required' | 'registration_failed'

export class OAuthConnectError extends Error {
  constructor(readonly code: OAuthConnectCode, message: string) {
    super(message)
    this.name = 'OAuthConnectError'
  }
}

export interface BearerChallenge {
  readonly resourceMetadata?: string
  readonly scope?: string
  readonly error?: string
}

export interface DiscoveredOAuth {
  /** The value sent as `resource` (RFC 8707). */
  readonly resource: string
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint?: string
  readonly registrationEndpoint?: string
  readonly tokenEndpointAuthMethods: readonly string[]
  readonly scopes: readonly string[]
}

const FETCH_TIMEOUT_MS = 10_000
const MAX_METADATA_BYTES = 64 * 1024

/** Parse `WWW-Authenticate: Bearer k="v", k=v` into the parameters discovery uses. */
export function parseBearerChallenge(header: string | null): BearerChallenge | undefined {
  if (header === null) return undefined
  const match = /^\s*bearer\b(.*)$/is.exec(header)
  if (match === null) return undefined
  const params: Record<string, string> = {}
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g
  for (const part of (match[1] ?? '').matchAll(pattern)) {
    const key = (part[1] ?? '').toLowerCase()
    params[key] = part[2] !== undefined ? part[2].replace(/\\(.)/g, '$1') : (part[3] ?? '')
  }
  return {
    ...(params['resource_metadata'] !== undefined ? { resourceMetadata: params['resource_metadata'] } : {}),
    ...(params['scope'] !== undefined ? { scope: params['scope'] } : {}),
    ...(params['error'] !== undefined ? { error: params['error'] } : {}),
  }
}

function normalise(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    url.hash = ''
    url.search = ''
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '')
    return url
  } catch {
    return undefined
  }
}

/**
 * Whether a PRM `resource` protects `serverUrl`: same origin, and equal or a
 * path prefix at a `/` boundary. Slack advertises its origin for `…/mcp`.
 */
export function resourceCovers(serverUrl: string, resource: string): boolean {
  const server = normalise(serverUrl)
  const covered = normalise(resource)
  if (server === undefined || covered === undefined) return false
  if (server.origin !== covered.origin) return false
  const prefix = covered.pathname === '/' ? '' : covered.pathname
  return server.pathname === covered.pathname || server.pathname === prefix || server.pathname.startsWith(`${prefix}/`)
}

/** Fetch JSON under the outbound policy: no redirects, a timeout, a size bound. */
export async function fetchLimitedJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ readonly status: number; readonly headers: Headers; readonly body: unknown }> {
  let target: URL
  try {
    target = assertOutboundUrl(url, { allowLoopbackHttp: true })
  } catch (error) {
    if (error instanceof OutboundPolicyError) throw new OAuthConnectError('discovery_failed', `${url}: ${error.message}`)
    throw error
  }
  let response: Response
  try {
    response = await fetchImpl(target, {
      ...init,
      redirect: 'manual',
      headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new OAuthConnectError('discovery_failed', `${target.origin} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new OAuthConnectError('discovery_failed', `${target.origin} answered with a redirect, which is not followed`)
  }
  const text = await readBounded(response)
  let body: unknown
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = undefined }
  return { status: response.status, headers: response.headers, body }
}

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new OAuthConnectError('discovery_failed', 'OAuth metadata is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

/** RFC 9728 §3.1: insert the well-known segment between host and path. */
function prmCandidates(serverUrl: URL): string[] {
  const path = serverUrl.pathname === '/' ? '' : serverUrl.pathname.replace(/\/+$/, '')
  const candidates = [`${serverUrl.origin}/.well-known/oauth-protected-resource${path}`]
  if (path !== '') candidates.push(`${serverUrl.origin}/.well-known/oauth-protected-resource`)
  return candidates
}

/** MCP 2025-11-25 order: RFC 8414 and OIDC, path-inserted first, then OIDC path-appended. */
function asCandidates(issuer: URL): string[] {
  const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/+$/, '')
  if (path === '') {
    return [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`]
  }
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ]
}

function sameIssuer(a: string, b: string): boolean {
  const left = normalise(a)
  const right = normalise(b)
  return left !== undefined && right !== undefined && left.href === right.href
}

async function challenge(serverUrl: string, fetchImpl: typeof fetch): Promise<BearerChallenge> {
  const result = await fetchLimitedJson(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dnt-harness', version: '0.1.0' } },
    }),
  }, fetchImpl).catch((error: unknown) => {
    // A streamed success body can exceed the bound; that still means "no OAuth".
    if (error instanceof OAuthConnectError && error.message === 'OAuth metadata is too large') {
      throw new OAuthConnectError('discovery_failed', 'the server answered without asking for authorization')
    }
    throw error
  })
  if (result.status !== 401) {
    throw new OAuthConnectError('discovery_failed', result.status >= 200 && result.status < 300
      ? 'the server answered without asking for authorization; it does not need OAuth'
      : `the server answered HTTP ${result.status} instead of asking for authorization`)
  }
  return parseBearerChallenge(result.headers.get('www-authenticate')) ?? {}
}

async function protectedResource(serverUrl: URL, hint: string | undefined, fetchImpl: typeof fetch): Promise<Record<string, unknown> | undefined> {
  const candidates = hint !== undefined ? [hint] : prmCandidates(serverUrl)
  for (const candidate of candidates) {
    const result = await fetchLimitedJson(candidate, { method: 'GET' }, fetchImpl)
    const body = record(result.body)
    if (result.status === 200 && body !== undefined) return body
    if (hint !== undefined) throw new OAuthConnectError('discovery_failed', `protected resource metadata at ${candidate} answered HTTP ${result.status}`)
  }
  return undefined
}

async function authorizationServer(issuer: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const issuerUrl = normalise(issuer)
  if (issuerUrl === undefined) throw new OAuthConnectError('discovery_failed', `authorization server '${issuer}' is not a URL`)
  for (const candidate of asCandidates(issuerUrl)) {
    const result = await fetchLimitedJson(candidate, { method: 'GET' }, fetchImpl)
    const body = record(result.body)
    if (result.status !== 200 || body === undefined) continue
    if (typeof body['issuer'] !== 'string' || !sameIssuer(body['issuer'], issuer)) {
      throw new OAuthConnectError('discovery_failed', `authorization server metadata names issuer '${String(body['issuer'])}', expected '${issuer}'`)
    }
    return body
  }
  throw new OAuthConnectError('discovery_failed', `no authorization server metadata found for ${issuer}`)
}

function endpoint(metadata: Record<string, unknown>, key: string, required: true): string
function endpoint(metadata: Record<string, unknown>, key: string, required: false): string | undefined
function endpoint(metadata: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = metadata[key]
  if (typeof value !== 'string' || value === '') {
    if (required) throw new OAuthConnectError('discovery_failed', `authorization server metadata has no ${key}`)
    return undefined
  }
  try {
    assertOutboundUrl(value, { allowLoopbackHttp: true })
  } catch (error) {
    throw new OAuthConnectError('discovery_failed', `${key} ${value}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return value
}

/** Discover everything a sign-in needs, or fail with `discovery_failed` naming the check. */
export async function discoverOAuth(serverUrl: string, options: { readonly fetchImpl?: typeof fetch; readonly scopes?: readonly string[] } = {}): Promise<DiscoveredOAuth> {
  const fetchImpl = options.fetchImpl ?? fetch
  const server = normalise(serverUrl)
  if (server === undefined) throw new OAuthConnectError('discovery_failed', `'${serverUrl}' is not a URL`)
  const bearer = await challenge(serverUrl, fetchImpl)
  const prm = await protectedResource(server, bearer.resourceMetadata, fetchImpl)

  let resource = serverUrl
  let issuers = [server.origin]
  let prmScopes: string[] = []
  if (prm !== undefined) {
    if (typeof prm['resource'] !== 'string' || !resourceCovers(serverUrl, prm['resource'])) {
      throw new OAuthConnectError('discovery_failed', `protected resource metadata names resource '${String(prm['resource'])}', which does not cover ${serverUrl}`)
    }
    resource = prm['resource']
    const servers = strings(prm['authorization_servers'])
    if (servers.length === 0) throw new OAuthConnectError('discovery_failed', 'protected resource metadata lists no authorization server')
    issuers = servers
    prmScopes = strings(prm['scopes_supported'])
  }

  const failures: string[] = []
  for (const issuer of issuers) {
    try {
      const metadata = await authorizationServer(issuer, fetchImpl)
      if (!strings(metadata['code_challenge_methods_supported']).includes('S256')) {
        throw new OAuthConnectError('discovery_failed', 'the authorization server does not support PKCE S256')
      }
      const configured = options.scopes ?? []
      const challenged = (bearer.scope ?? '').split(/\s+/).filter((scope) => scope !== '')
      const scopes = configured.length > 0 ? [...configured] : challenged.length > 0 ? challenged : prmScopes
      const revocation = endpoint(metadata, 'revocation_endpoint', false)
      const registration = endpoint(metadata, 'registration_endpoint', false)
      return {
        resource,
        issuer: typeof metadata['issuer'] === 'string' ? metadata['issuer'] : issuer,
        authorizationEndpoint: endpoint(metadata, 'authorization_endpoint', true),
        tokenEndpoint: endpoint(metadata, 'token_endpoint', true),
        ...(revocation !== undefined ? { revocationEndpoint: revocation } : {}),
        ...(registration !== undefined ? { registrationEndpoint: registration } : {}),
        // RFC 8414 §2: the default when omitted is client_secret_basic.
        tokenEndpointAuthMethods: metadata['token_endpoint_auth_methods_supported'] === undefined
          ? ['client_secret_basic']
          : strings(metadata['token_endpoint_auth_methods_supported']),
        scopes,
      }
    } catch (error) {
      failures.push(`${issuer}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new OAuthConnectError('discovery_failed', `no advertised authorization server worked: ${failures.join('; ')}`)
}
