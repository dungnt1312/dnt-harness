import { describe, expect, it } from 'vitest'
import { OAuthConnectError } from '../../src/harness/mcp/oauth-discovery.ts'
import { parseOAuthOrigins, resolveRedirect } from '../../src/web/mcp-oauth-connect.ts'

const origins = ['https://harness.example.com']

describe('parseOAuthOrigins', () => {
  it('keeps https origins, lowercased, without a trailing slash or path', () => {
    expect(parseOAuthOrigins(['https://Harness.Example.com/', 'https://other.example.com:8443'])).toEqual(['https://harness.example.com', 'https://other.example.com:8443'])
  })

  it('drops duplicates and blanks', () => {
    expect(parseOAuthOrigins(['https://a.example.com', 'https://a.example.com/', '  '])).toEqual(['https://a.example.com'])
  })

  it('refuses anything that is not an https origin', () => {
    expect(() => parseOAuthOrigins(['http://harness.example.com'])).toThrow(/https/)
    expect(() => parseOAuthOrigins(['harness.example.com'])).toThrow(/not a URL|https/)
    expect(() => parseOAuthOrigins(['https://harness.example.com/app'])).toThrow(/path/)
    expect(() => parseOAuthOrigins(['https://user:pw@harness.example.com'])).toThrow(/credentials|userinfo/)
  })

  it('refuses http even for localhost: loopback is already allowed without it', () => {
    expect(() => parseOAuthOrigins(['http://localhost:3082'])).toThrow(/https/)
  })
})

describe('resolveRedirect', () => {
  it('uses the request host for loopback', () => {
    expect(resolveRedirect('127.0.0.1:3082', 3082, origins)).toEqual({ mode: 'loopback', redirectUri: 'http://127.0.0.1:3082/api/mcp/oauth/callback' })
    expect(resolveRedirect('localhost:3082', 3082, [])).toEqual({ mode: 'loopback', redirectUri: 'http://localhost:3082/api/mcp/oauth/callback' })
    expect(resolveRedirect('[::1]:3082', 3082, [])).toEqual({ mode: 'loopback', redirectUri: 'http://[::1]:3082/api/mcp/oauth/callback' })
  })

  it('uses the declared origin when the request host matches it', () => {
    expect(resolveRedirect('harness.example.com', 3082, origins)).toEqual({ mode: 'origin', redirectUri: 'https://harness.example.com/api/mcp/oauth/callback' })
    expect(resolveRedirect('HARNESS.example.com', 3082, origins).mode).toBe('origin')
  })

  it('matches a declared origin that carries a port', () => {
    expect(resolveRedirect('harness.example.com:8443', 3082, ['https://harness.example.com:8443'])).toEqual({ mode: 'origin', redirectUri: 'https://harness.example.com:8443/api/mcp/oauth/callback' })
    expect(resolveRedirect('harness.example.com', 3082, ['https://harness.example.com:8443']).mode).toBe('paste')
  })

  it('falls back to the bound loopback port, to be pasted back, for any other host', () => {
    expect(resolveRedirect('100.120.204.10', 3082, origins)).toEqual({ mode: 'paste', redirectUri: 'http://127.0.0.1:3082/api/mcp/oauth/callback' })
    expect(resolveRedirect('dungnts-mac-mini', 4000, [])).toEqual({ mode: 'paste', redirectUri: 'http://127.0.0.1:4000/api/mcp/oauth/callback' })
    expect(resolveRedirect(undefined, 3082, origins).mode).toBe('paste')
  })

  it('never echoes a hostile Host header into the redirect', () => {
    const resolved = resolveRedirect('evil.example/..', 3082, origins)
    expect(resolved).toEqual({ mode: 'paste', redirectUri: 'http://127.0.0.1:3082/api/mcp/oauth/callback' })
    expect(() => { throw new OAuthConnectError('discovery_failed', 'unused') }).toThrow()
  })
})
