import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpConfigStore, applyMigration, assertBinaryCanOpen, dryRunMigration, planMigration, THIS_BINARY } from 'mini-dsh'

describe('mcp config migration', () => {
  it('quarantines omitted enabled and classifies legacy oauth as an external token', async () => {
    const raw = JSON.stringify({
      version: 1,
      servers: {
        implied: { transport: 'stdio', command: 'node' },
        old: { transport: 'http', url: 'https://example.test/mcp', enabled: true, auth: { type: 'oauth', provider: 'fixture', accessToken: '${TOKEN}' } },
      },
    })
    const dry = dryRunMigration(raw)
    expect(dry.mutated).toBe(false)
    expect(dry.actions.map((action) => action.action)).toEqual(['quarantine-omitted-enabled', 'keep', 'external-token'])
    const plan = planMigration(raw)
    expect(plan.config.servers.implied?.enabled).toBe(false)
    expect(plan.config.servers.old?.auth?.type).toBe('external_token')

    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-migrate-'))
    try {
      const dir = path.join(home, 'workspaces', 'ws')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'mcp.json'), raw)
      await applyMigration(home, 'ws', raw)
      const loaded = await new McpConfigStore(home).loadMcp('ws')
      expect(loaded.version).toBe(2)
      expect(loaded.servers.implied?.enabled).toBe(false)
      expect(loaded.servers.old?.auth?.type).toBe('external_token')
      assertBinaryCanOpen({ configSchema: 2, requiresSafetyKernel: true, minimumBinary: '0.1.0' }, THIS_BINARY)
      expect(() => assertBinaryCanOpen(
        { configSchema: 2, requiresSafetyKernel: true, minimumBinary: '0.1.0' },
        { version: '0.0.1', safetyKernel: false, maxSchema: 1 },
      )).toThrow(/unsafe downgrade/)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

  it('keeps a checksummed backup and a dry-run that does not write', async () => {
    const raw = JSON.stringify({ version: 2, revision: 1, servers: { kept: { transport: 'stdio', command: 'node', enabled: false } } })
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-migrate-v2-'))
    try {
      const first = await applyMigration(home, 'ws', raw)
      expect(first.config.servers.kept?.enabled).toBe(false)
      const again = dryRunMigration(raw)
      expect(again.mutated).toBe(false)
      expect(again.actions).toEqual([])
      const backups = await fs.readdir(path.join(home, 'mcp-backups'))
      expect(backups.length).toBeGreaterThan(0)
      const manifest = JSON.parse(await fs.readFile(path.join(home, 'mcp-backups', backups[0]!, 'manifest.json'), 'utf8')) as { checksum: string }
      expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
