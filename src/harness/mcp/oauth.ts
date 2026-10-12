/**
 * Managed OAuth is authorization-code + PKCE S256 for a pinned fixture
 * profile. The public callback only deposits a code. It does not create a
 * local session. The browser session that started the flow completes the
 * token exchange.
 *
 * Discovery and client registration live in `oauth-discovery.ts` and
 * `oauth-registration.ts`; this class only runs the grant once the
 * endpoints and client are known. Confidential clients authenticate with
 * `client_secret_post` or `client_secret_basic`; the secret is resolved per
 * exchange through `secretFor` and never stored with the tokens.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { TokenEndpointAuth } from './config.ts'
import { assertOutboundUrl, OutboundPolicyError } from './outbound-policy.ts'
import { OAuthStore, type OAuthTokens } from './oauth-store.ts'

/** Resolves a confidential client's secret for one server, at the moment it is needed. */
export type ClientSecretSource = (workspaceId: string, server: string) => Promise<string | undefined>

interface ClientAuth {
  readonly clientId: string
  readonly method: TokenEndpointAuth
  readonly secret: string | undefined
}

const SKEW_MS = 30_000

// Shared by managers using the same store. Network refresh locks are separate
// from short disk-write queues so revocation never waits for the endpoint.
interface GrantFence {
  generation: number
  revoked: boolean
  writes: Promise<void>
}
const grantFences = new WeakMap<OAuthStore, Map<string, GrantFence>>()

function grantFence(store: OAuthStore, workspaceId: string, server: string): GrantFence {
  let grants = grantFences.get(store)
  if (grants === undefined) { grants = new Map(); grantFences.set(store, grants) }
  const key = JSON.stringify([workspaceId, server])
  let fence = grants.get(key)
  if (fence === undefined) {
    fence = { generation: 0, revoked: false, writes: Promise.resolve() }
    grants.set(key, fence)
  }
  return fence
}

function serializeWrite<T>(fence: GrantFence, body: () => Promise<T>): Promise<T> {
  const next = fence.writes.then(body)
  fence.writes = next.then(() => undefined, () => undefined)
  return next
}

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
  /** Defaults to `none` (public client with PKCE). */
  readonly tokenEndpointAuth?: TokenEndpointAuth
}

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

/** The token endpoint could not answer now; the stored grant is still good. */
export class OAuthTemporaryError extends OAuthFlowError {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthTemporaryError'
  }
}

export class ManagedOAuth {
  constructor(
    private readonly store: OAuthStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly secretFor: ClientSecretSource = async () => undefined,
  ) {}

  /** Read-only view of the stored grant (phase, missing scope); never sent to a browser as is. */
  async tokenState(workspaceId: string, server: string): Promise<OAuthTokens | undefined> {
    return this.store.readTokens(workspaceId, server)
  }

  /**
   * The server answered `insufficient_scope`. Refreshing cannot add scope,
   * so the grant waits for a person to sign in again with `scope` added.
   */
  async markScopeRequired(workspaceId: string, server: string, scope: string | undefined): Promise<void> {
    const fence = grantFence(this.store, workspaceId, server)
    await serializeWrite(fence, async () => {
      const current = await this.store.readTokens(workspaceId, server)
      if (current === undefined || current.phase === 'local_revoked') return
      await this.store.saveTokens(workspaceId, server, {
        ...current,
        phase: 'auth_required',
        ...(scope !== undefined && scope !== '' ? { missingScope: scope } : {}),
      })
    })
  }

  private async clientAuth(workspaceId: string, server: string, clientId: string, method: TokenEndpointAuth | undefined): Promise<ClientAuth> {
    const resolved = method ?? 'none'
    if (resolved === 'none') return { clientId, method: resolved, secret: undefined }
    const secret = await this.secretFor(workspaceId, server)
    if (secret === undefined || secret === '') throw new OAuthFlowError('client secret is not available; add it in Settings → Secrets')
    return { clientId, method: resolved, secret }
  }

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
      ...(input.tokenEndpointAuth !== undefined ? { tokenEndpointAuth: input.tokenEndpointAuth } : {}),
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

