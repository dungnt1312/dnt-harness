import type { Context } from '../../kernel/index.ts'
import { agentScope } from '../agent/scope.ts'
import type { ToolCall } from '../llm/types.ts'
import { matchCommand } from './matcher.ts'
import type { DangerousCommandsConfig, GuardMatch } from './types.ts'
import type { PreExecuteDecision, ToolExecution } from '../tools/types.ts'
import { currentToolExecution } from '../tools/execution-scope.ts'

export type GuardConfigSource =
  | (() => DangerousCommandsConfig | Promise<DangerousCommandsConfig>)
  | ((workspaceId: string) => DangerousCommandsConfig | Promise<DangerousCommandsConfig>)

export interface GuardOptions {
  readonly configSource: GuardConfigSource
  readonly onMatch?: (match: GuardMatch, call: ToolCall) => void
}

export interface GuardHandle {
  getMatch(call: ToolCall, executionId?: string): GuardMatch | null
  clearForWorkspace(workspaceId: string): void
  dispose(): boolean
}

export function attachDangerousCommandGuard(ctx: Context, options: GuardOptions): GuardHandle {
  const perCall = new WeakMap<ToolCall, GuardMatch>()
  const byExecution = new Map<string, GuardMatch>()
  const executionWorkspace = new Map<string, string>()

  function store(call: ToolCall, match: GuardMatch, payloadExec?: ToolExecution): void {
    perCall.set(call, match)
    const executionId = currentToolExecution(payloadExec)?.executionId
    if (executionId !== undefined) {
      byExecution.set(executionId, match)
      const wid = agentScope.getStore()?.workspaceId as string | undefined
      if (wid !== undefined) executionWorkspace.set(executionId, wid)
    }
  }

  async function resolveConfig(): Promise<DangerousCommandsConfig> {
    const wid = agentScope.getStore()?.workspaceId as string | undefined
    const fn = options.configSource as (...args: string[]) => DangerousCommandsConfig | Promise<DangerousCommandsConfig>
    // Prefer wid-arity when a workspace is in scope and the source expects it
    if (wid !== undefined && fn.length >= 1) return fn(wid)
    if (wid !== undefined) {
      // No-arg source in a workspace context: call without args (ignore wid)
      return (fn as () => DangerousCommandsConfig | Promise<DangerousCommandsConfig>)()
    }
    return (fn as () => DangerousCommandsConfig | Promise<DangerousCommandsConfig>)()
  }

  const dispose = ctx.on(
    'tools/rewrite',
    async (
      payload: { readonly call: ToolCall; readonly exec: ToolExecution },
      next: (replacement?: { readonly call: ToolCall; readonly exec?: ToolExecution }) => Promise<PreExecuteDecision>,
    ): Promise<PreExecuteDecision> => {
      try {
        if (payload.call.name !== 'Bash') return next()
        const command = (payload.call.args as Record<string, unknown>)['command']
        if (typeof command !== 'string') return next()

        let config: DangerousCommandsConfig
        try {
          config = await resolveConfig()
        } catch (error) {
          return { kind: 'deny', reason: `blocked by Dangerous Commands: guard error — config unavailable (${String(error instanceof Error ? error.message : error)}) (fail-closed)` }
        }

        let match: GuardMatch | null
        try {
          match = matchCommand(command, config)
        } catch (error) {
          return { kind: 'deny', reason: `blocked by Dangerous Commands: guard error — ${String(error instanceof Error ? error.message : error)} (fail-closed)` }
        }

        if (match === null) return next()
        const action = match.action as string
        if (action === 'allow' || action === 'off') return next()

        if (action === 'deny') {
          options.onMatch?.(match, payload.call)
          const label = match.presetId ?? match.ruleId ?? 'rule'
          return { kind: 'deny', reason: `blocked by Dangerous Commands: matched ${label} — ${match.reason}` }
        }

        if (action === 'ask') {
          store(payload.call, match, payload.exec)
          options.onMatch?.(match, payload.call)
          const decision = await next({ call: payload.call, exec: payload.exec })
          if (decision.kind === 'allow' && decision.call !== payload.call) {
            store(decision.call, match, payload.exec)
          }
          return decision
        }

        return next()
      } catch (error) {
        return { kind: 'deny', reason: `blocked by Dangerous Commands: guard error — ${String(error instanceof Error ? error.message : error)} (fail-closed)` }
      }
    },
    true,
  )

  return {
    getMatch(call: ToolCall, executionId?: string): GuardMatch | null {
      const direct = perCall.get(call)
      if (direct !== undefined) return direct
      if (executionId !== undefined) return byExecution.get(executionId) ?? null
      return null
    },
    clearForWorkspace(workspaceId: string): void {
      for (const [executionId, wid] of [...executionWorkspace.entries()]) {
        if (wid === workspaceId) {
          executionWorkspace.delete(executionId)
          byExecution.delete(executionId)
        }
      }
    },
    dispose,
  }
}
