/**
 * Bounded one-level multi-agent execution (G4): the root agent spawns
 * children through the SAME G1 loop and G3 builder — there is no second
 * runtime. Children get a brief, an isolated session, and a capability
 * ceiling = mode exposure ∩ definition ∩ spawn grant (intersection — a grant
 * never widens the definition); they can never spawn children. Internal
 * lifecycle: spawn / list / wait / result / cancel. No steering, no detached
 * children, no automatic restart resumption — a child session is driven by
 * this executor only, and restart reconstructs handles from durable logs,
 * reporting unfinished children as interrupted.
 *
 * Memory stays bounded: the in-memory map holds ACTIVE children only. Once a
 * child's terminal record is durable its entry is evicted, and every query
 * reconstructs the settled handle from the durable logs — the same path a
 * restart uses — so a settled child never disappears from list/wait.
 */
import { createHash } from 'node:crypto'
import type { Context } from '../../kernel/index.ts'
import { newTurnId, type SessionId, type WorkspaceId, type ProjectId } from '../../util/brand.ts'
import type { Agent } from '../agent/agent.ts'
import { agentScope, type AgentScope } from '../agent/scope.ts'
import type { AgentDefinition } from './definition-service.ts'
import type { SessionEvent, TurnEndReason } from '../session/events.ts'
import type { GrantedRoot } from '../tools/types.ts'

/**
 * What a child is asked to do. `prompt` is the brief in prose — the primary
 * form; the structured `objective`/`constraints`/`references` form stays
 * accepted. Either `prompt` or `objective` must be non-empty.
 */
export interface TaskPacket {
  /** The brief, in prose. Preferred over the structured fields. */
  readonly prompt?: string
  readonly objective?: string
  readonly constraints?: readonly string[]
  readonly references?: readonly string[]
  readonly requiredResult: string
}

/**
 * The one normalized brief: the trimmed non-empty `prompt`, otherwise the
 * trimmed non-empty `objective`. Rendering and both durable records reuse it,
 * so runtime and storage can never disagree about what the child was told.
 */
export function normalizeBrief(packet: TaskPacket): string | undefined {
  const prompt = packet.prompt?.trim() ?? ''
  if (prompt !== '') return prompt
  const objective = packet.objective?.trim() ?? ''
  return objective !== '' ? objective : undefined
}

/**
 * The model a child runs on. The host resolves the pair (spawn request >
 * definition > parent session) and hands it over complete: the executor
 * never looks providers up itself.
 */
export interface ChildModel {
  readonly provider: string
  readonly model: string
  readonly thinkingLevel?: string | null
}

export interface SpawnAdmissionInput {
  readonly workspaceId: WorkspaceId
  readonly parentSessionId: SessionId
  /** The child definition being admitted (Explorer-class rules key on it). */
  readonly definition: string
  readonly candidates: readonly string[]
}

/** Trusted host callback evaluated inside the executor's serialized admission. */
export type SpawnAdmissionResolver = (input: SpawnAdmissionInput) => Promise<readonly string[]>

export interface SpawnRequest {
  readonly workspaceId: WorkspaceId
  readonly projectId?: ProjectId | undefined
  /** The root session/turn that owns this child. */
  readonly parentSessionId: SessionId
  readonly parentTurnId: string
  readonly definition: AgentDefinition
  /** Explicit trusted fixture ceiling, primarily for low-level/headless callers. */
  readonly exposureCeiling?: readonly string[] | undefined
  /** Host authority resolver, evaluated at the admission linearization point. */
  readonly admissionResolver?: SpawnAdmissionResolver | undefined
  readonly packet: TaskPacket
  /**
   * Spawn grant: INTERSECTS the definition's tool ceiling (never widens it).
   * Omitted grants leave the definition's tools in force.
   */
  readonly grantTools?: readonly string[] | undefined
  /** Stamped into the child's own log; omitted leaves the host's defaults. */
  readonly model?: ChildModel | undefined
  /** `'brief'` hands the child a bounded parent-conversation projection. */
  readonly inherit?: 'none' | 'brief' | undefined
  /**
   * The projection itself, captured by the caller at spawn. Present exactly
   * when `inherit` is `'brief'` (possibly empty when nothing was eligible).
   */
  readonly inheritedContext?: string | undefined
  /** The parent's additional file-tool folders at spawn; the child never gains more. */
  readonly grants?: readonly GrantedRoot[] | undefined
}

/**
 * `uncertain` means an append acknowledgement failed and canonical storage
 * could not be read to establish whether the parent lifecycle record landed.
 * It deliberately does not assert either a terminal failure or a rollback.
 */
export type ChildStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'uncertain'

/** A completed child's deliverable. */
export interface ChildResult {
  /** The child's FINAL tool-free message — its whole deliverable. */
  readonly report: string
  /**
   * Files the child read or wrote, from Read/Write/Edit arguments. Not a
   * claim about everything it found: discovered paths live in `report`.
   */
  readonly filesTouched: readonly string[]
  /** Set when `report` was cut at {@link MAX_REPORT_CHARS}. */
  readonly truncated?: boolean
}

/** Runtime status is distinct from any model claim of success. */
export interface ChildHandle {
  readonly childSessionId: SessionId
  readonly status: ChildStatus
  readonly definitionName: string
  /** The child's effective `provider:model`, when one was stamped. */
  readonly model?: string
  readonly startedAt: number
  readonly endedAt?: number
  /** Only a completed child that ended on a tool-free message has one. */
  readonly result?: ChildResult
  /**
   * What a child that did NOT complete (failed, cancelled, interrupted) got
   * done: its last message and the files it touched. Evidence, not a verdict —
   * a caller must verify it, but it never has to start from zero.
   */
  readonly partial?: ChildResult
  /** Why there is no result; always names the child's full-log session. */
  readonly error?: string
  /** A running child parked on an approval nobody has answered yet. */
  readonly awaitingApproval?: boolean
}

/** Longest report handed back before an explicit truncation marker. */
export const MAX_REPORT_CHARS = 16_000
const MAX_FILES_TOUCHED = 40
/** Tools whose `path` argument names a FILE the child worked on. */
const FILE_ARG_TOOLS = new Set(['Read', 'Write', 'Edit'])

export class SpawnError extends Error {
  constructor(
    readonly code: 'capacity' | 'depth' | 'packet' | 'inherit' | 'ownership',
    message: string,
  ) {
    super(message)
    this.name = 'SpawnError'
  }
}

function snapshotSpawnRequest<T extends SpawnRequest | Omit<SpawnRequest, 'parentTurnId'>>(request: T): T {
  const definition: AgentDefinition = {
    ...request.definition,
    tools: [...request.definition.tools],
    disallowedTools: [...request.definition.disallowedTools],
    ...(request.definition.skills !== undefined ? { skills: [...request.definition.skills] } : {}),
  }
  const packet: TaskPacket = {
    ...request.packet,
    ...(request.packet.constraints !== undefined ? { constraints: [...request.packet.constraints] } : {}),
    ...(request.packet.references !== undefined ? { references: [...request.packet.references] } : {}),
  }
  return {
    ...request,
    definition,
    packet,
    ...(request.exposureCeiling !== undefined ? { exposureCeiling: [...request.exposureCeiling] } : {}),
    ...(request.grantTools !== undefined ? { grantTools: [...request.grantTools] } : {}),
    ...(request.grants !== undefined ? { grants: request.grants.map((grant) => ({ ...grant })) } : {}),
  }
}

/** The slice of a session the executor reads and writes. */
interface StoredSession {
  readonly id: SessionId
  readonly events: readonly SessionEvent[]
  /** Actual Session storage failures poison the instance permanently. */
  readonly poisoned?: boolean
  append(event: unknown): unknown
  durable(): Promise<void>
}

interface SessionsLike {
  create(workspaceId?: WorkspaceId): StoredSession
  load(id: SessionId): Promise<StoredSession>
  /** Canonical persisted events, bypassing any poisoned loaded Session. */
  readCanonicalEvents?(id: SessionId): Promise<readonly SessionEvent[] | undefined>
  has(id: SessionId): boolean
  workspaceOf(id: SessionId): WorkspaceId | undefined
  summaries(): readonly { readonly id: SessionId }[]
  delete(id: SessionId): Promise<void>
}

