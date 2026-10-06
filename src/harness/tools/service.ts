import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { Service, type Context } from '../../kernel/index.ts'
import { newExecutionId, type ExecutionId } from '../../util/brand.ts'
import type { ToolCall, ToolSchema } from '../llm/types.ts'
import { canonicalCall } from './names.ts'
import { takeMcpOutcome } from '../mcp/staged-outcome.ts'
import { toolExecutionScope } from './execution-scope.ts'
import { agentScope } from '../agent/scope.ts'
import { FileObservations } from '../../capabilities/fs/observation.ts'
import { classifyGrantedRoots, samePath, within } from '../../capabilities/fs/grants.ts'
import type { ApprovedPath, GrantedRoot, PreExecuteDecision, PreparedToolCall, ToolDefinition, ToolExecution, ToolResult } from './types.ts'

declare module 'dnt-harness' {
  interface Context {
    tools: ToolsService
  }
}

/** Resolves the workspace grant for the tool run in flight, if any. */
export type RootResolver = () => {
  root: string
  additionalRoots?: readonly GrantedRoot[]
  deniedRoots?: readonly string[]
  memoryRoots?: readonly string[]
  hostStorageRoot?: string
} | undefined

/**
 * The scoped tool registry and guarded execution pipeline. Tools register
 * as effects; execution runs the `tools/pre-execute` waterfall (policy and
 * rewriting), then the tool body, then `tools/post-execute` (result
 * transformation). A denied or throwing call becomes a failed `ToolResult`
 * the model can see — never an exception into the loop.
 *
 * The host installs a {@link RootResolver}; root-aware tools fail closed
 * when it yields nothing. Tool names normalize to canonical identity at
 * the boundary, so legacy lowercase callers hit the same registry entry,
 * the same permission rules, and never a duplicate.
 */
/**
 * Consulted once per call after authorization settles (allowed or not):
 * returns the out-of-grant paths an approval authorized for exactly this
 * call. Side effect: when allowed, it may also persist the session grant the
 * approver asked for; a failure there fails the call closed.
 */
export type ApprovedPathResolver = (call: ToolCall, allowed: boolean, exec?: ToolExecution) => Promise<readonly ApprovedPath[] | undefined>

/** Retires host-owned authorization evidence for one execution. */
export type AuthorityRetirer = (executionId: ExecutionId) => void

/**
 * Narrow the build-time grant to what is STILL granted right before the
 * tool runs: a folder revoked while the call waited for approval no longer
 * authorizes it, and access never widens mid-call.
 */
function stillGranted(before: readonly GrantedRoot[] | undefined, now: readonly GrantedRoot[] | undefined): GrantedRoot[] {
  const snapshot = before ?? []
  const current = now ?? []
  const boundaries = [
    ...snapshot,
    ...current.filter((root) => snapshot.some((spawned) => within(spawned.path, root.path))),
  ].filter((root, index, roots) => roots.findIndex((candidate) => samePath(candidate.path, root.path)) === index)
  return boundaries.flatMap((root) => {
    const spawned = classifyGrantedRoots(snapshot, root.path)
    const live = classifyGrantedRoots(current, root.path)
    if (spawned === undefined || live === undefined) return []
    return [{ path: root.path, access: spawned.access === 'write' && live.access === 'write' ? 'write' as const : 'read' as const }]
  })
}

/** Copy JSON intent into host ownership; never freeze a caller's objects. */
function snapshotCall(call: ToolCall): ToolCall {
  const canonical = canonicalCall(call)
  const args = structuredClone(canonical.args)
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(args)
  return Object.freeze({ id: canonical.id, name: canonical.name, args })
}

/**
 * Freeze authority-bearing execution metadata without freezing mutable runtime
 * services (AbortSignal and FileObservations). Arrays and grant entries are
 * detached first so a caller cannot mutate either the envelope or its source.
 */
