import { randomUUID } from 'node:crypto'
import type { Context } from '../../kernel/index.ts'
import type { ExecutionId, SessionId, TurnId } from '../../util/brand.ts'
import { agentScope } from '../agent/scope.ts'
import type { ToolCall } from '../llm/types.ts'
import { canonicalCall, canonicalPolicy } from '../tools/names.ts'
import type { PreExecuteDecision, ToolExecution } from '../tools/types.ts'

/** What the policy wants for one tool call. */
export type ApprovalMode = 'allow' | 'ask' | 'deny'

/** A live or static permission map; the getter form re-reads on every call. */
export type PolicySource = Readonly<Record<string, ApprovalMode>> | (() => Readonly<Record<string, ApprovalMode>>)

/** Inputs for a workspace-scoped re-evaluation of pending approvals. */
export interface Reevaluation {
  /** Only entries stamped with this execution workspace are touched. */
  readonly workspaceId?: string
  /** Only entries owned by this root execution domain (the root and its children). */
  readonly rootSessionId?: string
  /** The effective policy snapshot for THIS workspace (host computed). */
  readonly policy?: Readonly<Record<string, ApprovalMode>>
  /** The mode's hard exposure ceiling for THIS workspace. */
  readonly toolExposure?: readonly string[]
}

/** Handle returned by {@link attachApproval} for live control. */
export interface ApprovalHandle {
  /**
   * Re-evaluate pending approvals for ONE workspace against the supplied
   * snapshot. Unexposed calls cancel; denied calls settle denied; newly
   * ALLOWED asks proceed through this serialized final gate (the scope and
   * policy checks here are the gate — host root restrictions still apply
   * downstream); calls still requiring ask remain pending. Entries from
   * other workspaces are never touched, and previously denied or cancelled
   * calls never resurrect.
   */
  reevaluate(scope: Reevaluation): void
}

/**
 * Lifecycle signal handed to the answerer: `done` settles the moment the
 * policy resolves the approval on its own (expiry, stop, policy change).
 * Transport bridges use it to retire their pending question — an expired or
 * cancelled approval must not stay answerable.
 */
export interface ApprovalLifecycle {
  /**
   * THE approval id: the same one recorded in `approval/request` and
   * `approval/decision` events. Transport bridges must answer with it — a
   * second, bridge-local id would make log-derived questions unanswerable.
   */
  readonly approvalId: string
  /** The host execution identity this approval authorizes, when known. */
  readonly executionId: ExecutionId | undefined
  readonly done: Promise<void>
  /**
   * Epoch ms at which this question expires undecided. Bridges surface it so
   * a human can see the decision window instead of watching a card vanish.
   */
  readonly expiresAt: number
}

/** Options for attaching an approval policy. */
export interface ApprovalOptions {
  /** Per-tool modes (canonical or legacy names); unnamed tools use `defaultMode`. */
  readonly policy?: PolicySource
  /** Mode for tools the policy map does not name. */
  readonly defaultMode?: ApprovalMode
  /**
   * Answerer consulted for `ask` calls; required before the first `ask`
   * decision. Returning true allows the call, false denies it. The
   * `lifecycle.done` promise settles when the policy resolved the approval
   * without the answerer (expiry, stop, policy change) — bridges should
   * retire the question then. Routing the question to the right human is
   * the answerer's concern; the policy stays transport-agnostic.
   */
  readonly askUser?: (call: ToolCall, lifecycle: ApprovalLifecycle) => Promise<boolean>
  /** Undecided approvals expire after this long; defaults to the harness limit. */
  readonly expiryMs?: number
  /**
   * Hard interaction annotation: true forces ask even if policy exact/wildcard
   * says allow. `scope` is the call's own session/workspace — at first
   * evaluation the executing scope, on re-evaluation the pending entry's
   * stamped scope — so a control change with no agent in flight never
   * answers for a different workspace.
   */
  readonly forceAsk?: (call: ToolCall, scope: ApprovalScope) => boolean
  /**
   * Extra facts recorded on the durable `approval/request` (e.g. why the
   * call needs approval), so a replayed question carries them too.
   */
  readonly requestDetails?: (call: ToolCall, scope?: ApprovalScope) => Record<string, unknown> | undefined
}

/** The session/workspace an approval belongs to. */
export interface ApprovalScope {
  readonly sessionId: SessionId | undefined
  readonly rootSessionId: SessionId | undefined
  readonly turnId: TurnId | undefined
  readonly executionId: ExecutionId | undefined
  readonly workspaceId: string | undefined
}

/** Minimal structural slice of the sessions service the policy records into. */
interface RecordingSession {
  append(event: Record<string, unknown>): unknown
  durable(): Promise<void>
}

type Settlement = { decision: 'allow' | 'deny' | 'expired' | 'cancelled'; reason?: string }

interface PendingEntry {
  readonly approvalId: string
  readonly call: ToolCall
  readonly mode: ApprovalMode
  /** Immutable execution scope — a control change in another workspace must never touch this entry. */
  readonly workspaceId: string | undefined
  readonly sessionId: SessionId | undefined
  readonly rootSessionId: SessionId | undefined
  readonly turnId: TurnId | undefined
  readonly executionId: ExecutionId | undefined
  /** Settles the answerer-side lifecycle (retire the transport question). */
  done(): void
  resolve(entry: Settlement): void
}