interface InternalChild {
  readonly childSessionId: SessionId
  /** Immutable ownership — lifecycle lookups are workspace-scoped. */
  readonly workspaceId: WorkspaceId
  readonly parentSessionId: SessionId
  readonly parentTurnId: string
  /** The project binding captured at the durable spawn boundary. */
  readonly projectId?: ProjectId
  readonly definitionName: string
  readonly model?: ChildModel
  agent?: Agent
  launch?: () => Promise<void>
  /** The child's durable log (live for an active child). */
  events: readonly SessionEvent[]
  status: ChildStatus
  readonly startedAt: number
  endedAt?: number
  failure?: string
  /** Result-or-error derivation, memoized by `resultComputed`. */
  result?: ChildResult
  partial?: ChildResult
  error?: string
  resultComputed: boolean
  /** Terminal bookkeeping ran (capacity released, record written). */
  finished: boolean
  /** Resolves when the run loop fully settles (event-driven wait). */
  readonly settled: Promise<void>
  readonly settle: () => void
}

/** A settled child's final handle and the ownership lookups need. */
interface SettledEntry {
  readonly handle: ChildHandle
  readonly workspaceId: WorkspaceId
  readonly parentSessionId: SessionId
}

const MAX_SETTLED_HANDLES = 256
/** Reported-child ids kept per executor; the oldest leave first. */
const MAX_REPORTED = 4096

export class ChildExecutor {
  /** ACTIVE children only; settled entries are evicted once durable. */
  private readonly active = new Map<SessionId, InternalChild>()
  /** Child ids per root (ids only), from spawns and recovery. */
  private readonly childIdsByRoot = new Map<SessionId, Set<SessionId>>()
  /**
   * Settled handles, so a settled child's log is digested once rather than on
   * every poll. Bounded: the oldest entry leaves first; a miss only costs a
   * rebuild from the durable logs.
   */
  private readonly settledHandles = new Map<SessionId, SettledEntry>()
  /** One canonical settlement writer per child; concurrent retries share it. */
  private readonly settlements = new Map<SessionId, Promise<ChildHandle | undefined>>()
  private readonly spawnedPerTurn = new Map<string, number>()
  /** Children each root turn spawned (`root:turn` → ids), until the turn settles. */
  private readonly turnChildren = new Map<string, Set<SessionId>>()
  /** Children whose outcome already reached the model that spawned them. */
  private readonly reported = new Set<SessionId>()
  /** Active reservations include spawns that have not launched yet. */
  private readonly reservedPerRoot = new Map<SessionId, number>()
  /** FIFO within each root; the root queue rotates after every dispatch. */
  private readonly pendingByRoot = new Map<SessionId, InternalChild[]>()
  private readonly runnableRoots: SessionId[] = []
  private pumping = false
  /** Parent-session writer: spawn admission and closing serialize here. */
  private readonly admissionTails = new Map<SessionId, Promise<void>>()
  /** Closing is synchronous before the first await, so new spawns refuse it. */
  private readonly closingTurns = new Set<string>()

  constructor(private readonly ctx: Context) {}

  private sessions(): SessionsLike | undefined {
    return this.ctx.get('sessions') as SessionsLike | undefined
  }

