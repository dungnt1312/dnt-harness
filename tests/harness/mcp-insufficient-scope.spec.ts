import { afterEach, describe, expect, it } from 'vitest'
import { McpServerClient } from '../../src/harness/mcp/client.ts'
import { McpDispatchError } from '../../src/harness/mcp/boundaries.ts'
import { startOAuthFixture, type OAuthFixture } from '../support/oauth-fixture.ts'

let fixture: OAuthFixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

/** A token the fixture granted with `scope`, obtained through its real token endpoint. */
async function tokenWithScope(f: OAuthFixture, scope: string): Promise<string> {
  const response = await fetch(`${f.origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: `code-for-${scope}` }),
  })
  return ((await response.json()) as { access_token: string }).access_token
}

describe('insufficient_scope over Streamable HTTP', () => {
  it('reports the missing scope once and does not refresh', async () => {
    fixture = await startOAuthFixture({ requiredScope: 'write' })
    const token = await tokenWithScope(fixture, 'read')
    let asked = 0
    const reported: Array<string | undefined> = []
    const client = new McpServerClient('remote', { name: 'remote', transport: 'http', url: fixture.mcpUrl, enabled: true }, {
      tokenSource: async (rejected) => { asked += 1; expect(rejected).toBeUndefined(); return token },
      onInsufficientScope: (scope) => { reported.push(scope) },
    }, () => {})
    try {
      const error = await client.listTools().catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(McpDispatchError)
      expect((error as McpDispatchError).receipt).toEqual({ kind: 'not_dispatched', reason: 'insufficient_scope' })
      expect((error as Error).message).toContain('write')
      expect(reported).toEqual(['write'])
      expect(asked).toBe(1)
    } finally {
      await client.disconnect()
    }
  })

  it('still connects when the token carries the scope', async () => {
    fixture = await startOAuthFixture({ requiredScope: 'write' })
    const token = await tokenWithScope(fixture, 'read write')
    const client = new McpServerClient('remote', { name: 'remote', transport: 'http', url: fixture.mcpUrl, enabled: true }, {
      tokenSource: async () => token,
    }, () => {})
    try {
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(['whoami'])
    } finally {
      await client.disconnect()
    }
  })
})