function readPolicy(source: PolicySource | undefined): Record<string, ApprovalMode> {
  const raw = typeof source === 'function' ? source() : (source ?? {})
  return canonicalPolicy(raw) as Record<string, ApprovalMode>
}

/**
 * Exact name, then `mcp__server__*`, then the catch-all `*`, then
 * `defaultMode`. MCP is not a special default: `--yolo` (`defaultMode:
 * 'allow'`) and a workspace `*` both apply to it. `forceAsk` still
 * overrides this for tools annotated as requiring interaction.
 */
function modeFor(policy: Readonly<Record<string, ApprovalMode>>, tool: string, defaultMode: ApprovalMode): ApprovalMode {
  const exact = policy[tool]
  if (exact !== undefined) return exact
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    const wildcard = parts.length >= 3 ? policy[`mcp__${parts[1]}__*`] : undefined
    if (wildcard !== undefined) return wildcard
  }
  return policy['*'] ?? defaultMode
}

/**
 * Attach an approval policy to `ctx` as one `tools/pre-execute` listener:
 * per-tool allow/ask/deny decisions, with `ask` calls pausing for the
 * configured answerer. `ask` without an answerer fails closed.
 *
 * Approvals bind to the session, the exact call, and fixed arguments; they
 * expire (never approving implicitly), honor the run's abort signal (stop
 * cancels waiters), and are recorded as durable `approval/request` and
 * `approval/decision` session events — an `allow` never starts a side
 * effect before its decision record is durable. After the answerer allows,
 * the *current* policy is re-read: a call the policy now denies stays
 * denied. The listener is owned by the calling fiber — unloading that fiber
 * removes the policy, so several scoped policies can coexist.
 */
