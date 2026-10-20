/**
 * Shutdown with an MCP connect still pending inside a managed-OAuth refresh:
 * close() must resolve within its bound, and the refresh that completes after
 * close must not persist a token.
 */
import { createServer, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { OAuthStore } from '../../src/harness/mcp/oauth-store.ts'

let web: WebServer | undefined
let home = ''
afterEach(async () => {
  await web?.close()
  web = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

describe('web shutdown with a pending MCP OAuth connect', () => {
  it('close() resolves and a refresh finishing after close saves no token', async () => {
    let held: ServerResponse | undefined
    let tokenHit!: () => void
    const tokenRequested = new Promise<void>((resolve) => { tokenHit = resolve })
    const remote = createServer((req, res) => {
      req.resume()
      // The refresh (and so the whole connect) hangs until the test releases it.
      if (req.url === '/token') { held = res; tokenHit(); return }
      res.statusCode = 401
      res.end('{}')
    })
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
    const address = remote.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-shutdown-oauth-'))
      web = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
      const wsId = ((await (await fetch(`${web.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
      const post = (route: string, body?: unknown) => fetch(`${web!.url}/api/workspaces/${wsId}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      expect((await post('/mcp/remote', { transport: 'http', url: `${origin}/mcp`, enabled: false, auth: { type: 'managed_oauth', provider: 'fixture', resource: `${origin}/mcp`, clientId: 'client' } })).status).toBe(201)
      const store = new OAuthStore(path.join(home, 'oauth'), await fs.readFile(path.join(home, 'oauth.master.key')))
      await store.saveTokens(wsId, 'remote', {
        accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: 0,
        tokenEndpoint: `${origin}/token`, clientId: 'client', phase: 'active', resource: `${origin}/mcp`,
      })

      const enabling = post('/mcp/remote/enable').catch(() => undefined)
      await tokenRequested

      const started = Date.now()
      await web.close()
      web = undefined
      expect(Date.now() - started).toBeLessThan(10_000)

      // The provider answers only now, after the host closed.
      held!.setHeader('content-type', 'application/json')
      held!.end(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, token_type: 'bearer' }))
      await enabling
      await new Promise((resolve) => setTimeout(resolve, 200))

      const stored = await store.readTokens(wsId, 'remote')
      expect(stored?.accessToken).toBe('access-old')
      expect(stored?.refreshToken).toBe('refresh-old')
    } finally {
      held?.destroy()
      await new Promise<void>((resolve) => remote.close(() => resolve()))
    }
  }, 30_000)
})
