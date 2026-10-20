import { afterEach, describe, expect, it } from 'vitest'
import { discoverOAuth, OAuthConnectError } from '../../src/harness/mcp/oauth-discovery.ts'
import { resolveClient } from '../../src/harness/mcp/oauth-registration.ts'
import type { OAuthServerRecord } from '../../src/harness/mcp/oauth-store.ts'
import { startOAuthFixture, type OAuthFixture, type OAuthFixtureOptions } from '../support/oauth-fixture.ts'
import { senderHttp } from '../support/outbound-sender.ts'

let fixture: OAuthFixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })
async function discovered(options: OAuthFixtureOptions = {}) {
  fixture = await startOAuthFixture(options)
  return { f: fixture, found: await discoverOAuth(fixture.mcpUrl) }
}
const redirectUri = 'http://127.0.0.1:4317/api/mcp/oauth/callback'

function previousRecord(f: OAuthFixture, redirect: string, issuer = f.origin): OAuthServerRecord {
  return {
    serverUrl: f.mcpUrl, resource: f.mcpUrl, issuer,
    authorizationEndpoint: `${f.origin}/authorize`, tokenEndpoint: `${f.origin}/token`,
    scopes: [], registration: { clientId: 'kept-client', redirectUri: redirect, issuedAt: 1 }, discoveredAt: 1,
  }
}

describe('resolveClient', () => {
  it('rejects an untrusted loopback registration endpoint for a public resource', async () => {
    const { found } = await discovered()
    let called = false
    await expect(resolveClient({ discovered: { ...found, resource: 'https://public.example/mcp', registrationEndpoint: 'http://127.0.0.1:1234/register' }, redirectUri, http: senderHttp(async () => { called = true; return Response.json({}) }) })).rejects.toThrow(/plain HTTP/)
    expect(called).toBe(false)
  })

  it('uses the configured client and never registers', async () => {
    const { f, found } = await discovered()
    const client = await resolveClient({ configured: { clientId: 'mine', tokenEndpointAuth: 'client_secret_post' }, discovered: found, redirectUri })
    expect(client).toEqual({ clientId: 'mine', tokenEndpointAuth: 'client_secret_post' })
    expect(f.registrations).toEqual([])
  })

  it('reuses a registration made for the same issuer and redirect URI', async () => {
    const { f, found } = await discovered()
    const client = await resolveClient({ discovered: found, redirectUri, previous: previousRecord(f, redirectUri) })
    expect(client.clientId).toBe('kept-client')
    expect(f.registrations).toEqual([])
  })

  it('registers a public client with the exact loopback redirect', async () => {
    const { f, found } = await discovered()
    const client = await resolveClient({ discovered: found, redirectUri, now: () => 42 })
    expect(client).toEqual({ clientId: 'registered-1', tokenEndpointAuth: 'none', registration: { clientId: 'registered-1', redirectUri, issuedAt: 42 } })
    expect(f.registrations).toEqual([{
      client_name: 'dnt-harness',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }])
  })

  it('registers again when the port changed or the issuer moved', async () => {
    const { f, found } = await discovered()
    await resolveClient({ discovered: found, redirectUri, previous: previousRecord(f, 'http://127.0.0.1:9999/api/mcp/oauth/callback') })
    await resolveClient({ discovered: found, redirectUri, previous: previousRecord(f, redirectUri, 'https://old-issuer.example') })
    expect(f.registrations).toHaveLength(2)
  })

  it('refuses a registration answer that turns the client confidential', async () => {
    const { found } = await discovered({ registrationReturnsSecret: true })
    const error = await resolveClient({ discovered: found, redirectUri }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OAuthConnectError)
    expect((error as OAuthConnectError).code).toBe('registration_failed')
  })

  it('asks for a client when the provider does not register clients', async () => {
    const { found } = await discovered({ registration: false })
    const error = await resolveClient({ discovered: found, redirectUri }).catch((cause: unknown) => cause) as OAuthConnectError
    expect(error.code).toBe('client_required')
    expect(error.message).toMatch(/does not offer client registration/)
  })

  it('says when registration exists but only for confidential clients, like GitLab', async () => {
    const { found } = await discovered({ tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'] })
    const error = await resolveClient({ discovered: found, redirectUri }).catch((cause: unknown) => cause) as OAuthConnectError
    expect(error.code).toBe('client_required')
    expect(error.message).toMatch(/only confidential clients/)
  })
})
