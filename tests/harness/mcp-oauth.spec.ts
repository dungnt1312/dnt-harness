import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedOAuth, OAuthStore } from 'dnt-harness'

describe('managed oauth profile', () => {
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