  private async withAdmission<T>(root: SessionId, work: () => Promise<T>): Promise<T> {
    const previous = this.admissionTails.get(root) ?? Promise.resolve()
    let release: () => void = () => {}
    const tail = new Promise<void>((resolve) => { release = resolve })
    this.admissionTails.set(root, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.admissionTails.get(root) === tail) this.admissionTails.delete(root)
    }
  }

  /**
   * Commit a durable closing fact through the SAME writer as spawn. An
   * in-flight spawn either commits before this marker or cannot dispatch.
   * A turn that never spawned anything needs no record: the in-memory guard
   * still refuses a late spawn, and the log stays free of empty markers.
   */
  async closeTurn(root: SessionId, turnId: string): Promise<void> {
    const key = `${root}:${turnId}`
    this.closingTurns.add(key)
    if ((this.spawnedPerTurn.get(key) ?? 0) === 0) return
    await this.withAdmission(root, async () => {
      const parent = await this.sessions()?.load(root)
      if (parent === undefined) throw new SpawnError('ownership', 'no such parent session')
      if (parent.events.some((event) => event.type === 'turn/closing' && event.turnId === turnId)) return
      parent.append({ type: 'turn/closing', turnId })
      await parent.durable()
    })
  }

  private enqueue(child: InternalChild): void {
    const root = child.parentSessionId
    const queue = this.pendingByRoot.get(root) ?? []
    queue.push(child)
    this.pendingByRoot.set(root, queue)
    if (!this.runnableRoots.includes(root)) this.runnableRoots.push(root)
    this.pump()
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.runnableRoots.length > 0) {
        const root = this.runnableRoots.shift() as SessionId
        const queue = this.pendingByRoot.get(root)
        const child = queue?.shift()
        if (queue !== undefined && queue.length > 0) this.runnableRoots.push(root)
        else this.pendingByRoot.delete(root)
        if (child === undefined || child.status !== 'queued' || child.launch === undefined) continue
        child.status = 'dispatching'
        void child.launch().catch(async (error: unknown) => {
          if (!child.finished) {
            child.status = 'failed'
            child.failure = errorText(error)
            await this.finish(child)
          }
        }).finally(() => {
          this.pump()
        })
      }
    } finally {
      this.pumping = false
    }
  }

  private removeQueued(child: InternalChild): void {
    const root = child.parentSessionId
    const queue = this.pendingByRoot.get(root)
    if (queue === undefined) return
    const index = queue.indexOf(child)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) {
      this.pendingByRoot.delete(root)
      const position = this.runnableRoots.indexOf(root)
      if (position >= 0) this.runnableRoots.splice(position, 1)
    }
  }

  /**
   * Index child relationships from durable logs after a restart. A child
   * whose parent is missing or owned by another workspace/project is skipped
   * and reported. Nothing is kept in memory beyond ids: handles reconstruct
   * on demand, and an unfinished child reports `interrupted` — never
   * `running`, never re-executed. Idempotent.
   */
  async recoverFromStorage(): Promise<number> {
    const sessions = this.sessions()
    if (sessions === undefined) return 0
    let recovered = 0
    for (const summary of sessions.summaries()) {
      const loaded = await sessions.load(summary.id).catch(() => undefined)
      if (loaded === undefined) continue
      const meta = childMetaOf(loaded.events)
      if (meta === undefined) continue
      const parentId = meta.parentSessionId as SessionId
      const parent = sessions.has(parentId) ? await sessions.load(parentId).catch(() => undefined) : undefined
      const problem = parent === undefined
        ? 'its parent session is missing'
        : sessions.workspaceOf(parentId) !== sessions.workspaceOf(summary.id)
          ? 'its parent belongs to another workspace'
          : !spawnCommitted(parent.events, summary.id)
            // No parent relationship record: the spawn never reached its
            // commit point, so this is a leftover, not a child.
            ? 'its parent never recorded the spawn'
            : meta.projectId !== undefined && boundProject(parent.events) !== meta.projectId
              ? 'its parent is bound to another project'
              : undefined
      if (problem !== undefined) {
        console.warn(`agents: skipped child ${summary.id}: ${problem}`)
        continue
      }
      this.indexChild(parentId, summary.id)
      recovered += 1
      // A crash between the committed spawn and the child's settlement leaves
      // the parent's log result-less forever, and every projection reads that
      // as a child still running. Where the child's own log holds nothing but
      // the interrupted recovery fact — an interrupted terminal turn, or no
      // turn at all — the guarded repair backfills that verdict into the
      // parent. A terminal completed/cancelled/failed child turn stays
      // untouched: it proves the child stopped, never that the parent
      // accepted its result, so that contract remains `uncertain`.
      if (parent !== undefined && sessions.readCanonicalEvents !== undefined) {
        const prior = latestChildResult(parent.events, summary.id)
        const terminal = terminalTurnReason(loaded.events)
        if ((prior === undefined || !isTerminalStatus(prior.status)) && (terminal === undefined || terminal === 'interrupted')) {
          const workspace = sessions.workspaceOf(summary.id)
          if (workspace !== undefined) await this.reconcile(workspace, summary.id)
        }
      }
    }
    return recovered
  }

  /** Every child of one root — active and settled — oldest first. */
  async childrenOfRoot(parentSessionId: SessionId, workspaceId?: WorkspaceId): Promise<ChildHandle[]> {
    const handles: ChildHandle[] = []
    const seen = new Set<SessionId>()
    // Active children first — including one still inside its spawn window.
    for (const child of this.active.values()) {
      if (child.parentSessionId !== parentSessionId) continue
      if (workspaceId !== undefined && child.workspaceId !== workspaceId) continue
      // Active entries are not durable handles yet, but still require the
      // parent ownership boundary: a deleted or rebound root owns no listing.
      if (!await this.ownsChild(workspaceId ?? child.workspaceId, child)) continue
      seen.add(child.childSessionId)
      handles.push(this.withResult(child))
    }
    // Settled ones: the index plus the root's own relationship records, with
    // the root log read once and shared by every rebuild.
    const ids = new Set<SessionId>(this.childIdsByRoot.get(parentSessionId) ?? [])
    const sessions = this.sessions()
    const root = sessions?.has(parentSessionId) === true ? await sessions.load(parentSessionId).catch(() => undefined) : undefined
    for (const event of root?.events ?? []) {
      if (event.type === 'agent/child-spawn') ids.add(event.childSessionId as SessionId)
    }
    for (const id of ids) {
      if (seen.has(id)) continue
      const handle = await this.settledHandle(id, workspaceId, root?.events)
      if (handle !== undefined && handle.parentSessionId === parentSessionId) handles.push(handle.handle)
    }
    return handles.sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Nonterminal children of one root, from the active index (synchronous). */
  runningChildrenOfRoot(parentSessionId: SessionId): SessionId[] {
    return [...this.active.values()]
      .filter((child) => child.parentSessionId === parentSessionId && (child.status === 'running' || child.status === 'dispatching' || child.status === 'queued'))
      .map((child) => child.childSessionId)
  }

  /** Active children this conversation holds, for `active` reporting. */
  activeOfRoot(parentSessionId: SessionId): number {
    return this.reservedPerRoot.get(parentSessionId) ?? 0
  }

  /**
   * Spawn one child. Order: dependency, packet, depth and ownership
   * preflight (async) → a SYNCHRONOUS check-and-reserve with no await inside
   * (concurrent spawns cannot race past a limit) → the child's durable
   * metadata → the parent's durable relationship (the commit point) → launch.
   * A failure before the commit point deletes the new child session and
   * rolls every reservation back; after it, the child settles as a durable
   * failed child and only active capacity is released.
   */
  async spawn(request: SpawnRequest): Promise<ChildHandle> {
    // Authority-bearing request fields are copied before the first await. A
    // caller mutating its request/role/grants while admission is queued cannot
    // widen the child that eventually commits.
    const pinned = snapshotSpawnRequest(request)
    const key = `${pinned.parentSessionId}:${pinned.parentTurnId}`
    if (this.closingTurns.has(key)) throw new SpawnError('ownership', 'turn is closing')
    return this.withAdmission(pinned.parentSessionId, async () => {
      if (this.closingTurns.has(key)) throw new SpawnError('ownership', 'turn is closing')
      return this.spawnAdmitted(pinned)
    })
  }

  /**
   * A manual HTTP delegation owns a real, short-lived Turn. The first spawn
   * creates that Turn while the root is idle; it closes admission after the
   * child relationship commits, then terminalizes only after settlement.
   * Its lifecycle shares the root's admission writer with model-driven spawn.
   */
  async spawnManual(request: Omit<SpawnRequest, 'parentTurnId'>, rootBusy: () => boolean, options: { turnId?: string; keepOpen?: boolean } = {}): Promise<{ turnId: string; handle: ChildHandle }> {
    const pinned = snapshotSpawnRequest(request)
    return this.withAdmission(pinned.parentSessionId, async () => {
      const parent = await this.sessions()?.load(pinned.parentSessionId)
      if (parent === undefined) throw new SpawnError('ownership', 'no such root session')
      if (childMetaOf(parent.events) !== undefined) throw new SpawnError('depth', 'one-level delegation: a child agent cannot spawn children')
      if (rootBusy()) throw new SpawnError('ownership', 'the root has an active conversation Turn')
      const open = [...parent.events].reverse().find((event) => event.type === 'turn/start' || event.type === 'turn/end')
      let turnId: string
      if (options.turnId !== undefined) {
        if (open?.type !== 'turn/start' || open.kind !== 'delegation' || open.turnId !== options.turnId ||
          this.closingTurns.has(`${pinned.parentSessionId}:${options.turnId}`)) {
          throw new SpawnError('ownership', 'no such open delegation Turn')
        }
        turnId = options.turnId
      } else {
        if (open?.type === 'turn/start') throw new SpawnError('ownership', 'the root has an open Turn')
        turnId = newTurnId()
        parent.append({ type: 'turn/start', turnId: turnId as never, kind: 'delegation' })
        await parent.durable()
      }
      let handle: ChildHandle
      try {
        handle = await this.spawnAdmitted({ ...pinned, parentTurnId: turnId })
      } catch (error) {
        // A failed spawn still closes the real delegation Turn. If storage is
        // poisoned, the open Turn remains visibly interrupted on recovery.
        if (parent.poisoned !== true) {
          parent.append({ type: 'turn/closing', turnId })
          parent.append({ type: 'turn/end', turnId, reason: 'failed' })
          await parent.durable()
        }
        throw error
      }
      if (options.keepOpen !== true) {
        const key = `${pinned.parentSessionId}:${turnId}`
        this.closingTurns.add(key)
        parent.append({ type: 'turn/closing', turnId: turnId as never })
        await parent.durable()
        // Terminalization happens after every child in this batch settles;
        // no detached work or conversational history is synthesized.
        void this.finishManualTurn(parent, turnId)
      }
      return { turnId, handle }
    })
  }

  private async finishManualTurn(parent: StoredSession, turnId: string): Promise<void> {
    const children = [...this.active.values()].filter((child) => child.parentSessionId === parent.id && child.parentTurnId === turnId)
    await Promise.all(children.map((child) => child.settled))
    try {
      if (parent.poisoned !== true) {
        parent.append({ type: 'turn/end', turnId, reason: 'completed' })
        await parent.durable()
      }
    } catch {
      // The canonical log is authoritative; recovery marks an open Turn
      // interrupted instead of claiming completion whose append failed.
    } finally {
      await this.releaseTurns(parent.id)
    }
  }

  private async spawnAdmitted(request: SpawnRequest): Promise<ChildHandle> {
    const sessions = this.sessions()
    if (sessions === undefined) throw new SpawnError('depth', 'no sessions service mounted')
    const agents = this.ctx.get('agents') as { create(s: unknown, identity?: unknown): Agent } | undefined
    if (agents === undefined) throw new SpawnError('depth', 'no agents service mounted')

    const brief = normalizeBrief(request.packet)
    if (brief === undefined) {
      throw new SpawnError('packet', "the task needs a non-empty 'prompt' (or the structured 'objective')")
    }
    const inherit = request.inherit ?? 'none'
    if ((inherit === 'brief') !== (request.inheritedContext !== undefined)) {
      throw new SpawnError('packet', "inheritedContext must accompany inherit:'brief' and nothing else")
    }
    if (inherit === 'brief' && request.definition.inheritable === false) {
      throw new SpawnError('inherit', `role '${request.definition.name}' does not accept inherited context (inheritable: false)`)
    }

    // One-level enforcement and ownership: the parent must be a root of the
    // requested workspace/project, checked before any child state exists.
    if (this.active.has(request.parentSessionId)) {
      throw new SpawnError('depth', 'one-level delegation: a child agent cannot spawn children')
    }
    const parent = sessions.has(request.parentSessionId)
      ? await sessions.load(request.parentSessionId).catch(() => undefined)
      : undefined
    if (parent === undefined) throw new SpawnError('ownership', 'no such parent session')
    if (childMetaOf(parent.events) !== undefined) {
      throw new SpawnError('depth', 'one-level delegation: the requested parent session is itself a child')
    }
    if (sessions.workspaceOf(parent.id) !== request.workspaceId || boundProject(parent.events) !== request.projectId) {
      throw new SpawnError('ownership', 'the parent session belongs to another workspace or project')
    }

    // Permission linearization point: resolve the trusted host snapshot after
    // queued admission waits, but before any reservation or durable child/root
    // metadata. The returned list is pinned for this child; later widening
    // cannot add tools, while the ordinary live root gate can still narrow it.
    const exposureCeiling = request.admissionResolver !== undefined
      ? await request.admissionResolver({
          workspaceId: request.workspaceId,
          parentSessionId: request.parentSessionId,
          definition: request.definition.name,
          candidates: request.definition.tools,
        })
      : request.exposureCeiling
    if (exposureCeiling === undefined) {
      throw new SpawnError('ownership', 'trusted spawn admission authority is required')
    }
    const pinnedExposureCeiling = [...exposureCeiling]

    const turnStart = parent.events.find((event) => event.type === 'turn/start' && event.turnId === request.parentTurnId)
    if (turnStart !== undefined && parent.events.some((event) =>
      (event.type === 'turn/closing' || event.type === 'turn/end') && event.turnId === request.parentTurnId)) {
      throw new SpawnError('ownership', 'turn is closing or already closed')
    }

    // Reservation accounting, uncapped: the per-turn counter decides whether
    // closeTurn still owes a durable turn/closing marker; the per-root counter
    // is the live child count surfaced to the parent. Both are released by the
    // same rollback/cleanup paths as before.
    const root = request.parentSessionId
    const turnKey = `${root}:${request.parentTurnId}`
    this.spawnedPerTurn.set(turnKey, (this.spawnedPerTurn.get(turnKey) ?? 0) + 1)
    this.reservedPerRoot.set(root, (this.reservedPerRoot.get(root) ?? 0) + 1)

    // ── durable records, up to the commit point ─────────────────
    // The child is active from the moment its session exists, so a list that
    // lands inside the spawn window sees it running — never a false settle.
    let session: StoredSession | undefined
    let child: InternalChild | undefined
    try {
      session = sessions.create(request.workspaceId)
      let settle: () => void = () => {}
      const settled = new Promise<void>((resolve) => { settle = resolve })
      child = {
        childSessionId: session.id,
        workspaceId: request.workspaceId,
        parentSessionId: root,
        parentTurnId: request.parentTurnId,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        definitionName: request.definition.name,
        ...(request.model !== undefined ? { model: request.model } : {}),
        events: session.events,
        status: 'queued',
        startedAt: Date.now(),
        resultComputed: false,
        finished: false,
        settled,
        settle,
      }
      this.active.set(child.childSessionId, child)
      const siblings = this.turnChildren.get(turnKey) ?? new Set<SessionId>()
      siblings.add(child.childSessionId)
      this.turnChildren.set(turnKey, siblings)
      // The model is a session-level ownership boundary, exactly as it is for
      // a user's own pick: stamping it in the child's log pins the pair for
      // the child's whole life, survives restart, and stops a child from
      // silently re-inheriting a later global default.
      if (request.model !== undefined) {
        session.append({
          type: 'session/model',
          provider: request.model.provider,
          model: request.model.model,
          ...(request.model.thinkingLevel !== undefined ? { thinkingLevel: request.model.thinkingLevel } : {}),
        })
      }
      // Durable spawn intent + parentage in the child's canonical log, with
      // a REAL barrier: an unrecorded child never starts executing. The
      // inherited text itself is runtime-only; its hash and size are audit.
      session.append({
        type: 'session/child-meta',
        parentSessionId: root,
        parentTurnId: request.parentTurnId,
        definition: request.definition.name,
        brief,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        ...(request.inheritedContext !== undefined
          ? { inherit: 'brief', inheritedHash: sha256Text(request.inheritedContext), inheritedChars: request.inheritedContext.length }
          : {}),
      })
      await session.durable()
      const spawnRecord = {
        type: 'agent/child-spawn' as const,
        childSessionId: session.id,
        parentTurnId: request.parentTurnId,
        definition: request.definition.name,
        brief,
      }
      parent.append(spawnRecord)
      const outcome = await reconcileParentAppend(sessions, parent, (event) => sameChildSpawn(event, spawnRecord))
      if (outcome === 'missing') throw new Error('parent did not persist the child spawn record')
      if (outcome === 'uncertain') {
        // Do not launch unparented work, delete a possibly committed child, or
        // call it failed. It remains retained until canonical storage can be
        // reconciled (or its root is deleted).
        child.status = 'uncertain'
        child.failure = 'the parent spawn record may have persisted, but canonical storage could not be read'
        child.finished = true
        child.settle()
      }
    } catch (error) {
      // Before the commit point: nothing may survive this attempt. (Recovery
      // also refuses any leftover the delete cannot remove: without the
      // parent's record it is not a child.)
      if (child !== undefined) {
        this.active.delete(child.childSessionId)
        this.turnChildren.get(turnKey)?.delete(child.childSessionId)
        if (child.status === 'queued') {
          child.status = 'failed'
          child.failure = `spawn failed before it was recorded: ${errorText(error)}`
        }
        child.finished = true
        child.settle()
      }
      if (session !== undefined) await sessions.delete(session.id).catch(() => {})
      this.releaseActive(root)
      const remaining = (this.spawnedPerTurn.get(turnKey) ?? 1) - 1
      if (remaining > 0) this.spawnedPerTurn.set(turnKey, remaining)
      else this.spawnedPerTurn.delete(turnKey)
      throw error
    }
    const childSession = session

    // ── committed or explicitly uncertain: preserve the child either way ──
    this.indexChild(root, childSession.id)
    if (child.status === 'uncertain') return this.withResult(child)

    try {
      // Ceiling = admission exposure ∩ definition ∩ explicit grant − disallowed.
      // Admission exposure is host-resolved and pinned before durable spawn;
      // a grant only narrows it. MCP always requires an explicit spawn grant.
      const disallowed = new Set(request.definition.disallowedTools)
      const eligible = new Set(pinnedExposureCeiling)
      const grant = request.grantTools ?? undefined
      const base = request.definition.tools.filter((tool) => {
        if (!eligible.has(tool)) return false
        if (tool.startsWith('mcp__')) return grant?.includes(tool) === true
        return grant !== undefined ? grant.includes(tool) : true
      })
      const toolCeiling = [...new Set(base)].filter((tool) => !disallowed.has(tool))

      // The COMPLETE child scope (childOf included) is the agent's immutable
      // identity: Agent.run() re-enters agentScope with it, so the exposure
      // gate sees the definition ceiling on every child tool start and the
      // context builder sees the pinned role instructions on every request.
      const identity: AgentScope = {
        sessionId: childSession.id,
        rootSessionId: root,
        workspaceId: request.workspaceId,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        childOf: {
          parentSessionId: root,
          parentTurnId: request.parentTurnId,
          definition: request.definition.name,
          instructions: request.definition.instructions,
          toolCeiling,
          ...(request.definition.skills !== undefined ? { skills: request.definition.skills } : {}),
          ...(request.inheritedContext !== undefined ? { inheritedContext: request.inheritedContext } : {}),
          ...(request.grants !== undefined && request.grants.length > 0 ? { grants: request.grants } : {}),
        },
      }
      const agent = agents.create(childSession, identity)
      child.agent = agent

      child.launch = async () => {
        // Run through the child's OWN identity (Agent.run re-stamps it): the
        // outer agentScope.run satisfies listeners expecting a scope during
        // setup. This starts only after fair dispatch claims the child.
        await agentScope.run(identity, async () => {
          try {
            if (child.status === 'dispatching') {
              child.status = 'running'
              agent.send(renderPacket(request.packet, brief))
              await agent.run()
              if (child.status === 'running') {
                const terminal = terminalTurnReason(child.events)
                if (terminal === 'completed') child.status = 'completed'
                else {
                  child.status = 'failed'
                  child.failure = terminal === undefined
                    ? 'the child run returned without a terminal turn record'
                    : `the child terminal turn ended ${terminal}`
                }
              }
            }
          } catch (error) {
            if (child.status === 'running' || child.status === 'dispatching') {
              child.status = 'failed'
              child.failure = errorText(error)
            }
          }
          await this.finish(child)
        })
      }
      this.enqueue(child)
    } catch (error) {
      // Launch failed after the relationship became durable: a failed child,
      // never an orphaned session.
      child.status = 'failed'
      child.failure = `launch failed: ${errorText(error)}`
      await this.finish(child)
    }
    return this.withResult(child)
  }

  /**
   * Event-driven wait over one or more children: settles when every named
   * child has settled, the timeout fires, or the caller's signal aborts —
   * whichever comes first. A timeout (or an abort) reports whatever is true
   * then and never cancels. Workspace-scoped: foreign or unknown ids are
   * dropped, so an empty result is the 404-shaped miss.
   */
  async wait(
    workspaceId: WorkspaceId,
    childSessionIds: readonly SessionId[],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ChildHandle[]> {
    const targets: (InternalChild | SettledEntry)[] = []
    for (const id of childSessionIds) {
      const child = await this.lookup(workspaceId, id)
      if (child !== undefined) targets.push(child)
    }
    if (targets.length === 0) return []

    const settled = Promise.all(targets.map((child) => (isLive(child) ? child.settled : undefined)))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs ?? 30_000)
      timer.unref?.()
    })
    // An already-aborted signal never fires its listener, so the check comes
    // first: a root Stop returns immediately instead of sitting out the timeout.
    const signal = options.signal
    let onAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => {
      if (signal === undefined) return
      if (signal.aborted) { resolve(); return }
      onAbort = (): void => { resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race<unknown>([settled, deadline, aborted])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
    return targets.map((child) => (isLive(child) ? this.withResult(child) : child.handle))
  }

  /** Cancel one child and AWAIT its actual settlement; siblings keep running. */
  async cancel(workspaceId: WorkspaceId, childSessionId: SessionId): Promise<ChildHandle | undefined> {
    const child = await this.lookup(workspaceId, childSessionId)
    if (child === undefined) return undefined
    if (!isLive(child)) {
      await this.cancelProcesses(childSessionId)
      return child.handle
    }
    if (child.status === 'uncertain') {
      await this.cancelProcesses(childSessionId)
      return this.withResult(child)
    }
    if (child.status === 'queued' || child.status === 'dispatching' || child.status === 'running') {
      const wasQueued = child.status === 'queued'
      child.status = 'cancelled' // sticky: the runner never overwrites it
      child.endedAt = Date.now()
      if (wasQueued) {
        this.removeQueued(child)
        await this.finish(child)
      } else {
        child.agent?.stop()
        await child.settled // cleanup confirmed, not merely requested
      }
    }
    return this.withResult(child)
  }

  /**
   * Reconcile one retained lifecycle entry against canonical storage. This is a
   * bounded, workspace- and parent-ownership-checked repair operation: it
   * never retries an append through a poisoned Session. A canonical parent
   * result wins; otherwise a canonical child terminal turn proves that no
   * process can still hold this reservation. Entries with no such proof stay
   * uncertain and continue holding capacity.
   */
  async reconcile(workspaceId: WorkspaceId, childSessionId: SessionId): Promise<ChildHandle | undefined> {
    // Verify authorization before joining an id-keyed repair. Otherwise a
    // foreign caller racing the owner could receive the owner's result from
    // `settlements` without ever crossing the workspace/parent boundary.
    const live = this.active.get(childSessionId)
    const candidate = live ?? await this.reconstruct(childSessionId, workspaceId)
    if (candidate === undefined || !await this.ownsChild(workspaceId, candidate)) return undefined

    const inFlight = this.settlements.get(childSessionId)
    if (inFlight !== undefined) return inFlight
    const task = this.reconcileOne(workspaceId, childSessionId)
    this.settlements.set(childSessionId, task)
    try {
      return await task
    } finally {
      if (this.settlements.get(childSessionId) === task) this.settlements.delete(childSessionId)
    }
  }

  /**
   * The one repair path for a retained live child and a restart-reconstructed
   * child. It reads canonical records before selecting a terminal status, then
   * appends exactly one parent result through a usable single writer. A poisoned
   * loaded parent is never reused; a fresh session after restart is the fence.
   */
  private async reconcileOne(workspaceId: WorkspaceId, childSessionId: SessionId): Promise<ChildHandle | undefined> {
    const sessions = this.sessions()
    if (sessions?.readCanonicalEvents === undefined) return undefined
    const live = this.active.get(childSessionId)
    // A live runner owns its terminal transition. Reconciliation is only for
    // retained, already-finished uncertain entries; otherwise it could observe
    // the child's terminal turn between `run()` and `finish()`, append the
    // parent result itself, and race finish's capacity release.
    if (live !== undefined && (!live.finished || live.status !== 'uncertain')) return this.withResult(live)
    const child = live ?? await this.reconstruct(childSessionId, workspaceId)
    if (child === undefined || !await this.ownsChild(workspaceId, child)) return undefined
    let parentEvents: readonly SessionEvent[] | undefined
    let childEvents: readonly SessionEvent[] | undefined
    try {
      parentEvents = await sessions.readCanonicalEvents(child.parentSessionId)
      childEvents = await sessions.readCanonicalEvents(child.childSessionId)
    } catch {
      return this.withResult(child)
    }
    if (parentEvents === undefined || childEvents === undefined) return this.withResult(child)
    if (!spawnCommitted(parentEvents, childSessionId)) {
      // A retained spawn never launched any work. Once canonical storage proves
      // its parent record absent, it is safe to undo the pre-launch allocation.
      // Do this only for the live retained entry: a restart cannot establish
      // that an historical child was never launched.
      if (live !== undefined && live.agent === undefined && live.status === 'uncertain') {
        try {
          await sessions.delete(childSessionId)
        } catch {
          return this.withResult(child)
        }
        this.active.delete(childSessionId)
        this.settledHandles.delete(childSessionId)
        const ids = this.childIdsByRoot.get(child.parentSessionId)
        ids?.delete(childSessionId)
        if (ids?.size === 0) this.childIdsByRoot.delete(child.parentSessionId)
        // Removing the active entry before releasing makes a repeated reconcile
        // a no-op, so this reservation is released exactly once.
        this.releaseActive(child.parentSessionId)
        child.settle()
        ;(this.ctx.get('agents') as { forget?(id: SessionId): void } | undefined)?.forget?.(childSessionId)
        return undefined
      }
      return this.withResult(child)
    }
    // A canonical cancelled turn is not proof that process cleanup succeeded.
    if (terminalTurnReason(childEvents) === 'cancelled') {
      try { await this.cancelProcesses(childSessionId) } catch { return this.withResult(child) }
    }
    let result = latestChildResult(parentEvents, childSessionId)
    if (result === undefined || !isTerminalStatus(result.status)) {
      // A child no live runner owns can never come back: with no terminal turn
      // anywhere, the restart view reads `interrupted`, so the repair settles
      // to that same verdict instead of leaving the parent's spawn result-less
      // forever — every projection reads a result-less spawn as still running.
      const terminal = terminalTurnReason(childEvents) ?? (live === undefined ? 'interrupted' : undefined)
      if (terminal === undefined) {
        // A committed spawn that never launched can never settle by itself:
        // no runner owns it and the unreliable parent writer behind the
        // uncertainty is never retried. The restart view of the same logs is
        // `interrupted`, so the live repair settles identically and releases
        // the reservation instead of holding it until the root is deleted.
        if (live !== undefined && live.agent === undefined) {
          live.status = 'interrupted'
          live.failure = 'the spawn commit could not be confirmed before launch; the child never ran'
          live.resultComputed = false
          delete live.result
          delete live.partial
          delete live.error
          this.finalizeCanonical(live)
          return this.withResult(live)
        }
        return this.withResult(child)
      }
      // An `interrupted` record carries no error: the recovery fact is the
      // outcome, and reconstruct must render the same text whether it reads
      // the record or the bare log.
      const status: Exclude<ChildStatus, 'running' | 'uncertain'> = terminal === 'completed'
        ? 'completed'
        : terminal === 'cancelled'
        ? 'cancelled'
        : terminal === 'interrupted' ? 'interrupted' : 'failed'
      const error = status === 'completed' || status === 'interrupted'
        ? undefined
        : `the child terminal turn ended ${terminal}`
      const record = {
        type: 'agent/child-result' as const,
        childSessionId,
        parentTurnId: child.parentTurnId,
        status,
        ...(error !== undefined ? { error } : {}),
      }
      try {
        const parent = await sessions.load(child.parentSessionId)
        // Never append via an instance whose writer has already been poisoned.
        if (parent.poisoned === true) return this.withResult(child)
        parent.append(record)
        const outcome = await reconcileParentAppend(sessions, parent, (event) => sameChildResult(event, record))
        if (outcome !== 'committed') return this.withResult(child)
      } catch {
        return this.withResult(child)
      }
      try {
        parentEvents = await sessions.readCanonicalEvents(child.parentSessionId)
      } catch {
        return this.withResult(child)
      }
      result = parentEvents === undefined ? undefined : latestChildResult(parentEvents, childSessionId)
      if (result === undefined || !isTerminalStatus(result.status)) return this.withResult(child)
    }
    child.status = result.status
    if (result.error !== undefined) child.failure = result.error
    else delete child.failure
    child.events = childEvents
    child.endedAt ??= result.timestamp
    child.resultComputed = false
    delete child.result
    delete child.partial
    delete child.error
    if (live !== undefined) this.finalizeCanonical(child)
    else this.remember({ handle: this.withResult(child), workspaceId: child.workspaceId, parentSessionId: child.parentSessionId })
    return this.withResult(child)
  }

  /** Record that these children's outcomes reached the model that spawned them. */
  markReported(childSessionIds: readonly SessionId[]): void {
    for (const id of childSessionIds) {
      this.reported.delete(id)
      this.reported.add(id)
    }
    while (this.reported.size > MAX_REPORTED) {
      const oldest = this.reported.values().next().value
      if (oldest === undefined) break
      this.reported.delete(oldest)
    }
  }

  /** Children one root turn spawned whose outcome the model has not been handed yet. */
  owedChildrenOfTurn(root: SessionId, turnId: string): SessionId[] {
    return [...(this.turnChildren.get(`${root}:${turnId}`) ?? [])].filter((id) => !this.reported.has(id))
  }

  /**
   * The children one root turn spawned whose outcome the model has not seen,
   * waited for until they settle. A root that closes its turn while they run
   * would cancel them and lose everything they did; this is what it joins
   * instead. Bounded by `timeoutMs` — children still running then are
   * cancelled (and report what they got done) — and by `signal`, a user stop,
   * which ends the wait without cancelling: Stop owns that cleanup.
   */
  async joinTurnChildren(
    workspaceId: WorkspaceId,
    root: SessionId,
    turnId: string,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<ChildHandle[]> {
    const ids = this.owedChildrenOfTurn(root, turnId)
    if (ids.length === 0) return []
    const deadline = Date.now() + Math.max(options.timeoutMs, 0)
    const live = (): SessionId[] => ids.filter((id) => {
      const child = this.active.get(id)
      return child !== undefined && !child.finished && (child.status === 'queued' || child.status === 'dispatching' || child.status === 'running')
    })
    for (let pending = live(); pending.length > 0; pending = live()) {
      if (options.signal?.aborted === true) return []
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        for (const id of pending) await this.cancel(workspaceId, id)
        break
      }
      await this.wait(workspaceId, pending, {
        timeoutMs: Math.min(remaining, 60_000),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
    }
    const handles = await this.wait(workspaceId, ids, { timeoutMs: 1 })
    this.markReported(handles.filter((handle) => handle.status !== 'running' && handle.status !== 'queued' && handle.status !== 'dispatching').map((handle) => handle.childSessionId))
    return handles
  }

  /** Root Stop: cancel every queued or running child of one root and await settlement. */
  async cancelAllOfRoot(parentSessionId: SessionId): Promise<number> {
    return this.cancelWhere((child) => child.parentSessionId === parentSessionId)
  }

  /** Root turn completion cleans up only children of this Turn. */
  async resolveForRootCompletion(parentSessionId: SessionId, parentTurnId: string): Promise<number> {
    return this.cancelWhere((child) => child.parentSessionId === parentSessionId && child.parentTurnId === parentTurnId)
  }

  private async cancelWhere(owns: (child: InternalChild) => boolean): Promise<number> {
    const active = [...this.active.values()].filter((child) =>
      owns(child) && (child.status === 'queued' || child.status === 'dispatching' || child.status === 'running'))
    const queued: Promise<void>[] = []
    for (const child of active) {
      const wasQueued = child.status === 'queued'
      child.status = 'cancelled'
      child.endedAt = Date.now()
      if (wasQueued) {
        this.removeQueued(child)
        queued.push(this.finish(child))
      } else {
        child.agent?.stop()
      }
    }
    await Promise.all([...queued, ...active.map((child) => child.settled)])
    return active.length
  }

  /**
   * A root turn reached its terminal lifecycle hook: its per-turn spawn
   * budgets are spent history and are dropped. This runs through the SAME
   * admission writer as spawn: a spawn still committing for the finished
   * turn completes first, so its key cannot be dropped and then re-created
   * by the commit — a leak only forgetRoot would remove.
   */
  async releaseTurns(parentSessionId: SessionId): Promise<void> {
    await this.withAdmission(parentSessionId, async () => {
      const prefix = `${parentSessionId}:`
      for (const key of [...this.spawnedPerTurn.keys()]) {
        if (key.startsWith(prefix)) this.spawnedPerTurn.delete(key)
      }
      for (const [key, ids] of [...this.turnChildren]) {
        if (!key.startsWith(prefix)) continue
        for (const id of ids) this.reported.delete(id)
        this.turnChildren.delete(key)
      }
    })
  }

  /**
   * A root session was deleted: drop every index it still owns. Returns the
   * child ids it indexed, so the host can drop their per-session state too.
   */
  async forgetRoot(parentSessionId: SessionId): Promise<SessionId[]> {
    // This hook is valid only after `sessions.delete()` succeeded. A failed
    // deletion leaves the root able to recover its terminal failure, so its
    // reservations must remain held.
    if (this.sessions()?.has(parentSessionId) !== false) return []
    await this.releaseTurns(parentSessionId)
    const ids = [...(this.childIdsByRoot.get(parentSessionId) ?? [])]
    this.childIdsByRoot.delete(parentSessionId)
    for (const child of [...this.active.values()]) {
      if (child.parentSessionId !== parentSessionId) continue
      this.active.delete(child.childSessionId)
      // Deletion follows successful root removal, so a retained terminal
      // failure can no longer be recovered through that root. Every entry
      // still in `active` holds exactly one reservation; removing it first
      // makes repeated cleanup a no-op.
      child.finished = true
      child.settle()
      this.releaseActive(parentSessionId)
      ;(this.ctx.get('agents') as { forget?(id: SessionId): void } | undefined)?.forget?.(child.childSessionId)
    }
    for (const id of ids) this.settledHandles.delete(id)
    return ids
  }

  /** Keep one settled handle, evicting the oldest past the bound. */
  private remember(entry: SettledEntry): void {
    this.settledHandles.delete(entry.handle.childSessionId)
    this.settledHandles.set(entry.handle.childSessionId, entry)
    while (this.settledHandles.size > MAX_SETTLED_HANDLES) {
      const oldest = this.settledHandles.keys().next().value
      if (oldest === undefined) break
      this.settledHandles.delete(oldest)
    }
  }

  /** A settled child's handle: cached, or rebuilt once from the durable logs. */
  private async settledHandle(
    childSessionId: SessionId,
    workspaceId: WorkspaceId | undefined,
    parentEvents?: readonly SessionEvent[],
  ): Promise<SettledEntry | undefined> {
    const cached = this.settledHandles.get(childSessionId)
    if (cached !== undefined) return workspaceId === undefined || cached.workspaceId === workspaceId ? cached : undefined
    const child = await this.reconstruct(childSessionId, workspaceId, parentEvents)
    if (child === undefined) return undefined
    const entry = { handle: this.withResult(child), workspaceId: child.workspaceId, parentSessionId: child.parentSessionId }
    this.remember(entry)
    return entry
  }

  private indexChild(parentSessionId: SessionId, childSessionId: SessionId): void {
    const ids = this.childIdsByRoot.get(parentSessionId) ?? new Set<SessionId>()
    ids.add(childSessionId)
    this.childIdsByRoot.set(parentSessionId, ids)
  }

  private releaseActive(parentSessionId: SessionId): void {
    const remaining = (this.reservedPerRoot.get(parentSessionId) ?? 1) - 1
    if (remaining > 0) this.reservedPerRoot.set(parentSessionId, remaining)
    else this.reservedPerRoot.delete(parentSessionId)
  }

  /**
   * Terminal bookkeeping, exactly once: release active capacity (the
   * per-turn attempt stays charged), write the durable terminal record,
   * settle waiters, and evict the entry only once that record is durable.
   */
  private async cancelProcesses(sessionId: SessionId): Promise<void> {
    const processes = this.ctx.get('processes') as { cancelSession(id: SessionId): Promise<void> } | undefined
    await processes?.cancelSession(sessionId)
    await this.flushProcesses(sessionId)
  }

  private async flushProcesses(sessionId: SessionId): Promise<void> {
    const bridge = this.ctx.get('process-events') as { flush(id: SessionId): Promise<void> } | undefined
    await bridge?.flush(sessionId)
  }

  private async finish(child: InternalChild): Promise<void> {
    if (child.finished) return
    child.endedAt ??= Date.now()
    if (child.status === 'running' || child.status === 'queued' || child.status === 'dispatching') child.status = 'failed'
    if (child.status === 'failed' && child.failure === undefined) child.failure = 'the child run failed'
    let parent: StoredSession | undefined
    try {
      const sessions = this.sessions()
      if (sessions === undefined) throw new Error('no sessions service mounted')
      if (child.status === 'cancelled') await this.cancelProcesses(child.childSessionId)
      else await this.flushProcesses(child.childSessionId)
      // Flush the child before making its terminal status visible from the
      // parent. Otherwise a failed child flush can leave a durable completed
      // parent record that contradicts the child's recoverable log.
      await (await sessions.load(child.childSessionId)).durable()
      parent = await sessions.load(child.parentSessionId)
      const resultRecord = {
        type: 'agent/child-result' as const,
        childSessionId: child.childSessionId,
        parentTurnId: child.parentTurnId,
        status: child.status,
        ...(child.failure !== undefined ? { error: child.failure } : {}),
      }
      parent.append(resultRecord)
      const outcome = await reconcileParentAppend(sessions, parent, (event) => sameChildResult(event, resultRecord))
      if (outcome === 'missing') throw new Error('parent did not persist the child result record')
      if (outcome === 'uncertain') {
        // The selected terminal state is not contradicted, but it cannot be
        // advertised as durable. Keep its reservation and child log intact.
        child.status = 'uncertain'
        child.failure = 'the parent result record may have persisted, but canonical storage could not be read'
        delete child.result
        delete child.partial
        delete child.error
        child.resultComputed = false
        child.finished = true
        child.settle()
        return
      }
    } catch (error) {
      // No failed durability barrier establishes a parent terminal record. This
      // includes the child-log flush: it may contain a terminal turn in memory,
      // but until canonical reads prove it, neither a failed result nor capacity
      // release is safe. `reconcile()` owns the later canonical repair.
      child.status = 'uncertain'
      child.failure = parent?.poisoned === true
        ? `the parent result record is not durably known: ${errorText(error)}`
        : `terminal persistence is not durably known: ${errorText(error)}`
      delete child.result
      delete child.partial
      delete child.error
      child.resultComputed = false
      child.finished = true
      child.settle()
      return
    }
    child.finished = true
    this.finalizeCanonical(child)
  }

  /** Release an active reservation only after a terminal canonical fact exists. */
  private finalizeCanonical(child: InternalChild): void {
    this.releaseActive(child.parentSessionId)
    const handle = this.withResult(child)
    child.settle()
    this.remember({ handle, workspaceId: child.workspaceId, parentSessionId: child.parentSessionId })
    this.active.delete(child.childSessionId)
    // The finished agent is not needed again; its session log is canonical.
    ;(this.ctx.get('agents') as { forget?(id: SessionId): void } | undefined)?.forget?.(child.childSessionId)
  }

  /** An active child, or a settled one from the cache or the durable logs. */
  private async lookup(workspaceId: WorkspaceId, childSessionId: SessionId): Promise<InternalChild | SettledEntry | undefined> {
    const live = this.active.get(childSessionId)
    if (live !== undefined) return await this.ownsChild(workspaceId, live) ? live : undefined
    const settled = await this.settledHandle(childSessionId, workspaceId)
    if (settled === undefined) return undefined
    const child = await this.reconstruct(childSessionId, workspaceId)
    return child !== undefined && await this.ownsChild(workspaceId, child) ? settled : undefined
  }

  /** Validate direct lifecycle access with the same parent boundaries as recovery. */
  private async ownsChild(workspaceId: WorkspaceId, child: Pick<InternalChild, 'workspaceId' | 'parentSessionId' | 'projectId'>): Promise<boolean> {
    if (child.workspaceId !== workspaceId) return false
    const sessions = this.sessions()
    if (sessions === undefined || !sessions.has(child.parentSessionId)) return false
    const parent = await sessions.load(child.parentSessionId).catch(() => undefined)
    return parent !== undefined &&
      sessions.workspaceOf(parent.id) === child.workspaceId &&
      boundProject(parent.events) === child.projectId
  }

  /**
   * Rebuild a settled child from its own log and its parent's records — the
   * single path for evicted entries and for restarts. A child the parent
   * never recorded (the spawn missed its commit point) is not a child. The
   * status is the parent's terminal record; without one, a terminal child
   * turn is `uncertain` and an incomplete child is `interrupted`.
   */
  private async reconstruct(
    childSessionId: SessionId,
    workspaceId?: WorkspaceId,
    parentEvents?: readonly SessionEvent[],
  ): Promise<InternalChild | undefined> {
    const sessions = this.sessions()
    if (sessions === undefined || !sessions.has(childSessionId)) return undefined
    const owner = sessions.workspaceOf(childSessionId)
    if (owner === undefined || (workspaceId !== undefined && owner !== workspaceId)) return undefined
    const loaded = await sessions.load(childSessionId).catch(() => undefined)
    if (loaded === undefined) return undefined
    const meta = childMetaOf(loaded.events)
    if (meta === undefined) return undefined
    const parentId = meta.parentSessionId as SessionId
    const recordsOf = parentEvents
      ?? (sessions.has(parentId) ? (await sessions.load(parentId).catch(() => undefined))?.events : undefined)
      ?? []
    if (!spawnCommitted(recordsOf, childSessionId)) return undefined
    let record: Extract<SessionEvent, { type: 'agent/child-result' }> | undefined
    for (const event of recordsOf) {
      if (event.type === 'agent/child-result' && event.childSessionId === childSessionId) record = event
    }
    // A terminal child turn proves only that the child stopped. It never proves
    // the parent accepted its result, so a completed child without a parent
    // result stays uncertain across process boundaries until settlement repairs
    // it. An open/incomplete child remains the existing interrupted recovery
    // fact: no terminal candidate exists to settle.
    const terminal = terminalTurnReason(loaded.events)
    const status: ChildStatus = record !== undefined && isTerminalStatus(record.status)
      ? record.status
      : terminal === undefined || terminal === 'interrupted' ? 'interrupted' : 'uncertain'
    // The child's model lives in its own log, so a reconstructed card reports
    // the pair it actually ran on rather than today's default.
    const stamped = [...loaded.events].reverse().find((event) => event.type === 'session/model')
    const model: ChildModel | undefined =
      stamped?.type === 'session/model' && typeof stamped.provider === 'string' && typeof stamped.model === 'string'
        ? { provider: stamped.provider, model: stamped.model, ...(stamped.thinkingLevel !== undefined ? { thinkingLevel: stamped.thinkingLevel } : {}) }
        : undefined
    return {
      childSessionId,
      workspaceId: owner,
      parentSessionId: parentId,
      parentTurnId: meta.parentTurnId,
      ...(meta.projectId !== undefined ? { projectId: meta.projectId as ProjectId } : {}),
      definitionName: meta.definition,
      ...(model !== undefined ? { model } : {}),
      events: loaded.events,
      status,
      startedAt: meta.timestamp,
      endedAt: record?.timestamp ?? loaded.events[loaded.events.length - 1]?.timestamp ?? meta.timestamp,
      ...(record?.error !== undefined ? { failure: record.error } : {}),
      resultComputed: false,
      finished: true,
      settled: Promise.resolve(),
      settle: () => {},
    }
  }

  /**
   * The handle, with the result-or-error derivation computed once per child
   * (`resultComputed`), whether or not a result exists. Only a completed
   * child may carry a result: its last non-empty assistant message that
   * declares no tool calls. Every other terminal state — and a completed
   * child without such a message — gets an honest error naming its log.
   */
  private withResult(child: InternalChild): ChildHandle {
    if (!child.resultComputed && child.status !== 'running' && child.status !== 'queued' && child.status !== 'dispatching') {
      const logPointer = `its full log is session ${child.childSessionId}`
      if (child.status === 'completed') {
        const result = digest(child.events)
        if (result !== undefined) child.result = result
        else child.error = `the child produced no final report; ${logPointer}`
      } else {
        const partial = digestPartial(child.events)
        if (partial !== undefined) child.partial = partial
        child.error = child.failure !== undefined
          ? `${child.failure}; the child did not complete (${child.status}); ${logPointer}`
          : `the child did not complete (${child.status}); ${logPointer}`
      }
      child.resultComputed = true
    }
    return {
      childSessionId: child.childSessionId,
      status: child.status,
      definitionName: child.definitionName,
      ...(child.model !== undefined ? { model: `${child.model.provider}:${child.model.model}` } : {}),
      startedAt: child.startedAt,
      ...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
      ...(child.result !== undefined ? { result: child.result } : {}),
      ...(child.partial !== undefined ? { partial: child.partial } : {}),
      ...(child.error !== undefined ? { error: child.error } : {}),
      ...(child.status === 'running' && awaitsApproval(child.events) ? { awaitingApproval: true } : {}),
    }
  }
}

/** The report (last tool-free message) and files touched, or undefined. */
function digest(events: readonly SessionEvent[]): ChildResult | undefined {
  return digestMessage(events, false)
}

/**
 * What a child that never finished left behind: its last non-empty message —
 * narration beside a tool call included — and the files it touched.
 */
function digestPartial(events: readonly SessionEvent[]): ChildResult | undefined {
  const touched = digestMessage(events, true)
  if (touched !== undefined) return touched
  const files = filesTouchedBy(events)
  return files.length > 0 ? { report: '', filesTouched: files } : undefined
}

function filesTouchedBy(events: readonly SessionEvent[]): string[] {
  const files = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/call' || !FILE_ARG_TOOLS.has(event.call.name)) continue
    const filePath = event.call.args['path']
    if (typeof filePath === 'string' && filePath !== '') files.add(filePath)
  }
  return [...files].slice(0, MAX_FILES_TOUCHED)
}

function digestMessage(events: readonly SessionEvent[], includeToolTurns: boolean): ChildResult | undefined {
  let report: string | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    if (!includeToolTurns && event.toolCalls !== undefined && event.toolCalls.length > 0) continue
    const content = event.content.trim()
    if (content === '') continue
    report = content
    break
  }
  if (report === undefined) return undefined
  const files = filesTouchedBy(events)
  const truncated = report.length > MAX_REPORT_CHARS
  return {
    report: truncated
      ? `${report.slice(0, MAX_REPORT_CHARS)}\n… [truncated ${report.length - MAX_REPORT_CHARS} chars]`
      : report,
    filesTouched: files,
    ...(truncated ? { truncated: true } : {}),
  }
}

