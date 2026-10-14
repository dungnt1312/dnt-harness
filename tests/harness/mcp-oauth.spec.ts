import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagedOAuth, OAuthStore } from 'dnt-harness'

describe('managed oauth profile', () => {
  it('does not let first Begin overwrite a Revoke epoch', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-first-revoke-'))
    const read = fs.readFile.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const paused = new Promise<void>((resolve) => { entered = resolve })
    try {
      const store = new OAuthStore(home, randomBytes(32))
      const oauth = new ManagedOAuth(store, (async () => Response.json({ access_token: 'stale' })) as typeof fetch)
      // Pause after the first read has observed ENOENT, before incarnation can write.
      let first = true
      vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        if (first && String(args[0]).includes('epoch-ws-remote.json')) {
          first = false
          try { return await read(...args) }
          catch (error) { entered(); await gate; throw error }
        }
        return read(...args)
      })
      const pending = depositedAuthorization(oauth)
      await paused
      const revoking = oauth.revoke('ws', 'remote')
      release()
      const tx = await pending
      await revoking
      await expect(oauth.complete(tx)).rejects.toThrow(/revoked|replaced/)
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('local_revoked')
    } finally { release(); vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }) }
  })

  it('returns one durable epoch to concurrent first incarnations', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-first-concurrent-'))
    const read = fs.readFile.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const paused = new Promise<void>((resolve) => { entered = resolve })
    try {
      const store = new OAuthStore(home, randomBytes(32))
      let first = true
      vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        if (first && String(args[0]).includes('epoch-ws-remote.json')) {
          first = false
          try { return await read(...args) }
          catch (error) { entered(); await gate; throw error }
        }
        return read(...args)
      })
      const a = store.incarnation('ws', 'remote')
      await paused
      const b = store.incarnation('ws', 'remote')
      // Let the second caller reach the missing-file read in the old implementation.
      await new Promise<void>((resolve) => setImmediate(resolve))
      release()
      const [firstEpoch, secondEpoch] = await Promise.all([a, b])
      expect(firstEpoch).toBe(secondEpoch)
      expect(await store.incarnation('ws', 'remote')).toBe(firstEpoch)
    } finally { release(); vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }) }
  })
  it('rejects completion of a deposited transaction after expiry', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-expiry-'))
    try {
      let clock = 1_000
      const store = new OAuthStore(home, randomBytes(32))
      const oauth = new ManagedOAuth(store, (async () => Response.json({ access_token: 'late' })) as typeof fetch, () => clock)
      const input = await depositedAuthorization(oauth)
      clock += 300_001
      await expect(oauth.complete(input)).rejects.toThrow(/expired/)
      expect(await store.readTokens('ws', 'remote')).toBeUndefined()
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  })

  it('does not publish after revoke, even when the old transaction was deposited first', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-revoke-'))
    try {
      const store = new OAuthStore(home, randomBytes(32))
      const oauth = new ManagedOAuth(store, (async () => Response.json({ access_token: 'late' })) as typeof fetch)
      const input = await depositedAuthorization(oauth)
      await oauth.revoke('ws', 'remote')
      await expect(oauth.complete(input)).rejects.toThrow(/revoked|replaced/)
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('local_revoked')
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  })

  it('rejects a changed configuration during a held exchange before publication', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-config-'))
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    try {
      const store = new OAuthStore(home, randomBytes(32))
      let config = 'original'
      const oauth = new ManagedOAuth(store, (async () => { entered(); return gate }) as typeof fetch, undefined, undefined, async () => config)
      const { state } = await oauth.begin({ workspaceId: 'ws', server: 'remote', principalId: 'p', resource: 'http://127.0.0.1/mcp', authorizationEndpoint: 'http://127.0.0.1/authorize', tokenEndpoint: 'http://127.0.0.1/token', redirectUri: 'http://127.0.0.1/callback', clientId: 'client', scopes: [], configIdentity: config })
      await oauth.deposit(state, 'code')
      const pending = oauth.complete({ state, workspaceId: 'ws', server: 'remote', principalId: 'p' })
      await started
      config = 'changed'
      release(Response.json({ access_token: 'stale' }))
      await expect(pending).rejects.toThrow(/configuration changed/)
      expect(await store.readTokens('ws', 'remote')).toBeUndefined()
    } finally { release(Response.json({ access_token: 'stale' })); await fs.rm(home, { recursive: true, force: true }) }
  })

  it('fails closed if the atomic grant write is interrupted', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-atomic-'))
    try {
      const store = new OAuthStore(home, randomBytes(32))
      const oauth = new ManagedOAuth(store, (async () => Response.json({ access_token: 'new' })) as typeof fetch)
      const record = { serverUrl: 'http://127.0.0.1/mcp', resource: 'http://127.0.0.1/mcp', issuer: 'http://127.0.0.1', authorizationEndpoint: 'http://127.0.0.1/authorize', tokenEndpoint: 'http://127.0.0.1/token', scopes: [], discoveredAt: 1 }
      const { state } = await oauth.begin({ workspaceId: 'ws', server: 'remote', principalId: 'p', resource: record.resource, authorizationEndpoint: record.authorizationEndpoint, tokenEndpoint: record.tokenEndpoint, redirectUri: 'http://127.0.0.1/callback', clientId: 'client', scopes: [], serverRecord: record })
      await oauth.deposit(state, 'code')
      vi.spyOn(store, 'publishGrant').mockRejectedValueOnce(new Error('disk full'))
      await expect(oauth.complete({ state, workspaceId: 'ws', server: 'remote', principalId: 'p' })).rejects.toThrow('disk full')
      expect(await store.readTokens('ws', 'remote')).toBeUndefined()
      expect(await store.readServerRecord('ws', 'remote')).toBeUndefined()
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  })
  it('retains the previous refresh token when the endpoint omits refresh_token', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    try {
      const store = new OAuthStore(home, randomBytes(32))
      await store.saveTokens('ws', 'remote', expiredTokens())
      const bodies: string[] = []
      const oauth = new ManagedOAuth(store, (async (_url, init) => {
        bodies.push(String(init?.body))
        return Response.json({ access_token: `access-${bodies.length}`, expires_in: 1 })
      }) as typeof fetch)
      await oauth.refresh('ws', 'remote')
      expect((await store.readTokens('ws', 'remote'))?.refreshToken).toBe('refresh-old')
      await oauth.refresh('ws', 'remote')
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toContain('refresh_token=refresh-old')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it.each(['success', 'temporary', 'rejected'] as const)('fences an in-flight refresh after local revoke (%s)', async (result) => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    let resolveResponse!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    try {
      const store = new OAuthStore(home, randomBytes(32))
      await store.saveTokens('ws', 'remote', expiredTokens())
      const oauth = new ManagedOAuth(store, (async () => { entered(); return response }) as typeof fetch)
      const pending = oauth.refresh('ws', 'remote').catch((error: unknown) => error)
      await started
      // Revocation must finish while the token endpoint is still blocked.
      await new ManagedOAuth(store).revoke('ws', 'remote')
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('local_revoked')
      await expect(oauth.accessToken('ws', 'remote')).resolves.toBeUndefined()
      resolveResponse(result === 'success'
        ? Response.json({ access_token: 'access-new', refresh_token: 'refresh-new' })
        : new Response('', { status: result === 'temporary' ? 503 : 400 }))
      await expect(pending).resolves.toBeUndefined()
      expect(await store.readTokens('ws', 'remote')).toMatchObject({ phase: 'local_revoked', accessToken: '', refreshToken: '' })
    } finally {
      resolveResponse(new Response('', { status: 400 }))
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it.each(['success', 'temporary', 'rejected'] as const)('fences an old network refresh after authorization replacement (%s)', async (result) => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const operations: Promise<unknown>[] = []
    try {
      const store = new OAuthStore(home, randomBytes(32))
      await store.saveTokens('ws', 'remote', expiredTokens())
      const refreshing = new ManagedOAuth(store, (async () => { entered(); return gate }) as typeof fetch)
      const pending = refreshing.refresh('ws', 'remote')
      operations.push(pending)
      await started
      const authorizing = new ManagedOAuth(store, (async () => Response.json({
        access_token: 'authorized-new', refresh_token: 'authorized-refresh',
      })) as typeof fetch)
      const input = await depositedAuthorization(authorizing)
      await expect(authorizing.complete(input)).resolves.toMatchObject({ accessToken: 'authorized-new' })
      release(result === 'success'
        ? Response.json({ access_token: 'stale-refresh', refresh_token: 'stale-refresh-token' })
        : new Response('', { status: result === 'temporary' ? 503 : 400 }))
      await expect(pending).resolves.toBeUndefined()
      expect(await store.readTokens('ws', 'remote')).toMatchObject({
        phase: 'active', accessToken: 'authorized-new', refreshToken: 'authorized-refresh',
      })
      await expect(refreshing.accessToken('ws', 'remote')).resolves.toBe('authorized-new')
    } finally {
      release(new Response('', { status: 400 }))
      await Promise.allSettled(operations)
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it.each(['complete', 'revoke'] as const)('fences a concurrent %s during an authorization write', async (operation) => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const writing = new Promise<void>((resolve) => { entered = resolve })
    const operations: Promise<unknown>[] = []
    try {
      const store = new OAuthStore(home, randomBytes(32))
      const save = store.saveTokens.bind(store)
      vi.spyOn(store, 'saveTokens').mockImplementation(async (ws, server, tokens) => {
        if (tokens.accessToken === 'authorized-first') { entered(); await gate }
        await save(ws, server, tokens)
      })
      let exchanges = 0
      const oauth = new ManagedOAuth(store, (async () => {
        exchanges += 1
        return Response.json({ access_token: exchanges === 1 ? 'authorized-first' : 'authorized-second' })
      }) as typeof fetch)
      const firstInput = await depositedAuthorization(oauth)
      const secondInput = await depositedAuthorization(oauth)
      const first = oauth.complete(firstInput).catch((error: unknown) => error)
      operations.push(first)
      await writing
      const second = operation === 'complete'
        ? oauth.complete(secondInput).catch((error: unknown) => error)
        : oauth.revoke('ws', 'remote')
      operations.push(second)
      // A second completion can wait for the publication lock before its exchange.
      release()
      if (operation === 'complete') {
        await expect(first).resolves.toMatchObject({ accessToken: 'authorized-first' })
        await expect(second).resolves.toMatchObject({ accessToken: 'authorized-second' })
        expect(await store.readTokens('ws', 'remote')).toMatchObject({ phase: 'active', accessToken: 'authorized-second' })
      } else {
        await expect(first).resolves.toBeInstanceOf(Error)
        await second
        expect(await store.readTokens('ws', 'remote')).toMatchObject({ phase: 'local_revoked', accessToken: '', refreshToken: '' })
        await expect(oauth.accessToken('ws', 'remote')).resolves.toBeUndefined()
      }
    } finally {
      release()
      await Promise.allSettled(operations)
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('serializes a revoke tombstone behind a refresh write already in progress', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const writing = new Promise<void>((resolve) => { entered = resolve })
    const operations: Promise<unknown>[] = []
    try {
      const store = new OAuthStore(home, randomBytes(32))
      await store.saveTokens('ws', 'remote', expiredTokens())
      const save = store.saveTokens.bind(store)
      vi.spyOn(store, 'saveTokens').mockImplementation(async (ws, server, tokens) => {
        if (tokens.phase === 'replacement_persisted') { entered(); await gate }
        await save(ws, server, tokens)
      })
      const oauth = new ManagedOAuth(store, (async () => Response.json({ access_token: 'new' })) as typeof fetch)
      const pending = oauth.refresh('ws', 'remote')
      operations.push(pending)
      await writing
      const revoked = oauth.revoke('ws', 'remote')
      operations.push(revoked)
      await expect(Promise.race([
        oauth.accessToken('ws', 'remote'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).resolves.toBeUndefined()
      release()
      await revoked
      await expect(pending).resolves.toBeUndefined()
      expect((await store.readTokens('ws', 'remote'))?.phase).toBe('local_revoked')
    } finally {
      release()
      await Promise.allSettled(operations)
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('deposits a code without creating a session and fences on local revoke', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    const store = new OAuthStore(home, randomBytes(32))
    let exchanged = 0
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      if (!body.includes('code_verifier=verifier-is-not-this') && req.url === '/token') exchanged += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'bearer' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const oauth = new ManagedOAuth(store)
      const started = await oauth.begin({
        workspaceId: 'ws',
        server: 'remote',
        principalId: 'person-a',
        resource: `${base}/mcp`,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        clientId: 'client',
        redirectUri: `${base}/callback`,
        scopes: ['tools'],
      })
      const state = new URL(started.authorizationUrl).searchParams.get('state') ?? ''
      await oauth.deposit(state, 'one-time-code')
      await expect(oauth.deposit(state, 'one-time-code')).rejects.toThrow(/already used/)
      await expect(oauth.complete({ state, principalId: 'person-b', workspaceId: 'ws', server: 'remote' })).rejects.toThrow(/does not belong/)
      await oauth.complete({ state, principalId: 'person-a', workspaceId: 'ws', server: 'remote' })
      expect(exchanged).toBe(1)
      const raw = await fs.readFile(path.join(home, 'tokens-ws-remote.json'), 'utf8')
      expect(raw).not.toContain('access-secret')
      expect(raw).not.toContain('refresh-secret')
      const revoked = await oauth.revoke('ws', 'remote')
      expect(revoked).toEqual({ local: 'revoked', remote: 'unavailable' })
      await expect(oauth.accessToken('ws', 'remote')).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe('managed oauth client authentication and server records', () => {
  async function withStore<T>(body: (store: OAuthStore) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    try { return await body(new OAuthStore(home, randomBytes(32))) } finally { await fs.rm(home, { recursive: true, force: true }) }
  }
  type Seen = { body: URLSearchParams; authorization: string | null }
  function recorder(seen: Seen[]): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      seen.push({ body: new URLSearchParams(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') })
      return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
    }) as typeof fetch
  }
  async function confidentialComplete(store: OAuthStore, method: 'client_secret_post' | 'client_secret_basic', seen: Seen[]) {
    const oauth = new ManagedOAuth(store, recorder(seen), undefined, async () => 'shh-secret')
    const { state } = await oauth.begin({
      workspaceId: 'ws', server: 'remote', principalId: 'p', resource: 'http://127.0.0.1/mcp',
      authorizationEndpoint: 'http://127.0.0.1/authorize', tokenEndpoint: 'http://127.0.0.1/token', clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenEndpointAuth: method,
    })
    await oauth.deposit(state, 'code')
    await oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' })
    return oauth
  }

  it('sends the client secret in the body for client_secret_post, and never stores it', async () => {
    await withStore(async (store) => {
      const seen: Seen[] = []
      await confidentialComplete(store, 'client_secret_post', seen)
      expect(seen[0]?.body.get('client_secret')).toBe('shh-secret')
      expect(seen[0]?.body.get('client_id')).toBe('client')
      expect(seen[0]?.authorization).toBeNull()
      const tokens = await store.readTokens('ws', 'remote')
      expect(tokens?.tokenEndpointAuth).toBe('client_secret_post')
      expect(JSON.stringify(tokens)).not.toContain('shh-secret')
    })
  })

  it('sends HTTP Basic for client_secret_basic, on the exchange and on refresh', async () => {
    await withStore(async (store) => {
      const seen: Seen[] = []
      const oauth = await confidentialComplete(store, 'client_secret_basic', seen)
      await oauth.refresh('ws', 'remote', 'access-new')
      const expected = `Basic ${Buffer.from('client:shh-secret').toString('base64')}`
      expect(seen.map((entry) => entry.authorization)).toEqual([expected, expected])
      expect(seen.every((entry) => !entry.body.has('client_secret') && !entry.body.has('client_id'))).toBe(true)
    })
  })

  it('refuses a confidential exchange when the secret is not available', async () => {
    await withStore(async (store) => {
      const oauth = new ManagedOAuth(store, recorder([]), undefined, async () => undefined)
      const { state } = await oauth.begin({
        workspaceId: 'ws', server: 'remote', principalId: 'p', resource: 'http://127.0.0.1/mcp',
        authorizationEndpoint: 'http://127.0.0.1/authorize', tokenEndpoint: 'http://127.0.0.1/token', clientId: 'client',
        redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenEndpointAuth: 'client_secret_post',
      })
      await oauth.deposit(state, 'code')
      await expect(oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' })).rejects.toThrow(/client secret is not available/)
    })
  })

  it('keeps insufficient_scope auth_required when an in-flight refresh succeeds', async () => {
    await withStore(async (store) => {
      await store.saveTokens('ws', 'remote', expiredTokens())
      let release!: (response: Response) => void
      const gate = new Promise<Response>((resolve) => { release = resolve })
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      const oauth = new ManagedOAuth(store, (async () => { entered(); return gate }) as typeof fetch)
      const pending = oauth.refresh('ws', 'remote')
      await started
      try {
        await oauth.markScopeRequired('ws', 'remote', 'write')
        release(Response.json({ access_token: 'new' }))
        await expect(pending).resolves.toBeUndefined()
        expect(await store.readTokens('ws', 'remote')).toMatchObject({ phase: 'auth_required', missingScope: 'write' })
      } finally { release(Response.json({ access_token: 'new' })); await pending }
    })
  })

  it.each(['missing', 'unloadable'] as const)('keeps an active grant when its client secret is %s during refresh', async (kind) => {
    await withStore(async (store) => {
      await store.saveTokens('ws', 'remote', { ...expiredTokens(), tokenEndpointAuth: 'client_secret_post' })
      const oauth = new ManagedOAuth(store, recorder([]), undefined, async () => {
        if (kind === 'unloadable') throw new Error('secret vault unavailable')
        return undefined
      })
      await expect(oauth.refresh('ws', 'remote')).rejects.toThrow(/secret|vault/)
      expect(await store.readTokens('ws', 'remote')).toMatchObject({ phase: 'active', accessToken: 'access-old' })
    })
  })

  it('marks a grant as needing sign-in with the missing scope', async () => {
    await withStore(async (store) => {
      await store.saveTokens('ws', 'remote', { ...expiredTokens(), expiresAt: Date.now() + 3_600_000 })
      const oauth = new ManagedOAuth(store)
      await oauth.markScopeRequired('ws', 'remote', 'write')
      await expect(oauth.accessToken('ws', 'remote')).resolves.toBeUndefined()
      expect(await oauth.tokenState('ws', 'remote')).toMatchObject({ phase: 'auth_required', missingScope: 'write' })
    })
  })

  it('stores a server record encrypted and deletes it with the tokens', async () => {
    await withStore(async (store) => {
      const record = {
        serverUrl: 'https://mcp.example.com/mcp', resource: 'https://mcp.example.com/mcp', issuer: 'https://mcp.example.com',
        authorizationEndpoint: 'https://mcp.example.com/authorize', tokenEndpoint: 'https://mcp.example.com/token',
        scopes: ['read'], registration: { clientId: 'reg-1', redirectUri: 'http://127.0.0.1:1/api/mcp/oauth/callback', issuedAt: 1 }, discoveredAt: 1,
      }
      await store.saveServerRecord('ws', 'remote', record)
      await store.saveTokens('ws', 'remote', expiredTokens())
      expect(await store.readServerRecord('ws', 'remote')).toEqual(record)
      await store.deleteServer('ws', 'remote')
      expect(await store.readServerRecord('ws', 'remote')).toBeUndefined()
      expect(await store.readTokens('ws', 'remote')).toBeUndefined()
    })
  })
})

describe('pasting the final redirect address', () => {
  const callback = 'http://127.0.0.1:3082/api/mcp/oauth/callback'
  const who = { workspaceId: 'ws', server: 'remote', principalId: 'p' }
  async function began(oauth: ManagedOAuth, redirectUri = callback) {
    const { state } = await oauth.begin({
      workspaceId: 'ws', server: 'remote', principalId: 'p', resource: 'http://127.0.0.1/mcp',
      authorizationEndpoint: 'http://127.0.0.1/authorize', tokenEndpoint: 'http://127.0.0.1/token', clientId: 'client',
      redirectUri, scopes: [],
    })
    return state
  }
  async function withOAuth<T>(body: (oauth: ManagedOAuth) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-oauth-'))
    try {
      const store = new OAuthStore(home, randomBytes(32))
      return await body(new ManagedOAuth(store, (async () => Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })) as typeof fetch))
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  }

  it('reads state and code from the address, deposits them, and returns the state', async () => {
    await withOAuth(async (oauth) => {
      const state = await began(oauth)
      await expect(oauth.acceptCallbackUrl(`${callback}?code=the-code&state=${state}`, who)).resolves.toBe(state)
      await expect(oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' })).resolves.toMatchObject({ accessToken: 'a' })
    })
  })

  it('accepts an address from a browser that kept only the path and query', async () => {
    await withOAuth(async (oauth) => {
      const state = await began(oauth)
      await expect(oauth.acceptCallbackUrl(`/api/mcp/oauth/callback?code=c&state=${state}`, who)).resolves.toBe(state)
    })
  })

  it('refuses an address for another server, another person, or another redirect URI', async () => {
    await withOAuth(async (oauth) => {
      const state = await began(oauth)
      const url = `${callback}?code=c&state=${state}`
      await expect(oauth.acceptCallbackUrl(url, { ...who, server: 'other' })).rejects.toThrow(/does not belong/)
      await expect(oauth.acceptCallbackUrl(url, { ...who, principalId: 'someone-else' })).rejects.toThrow(/does not belong/)
      await expect(oauth.acceptCallbackUrl(`http://evil.example/api/mcp/oauth/callback?code=c&state=${state}`, who)).rejects.toThrow(/redirect address/)
      await expect(oauth.acceptCallbackUrl(`http://127.0.0.1:3082/elsewhere?code=c&state=${state}`, who)).rejects.toThrow(/redirect address/)
    })
  })

  it('refuses a provider error, a missing code, an unknown state, and text that is not an address', async () => {
    await withOAuth(async (oauth) => {
      const state = await began(oauth)
      await expect(oauth.acceptCallbackUrl(`${callback}?error=access_denied&state=${state}`, who)).rejects.toThrow(/access_denied/)
      await expect(oauth.acceptCallbackUrl(`${callback}?state=${state}`, who)).rejects.toThrow(/no authorization code/)
      await expect(oauth.acceptCallbackUrl(`${callback}?code=c&state=unknown`, who)).rejects.toThrow(/unknown, expired, or already used/)
      await expect(oauth.acceptCallbackUrl('this is not a url', who)).rejects.toThrow(/not an address/)
    })
  })

  it('does not echo the code in errors', async () => {
    await withOAuth(async (oauth) => {
      const message = await oauth.acceptCallbackUrl(`${callback}?code=secret-code-123&state=unknown`, who).catch((error: unknown) => (error as Error).message)
      expect(message).not.toContain('secret-code-123')
    })
  })

  it('treats a callback the browser already deposited as done, keeping the first code', async () => {
    await withOAuth(async (oauth) => {
      const state = await began(oauth)
      await oauth.deposit(state, 'from-browser')
      await expect(oauth.acceptCallbackUrl(`${callback}?code=pasted&state=${state}`, who)).resolves.toBe(state)
      await expect(oauth.complete({ state, principalId: 'p', workspaceId: 'ws', server: 'remote' })).resolves.toMatchObject({ accessToken: 'a' })
    })
  })
})

async function depositedAuthorization(oauth: ManagedOAuth) {
  const { state } = await oauth.begin({
    workspaceId: 'ws', server: 'remote', principalId: 'person-a',
    resource: 'http://127.0.0.1/mcp', authorizationEndpoint: 'http://127.0.0.1/authorize',
    tokenEndpoint: 'http://127.0.0.1/token', clientId: 'client',
    redirectUri: 'http://127.0.0.1/callback', scopes: ['tools'],
  })
  await oauth.deposit(state, 'one-time-code')
  return { state, principalId: 'person-a', workspaceId: 'ws', server: 'remote' }
}

function expiredTokens() {
  return {
    accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: 0,
    tokenEndpoint: 'http://127.0.0.1/token', clientId: 'client', resource: 'http://127.0.0.1/mcp', phase: 'active' as const,
  }
}
