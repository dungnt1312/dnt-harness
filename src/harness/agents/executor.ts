/**
 * Bounded one-level multi-agent execution (G4): the root agent spawns
 * children through the SAME G1 loop and G3 builder — there is no second
 * runtime. Children get a task packet, an isolated session, and a capability
 * ceiling = mode exposure ∩ definition ∩ spawn grant (intersection — a grant
 * never widens the definition); they can never spawn children. Internal
 * lifecycle: spawn / list / wait / result / cancel. No steering, no detached
 * children, no automatic restart resumption — restart recovers relationships
 * from durable logs and marks unfinished children interrupted.
 */
import type { Context } from '../../kernel/index.ts'
import type { SessionId, WorkspaceId, ProjectId } from '../../util/brand.ts'
import type { Agent } from '../agent/agent.ts'
import { agentScope, type AgentScope } from '../agent/scope.ts'
import type { AgentDefinition } from './definition-service.ts'
import type { SessionEvent } from '../session/events.ts'

/** Task packet: the ONLY parent context a child receives. */
export interface TaskPacket {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly references: readonly string[]
  readonly requiredResult: string
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

export interface SpawnRequest {
  readonly workspaceId: WorkspaceId
  readonly projectId?: ProjectId | undefined
  /** The root session/turn that owns this child. */
  readonly parentSessionId: SessionId
  readonly parentTurnId: string
  readonly definition: AgentDefinition
  readonly packet: TaskPacket
  /**
   * Spawn grant: INTERSECTS the definition's tool ceiling (never widens it).
   * Omitted grants leave the definition's tools in force.
   */
  readonly grantTools?: readonly string[] | undefined
  /** Stamped into the child's own log; omitted leaves the host's defaults. */
  readonly model?: ChildModel | undefined
}

export type ChildStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Runtime status is distinct from any model claim of success. */
export interface ChildHandle {
  readonly childSessionId: SessionId
  readonly status: ChildStatus
  readonly definitionName: string
  /** The child's effective `provider:model`, when one was stamped. */
  readonly model?: string
  readonly startedAt: number
  readonly endedAt?: number
  /** Bounded digest extracted from the child log (summary + file refs). */
  readonly result?: { readonly summary: string; readonly fileReferences: readonly string[] }
  readonly error?: string
  /** A running child parked on an approval nobody has answered yet. */
  readonly awaitingApproval?: boolean
}

const MAX_ACTIVE_CHILDREN = 3
const MAX_CHILDREN_PER_TURN = 8

export class SpawnError extends Error {
  constructor(
    readonly code: 'capacity' | 'depth',
    message: string,
  ) {
    super(message)
    this.name = 'SpawnError'
  }
}

interface InternalChild {
  readonly childSessionId: SessionId
  /** Immutable ownership — lifecycle lookups are workspace-scoped. */
  readonly workspaceId: WorkspaceId
  readonly parentSessionId: SessionId
  readonly parentTurnId: string
  readonly definition: AgentDefinition
  grantTools: readonly string[]
  readonly model?: ChildModel
  readonly agent?: Agent
  /** Durable events (always present; recovered children may have no live agent). */
  readonly events: readonly SessionEvent[]
  status: ChildStatus
  readonly startedAt: number
  endedAt?: number
  result?: { readonly summary: string; readonly fileReferences: readonly string[] }
  failure?: string
  /** Resolves when the run loop fully settles (event-driven wait). */
  readonly settled: Promise<void>
}

export class ChildExecutor {
  private readonly children = new Map<SessionId, InternalChild>()
  private readonly spawnedPerTurn = new Map<string, number>()
  /** Active capacity reservations include spawns that have not reached children.set yet. */
  private reservedActive = 0

  constructor(private readonly ctx: Context) {}

