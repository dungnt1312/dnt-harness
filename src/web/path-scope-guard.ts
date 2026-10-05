/**
 * Path-scope guard for the file tools: classifies every path a
 * `Read/Write/Edit/Glob/Grep` call targets against the run's grants BEFORE
 * authorization, without touching the filesystem.
 *
 * - network/device paths, app storage, and writes into a read-only granted
 *   folder are denied outright (never askable);
 * - paths inside a granted folder pass through unchanged;
 * - paths outside every granted folder are recorded as a match, which the
 *   host turns into a forced approval when the CURRENT owning mode requires
 *   it. Only an ALLOW settlement authorizes that exact path, for that one
 *   call, via {@link PathScopeGuard.take}.
 *
 * The target and intent are immutable classification snapshots. The host
 * rechecks that snapshot against current grants and current mode authority;
 * no exemption is snapshotted here.
 */
import path from 'node:path'
import type { Context } from '../kernel/index.ts'
import { agentScope } from '../harness/agent/scope.ts'
import type { ToolCall } from '../harness/llm/types.ts'
import type { ApprovedPath, PathIntent, PreExecuteDecision, ToolExecution } from '../harness/tools/types.ts'
import { classifyTarget, targetPaths } from '../capabilities/fs/grants.ts'
import { currentToolExecution } from '../harness/tools/execution-scope.ts'

/** One out-of-grant path a pending call targets. */
export interface PathScopeMatch {
  readonly sessionId: string | undefined
  readonly executionId: string
  readonly workspaceId: string | undefined
  readonly projectId: string | undefined
  readonly parentSessionId: string | undefined
  /** Child spawn snapshot; root sessions leave this undefined. */
  readonly grantSnapshot: readonly { readonly path: string; readonly access: 'read' | 'write' }[] | undefined
  /** Absolute lexical path, exactly as the approver sees it. */
  readonly path: string
  readonly intent: PathIntent
  /** Folder a session-scoped approval would grant, when that folder is grantable. */
  readonly proposedGrant?: string
  /** Set by the answer route: grant `proposedGrant` to the session once the call is allowed. */
  grantForSession?: boolean
  /** The approval whose answer asked for the session grant (recorded on `session/grants`). */
  approvalId?: string
  /** The exact arguments classified; a call whose arguments changed is not authorized. */
  readonly argsKey: string
}

export interface PathScopeOptions {
  /** Validate `folder` for a session-scoped answer; undefined when it is not grantable. */
  readonly proposeGrant: (folder: string) => Promise<string | undefined>
}

export interface PathScopeGuard {
  /** The pending out-of-grant match for this call, if any. */
  get(executionId: string | undefined, call: ToolCall): PathScopeMatch | undefined
  /**
   * Called once per call after authorization settles. Drops the match and,
   * when allowed, returns the single path it authorizes.
   */
  take(executionId: string | undefined, call: ToolCall, allowed: boolean): PathScopeMatch | undefined
  /** Drop all immutable classification state for a completed/refused execution. */
  retire(executionId: string | undefined): void
}

const SEARCH_TOOLS = new Set(['Glob', 'Grep'])

function keyOf(executionId: string | undefined, call: ToolCall): string {
  return `${executionId ?? ''}\u0000${call.name}\u0000${call.id}\u0000${JSON.stringify(call.args)}`
}

function argsKeyOf(call: ToolCall): string {
  return `${call.name}\u0000${JSON.stringify(call.args)}`
}

/**
 * Attach the guard as the LAST `tools/rewrite` listener (appended, not
 * prepended), so it classifies the final call after every hook rewrite.
 */
