import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpConfigStore, MIGRATION_STEPS, applyMigration, assertBinaryCanOpen, dryRunMigration, planMigration, recoverMigrations, THIS_BINARY } from 'dnt-harness'

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

    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-migrate-'))
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

describe('interrupted migration recovery', () => {
  const v1 = JSON.stringify({ version: 1, servers: { implied: { transport: 'stdio', command: 'node' } } })

  // Every durable boundary before commit; the host "dies" right after each.
  for (const crashAfter of MIGRATION_STEPS.filter((step) => step !== 'migration_committed')) {
    it(`a crash after '${crashAfter}' recovers to a readable config and never leaves an old binary able to open v2`, async () => {
      const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-migrate-crash-'))
      try {
        const target = path.join(home, 'workspaces', 'ws', 'mcp.json')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, v1)
        await expect(applyMigration(home, 'ws', v1, (step) => {
          if (step === crashAfter) throw new Error('host died')
        })).rejects.toThrow('host died')

        const reached = MIGRATION_STEPS.indexOf(crashAfter)
        const touchedTarget = reached >= MIGRATION_STEPS.indexOf('mutation_started')
        const settled = await recoverMigrations(home)
        expect(settled.map((entry) => entry.outcome)).toEqual([touchedTarget ? 'rolled_back' : 'abandoned'])
        // The unmigrated v1 file is back, byte for byte, and still loads.
        expect(await fs.readFile(target, 'utf8')).toBe(v1)
        expect((await new McpConfigStore(home).loadMcp('ws')).servers.implied).toBeDefined()
        // Once the target may have changed, the marker already refuses old binaries.
        const marker = await fs.readFile(path.join(home, 'mcp-compatibility.json'), 'utf8').catch(() => undefined)
        expect(marker !== undefined).toBe(touchedTarget)
        // Idempotent: a second restart settles nothing.
        expect(await recoverMigrations(home)).toEqual([])
        // And the migration can run again cleanly.
        await applyMigration(home, 'ws', v1)
        expect((await new McpConfigStore(home).loadMcp('ws')).version).toBe(2)
      } finally {
        await fs.rm(home, { recursive: true, force: true })
      }
    })
  }

  it('refuses to restore a backup whose checksum no longer matches', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-migrate-tamper-'))
    try {
      const target = path.join(home, 'workspaces', 'ws', 'mcp.json')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, v1)
      await expect(applyMigration(home, 'ws', v1, (step) => {
        if (step === 'artifacts_committed') throw new Error('host died')
      })).rejects.toThrow()
      const [backup] = await fs.readdir(path.join(home, 'mcp-backups'))
      await fs.writeFile(path.join(home, 'mcp-backups', backup!, 'mcp.json'), '{"version":1,"servers":{}}')
      await expect(recoverMigrations(home)).rejects.toThrow(/fails its checksum/)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

  it('keeps a checksummed backup and a dry-run that does not write', async () => {
    const v2 = JSON.stringify({ version: 2, revision: 1, servers: { kept: { transport: 'stdio', command: 'node', enabled: false } } })
    const v1 = JSON.stringify({ version: 1, servers: { kept: { transport: 'stdio', command: 'node', enabled: false } } })
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-migrate-v2-'))
    try {
      // Already v2: nothing to migrate, so nothing is written or backed up.
      const first = await applyMigration(home, 'ws', v2)
      expect(first.config.servers.kept?.enabled).toBe(false)
      await expect(fs.stat(path.join(home, 'mcp-backups'))).rejects.toThrow()
      const again = dryRunMigration(v2)
      expect(again.mutated).toBe(false)
      expect(again.actions).toEqual([])

      await applyMigration(home, 'ws', v1)
      const backups = await fs.readdir(path.join(home, 'mcp-backups'))
      expect(backups.length).toBeGreaterThan(0)
      const manifest = JSON.parse(await fs.readFile(path.join(home, 'mcp-backups', backups[0]!, 'manifest.json'), 'utf8')) as { checksum: string }
      expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
