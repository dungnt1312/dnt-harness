import { afterEach, describe, expect, it } from 'vitest'
import { discoverOAuth, OAuthConnectError, parseBearerChallenge, resourceCovers } from '../../src/harness/mcp/oauth-discovery.ts'
import { startOAuthFixture, type OAuthFixture, type OAuthFixtureOptions } from '../support/oauth-fixture.ts'

let fixture: OAuthFixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })
async function start(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
  fixture = await startOAuthFixture(options)
  return fixture
}
async function failure(promise: Promise<unknown>): Promise<OAuthConnectError> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(OAuthConnectError)
  return error as OAuthConnectError
}

describe('parseBearerChallenge', () => {
  it('reads quoted and unquoted parameters, case-insensitively', () => {
    expect(parseBearerChallenge('Bearer realm="OAuth", resource_metadata="https://h/.well-known/x", scope="read write"'))
      .toEqual({ resourceMetadata: 'https://h/.well-known/x', scope: 'read write' })
    expect(parseBearerChallenge('bearer error=insufficient_scope, scope=write')).toEqual({ error: 'insufficient_scope', scope: 'write' })
    expect(parseBearerChallenge('Bearer error="invalid_request", error_description="No token, sorry"')).toEqual({ error: 'invalid_request' })
  })

  it('ignores other schemes and an absent header', () => {
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined()
    expect(parseBearerChallenge(null)).toBeUndefined()
  })
})

describe('resourceCovers', () => {
  it('matches after normalising case, default port, and a trailing slash', () => {
    expect(resourceCovers('https://API.example.com:443/mcp/', 'https://api.example.com/mcp')).toBe(true)
    expect(resourceCovers('https://api.githubcopilot.com/mcp', 'https://api.githubcopilot.com/mcp/')).toBe(true)
  })

  it('accepts a resource that is a path prefix at a slash boundary, like Slack', () => {
    expect(resourceCovers('https://mcp.slack.com/mcp', 'https://mcp.slack.com')).toBe(true)
    expect(resourceCovers('https://h.example/mcp-v2', 'https://h.example/mcp')).toBe(false)
  })

  it('refuses another origin', () => {
    expect(resourceCovers('https://h.example/mcp', 'https://evil.example/mcp')).toBe(false)
    expect(resourceCovers('https://h.example/mcp', 'http://h.example/mcp')).toBe(false)
  })
})

describe('discoverOAuth', () => {
  it('follows the challenge to PRM and RFC 8414 metadata', async () => {
    const f = await start({ prmScopes: ['read', 'write'] })
    const found = await discoverOAuth(f.mcpUrl)
    expect(found).toEqual({
      resource: f.mcpUrl,
      issuer: f.origin,
      authorizationEndpoint: `${f.origin}/authorize`,
      tokenEndpoint: `${f.origin}/token`,
      revocationEndpoint: `${f.origin}/revoke`,
      registrationEndpoint: `${f.origin}/register`,
      tokenEndpointAuthMethods: ['none', 'client_secret_post'],
      scopes: ['read', 'write'],
    })
  })

  it('falls back to the well-known PRM when the challenge does not name one', async () => {
    const f = await start({ challengeMetadata: false })
    expect((await discoverOAuth(f.mcpUrl)).issuer).toBe(f.origin)
    expect(f.requests).toContain('GET /.well-known/oauth-protected-resource/mcp')
  })

  it('treats the server origin as the authorization server when there is no PRM, like Atlassian', async () => {
    const f = await start({ challengeMetadata: false, wellKnownPrm: false })
    const found = await discoverOAuth(f.mcpUrl)
    expect(found.issuer).toBe(f.origin)
    expect(found.resource).toBe(f.mcpUrl)
  })

  it('tries RFC 8414 before OpenID for an issuer with a path', async () => {
    const f = await start({ issuerPath: '/tenant', oidcOnly: true })
    const found = await discoverOAuth(f.mcpUrl)
    expect(found.issuer).toBe(`${f.origin}/tenant`)
    const metadataRequests = f.requests.filter((line) => line.includes('/.well-known/o') && !line.includes('protected-resource'))
    expect(metadataRequests).toEqual([
      'GET /.well-known/oauth-authorization-server/tenant',
      'GET /.well-known/openid-configuration/tenant',
    ])
  })

  it('takes scopes from config, then the challenge, then PRM', async () => {
    const f = await start({ challengeScope: 'from-challenge', prmScopes: ['from-prm'] })
    expect((await discoverOAuth(f.mcpUrl)).scopes).toEqual(['from-challenge'])
    expect((await discoverOAuth(f.mcpUrl, { scopes: ['configured'] })).scopes).toEqual(['configured'])
  })

  it('refuses an issuer that does not match the metadata it came from', async () => {
    const f = await start({ issuerOverride: 'https://other.example' })
    const error = await failure(discoverOAuth(f.mcpUrl))
    expect(error.code).toBe('discovery_failed')
    expect(error.message).toMatch(/issuer/)
  })

  it('refuses a resource on another origin', async () => {
    const f = await start({ prmResource: () => 'https://elsewhere.example/mcp' })
    expect((await failure(discoverOAuth(f.mcpUrl))).message).toMatch(/resource/)
  })

  it('refuses an authorization server without S256', async () => {
    const f = await start({ codeChallengeMethods: ['plain'] })
    expect((await failure(discoverOAuth(f.mcpUrl))).message).toMatch(/S256/)
  })

  it('refuses a server that does not ask for authorization', async () => {
    const f = await start()
    const error = await failure(discoverOAuth(`${f.origin}/not-mcp`))
    expect(error.code).toBe('discovery_failed')
    expect(error.message).toMatch(/HTTP 404/)
  })

  it('refuses private-range targets before sending anything', async () => {
    const error = await failure(discoverOAuth('https://10.0.0.5/mcp'))
    expect(error.message).toMatch(/prohibited/)
  })

  it('does not follow redirects and bounds the metadata size', async () => {
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } })) as typeof fetch
    expect((await failure(discoverOAuth('https://mcp.example.com/mcp', { fetchImpl: redirecting }))).message).toMatch(/redirect/)
    let calls = 0
    const huge = (async () => {
      calls += 1
      if (calls === 1) return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/prm"' } })
      return new Response(`{"x":"${'a'.repeat(70_000)}"}`, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    expect((await failure(discoverOAuth('https://mcp.example.com/mcp', { fetchImpl: huge }))).message).toMatch(/too large/)
  })
})
