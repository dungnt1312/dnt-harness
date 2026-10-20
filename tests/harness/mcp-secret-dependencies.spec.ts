import { describe, expect, it } from 'vitest'
import { parseMcpConfig } from '../../src/harness/mcp/config.ts'
import { secretRefsOf, serversUsingSecret } from '../../src/harness/mcp/secret-dependencies.ts'

const config = parseMcpConfig(JSON.stringify({
  version: 1,
  servers: {
    local: { transport: 'stdio', command: '/bin/echo', enabled: true, env: { AUTH: 'Bearer ${API_TOKEN}', PLAIN: 'x', BOTH: '${A}:${B}' } },
    headers: { transport: 'http', url: 'https://example.com/mcp', enabled: false, headers: { 'x-key': 'k-${HEADER_KEY}' } },
    bearer: { transport: 'http', url: 'https://example.com/mcp', enabled: true, auth: { type: 'bearer', token: '${API_TOKEN}' } },
    managed: {
      transport: 'http', url: 'https://example.com/mcp', enabled: true,
      auth: { type: 'managed_oauth', provider: 'example.com', resource: 'https://example.com/mcp', clientId: 'c', clientSecret: '${CLIENT_SECRET}' },
    },
  },
}))

describe('secret dependencies of MCP servers', () => {
  it('finds references in env, headers, static auth and a managed OAuth client secret, whole or embedded', () => {
    expect([...secretRefsOf(config.servers['local']!)].sort()).toEqual(['A', 'API_TOKEN', 'B'])
    expect([...secretRefsOf(config.servers['headers']!)]).toEqual(['HEADER_KEY'])
    expect([...secretRefsOf(config.servers['bearer']!)]).toEqual(['API_TOKEN'])
    expect([...secretRefsOf(config.servers['managed']!)]).toEqual(['CLIENT_SECRET'])
  })

  it('lists the servers that read one secret, optionally only the enabled ones', () => {
    expect(serversUsingSecret(config, 'API_TOKEN')).toEqual(['local', 'bearer'])
    expect(serversUsingSecret(config, 'HEADER_KEY')).toEqual(['headers'])
    expect(serversUsingSecret(config, 'HEADER_KEY', { enabledOnly: true })).toEqual([])
    expect(serversUsingSecret(config, 'API')).toEqual([])
  })
})
