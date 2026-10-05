/**
 * The file-backed session store: one directory per session under
 * `<dataDir>/sessions/<id>/` holding the canonical `events.jsonl` and the
 * rebuildable `summary.json` projection.
 *
 * Every session has exactly one writer: appends serialize through a
 * per-session promise chain and each record is written and fsynced before
 * the write resolves. After a write failure the session's writer is
 * *poisoned* — every later append and flush rejects with the original
 * error, because in-memory state can no longer be claimed durable.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionId, WorkspaceId } from '../../util/brand.ts'
import type { SessionEvent } from '../session/events.ts'
import {
  appendEventLine,
  encodeEventLine,
  readEventLog,
  replaceFileAtomic,
  SessionLogError,
} from './events-jsonl.ts'

/** Rebuildable per-session metadata projection (never authoritative). */
export interface SessionSummary {
  readonly id: SessionId
  readonly createdAt: number
  readonly updatedAt: number
  readonly eventCount: number
  readonly lastSeq: number
  /** The last recorded custom title, or null when the title is derived. */
  readonly title: string | null
  /**
   * The title derived from the first user message, or null when the log holds
   * no user message yet. Derived, not authored: rebuilt from `events.jsonl`,
   * which is why a restart cannot lose it. Absent in summaries written before
   * derived titles were projected; those rebuild at boot.
   */
  readonly derivedTitle?: string | null
  /** The last recorded project binding; null is an explicit unbind. Absent v1 summaries rebuild. */
  readonly projectId?: string | null
  /** The last recorded pin state. Absent in summaries written before pinning; those rebuild. */
  readonly pinned?: boolean
  /**
   * Set when the log carries `session/child-meta`: this session is a subagent
   * of that parent. Null for user-owned conversations. Absent in summaries
   * written before subagent listing; those rebuild.
   */
  readonly parentSessionId?: string | null
}

/** Storage seam behind `SessionsService`; file-backed in production. */
export interface SessionStore {
  /** Eagerly create/validate the data root; hosts await it at startup. */
  init?(): Promise<void>
  /** Durable-append one stamped event; resolves after the record is synced. */
  append(id: SessionId, event: SessionEvent, options?: AppendOptions): Promise<void>
  /**
   * Sync every deferred record of this session. With only strict appends the
   * session is already durable and this resolves immediately. Must exist
   * whenever `append()` accepts a relaxed option — a caller deferring syncs
   * has no other way to name the barrier.
   */
  checkpoint?(id: SessionId): Promise<void>
  /** Resolve once every queued append for the session is synced. */
  flush(id: SessionId): Promise<void>
  /** Load the full log (tail-repairing a torn final record). */
  read(id: SessionId): Promise<{ events: SessionEvent[]; truncatedTail: boolean }>
  /** Replace the whole log (fork startup): atomic validated rewrite. */
  replace(id: SessionId, events: readonly SessionEvent[]): Promise<void>
  /** Rewrite the summary projection. */
  writeSummary(id: SessionId, summary: SessionSummary): Promise<void>
  /** Read the summary projection; undefined when the session is unknown. */
  readSummary(id: SessionId): Promise<SessionSummary | undefined>
  /** Read only the canonical log tail sequence for stale-summary detection. */
  readLastSeq?(id: SessionId): Promise<number>
  /** Ids of every stored session. */
  list(): Promise<SessionId[]>
  /** Remove the session directory entirely. */
  remove(id: SessionId): Promise<void>
  /** Close owned file handles during host shutdown. */
  close?(): Promise<void>
}

/** Append options: `relaxed` defers the fsync to the next `checkpoint()`. */
export interface AppendOptions {
  /**
   * Write without syncing. High-frequency records (streaming chunks) batch
   * their durability into the next `checkpoint()` instead of paying one fsync
   * per line; the data is still written to the file in order. Omitted means
   * the record syncs before `append()` resolves.
   */
  readonly relaxed?: boolean
}

/** Options for the file-backed store. */
export interface FileSessionStoreOptions {
  /** The one writable data root this process owns. */
  readonly dir: string
  /**
   * Workspace scoping: sessions live under `<dir>/workspaces/<ws>/sessions/`.
   * Omitted stores directly under `<dir>/sessions/` (tests, migration).
   */
  readonly workspaceId?: WorkspaceId
}

const SUMMARY_SCHEMA_VERSION = 1

export class FileSessionStore implements SessionStore {
  private readonly sessionsDir: string
  private readonly workspaceId: WorkspaceId | undefined
  private readonly handles = new Map<SessionId, fs.FileHandle>()
  private readonly writers = new Map<SessionId, Promise<void>>()
  /** Sessions whose relaxed appends are written but not yet synced. */
  private readonly dirty = new Set<SessionId>()
  private closed = false

