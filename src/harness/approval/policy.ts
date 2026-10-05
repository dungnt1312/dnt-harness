import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '../../kernel/index.ts'
import type { ExecutionId, SessionId, TurnId } from '../../util/brand.ts'
import { agentScope } from '../agent/scope.ts'
import type { ToolCall } from '../llm/types.ts'
import { canonicalCall } from '../tools/names.ts'
import { resolvePermission, type ApprovalMode } from './resolution.ts'
import type { AskRequirement, AuthorityDecision } from '../tools/authority.ts'
export type { ApprovalMode } from './resolution.ts'
import type { PreExecuteDecision, ToolExecution } from '../tools/types.ts'

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
  reevaluate(scope: Reevaluation): Promise<void>
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
  /** Authoritative host resolver, called with immutable entry scope; failures deny. Overrides legacy policy lookup. */
  readonly authorityResolver?: (call: ToolCall, scope: ApprovalScope) => AuthorityDecision | Promise<AuthorityDecision>
  /** Host-owned, execution-scoped human-approval evidence. Omit for generic harness compatibility. */
  readonly receiptRegistry?: ApprovalReceiptRegistry & { issue(call: ToolCall, scope: ApprovalScope, requirements: readonly AskRequirement[]): ApprovalReceipt | undefined }
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

export interface ApprovalReceipt {
  readonly callFingerprint: string
  readonly workspaceId: string
  readonly rootSessionId: SessionId
  readonly sessionId: SessionId
  readonly executionId: ExecutionId
  readonly requirements: readonly AskRequirement[]
}

export interface ApprovalReceiptRegistry {
  readonly receiptFor: (call: ToolCall, scope: ApprovalScope) => ApprovalReceipt | undefined
  readonly covers: (call: ToolCall, scope: ApprovalScope, requirements: readonly AskRequirement[]) => boolean
  readonly retire: (executionId: ExecutionId | undefined) => void
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort().map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
}

export function approvalCallFingerprint(call: ToolCall): string {
  const canonical = canonicalCall(call)
  return createHash('sha256').update(stableJson({ name: canonical.name, args: canonical.args })).digest('hex')
}

function sameRequirement(left: AskRequirement, right: AskRequirement): boolean {
  return left.kind === right.kind && left.subjectFingerprint === right.subjectFingerprint && left.version === right.version
}

export function createApprovalReceiptRegistry(): ApprovalReceiptRegistry & { issue(call: ToolCall, scope: ApprovalScope, requirements: readonly AskRequirement[]): ApprovalReceipt | undefined } {
  const receipts = new Map<ExecutionId, ApprovalReceipt>()
  const complete = (scope: ApprovalScope): boolean =>
    scope.workspaceId !== undefined && scope.rootSessionId !== undefined && scope.sessionId !== undefined && scope.executionId !== undefined
  return {
    issue(call, scope, requirements) {
      if (!complete(scope)) return undefined
      const receipt: ApprovalReceipt = Object.freeze({
        callFingerprint: approvalCallFingerprint(call),
        workspaceId: scope.workspaceId!,
        rootSessionId: scope.rootSessionId!,
        sessionId: scope.sessionId!,
        executionId: scope.executionId!,
        requirements: Object.freeze(requirements.map((requirement) => Object.freeze({ ...requirement }))),
      })
      receipts.set(scope.executionId!, receipt)
      return receipt
    },
    receiptFor(call, scope) {
      if (!complete(scope)) return undefined
      const receipt = receipts.get(scope.executionId!)
      if (receipt === undefined || receipt.callFingerprint !== approvalCallFingerprint(call) || receipt.workspaceId !== scope.workspaceId || receipt.rootSessionId !== scope.rootSessionId || receipt.sessionId !== scope.sessionId) return undefined
      return receipt
    },
    covers(call, scope, requirements) {
      const receipt = this.receiptFor(call, scope)
      return receipt !== undefined && requirements.every((required) => receipt.requirements.some((shown) => sameRequirement(shown, required)))
    },
    retire(executionId) { if (executionId !== undefined) receipts.delete(executionId) },
  }
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
  readonly requirements: readonly AskRequirement[]
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
  return { ...raw }
}

