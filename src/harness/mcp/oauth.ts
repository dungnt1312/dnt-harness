/**
 * Managed OAuth is authorization-code + PKCE S256 for a pinned fixture
 * profile. The public callback only deposits a code. It does not create a
 * local session. The browser session that started the flow completes the
 * token exchange.
 *
 * Dynamic client registration is not implemented.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertOutboundUrl, OutboundPolicyError } from './outbound-policy.ts'
import { OAuthStore, type OAuthTokens } from './oauth-store.ts'

const SKEW_MS = 30_000

export interface OAuthBegin {
  readonly workspaceId: string
  readonly server: string
  readonly principalId: string
  readonly resource: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly clientId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
}

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

export class ManagedOAuth {
  constructor(
    private readonly store: OAuthStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async begin(input: OAuthBegin): Promise<{ readonly authorizationUrl: string; readonly state: string }> {
    assertOauthUrl(input.authorizationEndpoint)
    assertOauthUrl(input.tokenEndpoint)
    assertOauthUrl(input.resource)
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    await this.store.saveTransaction({
      state,
      verifier,
      workspaceId: input.workspaceId,
      server: input.server,
      principalId: input.principalId,
      resource: input.resource,
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      expiresAt: this.now() + 5 * 60_000,
      code: undefined,
    })
    const url = new URL(input.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('resource', input.resource)
    if (input.scopes.length > 0) url.searchParams.set('scope', input.scopes.join(' '))
    return { authorizationUrl: url.toString(), state }
  }

  /** Public deposit. No session is created and the verifier is not returned. */
  async deposit(state: string, code: string): Promise<void> {
    if (state === '' || code === '') throw new OAuthFlowError('callback is missing state or code')
    const tx = await this.store.takeTransaction(state)
    if (tx === undefined || tx.expiresAt <= this.now() || tx.code !== undefined) {
      throw new OAuthFlowError('callback state is unknown, expired, or already used')
    }
    await this.store.saveTransaction({ ...tx, code })
  }

  async complete(input: { readonly state: string; readonly principalId: string; readonly workspaceId: string; readonly server: string }): Promise<OAuthTokens> {
    const tx = await this.store.readTransaction(input.state)
    if (tx === undefined || tx.code === undefined) throw new OAuthFlowError('authorization has not been deposited')
    if (tx.principalId !== input.principalId || tx.workspaceId !== input.workspaceId || tx.server !== input.server) {
      throw new OAuthFlowError('callback does not belong to this principal, workspace, and server')
    }
    const tokens = await this.exchange(tx.tokenEndpoint, new URLSearchParams({
      grant_type: 'authorization_code',
      code: tx.code,
      code_verifier: tx.verifier,
      redirect_uri: tx.redirectUri,
      client_id: tx.clientId,
      resource: tx.resource,
    }))
    await this.store.saveTokens(tx.workspaceId, tx.server, { ...tokens, phase: 'active', resource: tx.resource })
    await this.store.deleteTransaction(input.state)
    return tokens
  }

  async accessToken(workspaceId: string, server: string): Promise<string | undefined> {
    const stored = await this.store.readTokens(workspaceId, server)
    if (stored === undefined || stored.phase === 'local_revoked') return undefined
    if (stored.phase === 'refresh_in_progress') return undefined
    if (stored.expiresAt <= this.now() + SKEW_MS) {
      const refreshed = await this.refresh(workspaceId, server)
      return refreshed?.accessToken
    }
    return stored.accessToken
  }

  async refresh(workspaceId: string, server: string): Promise<OAuthTokens | undefined> {
    return this.store.withServerLock(workspaceId, server, async () => {
      const current = await this.store.readTokens(workspaceId, server)
      if (current === undefined || current.phase === 'local_revoked') return undefined
      if (current.phase === 'replacement_persisted') {
        const active = { ...current, phase: 'active' as const }
        await this.store.saveTokens(workspaceId, server, active)
        return active
      }
      await this.store.saveTokens(workspaceId, server, { ...current, phase: 'refresh_in_progress' })
      let next: OAuthTokens
      try {
        next = await this.exchange(current.tokenEndpoint, new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: current.clientId,
          resource: current.resource,
        }))
      } catch {
        await this.store.saveTokens(workspaceId, server, { ...current, phase: 'auth_required' })
        return undefined
      }
      const persisted = { ...next, phase: 'replacement_persisted' as const, resource: current.resource }
      await this.store.saveTokens(workspaceId, server, persisted)
      const active = { ...persisted, phase: 'active' as const }
      await this.store.saveTokens(workspaceId, server, active)
      return active
    })
  }

  /**
   * Local revoke lands before any remote call. Remote failure does not
   * reactivate the token.
   */
  async revoke(workspaceId: string, server: string, revocationEndpoint?: string): Promise<{ readonly local: 'revoked'; readonly remote: 'succeeded' | 'failed' | 'unavailable' }> {
    const current = await this.store.readTokens(workspaceId, server)
    await this.store.saveTokens(workspaceId, server, current === undefined
      ? tombstone(workspaceId, server)
      : { ...current, phase: 'local_revoked', accessToken: '', refreshToken: '' })
    if (revocationEndpoint === undefined || current === undefined) return { local: 'revoked', remote: 'unavailable' }
    try {
      assertOauthUrl(revocationEndpoint)
      const response = await this.fetchImpl(revocationEndpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: current.accessToken, client_id: current.clientId }),
      })
      return { local: 'revoked', remote: response.ok ? 'succeeded' : 'failed' }
    } catch {
      return { local: 'revoked', remote: 'failed' }
    }
  }

  private async exchange(endpoint: string, body: URLSearchParams): Promise<OAuthTokens> {
    assertOauthUrl(endpoint)
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    if (response.status >= 300 && response.status < 400) throw new OAuthFlowError('token endpoint redirected')
    if (!response.ok) throw new OAuthFlowError('token endpoint rejected the exchange')
    const parsed = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown }
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') throw new OAuthFlowError('token response has no access token')
    if (parsed.token_type !== undefined && String(parsed.token_type).toLowerCase() !== 'bearer') {
      throw new OAuthFlowError('token response is not a bearer token')
    }
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600
    return {
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
      expiresAt: this.now() + expiresIn * 1000,
      tokenEndpoint: endpoint,
      clientId: body.get('client_id') ?? '',
      phase: 'active',
      resource: body.get('resource') ?? '',
    }
  }
}

function assertOauthUrl(raw: string): void {
  try {
    assertOutboundUrl(raw, { allowLoopbackHttp: true })
  } catch (error) {
    if (error instanceof OutboundPolicyError) throw new OAuthFlowError(error.message)
    throw error
  }
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

void same

function tombstone(workspaceId: string, server: string): OAuthTokens {
  return {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    tokenEndpoint: '',
    clientId: '',
    phase: 'local_revoked',
    resource: '',
    workspaceId,
    server,
  }
}