  /**
   * The person signed in on a machine whose browser could not reach this
   * host's callback, and pasted the address it ended on. Read `state` and
   * `code` from it and deposit them, exactly as the callback page would.
   *
   * The address must belong to this person's own pending sign-in for this
   * server, and must be that sign-in's redirect address: a code is accepted
   * only for the transaction that asked for it, and the PKCE verifier never
   * leaves the host. Errors name what is wrong without echoing the code.
   * A callback the browser already deposited counts as done.
   */
  async acceptCallbackUrl(address: string, expected: { readonly workspaceId: string; readonly server: string; readonly principalId: string }): Promise<string> {
    const text = address.trim()
    if (!/^(https?:\/\/|\/)/i.test(text)) throw new OAuthFlowError('that is not an address; paste the full address from the browser\'s address bar')
    let pasted: URL
    try { pasted = new URL(text, 'http://paste.invalid') } catch { throw new OAuthFlowError('that is not an address; paste the full address from the browser\'s address bar') }
    const providerError = pasted.searchParams.get('error')
    if (providerError !== null) throw new OAuthFlowError(`the provider did not grant access (${providerError.slice(0, 80)})`)
    const state = pasted.searchParams.get('state') ?? ''
    const tx = state === '' ? undefined : await this.store.readTransaction(state)
    if (tx === undefined || tx.expiresAt <= this.now()) throw new OAuthFlowError('callback state is unknown, expired, or already used')
    if (tx.principalId !== expected.principalId || tx.workspaceId !== expected.workspaceId || tx.server !== expected.server) {
      throw new OAuthFlowError('callback does not belong to this principal, workspace, and server')
    }
    const redirect = new URL(tx.redirectUri)
    const sameOrigin = text.startsWith('/') || pasted.origin === redirect.origin
    if (!sameOrigin || pasted.pathname !== redirect.pathname) throw new OAuthFlowError('the address is not this sign-in\'s redirect address; paste the one the browser ended on after you signed in')
    if (tx.code !== undefined) return state
    const code = pasted.searchParams.get('code') ?? ''
    if (code === '') throw new OAuthFlowError('the address has no authorization code; paste the address the browser ended on after you signed in')
    await this.deposit(state, code)
    return state
  }

  async complete(input: { readonly state: string; readonly principalId: string; readonly workspaceId: string; readonly server: string }): Promise<OAuthTokens> {
    const tx = await this.store.readTransaction(input.state)
    if (tx === undefined || tx.code === undefined) throw new OAuthFlowError('authorization has not been deposited')
    if (tx.principalId !== input.principalId || tx.workspaceId !== input.workspaceId || tx.server !== input.server) {
      throw new OAuthFlowError('callback does not belong to this principal, workspace, and server')
    }
    const fence = grantFence(this.store, tx.workspaceId, tx.server)
    const generation = fence.generation
    const client = await this.clientAuth(tx.workspaceId, tx.server, tx.clientId, tx.tokenEndpointAuth)
    const tokens = await this.exchange(tx.tokenEndpoint, new URLSearchParams({
      grant_type: 'authorization_code',
      code: tx.code,
      code_verifier: tx.verifier,
      redirect_uri: tx.redirectUri,
      resource: tx.resource,
    }), client)
    await serializeWrite(fence, async () => {
      if (fence.generation !== generation) throw new OAuthFlowError('authorization was locally revoked or replaced')
      await this.store.saveTokens(tx.workspaceId, tx.server, { ...tokens, phase: 'active', resource: tx.resource })
      if (fence.generation !== generation) throw new OAuthFlowError('authorization was locally revoked or replaced')
      // Linearize replacement after persistence, without an intervening await.
      // Refreshes started even during this write belong to the previous grant;
      // queued completes must not overwrite it, and an in-write revoke wins.
      fence.generation += 1
      fence.revoked = false
    })
    await this.store.deleteTransaction(input.state)
    return tokens
  }

  /**
   * The access token to send now, refreshed when it is about to expire.
   * `undefined` means a person has to authorize again; a thrown
   * {@link OAuthTemporaryError} means try later with the same grant.
   */
  async accessToken(workspaceId: string, server: string): Promise<string | undefined> {
    const fence = grantFence(this.store, workspaceId, server)
    if (fence.revoked) return undefined
    const stored = await this.store.readTokens(workspaceId, server)
    if (fence.revoked) return undefined
    if (stored === undefined || stored.phase === 'local_revoked' || stored.phase === 'auth_required') return undefined
    // `refresh_in_progress` outside the lock is either a refresh running in
    // this process (refresh() waits for it) or one a crash interrupted
    // (refresh() resumes it). Neither is a reason to give up the grant.
    if (stored.phase !== 'active' || stored.expiresAt <= this.now() + SKEW_MS) {
      const refreshed = await this.refresh(workspaceId, server)
      return refreshed?.accessToken
    }
    return stored.accessToken
  }

  /**
   * The server refused `rejected` (HTTP 401/403). Refresh once, however many
   * callers report the same token; a token already replaced is returned as is.
   */
  async replaceRejected(workspaceId: string, server: string, rejected: string | undefined): Promise<string | undefined> {
    const refreshed = await this.refresh(workspaceId, server, rejected)
    return refreshed?.accessToken
  }