export function attachPathScopeGuard(ctx: Context, options: PathScopeOptions): PathScopeGuard {
  const matches = new Map<string, PathScopeMatch>()
  // `take()` consumes the authorization grant, but current authority still
  // needs the immutable classification through final admission.
  const snapshots = new Map<string, PathScopeMatch>()

  ctx.on('tools/rewrite', async (
    payload: { readonly call: ToolCall; readonly exec: ToolExecution | undefined },
    next: (replacement?: { readonly call: ToolCall; readonly exec?: ToolExecution }) => Promise<PreExecuteDecision>,
  ): Promise<PreExecuteDecision> => {
    const targets = targetPaths(payload.call)
    if (targets.length === 0) return next()
    const scope = agentScope.getStore()
    // Grants and out-of-grant approvals belong to project-bound sessions; a
    // memory-mode folder grant keeps its hard boundary.
    if (scope !== undefined && scope.projectId === undefined) return next()
    // A rewrite listener may forward only the call; the grant is then
    // resolved again rather than guessed.
    const exec = currentToolExecution(payload.exec)
    const grant = exec ?? ctx.tools.currentGrant()
    if (grant === undefined || grant.root === '') return next()
    let outside: { path: string; intent: PathIntent } | undefined
    for (const target of targets) {
      const classified = classifyTarget(grant, target.target, target.intent)
      switch (classified.kind) {
        case 'blocked':
          return { kind: 'deny', reason: `path '${target.target}' is refused: ${classified.reason}` }
        case 'denied':
          return { kind: 'deny', reason: `path '${target.target}' is inside application-internal storage and is not accessible to tools` }
        case 'read-only':
          return { kind: 'deny', reason: `path '${target.target}' is in a read-only granted folder (${classified.root.path})` }
        case 'in-grant':
          break
        case 'out-of-grant':
          outside = { path: classified.abs, intent: target.intent }
          break
      }
    }
    if (outside === undefined) return next()
    // Search tools target a folder; file tools target a file in its parent.
    // Children never get a session option: their grants are a spawn snapshot.
    const folder = SEARCH_TOOLS.has(payload.call.name) ? outside.path : path.dirname(outside.path)
    const proposedGrant = scope?.childOf === undefined ? await options.proposeGrant(folder) : undefined
    const executionId = exec?.executionId
    if (executionId === undefined) {
      // No host execution identity: nothing durable can authorize this call,
      // and a bare call-id key would leak across roots. Fail closed.
      return { kind: 'deny', reason: 'path approval requires a host execution identity' }
    }
    const match: PathScopeMatch = {
      sessionId: scope?.sessionId,
      executionId,
      workspaceId: scope?.workspaceId,
      projectId: scope?.projectId,
      parentSessionId: scope?.childOf?.parentSessionId,
      grantSnapshot: scope?.childOf?.grants,
      path: outside.path,
      intent: outside.intent,
      ...(proposedGrant !== undefined ? { proposedGrant } : {}),
      argsKey: argsKeyOf(payload.call),
    }
    const key = keyOf(executionId, payload.call)
    matches.set(key, match)
    snapshots.set(key, match)
    return next({ call: payload.call, ...(exec !== undefined ? { exec } : {}) })
  })

  const get = (executionId: string | undefined, call: ToolCall): PathScopeMatch | undefined => {
    const match = snapshots.get(keyOf(executionId, call))
    return match !== undefined && match.argsKey === argsKeyOf(call) ? match : undefined
  }

  return {
    get,
    take(executionId, call, allowed) {
      const key = keyOf(executionId, call)
      const match = matches.get(key)
      matches.delete(key)
      if (!allowed) snapshots.delete(key)
      if (!allowed || match === undefined || match.argsKey !== argsKeyOf(call)) return undefined
      return match
    },
    retire(executionId) {
      if (executionId === undefined) return
      const prefix = `${executionId}\u0000`
      for (const key of matches.keys()) if (key.startsWith(prefix)) matches.delete(key)
      for (const key of snapshots.keys()) if (key.startsWith(prefix)) snapshots.delete(key)
    },
  }
}

/** The approved path a settled match authorizes. */
export function approvedPathOf(match: PathScopeMatch): ApprovedPath {
  return { path: match.path, intent: match.intent }
}
