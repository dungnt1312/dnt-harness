/**
 * Move a v1 mcp.json to v2 without changing what an unmigrated file means.
 * Omitted `enabled` is quarantined off. A legacy oauth block becomes an
 * external token reference, not a managed OAuth session.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { McpConfigError, parseMcpConfig, type McpConfig, type McpServerConfig } from './config.ts'
import { hashServers, parseV2McpConfig } from './config-v2.ts'

export interface CompatibilityMarker {
  readonly configSchema: number
  readonly requiresSafetyKernel: boolean
  readonly minimumBinary: string
}

export interface BinaryIdentity {
  readonly version: string
  readonly safetyKernel: boolean
  readonly maxSchema: number
}

/** This build understands the no-replay journal and the v2 reader. */
export const THIS_BINARY: BinaryIdentity = { version: '0.1.0', safetyKernel: true, maxSchema: 2 }

export const MIGRATION_STEPS = [
  'validated',
  'backup_written',
  'backup_verified',
  'mutation_started',
  'artifacts_committed',
  'migration_committed',
] as const

export type MigrationStep = typeof MIGRATION_STEPS[number]

export interface MigrationAction {
  readonly server: string
  readonly action: 'keep' | 'quarantine-omitted-enabled' | 'external-token'
  readonly detail: string
}

export interface MigrationPlan {
  readonly actions: readonly MigrationAction[]
  readonly config: McpConfig
}

export function planMigration(raw: string): MigrationPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new McpConfigError('invalid', `mcp.json is not valid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigError('invalid', 'mcp.json must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record['version'] === 2) {
    return { actions: [], config: parseV2McpConfig(raw) }
  }
  const v1 = parseMcpConfig(raw)
  const serversRaw = record['servers'] as Record<string, unknown>
  const servers: Record<string, McpServerConfig> = {}
  const actions: MigrationAction[] = []
  for (const [name, server] of Object.entries(v1.servers)) {
    const source = serversRaw[name]
    const sourceRecord = source !== null && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : {}
    let next: McpServerConfig = { ...server }
    if (!Object.prototype.hasOwnProperty.call(sourceRecord, 'enabled')) {
      next = { ...next, enabled: false }
      actions.push({ server: name, action: 'quarantine-omitted-enabled', detail: 'omitted enabled is quarantined disabled; v1 would have treated it as on' })
    } else {
      actions.push({ server: name, action: 'keep', detail: next.enabled ? 'explicitly enabled' : 'explicitly disabled' })
    }
    if (next.auth?.type === 'oauth') {
      next = { ...next, auth: { type: 'external_token', provider: next.auth.provider, accessToken: next.auth.accessToken } }
      actions.push({ server: name, action: 'external-token', detail: 'legacy oauth reference is an external token, not managed OAuth' })
    }
    servers[name] = next
  }
  return {
    actions,
    config: { version: 2, revision: 1, contentHash: hashServers(servers), servers },
  }
}

export function assertBinaryCanOpen(marker: CompatibilityMarker, binary: BinaryIdentity = THIS_BINARY): void {
  if (marker.configSchema > binary.maxSchema || (marker.requiresSafetyKernel && !binary.safetyKernel)) {
    throw new Error(`unsafe downgrade refused: schema ${marker.configSchema} requires the safety kernel`)
  }
}

export async function readCompatibilityMarker(home: string): Promise<CompatibilityMarker | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(home, 'mcp-compatibility.json'), 'utf8')) as Partial<CompatibilityMarker>
    if (typeof parsed.configSchema !== 'number' || typeof parsed.requiresSafetyKernel !== 'boolean' || typeof parsed.minimumBinary !== 'string') {
      throw new Error('mcp-compatibility.json is malformed')
    }
    return { configSchema: parsed.configSchema, requiresSafetyKernel: parsed.requiresSafetyKernel, minimumBinary: parsed.minimumBinary }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function assertSchemaFloor(home: string, binary: BinaryIdentity = THIS_BINARY): Promise<void> {
  const marker = await readCompatibilityMarker(home)
  if (marker !== undefined) assertBinaryCanOpen(marker, binary)
}

export interface DryRunReport {
  readonly mutated: false
  readonly actions: readonly MigrationAction[]
  readonly bytes: number
}

/** Classify the file. Does not write config, secrets, or the network. */
export function dryRunMigration(raw: string): DryRunReport {
  const plan = planMigration(raw)
  return { mutated: false, actions: plan.actions, bytes: Buffer.byteLength(raw) }
}

export async function applyMigration(home: string, workspaceId: string, raw: string): Promise<MigrationPlan> {
  const plan = planMigration(raw)
  if (plan.actions.length === 0 && raw.includes('"version": 2')) return plan
  const dir = path.join(home, 'workspaces', workspaceId)
  const target = path.join(dir, 'mcp.json')
  const backupDir = path.join(home, 'mcp-backups', `${workspaceId}-${Date.now()}`)
  await fs.mkdir(backupDir, { recursive: true })
  const backupFile = path.join(backupDir, 'mcp.json')
  await fs.writeFile(backupFile, raw, { mode: 0o600 })
  const checksum = createHash('sha256').update(raw).digest('hex')
  await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify({ checksum, steps: MIGRATION_STEPS }, null, 2))
  const readBack = await fs.readFile(backupFile, 'utf8')
  if (createHash('sha256').update(readBack).digest('hex') !== checksum) {
    throw new Error('migration backup checksum does not match')
  }
  const journal = path.join(backupDir, 'steps.json')
  const steps: MigrationStep[] = ['validated', 'backup_written', 'backup_verified', 'mutation_started']
  await fs.writeFile(journal, JSON.stringify(steps))
  await fs.mkdir(dir, { recursive: true })
  const next = `${JSON.stringify(plan.config, null, 2)}\n`
  await fs.writeFile(target, next, { mode: 0o600 })
  steps.push('artifacts_committed', 'migration_committed')
  await fs.writeFile(journal, JSON.stringify(steps))
  const marker: CompatibilityMarker = { configSchema: 2, requiresSafetyKernel: true, minimumBinary: THIS_BINARY.version }
  await fs.writeFile(path.join(home, 'mcp-compatibility.json'), `${JSON.stringify(marker, null, 2)}\n`)
  return plan
}