  async refresh(workspaceId: string, server: string, rejected?: string): Promise<OAuthTokens | undefined> {
    const fence = grantFence(this.store, workspaceId, server)
    const generation = fence.generation
    const fenced = (): boolean => fence.revoked || fence.generation !== generation
    const save = (tokens: OAuthTokens): Promise<boolean> => serializeWrite(fence, async () => {
      if (fenced()) return false
      await this.store.saveTokens(workspaceId, server, tokens)
      return !fenced()
    })
    if (fenced()) return undefined
    return this.store.withServerLock(workspaceId, server, async () => {
      if (fenced()) return undefined
      const current = await this.store.readTokens(workspaceId, server)
      if (fenced()) return undefined
      if (current === undefined || current.phase === 'local_revoked' || current.phase === 'auth_required') return undefined
      if (current.phase === 'replacement_persisted') {
        const active = { ...current, phase: 'active' as const }
        if (!await save(active)) return undefined
        return active
      }
      // Another caller refreshed while this one waited for the lock.
      const stillGood = current.phase === 'active' && current.expiresAt > this.now() + SKEW_MS
      if (stillGood && (rejected === undefined || current.accessToken !== rejected)) return current
      if (current.refreshToken === '') {
        await save({ ...current, phase: 'auth_required' })
        return undefined
      }
      if (!await save({ ...current, phase: 'refresh_in_progress' })) return undefined
      let next: OAuthTokens
      try {
        const client = await this.clientAuth(workspaceId, server, current.clientId, current.tokenEndpointAuth)
        next = await this.exchange(current.tokenEndpoint, new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          resource: current.resource,
        }), client)
      } catch (error) {
        if (fenced()) return undefined
        if (error instanceof OAuthTemporaryError) {
          // Network trouble or a 5xx/429 says nothing about the grant: keep it.
          if (!await save({ ...current, phase: 'active' })) return undefined
          throw error
        }
        await save({ ...current, phase: 'auth_required' })
        return undefined
      }
      const persisted = { ...next, phase: 'replacement_persisted' as const, resource: current.resource }
      if (!await save(persisted)) return undefined
      const active = { ...persisted, phase: 'active' as const }
      if (!await save(active)) return undefined
      return active
    })
  }

  /**
   * Local revoke lands before any remote call. Remote failure does not
   * reactivate the token.
   */
  async revoke(workspaceId: string, server: string, revocationEndpoint?: string): Promise<{ readonly local: 'revoked'; readonly remote: 'succeeded' | 'failed' | 'unavailable' }> {
    const fence = grantFence(this.store, workspaceId, server)
    fence.generation += 1
    fence.revoked = true // Fence callers synchronously, before any disk/network await.
    const current = await serializeWrite(fence, async () => {
      const stored = await this.store.readTokens(workspaceId, server)
      await this.store.saveTokens(workspaceId, server, stored === undefined
        ? tombstone(workspaceId, server)
        : { ...stored, phase: 'local_revoked', accessToken: '', refreshToken: '' })
      return stored
    })
    if (revocationEndpoint === undefined || current === undefined || current.accessToken === '') return { local: 'revoked', remote: 'unavailable' }
    try {
      assertOauthUrl(revocationEndpoint)
      const client = await this.clientAuth(workspaceId, server, current.clientId, current.tokenEndpointAuth)
      const { headers, body } = authenticated(new URLSearchParams({ token: current.accessToken }), client)
      const response = await this.fetchImpl(revocationEndpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
        signal: AbortSignal.timeout(15_000),
      })
      await response.body?.cancel().catch(() => undefined)
      return { local: 'revoked', remote: response.ok ? 'succeeded' : 'failed' }
    } catch {
      return { local: 'revoked', remote: 'failed' }
    }
  }

  private async exchange(endpoint: string, grant: URLSearchParams, client: ClientAuth): Promise<OAuthTokens> {
    assertOauthUrl(endpoint)
    const { headers, body } = authenticated(grant, client)
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new OAuthTemporaryError(`token endpoint temporarily unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status >= 300 && response.status < 400) throw new OAuthFlowError('token endpoint redirected')
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined)
      throw new OAuthTemporaryError(`token endpoint temporarily unavailable (HTTP ${response.status})`)
    }
    if (!response.ok) throw new OAuthFlowError('token endpoint rejected the exchange')
    const parsed = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown }
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') throw new OAuthFlowError('token response has no access token')
    if (parsed.token_type !== undefined && String(parsed.token_type).toLowerCase() !== 'bearer') {
      throw new OAuthFlowError('token response is not a bearer token')
    }
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600
    return {
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : (grant.get('refresh_token') ?? ''),
      expiresAt: this.now() + expiresIn * 1000,
      tokenEndpoint: endpoint,
      clientId: client.clientId,
      phase: 'active',
      resource: grant.get('resource') ?? '',
      ...(client.method !== 'none' ? { tokenEndpointAuth: client.method } : {}),
    }
  }
}

/**
 * Apply the client's token-endpoint authentication (RFC 6749 §2.3.1).
 * Public clients send `client_id` in the body. Basic encodes id and secret
 * form-urlencoded first, as the RFC requires.
 */
function authenticated(grant: URLSearchParams, client: ClientAuth): { readonly headers: Record<string, string>; readonly body: URLSearchParams } {
  const body = new URLSearchParams(grant)
  if (client.method === 'client_secret_basic') {
    const user = encodeURIComponent(client.clientId)
    const password = encodeURIComponent(client.secret ?? '')
    return { headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }, body }
  }
  body.set('client_id', client.clientId)
  if (client.method === 'client_secret_post') body.set('client_secret', client.secret ?? '')
  return { headers: {}, body }
}

function assertOauthUrl(raw: string): void {
  try {
    assertOutboundUrl(raw, { allowLoopbackHttp: true })
  } catch (error) {
    if (error instanceof OutboundPolicyError) throw new OAuthFlowError(error.message)
    throw error
  }
}

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