  /**
   * Recover child relationships from durable logs after a restart: any
   * stored session carrying `session/child-meta` registers as a child of
   * its recorded parent. Unfinished children surface as `interrupted` —
   * never `running`, never re-executed. Idempotent.
   */
  async recoverFromStorage(): Promise<number> {
    const sessions = this.ctx.get('sessions') as
      | {
          summaries(): { id: SessionId }[]
          workspaceOf(id: SessionId): WorkspaceId | undefined
          load(id: SessionId): Promise<{ events: { type: string; [key: string]: unknown }[] }>
        }
      | undefined
    if (sessions === undefined) return 0
    let recovered = 0
    for (const summary of sessions.summaries()) {
      if (this.children.has(summary.id)) continue
      const loaded = await sessions.load(summary.id).catch(() => undefined)
      if (loaded === undefined) continue
      const meta = [...loaded.events].reverse().find((event) => event.type === 'session/child-meta') as
        | { parentSessionId: string; parentTurnId: string; definition: string }
        | undefined
      if (meta === undefined) continue
      const workspaceId = sessions.workspaceOf(summary.id)
      if (workspaceId === undefined) continue
      const latestTurnEnd = [...loaded.events].reverse().find((event) => event.type === 'turn/end') as
        | { reason?: string }
        | undefined
      // The child's model lives in its own log, so a recovered card reports
      // the pair it actually ran on rather than today's default.
      const stamped = [...loaded.events].reverse().find((event) => event.type === 'session/model') as
        | { provider?: string | null; model?: string | null; thinkingLevel?: string | null }
        | undefined
      const model: ChildModel | undefined =
        typeof stamped?.provider === 'string' && typeof stamped.model === 'string'
          ? { provider: stamped.provider, model: stamped.model, ...(stamped.thinkingLevel !== undefined ? { thinkingLevel: stamped.thinkingLevel } : {}) }
          : undefined
      const openTurn = countOpenTurns(loaded.events) > 0
      const interrupted = openTurn || latestTurnEnd?.reason === 'interrupted'
      const child: InternalChild = {
        childSessionId: summary.id,
        workspaceId,
        parentSessionId: meta.parentSessionId as SessionId,
        parentTurnId: meta.parentTurnId,
        definition: { name: meta.definition, description: '', instructions: '', tools: [], disallowedTools: [] },
        grantTools: [],
        ...(model !== undefined ? { model } : {}),
        events: loaded.events as unknown as readonly SessionEvent[],
        status: interrupted ? 'interrupted' : 'completed',
        startedAt: 0,
        endedAt: Date.now(),
        settled: Promise.resolve(),
      }
      this.children.set(summary.id, child)
      recovered += 1
    }
    return recovered
  }

  childrenOfRoot(parentSessionId: SessionId, workspaceId?: WorkspaceId): ChildHandle[] {
    return [...this.children.values()]
      .filter((child) => child.parentSessionId === parentSessionId && (workspaceId === undefined || child.workspaceId === workspaceId))
      .map((child) => this.withResult(child))
  }

