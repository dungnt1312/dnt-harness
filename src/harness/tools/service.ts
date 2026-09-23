import { Service, type Context } from '../../kernel/index.ts'
import type { ToolCall, ToolSchema } from '../llm/types.ts'
import { canonicalCall } from './names.ts'
import { takeMcpOutcome } from '../mcp/staged-outcome.ts'
import type { PreExecuteDecision, PreparedToolCall, ToolDefinition, ToolExecution, ToolResult } from './types.ts'

declare module 'mini-dsh' {
  interface Context {
    tools: ToolsService
  }
}

/** Resolves the workspace grant for the tool run in flight, if any. */
export type RootResolver = () => { root: string; deniedRoots?: readonly string[] } | undefined

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
export class ToolsService extends Service {
  private tools = new Map<string, ToolDefinition>()
  private rootResolver: RootResolver | undefined
  private policyRevisionValue = 0

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
  async prepare(call: ToolCall, options: { signal?: AbortSignal } = {}): Promise<PreparedToolCall> {
    const canonical = canonicalCall(call)
    const tool = this.tools.get(canonical.name)
    if (tool === undefined) {
      return { call: canonical, execute: async () => ({ ok: false, output: `unknown tool '${canonical.name}' (registered: ${[...this.tools.keys()].join(', ') || 'none'})` }) }
    }
    const exec = this.buildExecution(canonical, options.signal)
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
      return {
        call: deniedCall,
        execute: () => this.postExecute(deniedCall, exec, { ok: false, output: `denied: ${rewrite.reason}` }),
      }
    }
    const rewritten = canonicalCall(rewrite.call)
    const decision: PreExecuteDecision = await this.ctx.waterfall(
      'tools/pre-execute',
      { call: rewritten, exec },
      (replacement) => Promise.resolve(
        replacement === undefined
          ? { kind: 'allow', call: rewritten }
          : { kind: 'allow', call: canonicalCall(replacement.call) },
      ),
    )
    const preparedCall = canonicalCall(decision.kind === 'allow' ? decision.call : (decision.call ?? rewritten))
    if (decision.kind === 'deny') {
      return {
        call: preparedCall,
        execute: () => this.postExecute(preparedCall, exec, { ok: false, output: `denied: ${decision.reason}` }),
      }
    }
    if ((tool.requiresRoot ?? false) && exec.root === '') {
      return {
        call: preparedCall,
        execute: () => this.postExecute(preparedCall, exec, {
          ok: false,
          output: `no workspace root is granted for '${preparedCall.name}'; grant one before running root-aware tools`,
        }),
      }
    }
    return {
      call: preparedCall,
      execute: async () => {
        let output: string
        try {
          output = await tool.execute(preparedCall.args, exec)
        } catch (error) {
          return this.postExecute(preparedCall, exec, { ok: false, output: `error: ${String(error)}` })
        }
        const staged = exec.toolCallId !== undefined && exec.toolCallId !== '' ? takeMcpOutcome(exec.toolCallId) : undefined
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
   * Assemble the execution context. The root may be empty here — the
   * requiresRoot fail-closed check runs after the permission gate, so a
   * policy denial always outranks a missing (or present) grant.
   */
  private buildExecution(call: ToolCall, signal: AbortSignal | undefined): ToolExecution {
    const grant = this.rootResolver?.()
    const limits = this.ctx.get('limits') as { toolOutputLimit?: number } | undefined
    return {
      root: grant?.root ?? '',
      ...(grant?.deniedRoots !== undefined ? { deniedRoots: grant.deniedRoots } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(limits?.toolOutputLimit !== undefined ? { outputLimit: limits.toolOutputLimit } : {}),
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
