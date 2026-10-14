import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  snapshotHash,
  validateSnapshot,
  type EffectiveCompactionSnapshot,
} from '../context/compaction-snapshot.ts'
import type { SessionEvent } from '../session/events.ts'
import { syncDirectory } from './events-jsonl.ts'

/** Ids become file names, so only plain tokens are accepted — never a path. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface SnapshotReference {
  readonly id: string
  readonly hash: string
}

/**
 * Sidecar store for effective-compaction snapshots. The session log stays the
 * only authority: a sidecar is a cache that is trusted solely when a durable
 * reference names its exact hash and the log still validates it. Writes are
 * temp → fsync → rename → directory sync, so a reference appended after `put`
 * resolves never points at a partial file.
 */
export class CompactionSnapshotStore {
  private closing = false
  private readonly pending = new Set<Promise<unknown>>()

  /** @param sessionDir trusted per-session directory resolver; never fed user input. */
  constructor(private readonly sessionDir: (sessionId: string) => string) {}

  async put(snapshot: EffectiveCompactionSnapshot): Promise<SnapshotReference> {
    if (this.closing) throw new Error('compaction snapshot store closing')
    if (!SAFE_TOKEN.test(snapshot.id)) throw new Error('invalid snapshot id')
    if (!SAFE_TOKEN.test(snapshot.sessionId)) throw new Error('invalid session id')
    const write = this.write(snapshot)
    this.pending.add(write)
    try {
      return await write
    } finally {
      this.pending.delete(write)
    }
  }

  private async write(snapshot: EffectiveCompactionSnapshot): Promise<SnapshotReference> {
    const dir = this.sessionDir(snapshot.sessionId)
    const target = path.join(dir, `${snapshot.id}.json`)
    const temp = path.join(dir, `.${snapshot.id}.${randomUUID()}.tmp`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const handle = await fs.open(temp, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(snapshot)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
    await syncDirectory(dir)
    return { id: snapshot.id, hash: snapshotHash(snapshot) }
  }

  /**
   * The snapshot named by a durable reference, or undefined when the sidecar is
   * missing, corrupt, tampered, or no longer valid for the log. Never throws
   * for bad content: a bad cache falls back to reconstruction.
   */
  async load(sessionId: string, ref: SnapshotReference, events: readonly SessionEvent[]): Promise<EffectiveCompactionSnapshot | undefined> {
    if (!SAFE_TOKEN.test(sessionId) || !SAFE_TOKEN.test(ref.id)) return undefined
    let parsed: EffectiveCompactionSnapshot
    try {
      parsed = JSON.parse(await fs.readFile(path.join(this.sessionDir(sessionId), `${ref.id}.json`), 'utf8')) as EffectiveCompactionSnapshot
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.id !== ref.id || parsed.sessionId !== sessionId) return undefined
    if (snapshotHash(parsed) !== ref.hash) return undefined
    return validateSnapshot(parsed, events).ok ? parsed : undefined
  }

  /** Remove every snapshot sidecar of the session except `keepIds`; other files are left alone. */
  async prune(sessionId: string, keepIds: ReadonlySet<string>): Promise<void> {
    if (!SAFE_TOKEN.test(sessionId)) return
    const dir = this.sessionDir(sessionId)
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(name)
      if (match === null || keepIds.has(match[1]!)) continue
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
    }
  }

  /** Stop accepting writes and wait for the ones in flight. */
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending])
  }
}