  /**
   * Spawn one child. Capacity is reserved SYNCHRONOUSLY before any await
   * (concurrent spawns cannot race past the limit). The spawn intent lands
   * durably in the child's own log before execution starts — a durability
   * failure aborts the spawn, it is never swallowed.
   */
  async spawn(request: SpawnRequest): Promise<ChildHandle> {
    // One-level enforcement: the parent must not itself be a child.
    const parent = this.children.get(request.parentSessionId)
    if (parent !== undefined) {
      throw new SpawnError('depth', 'one-level delegation: a child agent cannot spawn children')
    }
    const parentMeta = await this.parentIsChild(request.parentSessionId)
    if (parentMeta) {
      throw new SpawnError('depth', 'one-level delegation: the requested parent session is itself a child')
    }

    const turnKey = `${request.parentSessionId}:${request.parentTurnId}`
    // Synchronous reservation: check AND occupy both counters before any
    // await, so concurrent spawns cannot race past the limits. Rollback on
    // pre-launch failure below.
    if (this.reservedActive >= MAX_ACTIVE_CHILDREN) {
      throw new SpawnError('capacity', `capacity reached: ${MAX_ACTIVE_CHILDREN} active children`)
    }
    const spawned = this.spawnedPerTurn.get(turnKey) ?? 0
    if (spawned >= MAX_CHILDREN_PER_TURN) {
      throw new SpawnError('capacity', `capacity reached: ${MAX_CHILDREN_PER_TURN} children per turn`)
    }
    this.spawnedPerTurn.set(turnKey, spawned + 1)
    this.reservedActive += 1
    let reserved = true

    try {
      const sessions = this.ctx.get('sessions') as
        | {
            create(ws?: WorkspaceId): {
              id: SessionId
              append(event: unknown): unknown
              durable(): Promise<void>
            }
            get(id: SessionId): { append(event: unknown): unknown; durable(): Promise<void> }
          }
        | undefined
      if (sessions === undefined) throw new SpawnError('depth', 'no sessions service mounted')
      const session = sessions.create(request.workspaceId)
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
      // a REAL barrier: an unrecorded child never starts executing.
      session.append({
        type: 'session/child-meta',
        parentSessionId: request.parentSessionId,
        parentTurnId: request.parentTurnId,
        definition: request.definition.name,
        objective: request.packet.objective,
      })
      await session.durable()
      // Root relationship intent/reference is canonical too — recovery can
      // list children from either side without spawning duplicate work.
      const parentSession = sessions.get(request.parentSessionId)
      parentSession.append({
        type: 'agent/child-spawn', childSessionId: session.id,
        parentTurnId: request.parentTurnId, definition: request.definition.name,
        objective: request.packet.objective,
      })
      await parentSession.durable()

      // Ceiling = (grant ? definition ∩ grant : definition) − disallowed.
      // A grant NARROWS; it never adds a tool the definition lacks.
      const disallowed = new Set(request.definition.disallowedTools)
      const grant = request.grantTools ?? undefined
      const base = request.definition.tools.filter((tool) => {
        if (tool.startsWith('mcp__')) {
          // G5: Worker/custom children require an EXPLICIT spawn grant for
          // every MCP tool. Omitted grants exclude all MCP names.
          return grant?.includes(tool) === true
        }
        return grant !== undefined ? grant.includes(tool) : true
      })
      const toolCeiling = [...new Set(base)].filter((tool) => !disallowed.has(tool))

      const agents = this.ctx.get('agents') as
        | { create(s: unknown, identity?: unknown): Agent }
        | undefined
      if (agents === undefined) throw new SpawnError('depth', 'no agents service mounted')
      // The COMPLETE child scope (childOf included) is the agent's immutable
      // identity: Agent.run() re-enters agentScope with it, so the exposure
      // gate sees the definition ceiling on every child tool start.
      const identity: AgentScope = {
        sessionId: session.id,
        workspaceId: request.workspaceId,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        childOf: {
          parentSessionId: request.parentSessionId,
          parentTurnId: request.parentTurnId,
          definition: request.definition.name,
          toolCeiling,
          ...(request.definition.skills !== undefined ? { skills: request.definition.skills } : {}),
        },
      }
      const agent = agents.create(session, identity)

      // Event-driven settlement: wait() races this promise, no polling.
      let settleResolve: (() => void) | undefined
      const settled = new Promise<void>((resolve) => {
        settleResolve = resolve
      })

      const child: InternalChild = {
        childSessionId: session.id,
        workspaceId: request.workspaceId,
        parentSessionId: request.parentSessionId,
        parentTurnId: request.parentTurnId,
        definition: request.definition,
        grantTools: toolCeiling,
        ...(request.model !== undefined ? { model: request.model } : {}),
        agent,
        events: agent.session.events,
        status: 'running',
        startedAt: Date.now(),
        settled,
      }
      this.children.set(session.id, child)

      // Run through the child's OWN identity (Agent.run re-stamps it): the
      // outer agentScope.run here only satisfies listeners expecting a
      // scope during setup.
      void agentScope.run(identity, async () => {
        try {
          // Writer handoff: a write-capable child yields the root's held
          // lease at this safe boundary (spawn), avoiding root-waits-while-
          // child-denied deadlocks. The root's next write call re-acquires
          // only after the child settles and releases.
          if (toolCeiling.some((tool) => tool === 'Write' || tool === 'Edit' || tool === 'Bash')) {
            // Awaited handoff: the child cannot begin its first write until
            // every root lease release has completed.
            await this.ctx.serial('agent/child-writer-handoff', {
              rootSessionId: request.parentSessionId,
              childSessionId: session.id,
            })
          }
          agent.send(renderPacket(request.packet, request.definition))
          await agent.run()
          // Cancellation is sticky: a stopped child is never relabeled.
          if (child.status === 'running') child.status = 'completed'
        } catch (error) {
          if (child.status === 'running') {
            child.status = 'failed'
            child.failure = String(error instanceof Error ? error.message : error)
          }
        }
        child.endedAt = Date.now()
        try {
          const parentSession = (this.ctx.get('sessions') as { get(id: SessionId): { append(event: unknown): unknown; durable(): Promise<void> } }).get(request.parentSessionId)
          parentSession.append({ type: 'agent/child-result', childSessionId: session.id, parentTurnId: request.parentTurnId, status: child.status })
          await parentSession.durable()
        } catch {
          // Child status remains available from its own canonical log.
        }
        this.reservedActive = Math.max(0, this.reservedActive - 1)
        settleResolve?.()
      }).catch(() => {
        if (child.status === 'running') {
          child.status = 'failed'
          child.endedAt = Date.now()
        }
        this.reservedActive = Math.max(0, this.reservedActive - 1)
        settleResolve?.()
      })
      return this.withResult(child)
    } catch (error) {
      if (reserved) {
        // Roll back the per-turn reservation on any pre-launch failure.
        const remaining = (this.spawnedPerTurn.get(turnKey) ?? 1) - 1
        this.spawnedPerTurn.set(turnKey, Math.max(remaining, 0))
        this.reservedActive = Math.max(0, this.reservedActive - 1)
        reserved = false
      }
      throw error
    }
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
    const targets = childSessionIds
      .map((id) => this.children.get(id))
      .filter((child): child is InternalChild => child !== undefined && child.workspaceId === workspaceId)
    if (targets.length === 0) return []

    const settled = Promise.all(targets.map((child) => child.settled))
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
    return targets.map((child) => this.withResult(child))
  }

