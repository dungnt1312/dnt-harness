/**
 * Which OAuth client the host signs in with, in MCP spec priority order:
 *
 * 1. a client the user configured (`managed_oauth.clientId`);
 * 2. a client this host registered before for the same issuer and redirect;
 * 3. dynamic client registration (RFC 7591) as a public PKCE client;
 * 4. otherwise `client_required`, so the UI asks the user for one.
 *
 * Client ID Metadata Documents are not used: they need a public HTTPS URL
 * this local host cannot serve, and every provider offering them so far also
 * offers registration.
 */
import type { TokenEndpointAuth } from './config.ts'
import { assertOutboundUrl, isLoopbackUrl } from './outbound-policy.ts'
import { fetchLimitedJson, OAuthConnectError, type DiscoveredOAuth } from './oauth-discovery.ts'
import type { OutboundHttp } from './outbound-http.ts'
import type { OAuthServerRecord } from './oauth-store.ts'

export interface ResolvedClient {
  readonly clientId: string
  readonly tokenEndpointAuth: TokenEndpointAuth
  /** Set when this connect registered the client; the caller stores it. */
  readonly registration?: NonNullable<OAuthServerRecord['registration']>
}

export async function resolveClient(input: {
  readonly configured?: { readonly clientId?: string | undefined; readonly tokenEndpointAuth?: TokenEndpointAuth | undefined }
  readonly discovered: DiscoveredOAuth
  readonly redirectUri: string
  readonly previous?: OAuthServerRecord | undefined
  /** Test seam: a policy transport with an injected low-level sender. */
  readonly http?: OutboundHttp
  readonly now?: () => number
}): Promise<ResolvedClient> {
  const configuredId = input.configured?.clientId
  if (configuredId !== undefined && configuredId !== '') {
    return { clientId: configuredId, tokenEndpointAuth: input.configured?.tokenEndpointAuth ?? 'none' }
  }

  const kept = input.previous?.registration
  if (kept !== undefined && kept.redirectUri === input.redirectUri && input.previous?.issuer === input.discovered.issuer) {
    return { clientId: kept.clientId, tokenEndpointAuth: 'none', registration: kept }
  }

  const registrationEndpoint = input.discovered.registrationEndpoint
  if (registrationEndpoint !== undefined) {
    const local = isLoopbackUrl(new URL(input.discovered.resource))
    assertOutboundUrl(registrationEndpoint, { allowLoopbackHttp: local })
  }
  const publicAllowed = input.discovered.tokenEndpointAuthMethods.includes('none')
  if (registrationEndpoint === undefined || !publicAllowed) {
    throw new OAuthConnectError('client_required', registrationEndpoint === undefined
      ? `${input.discovered.issuer} does not offer client registration. Create an OAuth app with the provider, using ${input.redirectUri} as its callback URL, then enter its client ID and secret.`
      : `${input.discovered.issuer} registers only confidential clients. Create an OAuth app with the provider, using ${input.redirectUri} as its callback URL, then enter its client ID and secret.`)
  }

  const result = await fetchLimitedJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'dnt-harness',
      redirect_uris: [input.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }, input.http, isLoopbackUrl(new URL(input.discovered.resource))).catch((error: unknown) => {
    if (error instanceof OAuthConnectError) throw new OAuthConnectError('registration_failed', error.message)
    throw error
  })
  const body = result.body !== null && typeof result.body === 'object' ? result.body as Record<string, unknown> : {}
  if (result.status !== 200 && result.status !== 201) {
    const reason = typeof body['error_description'] === 'string' ? `: ${body['error_description'].slice(0, 200)}` : ''
    throw new OAuthConnectError('registration_failed', `client registration answered HTTP ${result.status}${reason}`)
  }
  const clientId = body['client_id']
  if (typeof clientId !== 'string' || clientId === '') throw new OAuthConnectError('registration_failed', 'client registration returned no client_id')
  const method = body['token_endpoint_auth_method']
  if (body['client_secret'] !== undefined || (method !== undefined && method !== 'none')) {
    throw new OAuthConnectError('registration_failed', 'the provider registered a confidential client; only public clients are registered automatically')
  }
  const registration = { clientId, redirectUri: input.redirectUri, issuedAt: (input.now ?? Date.now)() }
  return { clientId, tokenEndpointAuth: 'none', registration }
}
