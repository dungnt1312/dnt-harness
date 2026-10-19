import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionId, WorkspaceId } from '../../util/brand.ts'
import type { SessionsService } from '../session/service.ts'
import { sessionModeOf } from '../session/events.ts'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { rootModeRecord } from './root-mode-record.ts'
import { DEFAULT_MODE_ID, type ModesService } from './service.ts'
import type { ResolvedMode } from './types.ts'

interface MigrationResult {
  readonly migrated: number
  readonly skippedChildren: number
  readonly defaultedWorkspaces: readonly string[]
}

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Completion marker version. Bump it whenever the migration's decision logic
 * or the marker's shape changes: an older (or newer, or unreadable) marker is
 * ignored and the next boot rescans every canonical log.
 * 2: each verified entry carries the canonical length it was verified at.
 */
export const ROOT_MODE_MIGRATION_VERSION = 2

/**
 * One session a completed pass resolved: a root holding a mode snapshot, or a
 * child (`child`). Logs are append-only, so the fact stays true for as long as
 * the log is at least `lastSeq` long. A shorter log (restored from a backup,
 * truncated, deleted) is read again.
 */
interface VerifiedSession {
  readonly id: string
  readonly lastSeq: number
  readonly child?: true
}

interface MigrationMarker {
  readonly version: number
  readonly completedAt: number
  /**
   * A session absent from this list (created later by a path that stamps no
   * snapshot, forked from a legacy root, or written by an older host) is read.
   */
  readonly verified: readonly VerifiedSession[]
}

const isVerifiedSession = (entry: unknown): entry is VerifiedSession => {
  if (entry === null || typeof entry !== 'object') return false
  const { id, lastSeq, child } = entry as Record<string, unknown>
  return typeof id === 'string' && typeof lastSeq === 'number' && Number.isInteger(lastSeq) && lastSeq >= 1 && (child === undefined || child === true)
}

/** A current marker's entries by id; undefined means "scan everything". */
async function readMarker(file: string): Promise<ReadonlyMap<string, VerifiedSession> | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<MigrationMarker>
    if (record.version !== ROOT_MODE_MIGRATION_VERSION || !Array.isArray(record.verified)) return undefined
    return new Map(record.verified.filter(isVerifiedSession).map((entry) => [entry.id, entry]))
  } catch {
    // Missing or unreadable: derived state only, so fall back to a full scan.
    return undefined
  }
}

const lastSeqOf = (events: readonly { readonly seq: number }[]): number => events.at(-1)?.seq ?? 0

/**
 * A data-home startup migration. Call after SessionsService.boot() but before
 * the HTTP listener begins accepting requests. The host already holds the
 * data-home ownership lock; no second process may append concurrently.
 * A stopped migration resumes by checking the canonical session/mode record,
 * never by trusting a derived checkpoint alone.
 *
 * The one derived record it does trust is an unloaded session's summary, and
 * only in the direction logs cannot undo: boot reconciled that summary with
 * the canonical tail (or rebuilt it from the log), so `modeFacts` saying the
 * log holds a child-meta or a mode record is what the canonical read would
 * find. A missing, older or negative fact still reads the canonical log, and
 * only that path writes.
 *
 * After a pass completes, `root-mode-migration.json` in the data home records
 * the sessions it resolved; later boots read only sessions outside that set.
 * A pass that throws leaves the previous marker (if any) untouched.
 */
export async function migrateRootModes(
  home: string,
  sessions: SessionsService,
  modes: ModesService,
  defaultMode: (workspaceId: WorkspaceId) => ResolvedMode,
): Promise<MigrationResult> {
  const backupDir = path.join(home, 'root-mode-backups')
  const markerFile = path.join(home, 'root-mode-migration.json')
  const previouslyVerified = await readMarker(markerFile)
  const verified: VerifiedSession[] = []
  let examined = 0
  const snapshots = new Map<WorkspaceId, ResolvedMode>()
  const defaultedWorkspaces = new Set<string>()
  let migrated = 0
  let skippedChildren = 0

  for (const summary of sessions.summaries()) {
    const id = summary.id as SessionId
    const workspaceId = sessions.workspaceOf(id)
    if (workspaceId === undefined) continue
    const known = previouslyVerified?.get(id)
    // The summary's lastSeq was reconciled with the canonical tail in
    // SessionsService.boot(), so a log shorter than verified shows up here.
    if (known !== undefined && summary.lastSeq >= known.lastSeq) {
      if (known.child === true) skippedChildren += 1
      verified.push(known)
      continue
    }
    examined += 1
    const durable = sessions.durableSummary(id)
    if (durable?.modeFacts?.child === true) {
      skippedChildren += 1
      verified.push({ id, lastSeq: durable.lastSeq, child: true })
      continue
    }
    if (durable?.modeFacts?.hasMode === true) {
      verified.push({ id, lastSeq: durable.lastSeq })
      continue
    }
    // Canonical reads (rather than summary projections) decide both child
    // identity and whether a previous interrupted attempt already landed.
    const events = await sessions.readCanonicalEvents(id)
    if (events === undefined) throw new Error(`root-mode migration: no canonical log for '${id}'`)
    if (events.some((event) => event.type === 'session/child-meta')) {
      skippedChildren += 1
      verified.push({ id, lastSeq: lastSeqOf(events), child: true })
      continue
    }
    if (sessionModeOf(events) !== undefined) {
      verified.push({ id, lastSeq: lastSeqOf(events) })
      continue
    }
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
      session.append(rootModeRecord(selected, 1))
      await session.durable()
      migrated += 1
    }
    await replaceFileAtomic(manifestFile, JSON.stringify({ v: 1, sessionId: id, workspaceId, originalSha256: digest(await fs.readFile(backupFile)), completed: true }))
    verified.push({ id, lastSeq: lastSeqOf(session.events) })
  }
  // Rewrite only when the set changed: no current marker, a new session was
  // resolved, or a verified one no longer exists.
  if (previouslyVerified === undefined || examined > 0 || verified.length !== previouslyVerified.size) {
    const marker: MigrationMarker = { version: ROOT_MODE_MIGRATION_VERSION, completedAt: Date.now(), verified }
    await replaceFileAtomic(markerFile, JSON.stringify(marker))
  }
  return { migrated, skippedChildren, defaultedWorkspaces: [...defaultedWorkspaces] }
}
