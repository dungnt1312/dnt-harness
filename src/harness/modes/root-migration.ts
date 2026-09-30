import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionId, WorkspaceId } from '../../util/brand.ts'
import type { SessionsService } from '../session/service.ts'
import { sessionModeOf } from '../session/events.ts'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { DEFAULT_MODE_ID, type ModesService } from './service.ts'
import type { ResolvedMode } from './types.ts'

interface MigrationResult {
  readonly migrated: number
  readonly skippedChildren: number
  readonly defaultedWorkspaces: readonly string[]
}

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/**
 * A data-home startup migration. Call after SessionsService.boot() but before
 * the HTTP listener begins accepting requests. The host already holds the
 * data-home ownership lock; no second process may append concurrently.
 * A stopped migration resumes by checking the canonical session/mode record,
 * never by trusting a derived checkpoint alone.
 */
export async function migrateRootModes(
  home: string,
  sessions: SessionsService,
  modes: ModesService,
  defaultMode: (workspaceId: WorkspaceId) => ResolvedMode,
): Promise<MigrationResult> {
  const backupDir = path.join(home, 'root-mode-backups')
  const snapshots = new Map<WorkspaceId, ResolvedMode>()
  const defaultedWorkspaces = new Set<string>()
  let migrated = 0
  let skippedChildren = 0

  for (const summary of sessions.summaries()) {
    const id = summary.id as SessionId
    const workspaceId = sessions.workspaceOf(id)
    if (workspaceId === undefined) continue
    // Canonical reads (rather than summary projections) decide both child
    // identity and whether a previous interrupted attempt already landed.
    const events = await sessions.readCanonicalEvents(id)
    if (events === undefined) throw new Error(`root-mode migration: no canonical log for '${id}'`)
    if (events.some((event) => event.type === 'session/child-meta')) {
      skippedChildren += 1
      continue
    }
    if (sessionModeOf(events) !== undefined) continue
    let selected = snapshots.get(workspaceId)
    if (selected === undefined) {
      const workspaceDefault = defaultMode(workspaceId)
      try {
        const resolved = await modes.resolve(workspaceId, workspaceDefault.definition.id)
        if ((await modes.disabledIds(workspaceId)).includes(resolved.definition.id)) throw new Error('disabled')
        selected = resolved
      } catch {
        selected = await modes.resolve(workspaceId, DEFAULT_MODE_ID)
        defaultedWorkspaces.add(workspaceId)
      }
      snapshots.set(workspaceId, selected)
    }

    const logPath = path.join(home, 'workspaces', workspaceId, 'sessions', id, 'events.jsonl')
    const original = await fs.readFile(logPath)
    const backupPath = path.join(backupDir, workspaceId, id)
    await fs.mkdir(backupPath, { recursive: true })
    const backupFile = path.join(backupPath, 'events.jsonl')
    const manifestFile = path.join(backupPath, 'manifest.json')
    try {
      const prior = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { originalSha256: string }
      const saved = await fs.readFile(backupFile)
      if (prior.originalSha256 !== digest(saved)) throw new Error('checksum mismatch')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`root-mode migration: backup of '${id}' is invalid: ${String(error)}`)
      }
      await replaceFileAtomic(backupFile, original.toString('utf8'))
      await replaceFileAtomic(manifestFile, JSON.stringify({ v: 1, sessionId: id, workspaceId, originalSha256: digest(original), completed: false }))
    }

    const session = await sessions.load(id)
    // Recovery itself may have appended interrupted-turn records. Only the
    // missing mode fact matters: retries never duplicate it.
    if (sessionModeOf(session.events) === undefined) {
      const snapshot = selected.definition
      session.append({
        type: 'session/mode', modeId: snapshot.id, revision: 1,
        snapshot, source: selected.source, hash: digest(JSON.stringify(snapshot)),
      })
      await session.durable()
      migrated += 1
    }
    await replaceFileAtomic(manifestFile, JSON.stringify({ v: 1, sessionId: id, workspaceId, originalSha256: digest(await fs.readFile(backupFile)), completed: true }))
  }
  return { migrated, skippedChildren, defaultedWorkspaces: [...defaultedWorkspaces] }
}