  constructor(options: FileSessionStoreOptions) {
    this.workspaceId = options.workspaceId
    this.sessionsDir = options.workspaceId === undefined
      ? path.join(options.dir, 'sessions')
      : path.join(options.dir, 'workspaces', options.workspaceId, 'sessions')
  }

  /** Create the data root eagerly so boot failures surface at startup. */
  async init(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true })
  }

  async append(id: SessionId, event: SessionEvent, options?: AppendOptions): Promise<void> {
    if (this.closed) throw new Error('session store is closed')
    const line = encodeEventLine(event)
    const previous = this.writers.get(id) ?? Promise.resolve()
    // The chain carries rejections: once a record fails, every later write
    // for this session fails with the first error (the writer is poisoned —
    // memory can no longer be claimed durable), and flush() surfaces it.
    // A relaxed append only writes; its sync joins the session's next
    // checkpoint, where one fsync batches the whole written prefix.
    const relaxed = options?.relaxed === true
    if (relaxed) this.dirty.add(id)
    const next = previous.then(() => this.writeRecord(id, line, relaxed))
    void next.catch(() => {})
    this.writers.set(id, next)
    // A settled, healthy chain carries nothing; drop it so the map does not
    // grow with every session written. A failed chain stays (poisoned).
    void next.then(() => { if (this.writers.get(id) === next) this.writers.delete(id) }, () => {})
    await next
  }

  /**
   * Sync the session's written-but-unsynced prefix. Strict appends never
   * leave the session dirty, so this is usually a no-op; after relaxed
   * appends it is the one fsync that makes the whole prefix durable.
   */
  async checkpoint(id: SessionId): Promise<void> {
    if (!this.dirty.has(id)) return
    await this.flush(id)
  }

  /**
   * Run `fn` with the session's log to itself: it waits for queued appends
   * and later appends wait for it. Reads and repairs must not interleave
   * with an append — a read that saw a half-written line would "repair"
   * (truncate) a record that is about to be acknowledged as durable.
   * A failure before this point keeps poisoning later appends.
   */
  private exclusive<T>(id: SessionId, fn: () => Promise<T>): Promise<T> {
    const previous = this.writers.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(fn)
    const chain = previous.then(() => result.then(() => {}, () => {}))
    void chain.catch(() => {})
    this.writers.set(id, chain)
    void chain.then(() => { if (this.writers.get(id) === chain) this.writers.delete(id) }, () => {})
    return result
  }

  async flush(id: SessionId): Promise<void> {
    // Draining the writer chain settles every queued append; the sync below
    // then covers whatever the prefix carried — a relaxed batch, or nothing
    // new when every record already synced itself.
    await this.writers.get(id)
    if (this.dirty.has(id)) {
      const handle = await this.openAppend(id)
      try {
        await handle.sync()
        this.dirty.delete(id)
      } catch (error) {
        throw error
      }
    }
  }

  private async writeRecord(id: SessionId, line: string, relaxed: boolean): Promise<void> {
    const handle = await this.openAppend(id)
    await appendEventLine(handle, line, relaxed ? { relaxed: true } : undefined)
  }

  async read(id: SessionId): Promise<{ events: SessionEvent[]; truncatedTail: boolean }> {
    this.assertSafeId(id)
    // Reads, repairs, replacements, and removals hold the writer chain: a
    // torn-tail repair or handle close must never race an in-flight append.
    return this.exclusive(id, async () => {
      await this.closeHandle(id)
      try {
        return await readEventLog(this.eventsPath(id))
      } catch (error) {
        if (error instanceof SessionLogError) throw error
        throw new SessionLogError('io', `cannot read session '${id}': ${String(error)}`)
      }
    })
  }

  async replace(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    this.assertSafeId(id)
    await this.exclusive(id, async () => {
      await this.closeHandle(id)
      await fs.mkdir(this.sessionDir(id), { recursive: true })
      const body = events.map((event) => encodeEventLine(event)).join('')
      await replaceFileAtomic(this.eventsPath(id), body)
    })
  }

  async writeSummary(id: SessionId, summary: SessionSummary): Promise<void> {
    this.assertSafeId(id)
    await fs.mkdir(this.sessionDir(id), { recursive: true })
    const body = `${JSON.stringify({ v: SUMMARY_SCHEMA_VERSION, ...summary }, null, 2)}\n`
    await replaceFileAtomic(this.summaryPath(id), body)
  }

  async readSummary(id: SessionId): Promise<SessionSummary | undefined> {
    this.assertSafeId(id)
    try {
      const raw = await fs.readFile(this.summaryPath(id), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (
        parsed['v'] !== SUMMARY_SCHEMA_VERSION ||
        parsed['id'] !== id ||
        !Number.isFinite(parsed['createdAt']) ||
        !Number.isFinite(parsed['updatedAt']) ||
        !Number.isInteger(parsed['eventCount']) ||
        !Number.isInteger(parsed['lastSeq']) ||
        (parsed['title'] !== null && typeof parsed['title'] !== 'string') ||
        (parsed['derivedTitle'] !== undefined && parsed['derivedTitle'] !== null && typeof parsed['derivedTitle'] !== 'string') ||
        (parsed['projectId'] !== undefined && parsed['projectId'] !== null && typeof parsed['projectId'] !== 'string') ||
        (parsed['pinned'] !== undefined && typeof parsed['pinned'] !== 'boolean') ||
        (parsed['parentSessionId'] !== undefined && parsed['parentSessionId'] !== null && typeof parsed['parentSessionId'] !== 'string')
      ) return undefined
      return {
        id,
        createdAt: parsed['createdAt'] as number,
        updatedAt: parsed['updatedAt'] as number,
        eventCount: parsed['eventCount'] as number,
        lastSeq: parsed['lastSeq'] as number,
        title: parsed['title'] as string | null,
        // Absent means the summary predates derived titles, so boot rebuilds it
        // from the canonical log rather than reporting a lose-it-on-restart gap.
        ...(parsed['derivedTitle'] !== undefined
          ? { derivedTitle: parsed['derivedTitle'] as string | null }
          : {}),
        // v1 summaries written before project bindings were projected are
        // accepted but marked incomplete so boot rebuilds them from the log.
        ...(parsed['projectId'] !== undefined
          ? { projectId: parsed['projectId'] as string | null }
          : {}),
        ...(parsed['pinned'] !== undefined ? { pinned: parsed['pinned'] as boolean } : {}),
        // Absent means the summary predates subagent listing; boot rebuilds it.
        ...(parsed['parentSessionId'] !== undefined
          ? { parentSessionId: parsed['parentSessionId'] as string | null }
          : {}),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Inspect the last canonical record without materializing full history.
   * A stale or malformed tail reports -1, making callers rebuild from the
   * authoritative log rather than trust a projection.
   */
  async readLastSeq(id: SessionId): Promise<number> {
    this.assertSafeId(id)
    return this.exclusive(id, () => this.readLastSeqNow(id))
  }

  private async readLastSeqNow(id: SessionId): Promise<number> {
    await this.closeHandle(id)
    try {
      const handle = await fs.open(this.eventsPath(id), 'r')
      try {
        const { size } = await handle.stat()
        if (size === 0) return 0
        const length = Math.min(size, 64 * 1024)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, size - length)
        const lines = buffer.toString('utf8').trimEnd().split('\n')
        const last = lines.at(-1)
        if (last === undefined || last === '') return 0
        const parsed: unknown = JSON.parse(last)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return -1
        const seq = (parsed as Record<string, unknown>)['seq']
        return typeof seq === 'number' && Number.isInteger(seq) && seq >= 1 ? seq : -1
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      return -1
    }
  }

  async list(): Promise<SessionId[]> {
    let entries
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
      .map((entry) => entry.name as SessionId)
      .sort()
  }

  async remove(id: SessionId): Promise<void> {
    this.assertSafeId(id)
    await this.exclusive(id, async () => {
      await this.closeHandle(id)
      // The log is gone: a deferred sync must not recreate its directory.
      this.dirty.delete(id)
      await fs.rm(this.sessionDir(id), { recursive: true, force: true })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    // Store callers normally drain at the service boundary; retain this guard
    // for direct store users so no pending append races handle closure.
    await Promise.allSettled([...this.writers.values()])
    // A deferred batch syncs here — the shutdown checkpoint — so closing the
    // store never discards written-but-unsynced records.
    await Promise.allSettled([...this.dirty].map((id) => this.checkpoint(id)))
    await Promise.all([...this.handles.keys()].map((id) => this.closeHandle(id)))
  }

  private sessionDir(id: SessionId): string {
    return path.join(this.sessionsDir, id)
  }

  private eventsPath(id: SessionId): string {
    return path.join(this.sessionDir(id), 'events.jsonl')
  }

  private summaryPath(id: SessionId): string {
    return path.join(this.sessionDir(id), 'summary.json')
  }

  private async openAppend(id: SessionId): Promise<fs.FileHandle> {
    const existing = this.handles.get(id)
    if (existing !== undefined) return existing
    await fs.mkdir(this.sessionDir(id), { recursive: true })
    const handle = await fs.open(this.eventsPath(id), 'a')
    this.handles.set(id, handle)
    return handle
  }

  private async closeHandle(id: SessionId): Promise<void> {
    const handle = this.handles.get(id)
    if (handle === undefined) return
    this.handles.delete(id)
    await handle.close().catch(() => {})
  }

  /** Session ids become directory names: only our own minted shape may pass. */
  private assertSafeId(id: SessionId): void {
    if (!/^session-[a-z0-9-]+$/.test(id)) {
      throw new SessionLogError('schema', `refusing unsafe session id '${id}'`)
    }
  }
}
