import { Service, type Context } from '../../kernel/index.ts'
import type { ProjectId, SessionId, WorkspaceId } from '../../util/brand.ts'
import type { Session } from '../session/session.ts'
import { Agent } from './agent.ts'

declare module 'dnt-harness' {
  interface Context {
    agents: AgentsService
  }
}

/** The workspace/project identity an agent's executions carry. */
export interface AgentIdentity {
  readonly workspaceId?: WorkspaceId
  readonly projectId?: ProjectId
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
  private readonly bySession = new Map<SessionId, Agent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /**
   * The agent driving `session` (a fresh session when omitted), carrying
   * the given workspace identity. Idempotent per session.
   */
  create(session?: Session, identity: AgentIdentity = {}): Agent {
    const target = session ?? this.ctx.sessions.create(identity.workspaceId)
    const existing = this.bySession.get(target.id)
    if (existing !== undefined) return existing
    const agent = new Agent(this.ctx, target, { ...identity, sessionId: target.id, rootSessionId: target.id })
    this.bySession.set(target.id, agent)
    return agent
  }

  /** Drop the registry entry for a removed session. */
  forget(id: SessionId): void {
    this.bySession.delete(id)
  }
}
