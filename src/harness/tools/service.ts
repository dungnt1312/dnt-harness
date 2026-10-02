import { Service, type Context } from '../../kernel/index.ts'
import { newExecutionId, type ExecutionId } from '../../util/brand.ts'
import type { ToolCall, ToolSchema } from '../llm/types.ts'
import { canonicalCall } from './names.ts'
import { takeMcpOutcome } from '../mcp/staged-outcome.ts'
import { toolExecutionScope } from './execution-scope.ts'
import { agentScope } from '../agent/scope.ts'
import { FileObservations } from '../../capabilities/fs/observation.ts'
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

/**
 * Narrow the build-time grant to what is STILL granted right before the
 * tool runs: a folder revoked while the call waited for approval no longer
 * authorizes it, and access never widens mid-call.
 */
function stillGranted(before: readonly GrantedRoot[] | undefined, now: readonly GrantedRoot[] | undefined): GrantedRoot[] {
  const result: GrantedRoot[] = []
  for (const root of before ?? []) {
    const current = now?.find((candidate) => candidate.path === root.path)
    if (current === undefined) continue
    result.push({ path: root.path, access: root.access === 'write' && current.access === 'write' ? 'write' : 'read' })
  }
  return result
}

export class ToolsService extends Service {
  private tools = new Map<string, ToolDefinition>()
  private rootResolver: RootResolver | undefined
  private approvedPathResolver: ApprovedPathResolver | undefined
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
    const canonical = canonicalCall(call)
    const tool = this.tools.get(canonical.name)
    if (tool === undefined) {
      return { call: canonical, executionId, execute: async () => ({ ok: false, output: `unknown tool '${canonical.name}' (registered: ${[...this.tools.keys()].join(', ') || 'none'})` }) }
    }
    const exec = this.buildExecution(canonical, options.signal, executionId)
    return toolExecutionScope.run(exec, () => this.gate(tool, canonical, exec, executionId))
  }

  /** The authorization chain for one call, run inside its execution scope. */
  private async gate(tool: ToolDefinition, canonical: ToolCall, exec: ToolExecution, executionId: ExecutionId): Promise<PreparedToolCall> {
    // Phase 1: rewrite/block hooks. Phase 2 below re-enters the ENTIRE
    // authorization chain with the rewritten call (host/mode/child/policy/
    // approval), while hooks themselves do not recurse.
    const rewrite: PreExecuteDecision = await this.ctx.waterfall(
      'tools/rewrite',
      { call: canonical, exec },
      (replacement) => Promise.resolve(
        replacement === undefined
          ? { kind: 'allow', call: canonical }
          : { kind: 'allow', call: canonicalCall(replacement.call) },
      ),
    )
    if (rewrite.kind === 'deny') {
      const deniedCall = canonicalCall(rewrite.call ?? canonical)
      await this.approvedPathResolver?.(deniedCall, false, exec).catch(() => undefined)
      return {
        call: deniedCall,
        executionId,
        execute: () => this.postExecute(deniedCall, exec, { ok: false, output: `denied: ${rewrite.reason}` }),
      }
    }
    const rewritten = canonicalCall(rewrite.call)
    let decision: PreExecuteDecision
    try {
      decision = await this.ctx.waterfall(
        'tools/pre-execute',
        { call: rewritten, exec },
        (replacement) => Promise.resolve(
          replacement === undefined
            ? { kind: 'allow', call: rewritten }
            : { kind: 'allow', call: canonicalCall(replacement.call) },
        ),
      )
    } catch (error) {
      // Nothing was authorized: let the host drop any pending per-call state.
      await this.approvedPathResolver?.(rewritten, false, exec).catch(() => undefined)
      throw error
    }
    const preparedCall = canonicalCall(decision.kind === 'allow' ? decision.call : (decision.call ?? rewritten))
    let approvedPaths: readonly ApprovedPath[] | undefined
    try {
      approvedPaths = await this.approvedPathResolver?.(preparedCall, decision.kind === 'allow', exec)
    } catch (error) {
      return {
        call: preparedCall,
        executionId,
        execute: () => this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${String(error instanceof Error ? error.message : error)}` }),
      }
    }
    if (decision.kind === 'deny') {
      return {
        call: preparedCall,
        executionId,
        execute: () => this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${decision.reason}` }),
      }
    }
    if ((tool.requiresRoot ?? false) && exec.root === '') {
      return {
        call: preparedCall,
        executionId,
        execute: () => this.postExecute(preparedCall, exec, {
          ok: false,
          output: `no workspace root is granted for '${preparedCall.name}'; grant one before running root-aware tools`,
        }),
      }
    }
    return {
      call: preparedCall,
      executionId,
      execute: async () => {
        // Authority may have narrowed while the call waited (approval, a
        // stale batch): re-check it right before the side effect.
        let refused: unknown
        try {
          refused = await toolExecutionScope.run(exec, () => this.ctx.serial('tools/final-gate', { call: preparedCall, exec }))
        } catch (error) {
          refused = `final authority check failed: ${String(error instanceof Error ? error.message : error)}`
        }
        if (typeof refused === 'string' && refused !== '') {
          return this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${refused}` })
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
    const { additionalRoots: _before, approvedPaths: _unused, ...base } = exec
    let additionalRoots = exec.additionalRoots
    if (exec.root !== '' && this.rootResolver !== undefined) {
      const now = this.rootResolver()
      if (now === undefined || now.root !== exec.root) {
        throw new Error('the workspace folder changed while this call was waiting; retry the call')
      }
      additionalRoots = stillGranted(exec.additionalRoots, now.additionalRoots)
    }
    return {
      ...base,
      ...(additionalRoots !== undefined && additionalRoots.length > 0 ? { additionalRoots } : {}),
      ...(approvedPaths !== undefined && approvedPaths.length > 0 ? { approvedPaths } : {}),
    }
  }

  /**
   * Assemble the execution context. The root may be empty here — the
   * requiresRoot fail-closed check runs after the permission gate, so a
   * policy denial always outranks a missing (or present) grant.
   */
  private buildExecution(call: ToolCall, signal: AbortSignal | undefined, executionId?: ExecutionId): ToolExecution {
    const grant = this.rootResolver?.()
    const limits = this.ctx.get('limits') as { toolOutputLimit?: number } | undefined
    const scope = agentScope.getStore()
    return {
      root: grant?.root ?? '',
      ...(scope?.sessionId !== undefined ? { sessionId: scope.sessionId, observations: this.fileObservations } : {}),
      ...(scope?.sessionId !== undefined && scope.childOf !== undefined ? { observationParents: [scope.childOf.parentSessionId] } : {}),
      ...(grant?.additionalRoots !== undefined && grant.additionalRoots.length > 0 ? { additionalRoots: grant.additionalRoots } : {}),
      ...(grant?.deniedRoots !== undefined ? { deniedRoots: grant.deniedRoots } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(limits?.toolOutputLimit !== undefined ? { outputLimit: limits.toolOutputLimit } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(call.id !== '' ? { toolCallId: call.id } : {}),
    }
  }

  private async postExecute(call: ToolCall, exec: ToolExecution, result: ToolResult): Promise<ToolResult> {
    return this.ctx.waterfall(
      'tools/post-execute',
      { call, exec, result },
      (replacement) => Promise.resolve(replacement?.result ?? result),
    )
  }
}