function childMetaOf(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'session/child-meta' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/child-meta') return event
  }
  return undefined
}

/** Whether the parent recorded this spawn — the relationship's commit point. */
function spawnCommitted(parentEvents: readonly SessionEvent[], childSessionId: string): boolean {
  return parentEvents.some((event) => event.type === 'agent/child-spawn' && event.childSessionId === childSessionId)
}

function isLive(child: InternalChild | SettledEntry): child is InternalChild {
  return 'settle' in child
}

/** The project a session is bound to, from its durable `session/project`. */
function boundProject(events: readonly SessionEvent[]): ProjectId | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/project') return event.projectId === null ? undefined : (event.projectId as ProjectId)
  }
  return undefined
}

function isTerminalStatus(status: string): status is Exclude<ChildStatus, 'running' | 'uncertain'> {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

/** The last durable terminal result for one child; parent log is authoritative. */
function latestChildResult(
  events: readonly SessionEvent[],
  childSessionId: SessionId,
): Extract<SessionEvent, { type: 'agent/child-result' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'agent/child-result' && event.childSessionId === childSessionId) return event
  }
  return undefined
}

type ParentAppendOutcome = 'committed' | 'missing' | 'uncertain'

/**
 * A durable acknowledgement is not proof of absence when it rejects: the
 * write might have reached storage before the Session became poisoned. After a
 * rejection, only the store's canonical parent log decides the lifecycle
 * record. We never retry the append through a poisoned Session.
 */
