import { Service, type Context } from '../../kernel/index.ts'
import type { ProjectId, SessionId, WorkspaceId } from '../../util/brand.ts'
import type { Session } from '../session/session.ts'
import { Agent } from './agent.ts'
import type { AgentScope } from './scope.ts'

declare module 'dnt-harness' {
  interface Context {
    agents: AgentsService
  }
}

/** The workspace/project identity an agent's executions carry. */
export interface AgentIdentity {
  readonly rootSessionId?: SessionId
  readonly workspaceId?: WorkspaceId
  readonly projectId?: ProjectId
  readonly childOf?: AgentScope['childOf']
}

/**
 * The live agent registry: creates drivers bound to durable sessions. One
 * session has exactly one agent — the one-active-Turn-per-session invariant
 * is enforced here, at the only place drivers are minted. A second
 * `create` for the same session returns the existing driver instead of a
 * competing one. The agent's workspace identity is fixed by the FIRST
 * creation: later calls with a different scope return the same driver with
 * the ORIGINAL scope (ownership never migrates).
 */
export class AgentsService extends Service {
  private writersSafe = true
  get persistenceSafe(): boolean { return this.writersSafe }
  private closing = false
  closeAdmission(): void { this.closing = true; for (const agent of this.bySession.values()) agent.closeAdmission() }

  private readonly bySession = new Map<SessionId, Agent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /**
   * The agent driving `session` (a fresh session when omitted), carrying
   * the given workspace identity. Idempotent per session.
   */
  create(session?: Session, identity: AgentIdentity = {}): Agent {
    if (this.closing) throw new Error('agent admission closed: host shutting down')
    const target = session ?? this.ctx.sessions.create(identity.workspaceId)
    const existing = this.bySession.get(target.id)
    if (existing !== undefined) return existing
    const agent = new Agent(this.ctx, target, {
      sessionId: target.id,
      rootSessionId: identity.rootSessionId ?? target.id,
      ...(identity.workspaceId !== undefined ? { workspaceId: identity.workspaceId } : {}),
      ...(identity.projectId !== undefined ? { projectId: identity.projectId } : {}),
      ...(identity.childOf !== undefined ? { childOf: identity.childOf } : {}),
    })
    this.bySession.set(target.id, agent)
    return agent
  }

  /** Stop all drivers before host-owned process teardown. */
  async stopAll(options: { timeoutMs?: number } = {}): Promise<void> {
    this.closeAdmission()
    const agents = [...this.bySession.values()]
    for (const agent of agents) agent.stop()
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    while (agents.some(agent => agent.busy)) {
      if (Date.now() >= deadline) {
        // Fence canonical appends and drain the already queued prefix before
        // the host can release ownership. A stuck tool cannot persist later.
        this.writersSafe = false
        const drains = agents.map(agent => agent.fencePersistence())
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([Promise.all(drains), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('canonical writers unresolved; ownership retained')), 1000) })])
          this.writersSafe = true
        } finally { clearTimeout(timer) }
        throw new Error('agent shutdown join timed out; persistence fenced')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** Drop the registry entry for a removed session. */
  forget(id: SessionId): void {
    this.bySession.delete(id)
  }
}