export function attachApproval(ctx: Context, options: ApprovalOptions = {}): ApprovalHandle {
  const defaultMode = options.defaultMode ?? 'ask'
  const expiryMs = options.expiryMs ?? 5 * 60_000
  const pending = new Map<string, PendingEntry>()

  // Structural lookup keeps this module decoupled from the sessions service
  // type; recording is skipped when no store-backed registry is mounted.
  const recorder = (): { session: RecordingSession; sessionId: SessionId; workspaceId: string | undefined } | undefined => {
    const scope = agentScope.getStore()
    if (scope === undefined) return undefined
    const session = recordingSession(scope.sessionId)
    if (session === undefined) return undefined
    return { session, sessionId: scope.sessionId, workspaceId: scope.workspaceId }
  }

  /**
   * The session that records one entry's decision, resolved by ITS OWN id
   * rather than by ambient scope. A settlement also arrives from a policy
   * change or a mode switch — an HTTP request with no agent in flight — and
   * a decision the log never saw is an authorization the audit cannot
   * explain, including the Always-allow that let the call proceed.
   */
  function recordingSession(sessionId: SessionId | undefined): RecordingSession | undefined {
    if (sessionId === undefined) return undefined
    const sessions = ctx.get('sessions') as { get(id: SessionId): RecordingSession } | undefined
    if (sessions === undefined) return undefined
    try {
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Settle one pending approval. The decision record lands durably before
   * the waiter resolves on `allow` — an authorization the log lost is an
   * authorization that never happened, and the side effect must not run.
   * Denials resolve even when recording fails: fail closed.
   */
  const settle = async (entry: PendingEntry, decision: 'allow' | 'deny' | 'expired' | 'cancelled', reason?: string): Promise<void> => {
    if (!pending.delete(entry.approvalId)) return
    entry.done()
    const session = recordingSession(entry.sessionId)
    if (session !== undefined) {
      try {
        session.append({
          type: 'approval/decision',
          approvalId: entry.approvalId,
          ...(entry.executionId !== undefined ? { executionId: entry.executionId } : {}),
          decision,
          ...(reason !== undefined ? { reason } : {}),
        })
        await session.durable()
      } catch (error) {
        if (decision === 'allow') {
          entry.resolve({
            decision: 'deny',
            reason: `approval decision could not be recorded: ${String(error instanceof Error ? error.message : error)}`,
          })
          return
        }
      }
    }
    entry.resolve({ decision, ...(reason !== undefined ? { reason } : {}) })
  }

  ctx.on('tools/pre-execute', async (payload: { call: ToolCall; exec: ToolExecution }, next: (replacement?: { call: ToolCall }) => Promise<PreExecuteDecision>): Promise<PreExecuteDecision> => {
    const call = canonicalCall(payload.call)
    const policy = readPolicy(options.policy)
    const baseMode = modeFor(policy, call.name, defaultMode)
    const executing = agentScope.getStore()
    const callScope: ApprovalScope = {
      sessionId: executing?.sessionId,
      rootSessionId: executing?.rootSessionId,
      turnId: executing?.turnId,
      executionId: payload.exec.executionId,
      workspaceId: executing?.workspaceId,
    }
    const mode = baseMode === 'allow' && options.forceAsk?.(call, callScope) === true ? 'ask' : baseMode
    if (mode === 'allow') return next()
    if (mode === 'deny') {
      return { kind: 'deny', reason: `policy denies '${call.name}'` }
    }
    if (payload.exec.signal?.aborted === true) {
      return { kind: 'deny', reason: `cancelled: stop requested while awaiting approval for '${call.name}'` }
    }
    if (options.askUser === undefined) {
      return { kind: 'deny', reason: `approval required for '${call.name}' but no askUser answerer is configured` }
    }

    const record = recorder()
    // Unguessable capability id: the answer route is transport-global.
    const approvalId = `approval-${randomUUID()}`
    if (record !== undefined) {
      record.session.append({
        ...(options.requestDetails?.(call, callScope) ?? {}),
        type: 'approval/request',
        approvalId,
        call,
        ...(callScope.rootSessionId !== undefined ? { rootSessionId: callScope.rootSessionId } : {}),
        ...(callScope.turnId !== undefined ? { turnId: callScope.turnId } : {}),
        ...(callScope.executionId !== undefined ? { executionId: callScope.executionId } : {}),
      })
      try {
        await record.session.durable()
      } catch (error) {
        // Fail closed before side effects: an unrecorded intent never runs.
        return { kind: 'deny', reason: `approval could not be recorded: ${String(error instanceof Error ? error.message : error)}` }
      }
    }

    const entry = await new Promise<Settlement>((resolve) => {
      let doneResolve: (() => void) | undefined
      const done = new Promise<void>((resolveDone) => {
        doneResolve = resolveDone
      })
      const pendingEntry: PendingEntry = {
        approvalId,
        call,
        mode,
        workspaceId: record?.workspaceId,
        sessionId: record?.sessionId,
        rootSessionId: callScope.rootSessionId,
        turnId: callScope.turnId,
        executionId: callScope.executionId,
        done: doneResolve as () => void,
        resolve,
      }
      pending.set(approvalId, pendingEntry)
      const expiresAt = Date.now() + expiryMs
      const timer = setTimeout(() => {
        void settle(pendingEntry, 'expired', `approval for '${call.name}' expired undecided`)
      }, expiryMs)
      timer.unref?.()
      const onAbort = (): void => {
        void settle(pendingEntry, 'cancelled', `cancelled: stop requested while awaiting approval for '${call.name}'`)
      }
      payload.exec.signal?.addEventListener('abort', onAbort, { once: true })
      if (payload.exec.signal?.aborted === true) onAbort()
      void options.askUser?.(call, { approvalId, executionId: callScope.executionId, done, expiresAt }).then((allowed) => {
        payload.exec.signal?.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        // Re-read the live policy: an approval cannot override a deny that
        // arrived after the question was asked.
        const current = modeFor(readPolicy(options.policy), call.name, defaultMode)
        if (current === 'deny') {
          void settle(pendingEntry, 'deny', `policy now denies '${call.name}'`)
          return
        }
        void settle(pendingEntry, allowed ? 'allow' : 'deny', allowed ? undefined : `the user denied '${call.name}'`)
      }, (error: unknown) => {
        payload.exec.signal?.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        void settle(pendingEntry, 'deny', `approval answerer failed: ${String(error instanceof Error ? error.message : error)}`)
      })
    })

    if (entry.decision === 'allow') return next()
    return { kind: 'deny', reason: entry.reason ?? `denied: ${entry.decision}` }
  })

  return {
    reevaluate: (scope: Reevaluation = {}): void => {
      const policy = scope.policy ?? readPolicy(options.policy)
      for (const entry of [...pending.values()]) {
        // Immutable scope: a control change addresses its own workspace only.
        if (scope.workspaceId !== undefined && entry.workspaceId !== scope.workspaceId) continue
        if (scope.rootSessionId !== undefined && (entry.rootSessionId ?? entry.sessionId) !== scope.rootSessionId) continue
        if (scope.toolExposure !== undefined && !scope.toolExposure.includes(entry.call.name)) {
          void settle(entry, 'cancelled', `mode change: '${entry.call.name}' is no longer exposed`)
          continue
        }
        const baseMode = modeFor(policy, entry.call.name, defaultMode)
        const entryScope: ApprovalScope = {
          sessionId: entry.sessionId,
          rootSessionId: entry.rootSessionId,
          turnId: entry.turnId,
          executionId: entry.executionId,
          workspaceId: entry.workspaceId,
        }
        const mode = baseMode === 'allow' && options.forceAsk?.(entry.call, entryScope) === true ? 'ask' : baseMode
        if (mode === 'deny') {
          void settle(entry, 'deny', `policy now denies '${entry.call.name}'`)
          continue
        }
        if (mode === 'allow') {
          // Newly allowed: the checks above are the serialized final gate
          // (scope match, exposure, policy); host root restrictions still
          // apply downstream in the tool pipeline. Exactly one settlement
          // wins because settle() claims the entry atomically.
          void settle(entry, 'allow')
        }
        // still 'ask': remains pending for its human answer.
      }
    },
  }
}
