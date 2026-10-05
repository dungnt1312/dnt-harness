import { createHash } from 'node:crypto'
import type { Context } from '../../kernel/index.ts'
import type { ToolCall } from '../llm/types.ts'
import { matchCommand } from './matcher.ts'
import type { DangerousCommandsConfig, GuardMatch } from './types.ts'
import type { ToolExecution } from '../tools/types.ts'
import { currentToolExecution } from '../tools/execution-scope.ts'

export interface GuardConfigSnapshot {
  readonly config: DangerousCommandsConfig
  readonly revision?: string | number
  readonly hash?: string
}

export type GuardConfigSource =
  | (() => DangerousCommandsConfig | GuardConfigSnapshot | Promise<DangerousCommandsConfig | GuardConfigSnapshot>)
  | ((workspaceId: string) => DangerousCommandsConfig | GuardConfigSnapshot | Promise<DangerousCommandsConfig | GuardConfigSnapshot>)

export interface GuardOptions {
  readonly configSource: GuardConfigSource
  readonly onMatch?: (match: GuardMatch, call: ToolCall) => void
}

export interface GuardEvaluation {
  readonly match: GuardMatch | null
  readonly revision: string | number
  readonly hash: string
}

export interface GuardHandle {
  /** Evaluate the finalized call against the current workspace config. */
  evaluate(call: ToolCall, workspaceId?: string, exec?: ToolExecution): Promise<GuardEvaluation>
  /** Presentation evidence for the live approval question only; never authority. */
  getMatch(call: ToolCall, executionId?: string): GuardMatch | null
  clearForWorkspace(workspaceId: string): void
  retire(executionId: string | undefined): void
  dispose(): boolean
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort().map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
}

function configHash(config: DangerousCommandsConfig): string {
  return createHash('sha256').update(stableJson(config)).digest('hex')
}

/**
 * Identity of the matched rule/preset: its id plus a hash of the matched
 * pattern. Deliberately independent of the rest of the config, so an edit to
 * an unrelated preset or rule does not invalidate a human approval, while a
 * change to the matched rule itself does.
 */
export function guardMatchFingerprint(match: GuardMatch): string {
  const patternHash = createHash('sha256').update(match.pattern).digest('hex')
  return createHash('sha256')
    .update(stableJson({ presetId: match.presetId ?? null, ruleId: match.ruleId ?? null, action: match.action, patternHash }))
    .digest('hex')
}

function isSnapshot(value: DangerousCommandsConfig | GuardConfigSnapshot): value is GuardConfigSnapshot {
  return 'config' in value
}

export function attachDangerousCommandGuard(ctx: Context, options: GuardOptions): GuardHandle {
  const perCall = new WeakMap<ToolCall, GuardMatch>()
  const byExecution = new Map<string, GuardMatch>()
  const executionWorkspace = new Map<string, string>()

  function retire(executionId: string | undefined): void {
    if (executionId === undefined) return
    byExecution.delete(executionId)
    executionWorkspace.delete(executionId)
  }

  function store(call: ToolCall, match: GuardMatch, workspaceId: string | undefined, payloadExec?: ToolExecution): void {
    perCall.set(call, match)
    const executionId = currentToolExecution(payloadExec)?.executionId
    if (executionId !== undefined) {
      byExecution.set(executionId, match)
      if (workspaceId !== undefined) executionWorkspace.set(executionId, workspaceId)
    }
  }

  async function resolveConfig(workspaceId?: string): Promise<GuardConfigSnapshot> {
    const fn = options.configSource as (...args: string[]) => DangerousCommandsConfig | GuardConfigSnapshot | Promise<DangerousCommandsConfig | GuardConfigSnapshot>
    const loaded = workspaceId !== undefined && fn.length >= 1 ? await fn(workspaceId) : await fn()
    if (isSnapshot(loaded)) {
      const hash = loaded.hash ?? configHash(loaded.config)
      return { config: loaded.config, hash, revision: loaded.revision ?? hash }
    }
    const hash = configHash(loaded)
    return { config: loaded, hash, revision: hash }
  }

  const disposeGate = ctx.on('tools/pre-execute', async (payload: { readonly call: ToolCall; readonly exec: ToolExecution }, next) => {
    try {
      const workspaceId = payload.exec.workspaceId
      const evaluation = await handle.evaluate(payload.call, workspaceId, payload.exec)
      const match = evaluation.match
      if (match?.action === 'deny') {
        const label = match.presetId ?? match.ruleId ?? 'rule'
        return { kind: 'deny' as const, reason: `blocked by Dangerous Commands: matched ${label} — ${match.reason}` }
      }
      return next()
    } catch (error) {
      return { kind: 'deny' as const, reason: `blocked by Dangerous Commands: ${String(error instanceof Error ? error.message : error)}` }
    }
  }, true)
  const disposePost = ctx.on('tools/post-execute', async (payload, next) => {
    retire(payload.exec.executionId)
    return next()
  })

  const handle: GuardHandle = {
    async evaluate(call, workspaceId, exec) {
      // Every evaluation supersedes earlier evidence for this call/execution,
      // including when the config is now unavailable or no longer matches.
      perCall.delete(call)
      const executionId = currentToolExecution(exec)?.executionId
      retire(executionId)
      let snapshot: GuardConfigSnapshot
      try {
        snapshot = await resolveConfig(workspaceId)
      } catch (error) {
        throw new Error(`guard error — config unavailable (${String(error instanceof Error ? error.message : error)}) (fail-closed)`)
      }
      let match: GuardMatch | null = null
      if (call.name === 'Bash') {
        const command = (call.args as Record<string, unknown>)['command']
        if (typeof command === 'string') {
          try {
            match = matchCommand(command, snapshot.config)
          } catch (error) {
            throw new Error(`guard error — ${String(error instanceof Error ? error.message : error)} (fail-closed)`)
          }
        }
      }
      if (match !== null && (match.action === 'ask' || match.action === 'deny')) {
        options.onMatch?.(match, call)
        if (match.action === 'ask') store(call, match, workspaceId, exec)
      }
      return { match, revision: snapshot.revision ?? snapshot.hash ?? configHash(snapshot.config), hash: snapshot.hash ?? configHash(snapshot.config) }
    },
    getMatch(call: ToolCall, executionId?: string): GuardMatch | null {
      const direct = perCall.get(call)
      if (direct !== undefined) return direct
      if (executionId !== undefined) return byExecution.get(executionId) ?? null
      return null
    },
    clearForWorkspace(workspaceId: string): void {
      for (const [executionId, wid] of [...executionWorkspace.entries()]) {
        if (wid === workspaceId) retire(executionId)
      }
    },
    retire,
    dispose: () => {
      const gate = disposeGate()
      const post = disposePost()
      byExecution.clear()
      executionWorkspace.clear()
      return gate || post
    },
  }
  return handle
}