  /** Cancel one child and AWAIT its actual settlement; siblings keep running. */
  async cancel(workspaceId: WorkspaceId, childSessionId: SessionId): Promise<ChildHandle | undefined> {
    const child = this.children.get(childSessionId)
    if (child === undefined || child.workspaceId !== workspaceId) return undefined
    if (child.status === 'running') {
      child.status = 'cancelled' // sticky: the runner never overwrites it
      child.endedAt = Date.now()
      child.agent?.stop()
      await child.settled // cleanup confirmed, not merely requested
    }
    return this.withResult(child)
  }

  /** Root Stop: cancel every running child of one root and await settlement. */
  async cancelAllOfRoot(parentSessionId: SessionId): Promise<number> {
    const running = [...this.children.values()].filter(
      (child) => child.parentSessionId === parentSessionId && child.status === 'running',
    )
    for (const child of running) {
      child.status = 'cancelled'
      child.endedAt = Date.now()
      child.agent?.stop()
    }
    await Promise.all(running.map((child) => child.settled))
    return running.length
  }

  /**
   * Root lifecycle gate: the root cannot complete a turn while its children
   * remain active. At turn-stopping, remaining running children are
   * cancelled (the spec's "resolve by cancelling within execution budgets")
   * and awaited so `turn/end: completed` never hides active work.
   */
  async resolveForRootCompletion(parentSessionId: SessionId, parentTurnId: string): Promise<number> {
    const running = [...this.children.values()].filter(
      (child) =>
        child.parentSessionId === parentSessionId &&
        child.parentTurnId === parentTurnId &&
        child.status === 'running',
    )
    if (running.length === 0) return 0
    for (const child of running) {
      child.status = 'cancelled'
      child.endedAt = Date.now()
      child.agent?.stop()
    }
    await Promise.all(running.map((child) => child.settled))
    return running.length
  }

  /** Whether the parent session's durable log marks it a child. */
  private async parentIsChild(parentSessionId: SessionId): Promise<boolean> {
    if (this.children.has(parentSessionId)) return true
    const sessions = this.ctx.get('sessions') as
      | { has(id: SessionId): boolean; load(id: SessionId): Promise<{ events: { type: string }[] }> }
      | undefined
    if (sessions === undefined || !sessions.has(parentSessionId)) return false
    const loaded = await sessions.load(parentSessionId).catch(() => undefined)
    if (loaded === undefined) return false
    return loaded.events.some((event) => event.type === 'session/child-meta')
  }

  /** Extract the bounded result digest from the child's durable log. */
  private withResult(child: InternalChild): ChildHandle {
    if (child.result === undefined && child.status !== 'running') {
      const summary: string[] = []
      const files = new Set<string>()
      for (const event of child.events) {
        if (event.type === 'assistant/message' && event.content.trim() !== '') summary.push(event.content.trim())
        if (event.type === 'tool/call') {
          const filePath = event.call.args['path']
          if (typeof filePath === 'string') files.add(filePath)
        }
      }
      child.result = { summary: summary.join('\n\n').slice(0, 4_000), fileReferences: [...files].slice(0, 20) }
    }
    return {
      childSessionId: child.childSessionId,
      status: child.status,
      definitionName: child.definition.name,
      ...(child.model !== undefined ? { model: `${child.model.provider}:${child.model.model}` } : {}),
      startedAt: child.startedAt,
      ...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
      ...(child.result !== undefined ? { result: child.result } : {}),
      ...(child.failure !== undefined ? { error: child.failure } : {}),
      ...(child.status === 'running' && awaitsApproval(child.events) ? { awaitingApproval: true } : {}),
    }
  }
}

/** An approval request with no decision yet: the child is parked on a human. */
function awaitsApproval(events: readonly SessionEvent[]): boolean {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.type === 'approval/decision') decided.add(event.approvalId)
  }
  return events.some((event) => event.type === 'approval/request' && !decided.has(event.approvalId))
}

/** Open turns (turn/start without turn/end) in a stored event list. */
function countOpenTurns(events: readonly { type: string; [key: string]: unknown }[]): number {
  let open = 0
  for (const event of events) {
    if (event.type === 'turn/start') open += 1
    else if (event.type === 'turn/end') open = Math.max(0, open - 1)
  }
  return open
}

/** The task packet with the definition instructions, as the child's opener. */
function renderPacket(packet: TaskPacket, definition: AgentDefinition): string {
  return [
    `<definition name="${definition.name}">\n${definition.instructions}\n</definition>`,
    '## Task',
    packet.objective,
    '## Constraints',
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    '## References',
    ...(packet.references.length > 0 ? packet.references.map((reference) => `- ${reference}`) : ['- (none)']),
    '## Required result',
    packet.requiredResult,
  ].join('\n\n')
}
