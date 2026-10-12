/**
 * Signing in from a machine whose browser cannot reach the host's callback:
 * a request through an undeclared host name falls back to the host's own
 * loopback redirect, and the person pastes the final address back. A
 * declared `--oauth-origin` completes on its own instead.
 */
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { startOAuthFixture, type OAuthFixture } from '../support/oauth-fixture.ts'

let web: WebServer | undefined
let fixture: OAuthFixture | undefined
let home = ''
afterEach(async () => {
  await web?.close(); web = undefined
  await fixture?.close(); fixture = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

async function boot(extra: { allowedHosts?: string[]; oauthOrigins?: string[] } = {}) {
  fixture = await startOAuthFixture()
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-paste-'))
  web = await createWebServer({ home, configFile: path.join(home, 'providers.json'), ...extra })
  const base = web.url
  const port = new URL(base).port
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const saved = await fetch(`${base}/api/workspaces/${wsId}/mcp/remote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transport: 'http', url: fixture.mcpUrl, enabled: false, auth: { type: 'managed_oauth', provider: 'fixture', resource: fixture.mcpUrl } }),
  })
  expect(saved.status).toBe(201)
  /** POST under any Host name, the way a request through a proxy arrives. */
  const call = (action: string, body: unknown, host = `127.0.0.1:${port}`) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/workspaces/${wsId}/mcp/remote/oauth/${action}`, method: 'POST',
      headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }))
    })
    req.on('error', reject)
    req.end(payload)
  })
  const row = async () => ((await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()) as Array<{ name: string; status: string; oauth?: { state: string } }>).find((entry) => entry.name === 'remote')
  return { f: fixture, base, port, call, row }
}

describe('MCP OAuth from a host name that is not loopback', () => {
  it('falls back to the host loopback redirect and finishes when the address is pasted back', async () => {
    const ctx = await boot({ allowedHosts: ['mac-mini.tail.example'] })
    const begun = await ctx.call('begin', {}, 'mac-mini.tail.example')
    expect(begun.status).toBe(200)
    expect(begun.json['redirectMode']).toBe('paste')
    const authorizationUrl = begun.json['authorizationUrl'] as string
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${ctx.port}/api/mcp/oauth/callback`)
    expect(ctx.f.registrations[0]?.['redirect_uris']).toEqual([`http://127.0.0.1:${ctx.port}/api/mcp/oauth/callback`])

    // The provider redirects the person's browser to an address it cannot reach; they copy it.
    const landed = await ctx.f.authorize(authorizationUrl)
    const pasted = await ctx.call('complete', { callbackUrl: landed.toString() }, 'mac-mini.tail.example')
    expect(pasted.status).toBe(200)
    expect(pasted.json).toEqual({ connected: true })
    expect((await ctx.row())?.oauth?.state).toBe('connected')
    expect(JSON.stringify(pasted.json)).not.toContain('code-for')
  })

  it('rejects a pasted address that does not belong to the sign-in, without echoing it', async () => {
    const ctx = await boot({ allowedHosts: ['mac-mini.tail.example'] })
    await ctx.call('begin', {}, 'mac-mini.tail.example')
    const bad = await ctx.call('complete', { callbackUrl: `http://127.0.0.1:${ctx.port}/api/mcp/oauth/callback?code=leaky-code&state=nope` }, 'mac-mini.tail.example')
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.json)).not.toContain('leaky-code')
    expect(bad.json['error']).toMatch(/unknown, expired, or already used/)
    expect((await ctx.row())?.oauth?.state).toBe('not_connected')
  })

  it('refuses to complete with neither a state nor an address', async () => {
    const ctx = await boot()
    expect((await ctx.call('complete', {})).status).toBe(400)
  })

  it('still completes on its own through loopback, as before', async () => {
    const ctx = await boot()
    const begun = await ctx.call('begin', {})
    expect(begun.json['redirectMode']).toBe('loopback')
  })

  it('uses a declared https origin as the redirect and completes on its own', async () => {
    const ctx = await boot({ allowedHosts: ['harness.example.com'], oauthOrigins: ['https://harness.example.com'] })
    const begun = await ctx.call('begin', {}, 'harness.example.com')
    expect(begun.json['redirectMode']).toBe('origin')
    const authorizationUrl = new URL(begun.json['authorizationUrl'] as string)
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('https://harness.example.com/api/mcp/oauth/callback')
    expect(ctx.f.registrations[0]?.['redirect_uris']).toEqual(['https://harness.example.com/api/mcp/oauth/callback'])
  })

  it('does not treat an undeclared host as an origin even when it is allowed', async () => {
    const ctx = await boot({ allowedHosts: ['harness.example.com'], oauthOrigins: ['https://other.example.com'] })
    expect((await ctx.call('begin', {}, 'harness.example.com')).json['redirectMode']).toBe('paste')
  })

  it('refuses a declared origin that is not https when the host starts', async () => {
    fixture = undefined
    home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-paste-'))
    await expect(createWebServer({ home, configFile: path.join(home, 'providers.json'), oauthOrigins: ['http://harness.example.com'] })).rejects.toThrow(/must use https/)
  })
})
