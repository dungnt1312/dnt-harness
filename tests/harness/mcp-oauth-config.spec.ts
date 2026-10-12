import { describe, expect, it } from 'vitest'
import { parseMcpConfig } from '../../src/harness/mcp/config.ts'

function parseAuth(auth: Record<string, unknown>) {
  const config = parseMcpConfig(JSON.stringify({
    version: 1,
    servers: { remote: { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', enabled: false, auth } },
  }))
  return config.servers['remote']?.auth
}

const base = { type: 'managed_oauth', provider: 'mcp.example.com', resource: 'https://mcp.example.com/mcp' }

describe('managed_oauth configuration', () => {
  it('accepts a server with no client id: the host registers one', () => {
    expect(parseAuth(base)).toEqual(base)
  })

  it('keeps existing files with a client id valid', () => {
    expect(parseAuth({ ...base, clientId: 'client', scopes: ['read'] })).toEqual({ ...base, clientId: 'client', scopes: ['read'] })
  })

  it('accepts a confidential client whose secret is a reference', () => {
    const auth = { ...base, clientId: 'client', clientSecret: '${GITHUB_OAUTH_SECRET}', tokenEndpointAuth: 'client_secret_post' }
    expect(parseAuth(auth)).toEqual(auth)
  })

  it('refuses a plain client secret', () => {
    expect(() => parseAuth({ ...base, clientId: 'client', clientSecret: 'plain', tokenEndpointAuth: 'client_secret_post' })).toThrow(/clientSecret must reference/)
  })

  it('refuses confidential authentication without both id and secret', () => {
    expect(() => parseAuth({ ...base, clientSecret: '${S}', tokenEndpointAuth: 'client_secret_basic' })).toThrow(/needs clientId and clientSecret/)
    expect(() => parseAuth({ ...base, clientId: 'client', tokenEndpointAuth: 'client_secret_post' })).toThrow(/needs clientId and clientSecret/)
  })

  it('refuses an unknown authentication method, an empty client id, and unknown keys', () => {
    expect(() => parseAuth({ ...base, tokenEndpointAuth: 'private_key_jwt' })).toThrow(/tokenEndpointAuth/)
    expect(() => parseAuth({ ...base, clientId: '' })).toThrow(/clientId/)
    expect(() => parseAuth({ ...base, authorizationEndpoint: 'https://x' })).toThrow(/unknown managed_oauth auth key/)
  })
})