/**
 * Exact name, then `mcp__server__*`, then the catch-all `*`, then
 * `defaultMode`. MCP is not a special default: `--yolo` (`defaultMode:
 * 'allow'`) and a workspace `*` both apply to it. `forceAsk` still
 * overrides this for tools annotated as requiring interaction.
 */
function modeFor(policy: Readonly<Record<string, ApprovalMode>>, tool: string, defaultMode: ApprovalMode): ApprovalMode {
  return resolvePermission(policy, tool, { defaultMode })
}

/**
 * The exposure ceiling a mode change keeps pending asks under. Built-in
 * tools must be listed by name; MCP names are dynamic, so the gate matches
 * the web host's `exposureDenial`: they stay exposed unless the incoming
 * mode has a ZERO-length ceiling (no tools at all) — a list of built-ins
 * says nothing about which `mcp__server__tool` names exist.
 */
function exposedBy(toolExposure: readonly string[], tool: string): boolean {
  if (tool.startsWith('mcp__')) return toolExposure.length > 0
  return toolExposure.includes(tool)
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
  // Claimed entries remain visible until their durable settlement completes.
  const settling = new Map<PendingEntry, Promise<void>>()

  const legacyAuthority = (policy: Readonly<Record<string, ApprovalMode>>, tool: string): AuthorityDecision => {
    const mode = modeFor(policy, tool, defaultMode)
    if (mode === 'deny') return { kind: 'deny', reason: `policy denies '${tool}'` }
    return mode === 'ask' ? { kind: 'ask', requirements: [{ kind: 'tool-policy' }] } : { kind: 'allow' }
  }

  const authority = async (call: ToolCall, scope: ApprovalScope, policy?: Readonly<Record<string, ApprovalMode>>): Promise<AuthorityDecision> => {
    try {
      const decision = options.authorityResolver !== undefined
        ? await options.authorityResolver(call, scope)
        : legacyAuthority(policy ?? readPolicy(options.policy), call.name)

      if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason ?? `policy denies '${call.name}'` }
      if (decision.kind === 'allow' && options.forceAsk?.(call, scope) === true) {
        return { kind: 'ask', requirements: [{ kind: 'interaction' }] }
      }
      return decision
    } catch (error) {
      return { kind: 'deny', reason: `authority resolver failed: ${String(error instanceof Error ? error.message : error)}` }
    }
  }

  // Structural lookup keeps this module decoupled from the sessions service
  // type; recording is skipped when no store-backed registry is mounted.
  const recorder = (scope: ApprovalScope): { session: RecordingSession } | undefined => {
    const session = recordingSession(scope.sessionId)
    return session === undefined ? undefined : { session }
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
  const settle = (entry: PendingEntry, decision: 'allow' | 'deny' | 'expired' | 'cancelled', reason?: string, humanApproved = false): Promise<void> => {
    const inFlight = settling.get(entry)
    if (inFlight !== undefined) return inFlight
    if (!pending.delete(entry.approvalId)) return Promise.resolve()
    // Publish completion before invoking lifecycle/recording callbacks.
    const completion = Promise.resolve().then(async () => {
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
      if (decision === 'allow' && humanApproved) {
        options.receiptRegistry?.issue(entry.call, {
          sessionId: entry.sessionId,
          rootSessionId: entry.rootSessionId,
          turnId: entry.turnId,
          executionId: entry.executionId,
          workspaceId: entry.workspaceId,
        }, entry.requirements)
      }
      entry.resolve({ decision, ...(reason !== undefined ? { reason } : {}) })
    }).finally(() => { settling.delete(entry) })
    settling.set(entry, completion)
    return completion
  }

  ctx.on('tools/pre-execute', async (payload: { call: ToolCall; exec: ToolExecution }, next: (replacement?: { call: ToolCall }) => Promise<PreExecuteDecision>): Promise<PreExecuteDecision> => {
    const call = canonicalCall(payload.call)
    const executing = agentScope.getStore()
    const callScope: ApprovalScope = {
      sessionId: payload.exec.sessionId ?? executing?.sessionId,
      rootSessionId: payload.exec.rootSessionId ?? executing?.rootSessionId,
      turnId: executing?.turnId,
      executionId: payload.exec.executionId,
      workspaceId: payload.exec.workspaceId ?? executing?.workspaceId,
    }
    Object.freeze(callScope)
    const decision = await authority(call, callScope)
    const mode = decision.kind
    if (payload.exec.signal?.aborted === true) {
      return { kind: 'deny', reason: `cancelled: stop requested while awaiting approval for '${call.name}'` }
    }
    if (decision.kind === 'allow') return next()
    if (decision.kind === 'deny') return decision
    if (options.askUser === undefined) {
      return { kind: 'deny', reason: `approval required for '${call.name}' but no askUser answerer is configured` }
    }

    const record = recorder(callScope)
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
        requirements: Object.freeze(decision.requirements.map((requirement) => Object.freeze({ ...requirement }))),
        workspaceId: callScope.workspaceId,
        sessionId: callScope.sessionId,
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
      const cleanup = (): void => {
        payload.exec.signal?.removeEventListener('abort', onAbort)
        clearTimeout(timer)
      }
      void done.then(cleanup)
      // Promise.resolve also contains synchronous answerer failures. The async
      // authority check cannot escape a fire-and-forget callback.
      void Promise.resolve().then(() => options.askUser!(call, { approvalId, executionId: callScope.executionId, done, expiresAt })).then(async (allowed) => {
        if (!pending.has(approvalId)) return
        const current = await authority(call, callScope)
        if (current.kind === 'deny') {
          await settle(pendingEntry, 'deny', options.authorityResolver === undefined ? `policy now denies '${call.name}'` : current.reason)
          return
        }
        await settle(pendingEntry, allowed ? 'allow' : 'deny', allowed ? undefined : `the user denied '${call.name}'`, allowed)
      }).catch(async (error: unknown) => {
        await settle(pendingEntry, 'deny', `approval answerer failed: ${String(error instanceof Error ? error.message : error)}`)
      })
    })

    if (entry.decision === 'allow') return next()
    return { kind: 'deny', reason: entry.reason ?? `denied: ${entry.decision}` }
  })

  return {
    reevaluate: async (scope: Reevaluation = {}): Promise<void> => {
      for (const entry of [...pending.values(), ...settling.keys()]) {
        // Immutable scope: a control change addresses its own workspace only.
        if (scope.workspaceId !== undefined && entry.workspaceId !== scope.workspaceId) continue
        if (scope.rootSessionId !== undefined && (entry.rootSessionId ?? entry.sessionId) !== scope.rootSessionId) continue
        const inFlight = settling.get(entry)
        if (inFlight !== undefined) {
          await inFlight
          continue
        }
        if (scope.toolExposure !== undefined && !exposedBy(scope.toolExposure, entry.call.name)) {
          await settle(entry, 'cancelled', `mode change: '${entry.call.name}' is no longer exposed`)
          continue
        }
        const entryScope: ApprovalScope = {
          sessionId: entry.sessionId,
          rootSessionId: entry.rootSessionId,
          turnId: entry.turnId,
          executionId: entry.executionId,
          workspaceId: entry.workspaceId,
        }
        const decision = await authority(entry.call, Object.freeze(entryScope), scope.policy)
        if (decision.kind === 'deny') {
          await settle(entry, 'deny', options.authorityResolver === undefined ? `policy now denies '${entry.call.name}'` : decision.reason)
          continue
        }
        if (decision.kind === 'allow') {
          // Newly allowed: the checks above are the serialized final gate
          // (scope match, exposure, policy); host root restrictions still
          // apply downstream in the tool pipeline. Exactly one settlement
          // wins because settle() claims the entry atomically.
          await settle(entry, 'allow')
        }
        // An answer/Stop/other reevaluation may have claimed it while the
        // resolver waited, even if this resolver still returns 'ask'.
        await settling.get(entry)
        // still 'ask' and unclaimed: remains pending for its human answer.
      }
    },
  }
}
