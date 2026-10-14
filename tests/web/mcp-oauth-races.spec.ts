import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, OAuthStore, type WebServer } from 'dnt-harness'
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

async function boot() {
  fixture = await startOAuthFixture()
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-oauth-races-'))
  web = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
  const ws = ((await (await fetch(`${web.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const url = `${web.url}/api/workspaces/${ws}/mcp/remote`
  const post = (suffix: string, body: unknown = {}) => fetch(`${url}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const save = (resource = fixture!.mcpUrl) => post('', { transport: 'http', url: fixture!.mcpUrl, enabled: false, auth: { type: 'managed_oauth', provider: 'fixture', resource } })
  expect((await save()).status).toBe(201)
  const begin = async () => {
    const response = await post('/oauth/begin')
    expect(response.status).toBe(200)
    const { state, authorizationUrl } = await response.json() as { state: string; authorizationUrl: string }
    const callback = await fixture!.authorize(authorizationUrl)
    expect((await fetch(callback)).status).toBe(200)
    return state
  }
  const store = new OAuthStore(path.join(home, 'oauth'), await fs.readFile(path.join(home, 'oauth.master.key')))
  return { post, save, begin, store, url }
}

describe('OAuth transaction incarnation and publication', () => {
  it('rejects a deposited transaction after Delete and same-name, same-URL recreate', async () => {
    const ctx = await boot()
    const state = await ctx.begin()
    expect((await fetch(ctx.url, { method: 'DELETE' })).status).toBe(200)
    expect((await ctx.save()).status).toBe(201)
    expect((await ctx.post('/oauth/complete', { state })).status).toBe(400)
    expect(await ctx.store.readTokens(((await ctx.store.readTransaction(state))!).workspaceId, 'remote')).toBeUndefined()
  })

  it('rejects a pending transaction after Revoke and accepts a fresh one', async () => {
    const ctx = await boot()
    const old = await ctx.begin()
    expect((await ctx.post('/oauth/revoke')).status).toBe(200)
    expect((await ctx.post('/oauth/complete', { state: old })).status).toBe(400)
    const fresh = await ctx.begin()
    expect((await ctx.post('/oauth/complete', { state: fresh })).status).toBe(200)
  })

  it('rejects an old transaction if OAuth config changes then changes back to the same URL', async () => {
    const ctx = await boot()
    const state = await ctx.begin()
    expect((await ctx.save('http://127.0.0.1/different')).status).toBe(201)
    expect((await ctx.save()).status).toBe(201)
    expect((await ctx.post('/oauth/complete', { state })).status).toBe(400)
  })
})