function freezeExecution(exec: ToolExecution): ToolExecution {
  return Object.freeze({
    ...exec,
    ...(exec.additionalRoots !== undefined ? {
      additionalRoots: Object.freeze(exec.additionalRoots.map((root) => Object.freeze({ ...root }))),
    } : {}),
    ...(exec.approvedPaths !== undefined ? {
      approvedPaths: Object.freeze(exec.approvedPaths.map((approved) => Object.freeze({ ...approved }))),
    } : {}),
    ...(exec.deniedRoots !== undefined ? { deniedRoots: Object.freeze([...exec.deniedRoots]) } : {}),
    ...(exec.memoryRoots !== undefined ? { memoryRoots: Object.freeze([...exec.memoryRoots]) } : {}),
    ...(exec.observationParents !== undefined ? { observationParents: Object.freeze([...exec.observationParents]) } : {}),
  })
}

export class ToolsService extends Service {
  private tools = new Map<string, ToolDefinition>()
  private rootResolver: RootResolver | undefined
  private approvedPathResolver: ApprovedPathResolver | undefined
  private authorityRetirer: AuthorityRetirer | undefined
  private policyRevisionValue = 0
  /** Host-owned observations: one per service, so a test host never shares state. */
  private readonly fileObservations = new FileObservations()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /**
   * Install the workspace-grant resolver. Called by the host; tools do not
   * look folders up themselves.
   */
  setRootResolver(resolver: RootResolver): void {
    this.rootResolver = resolver
  }

  /** Install the host's approved-path resolver (out-of-grant approvals). */
  setApprovedPathResolver(resolver: ApprovedPathResolver): void {
    this.approvedPathResolver = resolver
  }

  /** Install the host seam that retires execution-scoped authorization evidence. */
  setAuthorityRetirer(retirer: AuthorityRetirer): void {
    this.authorityRetirer = retirer
  }

  /** The workspace grant the resolver yields for the current scope, if any. */
  currentGrant(): ReturnType<RootResolver> {
    return this.rootResolver?.()
  }

  /** Bump when the effective permission policy changes; recorded per call. */
  bumpPolicyRevision(): number {
    return ++this.policyRevisionValue
  }

  /** The current permission-policy revision. */
  get policyRevision(): number {
    return this.policyRevisionValue
  }

  /**
   * Register a tool. The registration is an effect: it unwinds when the
   * owning fiber unloads, so the schema leaves request assembly too.
   * Canonical names only: a legacy alias registering under a name that
   * normalizes to an already-registered tool is rejected.
   *
   * @returns a disposer removing the tool.
   */
  register(tool: ToolDefinition): () => void {
    const canonical = canonicalCall({ id: '', name: tool.name, args: {} }).name
    if (this.tools.has(canonical)) {
      throw new Error(`tools: '${canonical}' is already registered`)
    }
    const effective = canonical === tool.name ? tool : { ...tool, name: canonical }
    this.tools.set(canonical, effective)
    const dispose = this.ctx.effect(() => () => {
      this.tools.delete(canonical)
    }, `tools.register(${canonical})`)
    return () => {
      void dispose()
    }
  }

  /**
   * Every registered tool's schema, resolved live for the execution scope.
   * A dynamic resolver returning undefined hides the tool entirely (G5
   * workspace-isolated MCP schemas and disable/exposure changes).
   */
  schemas(): ToolSchema[] {
    const schemas: ToolSchema[] = []
    for (const tool of this.tools.values()) {
      const resolved = tool.schema?.()
      if (tool.schema !== undefined && resolved === undefined) continue
      schemas.push({
        name: tool.name,
        description: resolved?.description ?? tool.description,
        parameters: resolved?.parameters ?? tool.parameters,
      })
    }
    return schemas
  }

  /**
   * Prepare one call through EVERY pre-execute gate (mode, child ceiling,
   * hooks, policy, approval). The returned call is the final, possibly
   * rewritten identity. The agent must durably record it BEFORE invoking
   * execute(). A denial is returned as a prepared no-side-effect result,
   * also carrying the exact rewritten call for a truthful log.
   */
  async prepare(call: ToolCall, options: { signal?: AbortSignal; executionId?: ExecutionId } = {}): Promise<PreparedToolCall> {
    const executionId = options.executionId ?? newExecutionId()
    const canonical = snapshotCall(call)
    const exec = this.buildExecution(canonical, options.signal, executionId)
    let prepared: PreparedToolCall
    // Unknown original identity is not recoverable by hooks: fail closed.
    if (!this.tools.has(canonical.name)) {
      await this.approvedPathResolver?.(canonical, false, exec).catch(() => undefined)
      prepared = { call: canonical, executionId, execute: () => this.postExecute(canonical, exec, { ok: false, output: `unknown tool '${canonical.name}' (registered: ${[...this.tools.keys()].join(', ') || 'none'})` }) }
    } else {
      try {
        prepared = await toolExecutionScope.run(exec, () => this.gate(canonical, exec, executionId))
      } catch (error) {
        this.retireAuthority(executionId)
        throw error
      }
    }
    let used = false
    return Object.freeze({
      call: prepared.call,
      ...(prepared.executionId !== undefined ? { executionId: prepared.executionId } : {}),
      execute: () => {
        if (used) return Promise.resolve({ ok: false, output: 'denied: prepared tool call has already been executed' })
        used = true
        return prepared.execute()
      },
    })
  }

