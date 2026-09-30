import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { Service, type Context } from '../../kernel/index.ts'
import {
  newSessionId,
  type InputId,
  type SessionId,
  type WorkspaceId,
} from '../../util/brand.ts'
import type { AttachmentRef } from '../attachments/store.ts'
import type { SessionEvent } from './events.ts'
import { Session } from './session.ts'
import { deriveTitle } from './title.ts'
import {
  FileSessionStore,
  type SessionStore,
  type SessionSummary,
} from '../storage/file-session-store.ts'
import { ScopeError } from '../workspace/types.ts'

declare module 'mini-dsh' {
  interface Context {
    sessions: SessionsService
  }
}

/** One durably accepted input still waiting for the driver. */
export interface PendingInput {
  readonly inputId: InputId
  readonly clientRequestId?: string
  readonly content: string
  readonly attachments?: readonly AttachmentRef[]
}

/** Options for the sessions service. */
export interface SessionsServiceOptions {
  /**
   * A fixed store for every session (unit tests). Omitted with `home`
   * absent keeps all sessions memory-only.
   */
  readonly store?: SessionStore
  /**
   * Data home for the file-first layout: session N of workspace W lives
   * under `<home>/workspaces/W/sessions/N/`. One store instance per
   * workspace, created lazily.
   */
  readonly home?: string
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number
}

/**
 * Mount the file-backed sessions service on a data home. Workspace layout:
 * one directory per workspace, the G1 store contract inside each.
 */
export function fileSessions(home: string, options: Omit<SessionsServiceOptions, 'store' | 'home'> = {}):
  (ctx: Context) => void {
  return (ctx: Context) => {
    new SessionsService(ctx, 'sessions', { ...options, home })
  }
}

/**
 * The session registry: creates, looks up, and forks durable conversation
 * logs, scoped to workspaces. A session belongs to exactly one workspace —
 * fixed at creation — and its durable records live inside that workspace's
 * tree. With a store, one process owns the data root: boot lists stored
 * sessions (summaries only), full histories load lazily, and loading runs
 * recovery — open turns become `interrupted`, tool calls without results
 * gain synthesized unknown-outcome records, undecided approvals are
 * invalidated. Tools are never replayed and queued input never auto-starts.
 */
export class SessionsService extends Service {
  private readonly loaded = new Map<SessionId, Session>()
  private readonly known = new Map<SessionId, SessionSummary>()
  /** Fixed workspace per session, assigned at create/load and never mutated. */
  private readonly ownership = new Map<SessionId, WorkspaceId>()
  private readonly loading = new Map<SessionId, Promise<Session>>()
  private readonly stores = new Map<WorkspaceId, SessionStore>()
  private readonly summaryWriters = new Map<SessionId, Promise<void>>()
  /** Highest durable canonical prefix awaiting its rebuildable projection. */
  private readonly summaryTargets = new Map<SessionId, number>()
  /** Deleted ids suppress late summary callbacks from recreating directories. */
  private readonly deleting = new Set<SessionId>()
  /** Shutdown suppresses new projections after the stores begin closing. */
  private closing = false
  private readonly fixedStore: SessionStore | undefined
  private readonly home: string | undefined
  private readonly now: () => number

  constructor(ctx: Context, name = 'sessions', options: SessionsServiceOptions = {}) {
    super(ctx, name)
    this.fixedStore = options.store
    this.home = options.home
    this.now = options.now ?? Date.now
    ctx.effect(() => () => this.closeStores(), 'sessions.close-stores')
  }

  /** The durable store for one workspace (tests may have a fixed one). */
  storeFor(workspaceId: WorkspaceId | undefined): SessionStore | undefined {
    if (this.fixedStore !== undefined) return this.fixedStore
    if (this.home === undefined || workspaceId === undefined) return undefined
    let store = this.stores.get(workspaceId)
    if (store === undefined) {
      store = new FileSessionStore({ dir: this.home, workspaceId })
      this.stores.set(workspaceId, store)
    }
    return store
  }

