/**
 * OAuth Connect through the web host against a loopback provider fixture:
 * discovery, registration, the callback page, completion, rows, revoke,
 * insufficient_scope, and the loopback-only rule.
 */
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { startOAuthFixture, type OAuthFixture, type OAuthFixtureOptions } from '../support/oauth-fixture.ts'

let web: WebServer | undefined
let fixture: OAuthFixture | undefined
let home = ''
afterEach(async () => {
  await web?.close()
  web = undefined
  await fixture?.close()
  fixture = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

interface Row { name: string; status: string; oauth?: { state: string; missingScope?: string; clientSource?: string } }

async function boot(options: OAuthFixtureOptions = {}, extra: { allowedHosts?: string[] } = {}) {
  fixture = await startOAuthFixture(options)
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-oauth-'))
  web = await createWebServer({ home, configFile: path.join(home, 'providers.json'), ...extra })
  const base = web.url
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const api = (route: string, body?: unknown) => fetch(`${base}/api/workspaces/${wsId}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const rows = async (): Promise<Row[]> => (await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()) as Row[]
  const row = async (name = 'remote'): Promise<Row | undefined> => (await rows()).find((entry) => entry.name === name)
  return { f: fixture, base, wsId, api, row }
}

async function addOAuthServer(api: (route: string, body?: unknown) => Promise<Response>, url: string, auth: Record<string, unknown> = {}) {
  const response = await api('/mcp/remote', {
    transport: 'http', url, enabled: false,
    auth: { type: 'managed_oauth', provider: new URL(url).host, resource: url, ...auth },
  })
  expect(response.status).toBe(201)
}

/** Begin, follow the provider redirect, load the callback page, complete. */
async function connect(ctx: Awaited<ReturnType<typeof boot>>, body: unknown = {}) {
  const begun = await ctx.api('/mcp/remote/oauth/begin', body)
  expect(begun.status).toBe(200)
  const { authorizationUrl, state } = await begun.json() as { authorizationUrl: string; state: string }
  const callback = await ctx.f.authorize(authorizationUrl)
  const page = await fetch(callback)
  const completed = await ctx.api('/mcp/remote/oauth/complete', { state })
  return { authorizationUrl: new URL(authorizationUrl), state, callback, page, completed }
}

function postWithHost(base: string, route: string, host: string, body: unknown): Promise<{ status: number; body: string }> {
  const url = new URL(route, base)
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

describe('MCP OAuth Connect', () => {
  it('discovers, registers, signs in, and runs the server with the token', async () => {
    const ctx = await boot({ prmScopes: ['read'] })
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    expect((await ctx.row())?.oauth).toEqual({ state: 'not_connected' })
    expect((await ctx.api('/mcp/remote/enable')).status).toBe(502)

    const flow = await connect(ctx)
    expect(flow.authorizationUrl.origin + flow.authorizationUrl.pathname).toBe(`${ctx.f.origin}/authorize`)
    expect(flow.authorizationUrl.searchParams.get('client_id')).toBe('registered-1')
    expect(flow.authorizationUrl.searchParams.get('redirect_uri')).toBe(`${ctx.base}/api/mcp/oauth/callback`)
    expect(flow.authorizationUrl.searchParams.get('resource')).toBe(ctx.f.mcpUrl)
    expect(flow.authorizationUrl.searchParams.get('scope')).toBe('read')
    expect(flow.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(ctx.f.registrations).toHaveLength(1)

    expect(flow.page.status).toBe(200)
    expect(flow.page.headers.get('content-type')).toContain('text/html')
    const csp = flow.page.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/default-src 'none'/)
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    const html = await flow.page.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).toContain('dnt-harness-mcp-oauth')
    expect(html).toContain(JSON.stringify(flow.state))

    expect(flow.completed.status).toBe(200)
    expect(await flow.completed.json()).toEqual({ connected: true })
    expect((await ctx.row())?.oauth).toEqual({ state: 'connected', clientSource: 'registered' })
    expect(ctx.f.tokenRequests[0]?.get('client_id')).toBe('registered-1')
    expect(ctx.f.tokenRequests[0]?.get('redirect_uri')).toBe(`${ctx.base}/api/mcp/oauth/callback`)

    expect((await ctx.api('/mcp/remote/enable')).status).toBe(200)
    expect((await ctx.row())?.status).toBe('ready')

    // A second Connect reuses the registration.
    await connect(ctx)
    expect(ctx.f.registrations).toHaveLength(1)
  })

  it('ignores endpoints, client, and redirect URI sent in the request body', async () => {
    const ctx = await boot()
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    const begun = await ctx.api('/mcp/remote/oauth/begin', {
      authorizationEndpoint: 'https://evil.example/authorize', tokenEndpoint: 'https://evil.example/token',
      clientId: 'evil', redirectUri: 'https://evil.example/callback',
    })
    const url = new URL(((await begun.json()) as { authorizationUrl: string }).authorizationUrl)
    expect(url.origin).toBe(ctx.f.origin)
    expect(url.searchParams.get('client_id')).toBe('registered-1')
    expect(url.searchParams.get('redirect_uri')).toBe(`${ctx.base}/api/mcp/oauth/callback`)
  })

  it('refuses to connect through a non-loopback host name', async () => {
    const ctx = await boot({}, { allowedHosts: ['dev.internal'] })
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    const port = new URL(ctx.base).port
    const answer = await postWithHost(ctx.base, `/api/workspaces/${ctx.wsId}/mcp/remote/oauth/begin`, `dev.internal:${port}`, {})
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toMatchObject({ code: 'loopback_required' })
    expect(ctx.f.registrations).toEqual([])
  })

  it('asks for a client when the provider cannot register one', async () => {
    const ctx = await boot({ registration: false })
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    const answer = await ctx.api('/mcp/remote/oauth/begin', {})
    expect(answer.status).toBe(400)
    expect(await answer.json()).toMatchObject({ code: 'client_required', error: expect.stringContaining(`${ctx.base}/api/mcp/oauth/callback`) })
  })

  it('signs in with a confidential client the user entered', async () => {
    const ctx = await boot({ registration: false })
    await fetch(`${ctx.base}/api/workspaces/${ctx.wsId}/secrets/FIXTURE_SECRET`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'user-secret' }),
    })
    await addOAuthServer(ctx.api, ctx.f.mcpUrl, { clientId: 'user-app', clientSecret: '${FIXTURE_SECRET}', tokenEndpointAuth: 'client_secret_post' })
    const flow = await connect(ctx)
    expect(flow.completed.status).toBe(200)
    expect(ctx.f.tokenRequests[0]?.get('client_secret')).toBe('user-secret')
    expect((await ctx.row())?.oauth).toEqual({ state: 'connected', clientSource: 'manual' })
  })

  it('reports a server that does not use OAuth', async () => {
    const ctx = await boot()
    await addOAuthServer(ctx.api, `${ctx.f.origin}/not-mcp`)
    const answer = await ctx.api('/mcp/remote/oauth/begin', {})
    expect(answer.status).toBe(400)
    expect(await answer.json()).toMatchObject({ code: 'discovery_failed' })
  })

  it('disconnects with the discovered revocation endpoint, ignoring one in the body', async () => {
    const ctx = await boot()
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    await connect(ctx)
    const revoked = await ctx.api('/mcp/remote/oauth/revoke', { revocationEndpoint: 'https://evil.example/revoke' })
    expect(await revoked.json()).toEqual({ local: 'revoked', remote: 'succeeded' })
    expect(ctx.f.revocations).toHaveLength(1)
    expect((await ctx.row())?.oauth?.state).toBe('not_connected')
  })

  it('turns insufficient_scope into needs-sign-in, and Reconnect asks for the union', async () => {
    const ctx = await boot({ prmScopes: ['read'], requiredScope: 'write' })
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    await connect(ctx)
    expect((await ctx.api('/mcp/remote/enable')).ok).toBe(false)
    expect((await ctx.row())?.oauth).toEqual({ state: 'needs_sign_in', missingScope: 'write', clientSource: 'registered' })

    const flow = await connect(ctx)
    expect(flow.authorizationUrl.searchParams.get('scope')).toBe('read write')
    expect((await ctx.api('/mcp/remote/reconnect')).status).toBe(200)
    expect(await ctx.row()).toMatchObject({ status: 'ready', oauth: { state: 'connected' } })
  })

  it('reconnects an enabled server as soon as sign-in completes', async () => {
    const ctx = await boot()
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    await connect(ctx)
    expect((await ctx.api('/mcp/remote/enable')).status).toBe(200)
    await ctx.api('/mcp/remote/oauth/revoke', {})
    await connect(ctx)
    expect(await ctx.row()).toMatchObject({ status: 'ready', oauth: { state: 'connected' } })
  })

  it('forgets the grant when the server is deleted, so a new URL under the same name starts over', async () => {
    const ctx = await boot()
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    await connect(ctx)
    expect((await fetch(`${ctx.base}/api/workspaces/${ctx.wsId}/mcp/remote`, { method: 'DELETE' })).status).toBe(200)
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    expect((await ctx.row())?.oauth).toEqual({ state: 'not_connected' })
  })

  it('does not hand a grant to a server whose URL changed', async () => {
    const ctx = await boot()
    await addOAuthServer(ctx.api, ctx.f.mcpUrl)
    await connect(ctx)
    await addOAuthServer(ctx.api, `${ctx.f.origin}/other-mcp`)
    expect((await ctx.row())?.oauth?.state).toBe('not_connected')
    const enabled = await ctx.api('/mcp/remote/enable')
    expect(enabled.ok).toBe(false)
    expect(await enabled.text()).toContain('auth_required')
  })

  it('serves a plain failure page for an unknown state, with no script', async () => {
    const ctx = await boot()
    const page = await fetch(`${ctx.base}/api/mcp/oauth/callback?state=%3C%2Fscript%3E&code=x`)
    expect(page.status).toBe(400)
    const html = await page.text()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('</script>')
  })
})