async function reconcileParentAppend(
  sessions: SessionsLike,
  parent: StoredSession,
  matches: (event: SessionEvent) => boolean,
): Promise<ParentAppendOutcome> {
  try {
    await parent.durable()
    return 'committed'
  } catch (error) {
    // Wrapper and store failures can both occur after the append reached disk;
    // canonical storage is the only authority when it can be read. Without a
    // durable reader, retain the historical non-poisoned failure behavior.
    if (sessions.readCanonicalEvents === undefined) {
      if (parent.poisoned !== true) throw error
      return 'uncertain'
    }
    try {
      const canonical = await sessions.readCanonicalEvents(parent.id)
      if (canonical === undefined) return parent.poisoned === true ? 'uncertain' : (() => { throw error })()
      return canonical.some(matches) ? 'committed' : 'missing'
    } catch (canonicalError) {
      // The deliberate original-error rethrow above must remain observable.
      if (canonicalError === error) throw error
      return 'uncertain'
    }
  }
}

/** Exact identity for the one spawn append this executor issued. */
function sameChildSpawn(
  event: SessionEvent,
  expected: { readonly childSessionId: SessionId; readonly parentTurnId: string; readonly definition: string; readonly brief: string },
): boolean {
  return event.type === 'agent/child-spawn' &&
    event.childSessionId === expected.childSessionId &&
    event.parentTurnId === expected.parentTurnId &&
    event.definition === expected.definition &&
    event.brief === expected.brief
}