  /**
   * Create an empty session, owned by `workspaceId` (required whenever
   * durable storage is in play — a session without a workspace never
   * exists).
   */
  create(workspaceId?: WorkspaceId): Session {
    if (this.closing) throw new Error('sessions: service is closing')
    // Only the home layout demands a workspace (fail closed): a fixed
    // store or memory mode is a test seam whose scoping the caller owns.
    if (this.home !== undefined && this.fixedStore === undefined && workspaceId === undefined) {
      throw new ScopeError('scope-mismatch', 'sessions require a workspace')
    }
    const store = this.storeFor(workspaceId)
    const session = new Session(this.ctx, {
      id: newSessionId(),
      ...(store !== undefined ? { store } : {}),
      now: this.now,
    })
    this.loaded.set(session.id, session)
    if (workspaceId !== undefined) this.ownership.set(session.id, workspaceId)
    session.setDurableListener((lastSeq) => this.scheduleSummary(session, lastSeq))
    if (store !== undefined) {
      // Empty sessions have no canonical record yet; retain an in-memory
      // listing only. Their summary lands with the first durable append.
      this.known.set(session.id, this.summarize(session))
    }
    return session
  }

  /**
   * List sessions stored under every workspace directory and load their
   * summaries. Call once at host startup; full histories stay on disk until
   * {@link SessionsService.load} is called.
   */
  async boot(): Promise<void> {
    const scan: { workspaceId: WorkspaceId | undefined; store: SessionStore }[] = []
    if (this.fixedStore !== undefined) {
      scan.push({ workspaceId: undefined, store: this.fixedStore })
    } else if (this.home !== undefined) {
      // Scan every workspace directory on disk (adopting even unlisted ones).
      const workspacesRoot = path.join(this.home, 'workspaces')
      let entries: Dirent[] = []
      try {
        entries = await fs.readdir(workspacesRoot, { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        scan.push({
          workspaceId: entry.name as WorkspaceId,
          store: this.storeFor(entry.name as WorkspaceId) as SessionStore,
        })
      }
    }
    for (const { workspaceId, store } of scan) {
      await store.init?.()
      for (const id of await store.list()) {
        if (this.loaded.has(id) || this.known.has(id)) continue
        // Ownership comes from the directory layout — the log is canonical
        // and the summary rebuildable, so a missing summary only delays the
        // metadata to load time.
        if (workspaceId !== undefined) this.ownership.set(id, workspaceId)
        let summary = await store.readSummary(id)
        // Summary is derived and may lag after a crash. Compare its claimed
        // prefix against lightweight canonical tail metadata before trusting it.
        const tail = await store.readLastSeq?.(id)
        if (
          summary === undefined ||
          summary.projectId === undefined ||
          summary.derivedTitle === undefined ||
          (tail !== undefined && summary.lastSeq !== tail)
        ) {
          // Deleting derived state must never hide a canonical session:
          // rebuild the projection from events.jsonl right here.
          summary = await this.rebuildSummary(id, store)
        }
        if (summary !== undefined) this.known.set(id, summary)
      }
    }
  }

  /**
   * Load a session's full history from its workspace store, run recovery,
   * and cache it. Resolves with the already-loaded session on repeat calls.
   */
  async load(id: SessionId): Promise<Session> {
    if (this.deleting.has(id)) throw new Error(`sessions: session '${id}' is being deleted`)
    const cached = this.loaded.get(id)
    if (cached !== undefined) return cached
    const inFlight = this.loading.get(id)
    if (inFlight !== undefined) return inFlight

    const task = (async (): Promise<Session> => {
      const store = this.storeFor(this.ownership.get(id))
      if (store === undefined) {
        throw new Error(`sessions: no session '${id}' (no durable store)`)
      }
      const { events, truncatedTail } = await store.read(id)
      if (this.deleting.has(id)) throw new Error(`sessions: session '${id}' was deleted`)
      if (truncatedTail) {
        console.warn(`sessions: quarantined a torn final record in '${id}'`)
      }
      const session = new Session(this.ctx, {
        id,
        store,
        now: this.now,
      })
      session.setDurableListener((lastSeq) => this.scheduleSummary(session, lastSeq))
      // Seed the log without re-broadcasting or rewriting history: recovery
      // records must be appends, just like live events.
      session.adoptHistory(events)

      // Recovery commits fully before the session becomes visible: a
      // half-applied recovery (records broadcast in memory but absent on
      // disk) must never be cached or handed out. On failure nothing is
      // registered, so a retry reloads the canonical disk state.
      await this.recover(session)
      if (this.deleting.has(id)) throw new Error(`sessions: session '${id}' was deleted`)
      await this.scheduleSummary(session, session.events.length)
      if (this.deleting.has(id)) throw new Error(`sessions: session '${id}' was deleted`)
      this.loaded.set(id, session)
      return session
    })()
    this.loading.set(id, task)
    try {
      return await task
    } finally {
      if (this.loading.get(id) === task) this.loading.delete(id)
    }
  }

  /**
   * Look up a loaded session. Throws on an unknown id — a missing referent
   * is never silently skipped. Stored-but-not-yet-loaded sessions must go
   * through {@link SessionsService.load}.
   */
  get(id: SessionId): Session {
    const session = this.loaded.get(id)
    if (session === undefined) {
      throw new Error(`sessions: no session '${id}'`)
    }
    return session
  }

  /** Whether the session is known (loaded or listed at boot). */
  has(id: SessionId): boolean {
    return this.loaded.has(id) || this.known.has(id)
  }

  /**
   * Read the canonical event log without consulting a loaded Session. This is
   * intentionally distinct from `load()`: callers reconciling a poisoned
   * in-memory Session need the persisted record, not its speculative log or
   * recovery side effects. `undefined` means this service has no durable store
   * for the session; I/O/schema errors remain observable to the caller.
   */
  async readCanonicalEvents(id: SessionId): Promise<readonly SessionEvent[] | undefined> {
    if (!this.has(id)) return undefined
    // A loaded session may still have queued writes in flight. Canonical
    // means "after the writer drained": wait for that prefix (a failed
    // append is fine — the store read below decides what landed) so the
    // answer can never race the pending queue.
    await this.loaded.get(id)?.drain().catch(() => {})
    const store = this.storeFor(this.ownership.get(id))
    if (store === undefined) return undefined
    const { events } = await store.read(id)
    return events
  }

  /**
   * The workspace owning a session, when known. Direct-ID access from a
   * foreign workspace fails closed against this.
   */
  workspaceOf(id: SessionId): WorkspaceId | undefined {
    return this.ownership.get(id)
  }

  /**
   * A stored session's summary without loading its history; undefined when
   * unknown.
   */
  summary(id: SessionId): SessionSummary | undefined {
    const session = this.loaded.get(id)
    if (session !== undefined) return this.summarize(session)
    return this.known.get(id)
  }

  /** Summaries for every known session (created here or listed at boot). */
  summaries(): SessionSummary[] {
    const all = new Map<SessionId, SessionSummary>()
    for (const [id, summary] of this.known) all.set(id, summary)
    for (const session of this.loaded.values()) all.set(session.id, this.summarize(session))
    return [...all.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Fork a session; the child stays in the source session's workspace. */
  async fork(source: Session, boundarySeq?: number): Promise<Session> {
    const child = source.fork(boundarySeq)
    const store = this.storeFor(this.ownership.get(source.id))
    if (store !== undefined) {
      await store.replace(child.id, child.events)
    }
    this.loaded.set(child.id, child)
    const ws = this.ownership.get(source.id)
    if (ws !== undefined) this.ownership.set(child.id, ws)
    child.setDurableListener((lastSeq) => this.scheduleSummary(child, lastSeq))
    if (store !== undefined) {
      // replace() is the child's canonical durability point.
      await this.persistSummary(child, child.events.length)
    }
    return child
  }

  /**
   * Remove a session and its stored history. Unknown ids are silently
   * ignored (like a no-op delete).
   */
  async delete(id: SessionId): Promise<void> {
    // Mark first: a concurrent load must fail before recovery, summary rebuild,
    // caching, or return can resurrect the canonical directory.
    this.deleting.add(id)
    const store = this.storeFor(this.ownership.get(id))
    const loading = this.loading.get(id)
    const session = this.loaded.get(id)
    // Close before yielding so no new canonical append can join the writer
    // after this deletion starts. Drain only the already-queued prefix; unlike
    // durable(), this deliberately does not schedule a summary projection.
    session?.close()
    session?.dispose()
    // Drain load/recovery, the canonical append prefix, and rebuildable
    // projection writers before removing the session directory. The append
    // must finish first: FileSessionStore.append() can create its directory.
    await loading?.catch(() => {})
    await session?.drain()
    await this.summaryWriters.get(id)?.catch(() => {})
    this.summaryWriters.delete(id)
    this.summaryTargets.delete(id)
    this.loaded.delete(id)
    this.known.delete(id)
    this.ownership.delete(id)
    if (store !== undefined) {
      await store.remove(id)
    }
  }

  /**
   * Durably accepted but not yet consumed inputs, oldest first. An input is
   * consumed once a `user/message` carrying its id lands in the log; after
   * a restart these stay pending and are never executed on their own.
   * Attachments ride along: a re-adopted input must reach the model with the
   * same files the user attached to it.
   */
  pendingInputs(session: Session): PendingInput[] {
    const consumed = new Set<string>()
    const queued: PendingInput[] = []
    for (const event of session.events) {
      if (event.type === 'input/queued') {
        queued.push({
          inputId: event.inputId as InputId,
          ...(event.clientRequestId !== undefined ? { clientRequestId: event.clientRequestId } : {}),
          content: event.content,
          ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
        })
      } else if (event.type === 'user/message' && event.inputId !== undefined) {
        consumed.add(event.inputId)
      }
    }
    return queued.filter((item) => !consumed.has(item.inputId))
  }

  /**
   * Recovery after a restart: close open turns as `interrupted`, synthesize
   * explicitly identified unknown-outcome records for tool calls whose
   * results never landed, and invalidate undecided approvals. Everything is
   * a durable append; nothing is replayed.
   */
  private async recover(session: Session): Promise<void> {
    const openTurns = new Set<string>()
    const unansweredByExecution = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
    const unansweredLegacy = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>[]>()
    const decided = new Set<string>()
    let currentTurn: string | undefined
    const legacyKey = (turnId: string | undefined, stepId: string, callId: string): string =>
      `${turnId ?? ''}\u0000${stepId}\u0000${callId}`
    for (const event of session.events) {
      switch (event.type) {
        case 'turn/start':
          currentTurn = event.turnId
          openTurns.add(event.turnId)
          break
        case 'turn/end':
          openTurns.delete(event.turnId)
          if (currentTurn === event.turnId) currentTurn = undefined
          break
        case 'tool/call':
          if (event.executionId !== undefined) {
            unansweredByExecution.set(event.executionId, event)
          } else {
            const key = legacyKey(currentTurn, event.stepId, event.call.id)
            const queued = unansweredLegacy.get(key) ?? []
            queued.push(event)
            unansweredLegacy.set(key, queued)
          }
          break
        case 'tool/result':
          if (event.executionId !== undefined) {
            unansweredByExecution.delete(event.executionId)
          } else {
            const key = legacyKey(currentTurn, event.stepId, event.callId)
            const queued = unansweredLegacy.get(key)
            queued?.shift()
            if (queued?.length === 0) unansweredLegacy.delete(key)
          }
          break
        case 'approval/decision':
          decided.add(event.approvalId)
          break
        default:
          break
      }
    }

    const unanswered = [
      ...unansweredByExecution.values(),
      ...[...unansweredLegacy.values()].flat(),
    ]
    for (const event of unanswered) {
      session.append({
        type: 'tool/result',
        stepId: event.stepId,
        ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
        callId: event.call.id,
        ok: false,
        output: `recovery: outcome unknown — the host was interrupted after this call was recorded; inspect actual state before retrying`,
        recovery: true,
      })
    }
    for (const event of session.events) {
      if (event.type !== 'approval/request' || decided.has(event.approvalId)) continue
      session.append({
        type: 'approval/decision',
        approvalId: event.approvalId,
        decision: 'invalidated',
        reason: 'host restart',
      })
    }
    for (const turnId of openTurns) {
      session.append({ type: 'turn/end', turnId: turnId as never, reason: 'interrupted' })
    }
    // Recovery records are durable facts: the load fails if they cannot be
    // committed, and the caller may retry from the canonical file.
    await session.durable()
  }

  /**
   * Rebuild the summary projection for a stored-but-unloaded session by
   * scanning its canonical log (metadata only — no recovery, no broadcast).
   */
  private async rebuildSummary(id: SessionId, store: SessionStore): Promise<SessionSummary | undefined> {
    try {
      const { events } = await store.read(id)
      const first = events[0]
      const last = events[events.length - 1]
      const summary: SessionSummary = {
        id,
        createdAt: first?.timestamp ?? 0,
        updatedAt: last?.timestamp ?? 0,
        eventCount: events.length,
        lastSeq: last?.seq ?? 0,
        title: lastRecorded(events, (event) => (event.type === 'session/title' ? event.title : undefined), null),
        derivedTitle: deriveTitle(events),
        projectId: lastRecorded(events, (event) => (event.type === 'session/project' ? event.projectId : undefined), null),
        pinned: lastRecorded(events, (event) => (event.type === 'session/pinned' ? event.pinned : undefined), false),
      }
      await store.writeSummary(id, summary)
      return summary
    } catch {
      // The log itself is unreadable: surface it rather than pretend.
      console.warn(`sessions: cannot rebuild summary for '${id}' from its log`)
      return undefined
    }
  }

  /** Force a summary projection only after its complete canonical log is durable. */
  async flushSummary(session: Session): Promise<void> {
    await session.durable()
    await this.scheduleSummary(session, session.events.length)
  }

  /** Schedule one coalesced write for the highest durable prefix. */
  private scheduleSummary(session: Session, lastSeq: number): Promise<void> {
    if (this.closing || this.deleting.has(session.id)) return Promise.resolve()
    const target = Math.max(this.summaryTargets.get(session.id) ?? 0, lastSeq)
    this.summaryTargets.set(session.id, target)
    const existing = this.summaryWriters.get(session.id)
    if (existing !== undefined) return existing

    const writer = (async (): Promise<void> => {
      while (!this.deleting.has(session.id)) {
        const targetSeq = this.summaryTargets.get(session.id) ?? 0
        if (targetSeq === 0) return
        await this.persistSummary(session, targetSeq)
        if ((this.summaryTargets.get(session.id) ?? 0) <= targetSeq) return
      }
    })()
    void writer.catch(() => {})
    this.summaryWriters.set(session.id, writer)
    void writer.finally(() => {
      if (this.summaryWriters.get(session.id) === writer) {
        this.summaryWriters.delete(session.id)
      }
    }).catch(() => {})
    return writer
  }

  /** Persist a canonical-prefix summary, serialized by scheduleSummary(). */
  private async persistSummary(session: Session, durableSeq?: number): Promise<void> {
    if (this.deleting.has(session.id)) return
    const store = this.storeFor(this.ownership.get(session.id))
    if (store === undefined) return
    const targetSeq = durableSeq ?? session.events.length
    // Summary must never claim records that have not passed a durability
    // barrier. Slice to the captured canonical prefix if later appends exist.
    const summary = this.summarize(session, targetSeq)
    if (summary.lastSeq !== targetSeq) {
      throw new Error(`sessions: cannot summarize missing durable prefix ${targetSeq}`)
    }
    if (this.deleting.has(session.id)) return
    await store.writeSummary(session.id, summary)
    if (!this.deleting.has(session.id)) this.known.set(session.id, summary)
  }

  /** Drain canonical append chains and projections before closing owned stores. */
  private async closeStores(): Promise<void> {
    this.closing = true
    // Close sessions to prevent a later append from opening a file handle after
    // the captured chains drain. Existing appends remain drainable.
    for (const session of this.loaded.values()) session.close()
    await Promise.allSettled([...this.loaded.values()].map((session) => session.drain()))
    await Promise.allSettled([...this.summaryWriters.values()])
    const stores = new Set<SessionStore>([
      ...(this.fixedStore !== undefined ? [this.fixedStore] : []),
      ...this.stores.values(),
    ])
    await Promise.allSettled([...stores].map((store) => store.close?.()))
  }

  /** Summary computed from a live session's log through a durable prefix. */
  private summarize(session: Session, lastSeq = session.events.length): SessionSummary {
    const events = session.events.slice(0, lastSeq)
    const first = events[0]
    const last = events[events.length - 1]
    return {
      id: session.id,
      createdAt: first?.timestamp ?? this.now(),
      updatedAt: last?.timestamp ?? this.now(),
      eventCount: events.length,
      lastSeq: last?.seq ?? 0,
      title: lastRecorded(events, (event) => (event.type === 'session/title' ? event.title : undefined), null),
      derivedTitle: deriveTitle(events),
      projectId: lastRecorded(events, (event) => (event.type === 'session/project' ? event.projectId : undefined), null),
      pinned: lastRecorded(events, (event) => (event.type === 'session/pinned' ? event.pinned : undefined), false),
    }
  }
}

/**
 * The last value a log recorded for one projected field, or `fallback` when it
 * never recorded one. `undefined` from `pick` means "this event says nothing
 * about the field", so a recorded `null` still wins over the fallback.
 */
function lastRecorded<T>(events: readonly SessionEvent[], pick: (event: SessionEvent) => T | undefined, fallback: T): T {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const value = event === undefined ? undefined : pick(event)
    if (value !== undefined) return value
  }
  return fallback
}
