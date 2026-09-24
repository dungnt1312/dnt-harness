/**
 * Move a v1 mcp.json to v2 without changing what an unmigrated file means.
 * Omitted `enabled` is quarantined off. A legacy oauth block becomes an
 * external token reference, not a managed OAuth session.
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
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

interface MigrationManifest {
  readonly workspaceId: string
  readonly target: string
  readonly checksum: string
}

/**
 * Observes each durable boundary as it is reached. Tests throw from it to
 * model a host dying right after that step was persisted.
 */
export type MigrationStepObserver = (step: MigrationStep) => void | Promise<void>

/**
 * Migrate one workspace's mcp.json with a verified backup and a step journal.
 * The compatibility marker is written before the target changes, so an old
 * binary is refused from the first byte of v2 onward; the target is replaced
 * atomically; `recoverMigrations` rolls an interrupted run back to its backup.
 */
export async function applyMigration(home: string, workspaceId: string, raw: string, onStep?: MigrationStepObserver): Promise<MigrationPlan> {
  const plan = planMigration(raw)
  if (plan.actions.length === 0 && isV2(raw)) return plan
  const target = path.join(home, 'workspaces', workspaceId, 'mcp.json')
  await fs.mkdir(path.join(home, 'mcp-backups'), { recursive: true })
  // Unique and never reused: mkdir without `recursive` fails if it exists.
  const backupDir = path.join(home, 'mcp-backups', `${workspaceId}-${Date.now()}-${randomBytes(4).toString('hex')}`)
  await fs.mkdir(backupDir, { mode: 0o700 })
  const steps: MigrationStep[] = []
  const reach = async (step: MigrationStep): Promise<void> => {
    steps.push(step)
    await writeSynced(path.join(backupDir, 'steps.json'), JSON.stringify(steps))
    await onStep?.(step)
  }
  await reach('validated')

  const checksum = sha256(raw)
  await writeSynced(path.join(backupDir, 'mcp.json'), raw, 0o600)
  const manifest: MigrationManifest = { workspaceId, target, checksum }
  await writeSynced(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await reach('backup_written')

  if (sha256(await fs.readFile(path.join(backupDir, 'mcp.json'), 'utf8')) !== checksum) {
    throw new Error('migration backup checksum does not match')
  }
  await reach('backup_verified')

  const marker: CompatibilityMarker = { configSchema: 2, requiresSafetyKernel: true, minimumBinary: THIS_BINARY.version }
  await replaceFileAtomic(path.join(home, 'mcp-compatibility.json'), `${JSON.stringify(marker, null, 2)}\n`)
  await reach('mutation_started')

  await fs.mkdir(path.dirname(target), { recursive: true })
  await replaceFileAtomic(target, `${JSON.stringify(plan.config, null, 2)}\n`)
  await reach('artifacts_committed')
  await reach('migration_committed')
  return plan
}

export interface MigrationRecovery {
  readonly backup: string
  readonly outcome: 'rolled_back' | 'abandoned'
}

/**
 * Settle every migration a crash left unfinished. A run that reached
 * `mutation_started` may have replaced the target, so the verified backup is
 * restored; an earlier one never touched it and is only marked abandoned.
 * Idempotent: settled runs are not revisited. The compatibility marker stays,
 * which errs toward refusing old binaries.
 */
export async function recoverMigrations(home: string): Promise<readonly MigrationRecovery[]> {
  const root = path.join(home, 'mcp-backups')
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const settled: MigrationRecovery[] = []
  for (const name of entries.sort()) {
    const dir = path.join(root, name)
    let steps: string[]
    try {
      steps = JSON.parse(await fs.readFile(path.join(dir, 'steps.json'), 'utf8')) as string[]
    } catch {
      continue
    }
    const last = steps[steps.length - 1]
    if (last === 'migration_committed' || last === 'rolled_back' || last === 'abandoned') continue
    if (!steps.includes('mutation_started')) {
      await writeSynced(path.join(dir, 'steps.json'), JSON.stringify([...steps, 'abandoned']))
      settled.push({ backup: name, outcome: 'abandoned' })
      continue
    }
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as MigrationManifest
    const original = await fs.readFile(path.join(dir, 'mcp.json'), 'utf8')
    if (sha256(original) !== manifest.checksum) throw new Error(`migration backup ${name} fails its checksum; refusing to restore it`)
    await fs.mkdir(path.dirname(manifest.target), { recursive: true })
    await replaceFileAtomic(manifest.target, original)
    await writeSynced(path.join(dir, 'steps.json'), JSON.stringify([...steps, 'rolled_back']))
    settled.push({ backup: name, outcome: 'rolled_back' })
  }
  return settled
}

function isV2(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { version?: unknown }).version === 2
  } catch {
    return false
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function writeSynced(file: string, contents: string, mode?: number): Promise<void> {
  const handle = await fs.open(file, 'w', mode)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