  /** The authorization chain for one call, run inside its execution scope. */
  private async gate(canonical: ToolCall, exec: ToolExecution, executionId: ExecutionId): Promise<PreparedToolCall> {
    // Phase 1: rewrite/block hooks. Phase 2 below re-enters the ENTIRE
    // authorization chain with the rewritten call (host/mode/child/policy/
    // approval), while hooks themselves do not recurse.
    let rewrite: PreExecuteDecision
    try {
      rewrite = await this.ctx.waterfall(
        'tools/rewrite',
        { call: canonical, exec },
        (replacement) => Promise.resolve(
          replacement === undefined
            ? { kind: 'allow', call: canonical }
            : { kind: 'allow', call: canonicalCall(replacement.call) },
        ),
      )
    } catch (error) {
      // Rewrite middleware failed: nothing was authorized, drop pending state.
      await this.approvedPathResolver?.(canonical, false, exec).catch(() => undefined)
      this.retireAuthority(executionId)
      throw error
    }
    if (rewrite.kind === 'deny') {
      const deniedCall = snapshotCall(rewrite.call ?? canonical)
      await this.approvedPathResolver?.(deniedCall, false, exec).catch(() => undefined)
      return {
        call: deniedCall,
        executionId,
        execute: () => this.postExecute(deniedCall, exec, { ok: false, output: `denied: ${rewrite.reason}` }),
      }
    }
    // Identity-preserving unless a hook actually rewrote the call: the guard
    // stores ask-matches keyed by the exact object it saw, so an unconditional
    // clone here would break the ask lookup downstream.
    const rewritten = rewrite.call === canonical ? canonical : snapshotCall(rewrite.call)
    const tool = this.tools.get(rewritten.name)
    if (tool === undefined) {
      await this.approvedPathResolver?.(rewritten, false, exec).catch(() => undefined)
      return { call: rewritten, executionId, execute: () => this.postExecute(rewritten, exec, { ok: false, output: `unknown tool '${rewritten.name}' (registered: ${[...this.tools.keys()].join(', ') || 'none'})` }) }
    }
    let attemptedRewrite = false
    let rewriteDenialReason = 'authorization cannot rewrite finalized tool identity or arguments'
    const rewriteDenied = (reason?: string): PreExecuteDecision => {
      if (!attemptedRewrite && reason !== undefined) rewriteDenialReason = reason
      attemptedRewrite = true
      return { kind: 'deny', reason: rewriteDenialReason, call: rewritten }
    }
    let decision: PreExecuteDecision
    try {
      // Every middleware boundary is checked: a listener cannot forward a
      // replacement to a downstream gate, nor return a changed call upstream.
      // Once rejected, every later next(...) from that listener stays denied.
      const changed = (candidate: unknown): boolean => {
        const proposed = (candidate as { call?: ToolCall } | undefined)?.call
        return proposed !== undefined && !isDeepStrictEqual(proposed, rewritten)
      }
      decision = await this.ctx.events.checkedWaterfall(
        'tools/pre-execute',
        {
          forward: (_current, proposed) => {
            if (attemptedRewrite) return Promise.resolve(rewriteDenied())
            if (proposed.length !== 1 || proposed[0] === null || typeof proposed[0] !== 'object') {
              return Promise.resolve(rewriteDenied('malformed authorization forward'))
            }
            const payload = proposed[0] as { call?: ToolCall | null; exec?: ToolExecution }
            if (payload.call === undefined || payload.call === null) {
              return Promise.resolve(rewriteDenied('malformed authorization forward'))
            }
            if (changed(payload)) return Promise.resolve(rewriteDenied())
            if (payload.exec === undefined) return Promise.resolve(rewriteDenied('malformed authorization forward'))
            if (payload.exec !== exec) return Promise.resolve(rewriteDenied())
            return undefined
          },
          result: (_current, result) => (changed(result) ? rewriteDenied() : undefined),
        },
        { call: rewritten, exec },
        (replacement) => Promise.resolve(
          replacement !== undefined && !isDeepStrictEqual(replacement.call, rewritten)
            ? rewriteDenied()
            : { kind: 'allow', call: rewritten },
        ),
      )
    } catch (error) {
      // Nothing was authorized: let the host drop any pending per-call state.
      await this.approvedPathResolver?.(rewritten, false, exec).catch(() => undefined)
      this.retireAuthority(executionId)
      throw error
    }
    if (attemptedRewrite || (decision.call !== undefined && !isDeepStrictEqual(decision.call, rewritten))) decision = rewriteDenied()
    const target = rewritten.args['path']
    const scopedMemoryPath = typeof target === 'string' && path.isAbsolute(target) && exec.memoryRoots?.some((root) => within(root, target)) === true
    if (decision.kind === 'allow' && (tool.requiresRoot ?? false) && exec.root === '' && !scopedMemoryPath) {
      decision = { kind: 'deny', reason: `no workspace root is granted for '${rewritten.name}'; grant one before running root-aware tools`, call: rewritten }
    }
    const preparedCall = rewritten
    let approvedPaths: readonly ApprovedPath[] | undefined
    try {
      approvedPaths = await this.approvedPathResolver?.(preparedCall, decision.kind === 'allow', exec)
    } catch (error) {
      this.retireAuthority(executionId)
      return {
        call: preparedCall,
        executionId,
        execute: () => this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${String(error instanceof Error ? error.message : error)}` }),
      }
    }
    if (decision.kind === 'deny') {
      this.retireAuthority(executionId)
      return {
        call: preparedCall,
        executionId,
        execute: () => this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${decision.reason}` }),
      }
    }
    return {
      call: preparedCall,
      executionId,
      execute: async () => {
        // Stop before dispatch prevents a body that has not started yet.
        if (exec.signal?.aborted) {
          this.retireAuthority(executionId)
          return this.postExecute(preparedCall, exec, { ok: false, output: `denied: cancelled: stop requested before dispatch of '${preparedCall.name}'` })
        }
        // Authority may have narrowed while the call waited (approval, a
        // stale batch): re-check it right before the side effect.
        let refused: unknown
        try {
          refused = await toolExecutionScope.run(exec, () => this.ctx.serial('tools/final-gate', { call: preparedCall, exec }))
        } catch (error) {
          refused = `final authority check failed: ${String(error instanceof Error ? error.message : error)}`
        }
        if (typeof refused === 'string' && refused !== '') {
          this.retireAuthority(executionId)
          return this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${refused}` })
        }
        // Stop may land while the asynchronous authority resolver is waiting.
        // Linearize cancellation immediately before body dispatch.
        if (exec.signal !== undefined && Boolean(exec.signal.aborted)) {
          this.retireAuthority(executionId)
          return this.postExecute(preparedCall, exec, { ok: false, output: `denied: cancelled: stop requested before dispatch of '${preparedCall.name}'` })
        }
        let output: string
        let runExec: ToolExecution
        try {
          runExec = this.executionAtRun(exec, approvedPaths)
          output = await tool.execute(preparedCall.args, runExec)
        } catch (error) {
          return this.postExecute(preparedCall, exec, { ok: false, output: `error: ${String(error)}` })
        }
        const staged = exec.executionId !== undefined ? takeMcpOutcome(exec.executionId) : undefined
        if (staged !== undefined) {
          return this.postExecute(preparedCall, exec, {
            ok: staged.ok,
            output,
            outcome: staged.outcome,
            invocationId: staged.invocationId,
          })
        }
        return this.postExecute(preparedCall, exec, { ok: true, output })
      },
    }
  }

  /** Compatibility convenience: prepare then execute (direct callers/tests). */
  async execute(call: ToolCall, options: { signal?: AbortSignal } = {}): Promise<ToolResult> {
    return (await this.prepare(call, options)).execute()
  }

  /**
   * The execution context at the moment the tool body starts: the grant is
   * re-resolved and intersected with the build-time grant (approval waits can
   * be long; a revoked folder must stop authorizing), and the approved
   * out-of-grant paths for this call are attached. A changed primary root
   * fails the call instead of running somewhere the approver did not see.
   */
  private executionAtRun(exec: ToolExecution, approvedPaths: readonly ApprovedPath[] | undefined): ToolExecution {
    const { additionalRoots: _before, memoryRoots: _memoryBefore, hostStorageRoot: _storageBefore, approvedPaths: _unused, ...base } = exec
    let additionalRoots = exec.additionalRoots
    let memoryRoots = exec.memoryRoots
    let hostStorageRoot = exec.hostStorageRoot
    if ((exec.root !== '' || memoryRoots !== undefined) && this.rootResolver !== undefined) {
      const now = this.rootResolver()
      if (now === undefined || now.root !== exec.root) {
        throw new Error('the workspace folder changed while this call was waiting; retry the call')
      }
      additionalRoots = stillGranted(exec.additionalRoots, now.additionalRoots)
      memoryRoots = exec.memoryRoots?.filter((root) => now.memoryRoots?.some((live) => samePath(root, live)))
      hostStorageRoot = exec.hostStorageRoot !== undefined && now.hostStorageRoot !== undefined
        && samePath(exec.hostStorageRoot, now.hostStorageRoot) ? exec.hostStorageRoot : undefined
    }
    return freezeExecution({
      ...base,
      ...(additionalRoots !== undefined && additionalRoots.length > 0 ? { additionalRoots } : {}),
      ...(memoryRoots !== undefined && memoryRoots.length > 0 ? { memoryRoots } : {}),
      ...(hostStorageRoot !== undefined ? { hostStorageRoot } : {}),
      ...(approvedPaths !== undefined && approvedPaths.length > 0 ? { approvedPaths } : {}),
    })
  }

  /**
   * Assemble the execution context. The root may be empty here — the
   * requiresRoot fail-closed check runs after the permission gate, so a
   * policy denial always outranks a missing (or present) grant.
   */
  private buildExecution(call: ToolCall, signal: AbortSignal | undefined, executionId?: ExecutionId): ToolExecution {
    const grant = this.rootResolver?.()
    const limits = this.ctx.get('limits') as { toolOutputLimit?: number; subagentBackgroundBashMaxMs?: number } | undefined
    const scope = agentScope.getStore()
    return freezeExecution({
      ...(scope?.turnId !== undefined ? { turnId: scope.turnId } : {}),
      ...(scope?.childOf !== undefined ? { subagentBackgroundBashMaxMs: limits?.subagentBackgroundBashMaxMs ?? 3_600_000 } : {}),
      root: grant?.root ?? '',
      ...(scope?.sessionId !== undefined ? { sessionId: scope.sessionId, observations: this.fileObservations } : {}),
      ...(scope?.rootSessionId !== undefined ? { rootSessionId: scope.rootSessionId } : {}),
      ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
      ...(scope?.sessionId !== undefined && scope.childOf !== undefined ? { observationParents: [scope.childOf.parentSessionId] } : {}),
      ...(grant?.additionalRoots !== undefined && grant.additionalRoots.length > 0 ? { additionalRoots: grant.additionalRoots } : {}),
      ...(grant?.deniedRoots !== undefined ? { deniedRoots: grant.deniedRoots } : {}),
      ...(grant?.memoryRoots !== undefined ? { memoryRoots: grant.memoryRoots } : {}),
      ...(grant?.hostStorageRoot !== undefined ? { hostStorageRoot: grant.hostStorageRoot } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(limits?.toolOutputLimit !== undefined ? { outputLimit: limits.toolOutputLimit } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(call.id !== '' ? { toolCallId: call.id } : {}),
    })
  }

  private retireAuthority(executionId: ExecutionId): void {
    this.authorityRetirer?.(executionId)
  }

  private async postExecute(call: ToolCall, exec: ToolExecution, result: ToolResult): Promise<ToolResult> {
    return this.ctx.waterfall(
      'tools/post-execute',
      { call, exec, result },
      (replacement) => Promise.resolve(replacement?.result ?? result),
    )
  }
}
