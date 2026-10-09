import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProjectId, SessionId, TurnId, WorkspaceId } from '../../util/brand.ts'
import type { GrantedRoot } from '../tools/types.ts'

/**
 * The ambient agent scope: while `Agent.run()` drives a turn, pipeline
 * listeners can read which session/workspace/project is executing — the
 * same initiator-scope idea found in other agent harnesses, rebuilt here.
 * The workspace and project come from the host at agent creation and are
 * fixed for the run: model-supplied arguments can never choose a different
 * workspace, and approval routing, tool grants, and scoped controls all
 * resolve through this store. The store is absent outside any run.
 */
export interface AgentScope {
  readonly sessionId: SessionId
  /** Root execution domain owning this run; equals sessionId for a root. */
  readonly rootSessionId?: SessionId
  /** Present only while a concrete Turn is executing. */
  readonly turnId?: TurnId
  readonly workspaceId?: WorkspaceId
  readonly projectId?: ProjectId
  /**
   * G4: present when this run is a CHILD agent. The definition's tool
   * ceiling rides here — the exposure gate enforces definition ∩ grant on
   * every child tool start. A child can never spawn children.
   *
   * The child's model is NOT here: it is stamped into the child's own log as
   * a `session/model` event at spawn, so the ordinary session resolution
   * carries the complete provider/model pair.
   */
  readonly childOf?: {
    readonly parentSessionId: SessionId
    readonly parentTurnId: string
    readonly definition: string
    /**
     * The definition body as resolved AT SPAWN — pinned for the child's life,
     * so editing the role file mid-run never changes a running child. It
     * becomes the child's system instructions; it grants nothing (the
     * ceiling below is the enforcement).
     */
    readonly instructions: string
    /** Provenance of the pinned definition (bundled role vs workspace file). */
    readonly definitionSource?: 'bundled' | 'user' | 'workspace' | 'project'
    /** Hard ceiling: admission exposure ∩ definition ∩ spawn grant (MCP explicit). */
    readonly toolCeiling: readonly string[]
    /**
     * The parent's additional file-tool folders, snapshotted AT SPAWN. Like
     * the tool ceiling, a child's grants never expand after spawn: folders
     * the parent gains later stay invisible to a running child.
     */
    readonly grants?: readonly GrantedRoot[]
    readonly skills?: readonly string[]
    /**
     * Bounded parent-conversation projection, captured at spawn when the
     * caller asked for `inherit: 'brief'`. Runtime-only: never persisted.
     */
    readonly inheritedContext?: string
  }
  /**
   * A ROOT conversation running as an agent role (scheduled automations):
   * the role's pinned instructions replace the mode prose and its tool
   * ceiling narrows exposure exactly like a child's. Unlike `childOf` there
   * is no parent: the root keeps its own turns, hooks and compaction.
   * Rebuilt from the session's durable `session/role` record.
   */
  readonly role?: {
    readonly definition: string
    readonly instructions: string
    readonly definitionSource?: 'bundled' | 'user' | 'workspace' | 'project'
    /** Pinned at creation: admission exposure ∩ definition − disallowed. */
    readonly toolCeiling: readonly string[]
    readonly skills?: readonly string[]
  }
}

export const agentScope = new AsyncLocalStorage<AgentScope>()