/** Exact identity for the one terminal-result append this executor issued. */
function sameChildResult(
  event: SessionEvent,
  expected: { readonly childSessionId: SessionId; readonly parentTurnId: string; readonly status: ChildStatus; readonly error?: string },
): boolean {
  return event.type === 'agent/child-result' &&
    event.childSessionId === expected.childSessionId &&
    event.parentTurnId === expected.parentTurnId &&
    event.status === expected.status &&
    event.error === expected.error
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** An approval request with no decision yet: the child is parked on a human. */
function awaitsApproval(events: readonly SessionEvent[]): boolean {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.type === 'approval/decision') decided.add(event.approvalId)
  }
  return events.some((event) => event.type === 'approval/request' && !decided.has(event.approvalId))
}

/** The terminal reason of the child's newest turn, if it closed one. */
function terminalTurnReason(events: readonly SessionEvent[]): TurnEndReason | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'turn/end') return event.reason
    if (event?.type === 'turn/start') return undefined
  }
  return undefined
}

/**
 * The child's opening message: the brief, then the required result. The
 * role's instructions are NOT here — they are the child's system prompt.
 * Empty structured sections are omitted rather than padded.
 */
function renderPacket(packet: TaskPacket, brief: string): string {
  const prose = packet.prompt?.trim() === brief
  return [
    ...(prose ? [brief] : ['## Task', brief]),
    ...(packet.constraints !== undefined && packet.constraints.length > 0 ? ['## Constraints', packet.constraints.map((c) => `- ${c}`).join('\n')] : []),
    ...(packet.references !== undefined && packet.references.length > 0 ? ['## References', packet.references.map((r) => `- ${r}`).join('\n')] : []),
    '## Required result', packet.requiredResult,
  ].join('\n\n')
}
