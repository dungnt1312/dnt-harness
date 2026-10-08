/**
 * Claude Code command hooks. A hook's `command` runs through the shell
 * (`/bin/sh -c`, `cmd.exe` on Windows) exactly as Claude Code runs it, in the
 * project directory with `CLAUDE_PROJECT_DIR` set; the event input arrives as
 * JSON on stdin. Results follow the Claude contract:
 *
 *   exit 0  success; stdout JSON (an object) is the structured output
 *   exit 2  blocking error; stderr is the reason (what it blocks depends on the event)
 *   other   non-blocking error; execution continues
 *
 * dnt-harness hardening that does not change the format: credential-looking
 * environment variables are scrubbed, output is capped, the process tree is
 * killed on timeout or stop, and the runner has no access to the harness
 * (a hook cannot call the model or a tool).
 */
import { spawn } from 'node:child_process'
import { scrubbedChildEnv } from '../child-env.ts'
import { DEFAULT_HOOK_TIMEOUT_SECONDS, type ClaudeHookEvent, type ResolvedHook } from './settings.ts'

/** Hook output past this many characters per stream is discarded. */
const HOOK_OUTPUT_CAP = 256 * 1024

export interface HookRunOptions {
  /** Working directory (project root, else the workspace folder). */
  readonly cwd?: string
  /** `CLAUDE_PROJECT_DIR` (defaults to cwd). */
  readonly projectDir?: string
  readonly signal?: AbortSignal
}

/** What one hook process did. */
export interface HookOutcome {
  readonly command: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** Parsed stdout when it is a JSON object (exit 0 only, per Claude). */
  readonly json?: Record<string, unknown>
  readonly durationMs: number
  readonly timedOut: boolean
}

/** Run one hook command with `input` on stdin. Never throws; spawn failures are non-blocking errors. */
export function runHook(hook: Pick<ResolvedHook, 'command' | 'timeout'>, input: Record<string, unknown>, options: HookRunOptions = {}): Promise<HookOutcome> {
  const started = Date.now()
  const timeoutMs = Math.round((hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000)
  return new Promise<HookOutcome>((resolve) => {
    let settled = false
    let stderr = ''
    let stdout = ''
    let timedOut = false
    let child: ReturnType<typeof spawn> | undefined
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      const json = exitCode === 0 ? parseJsonObject(stdout) : undefined
      resolve({
        command: hook.command,
        exitCode,
        stdout,
        stderr,
        ...(json !== undefined ? { json } : {}),
        durationMs: Date.now() - started,
        timedOut,
      })
    }
    const cancel = (): void => {
      if (child !== undefined) {
        if (process.platform === 'win32' && child.pid !== undefined) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child?.kill('SIGKILL'))
        } else {
          try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') }
          catch { child.kill('SIGKILL') }
        }
        // Do not wait on inherited pipes held by a surviving descendant.
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
      }
      finish(null)
    }
    const timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, timeoutMs)
    timer.unref?.()
    if (options.signal?.aborted === true) {
      cancel()
      return
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    const projectDir = options.projectDir ?? options.cwd
    try {
      child = spawn(hook.command, {
        shell: true,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: scrubbedChildEnv(projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : {}),
        windowsHide: true,
        // Own process group so a timeout kills the whole tree.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      stderr = `hook spawn failed: ${String(error instanceof Error ? error.message : error)}`
      finish(1)
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < HOOK_OUTPUT_CAP) stdout += chunk.toString('utf8').slice(0, HOOK_OUTPUT_CAP - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < HOOK_OUTPUT_CAP) stderr += chunk.toString('utf8').slice(0, HOOK_OUTPUT_CAP - stderr.length)
    })
    child.on('error', (error: Error) => {
      stderr += `hook error: ${error.message}`
      finish(1)
    })
    child.on('close', (code: number | null) => finish(code))
    // A hook that never reads stdin must not crash the write.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(JSON.stringify(input))
  })
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

// ── interpreting results (Claude Code output contract) ───────────────────

/** The merged effect of every hook that ran for one event. */
export interface HookVerdict {
  /** `continue: false` from any hook: stop the turn (Claude stops processing). */
  readonly stop?: { readonly reason: string }
  /**
   * The event's blocking outcome: exit 2, `decision: "block"`, or (PreToolUse)
   * `permissionDecision: "deny"`. The reason is what the model (or user) sees.
   */
  readonly block?: { readonly reason: string }
  /** PreToolUse: the strongest permission decision (deny > ask > allow). */
  readonly permission?: 'allow' | 'deny' | 'ask'
  readonly permissionReason?: string
  /** PreToolUse: rewritten tool input (last hook in config order wins). */
  readonly updatedInput?: Record<string, unknown>
  /** Context for the model: `additionalContext`, or plain stdout where Claude adds it. */
  readonly additionalContext?: string
  /** Messages for the user (`systemMessage`, non-blocking error stderr). */
  readonly userMessages: readonly string[]
}

/** Events whose plain exit-0 stdout Claude adds to the model's context. */
const STDOUT_IS_CONTEXT: ReadonlySet<ClaudeHookEvent> = new Set<ClaudeHookEvent>(['UserPromptSubmit', 'SessionStart'])
/** Events where exit 2 / `decision: "block"` has an effect. */
const BLOCKABLE: ReadonlySet<ClaudeHookEvent> = new Set<ClaudeHookEvent>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Merge the outcomes of one event's hooks (config order) into one verdict. */
export function interpretHooks(event: ClaudeHookEvent, outcomes: readonly HookOutcome[]): HookVerdict {
  let stop: { reason: string } | undefined
  const blockReasons: string[] = []
  let permission: 'allow' | 'deny' | 'ask' | undefined
  let permissionReason: string | undefined
  let updatedInput: Record<string, unknown> | undefined
  const context: string[] = []
  const userMessages: string[] = []
  const rank = { allow: 1, ask: 2, deny: 3 } as const

  for (const outcome of outcomes) {
    if (outcome.exitCode === 2) {
      const reason = outcome.stderr.trim() !== '' ? outcome.stderr.trim() : `hook '${outcome.command}' exited 2`
      if (BLOCKABLE.has(event)) blockReasons.push(reason)
      else userMessages.push(reason)
      continue
    }
    if (outcome.exitCode !== 0) {
      userMessages.push(outcome.timedOut
        ? `hook '${outcome.command}' timed out`
        : `hook '${outcome.command}' failed (exit ${outcome.exitCode ?? 'killed'})${outcome.stderr.trim() !== '' ? `: ${outcome.stderr.trim()}` : ''}`)
      continue
    }
    const json = outcome.json
    if (json === undefined) {
      if (STDOUT_IS_CONTEXT.has(event) && outcome.stdout.trim() !== '') context.push(outcome.stdout.trim())
      continue
    }
    if (json['continue'] === false) stop ??= { reason: str(json['stopReason']) ?? `hook '${outcome.command}' stopped the turn` }
    const systemMessage = str(json['systemMessage'])
    if (systemMessage !== undefined) userMessages.push(systemMessage)

    const specific = json['hookSpecificOutput'] !== null && typeof json['hookSpecificOutput'] === 'object' && !Array.isArray(json['hookSpecificOutput'])
      ? json['hookSpecificOutput'] as Record<string, unknown>
      : undefined
    const additional = str(specific?.['additionalContext'])
    if (additional !== undefined) context.push(additional)

    const decision = json['decision']
    const reason = str(json['reason'])
    if (event === 'PreToolUse') {
      let next: 'allow' | 'deny' | 'ask' | undefined
      let nextReason: string | undefined
      const fromSpecific = specific?.['permissionDecision']
      if (fromSpecific === 'allow' || fromSpecific === 'deny' || fromSpecific === 'ask') {
        next = fromSpecific
        nextReason = str(specific?.['permissionDecisionReason'])
      } else if (decision === 'approve') {
        next = 'allow'
        nextReason = reason
      } else if (decision === 'block') {
        next = 'deny'
        nextReason = reason
      }
      if (next !== undefined && (permission === undefined || rank[next] > rank[permission])) {
        permission = next
        permissionReason = nextReason
      }
      const rewritten = specific?.['updatedInput']
      if (rewritten !== null && typeof rewritten === 'object' && !Array.isArray(rewritten)) updatedInput = rewritten as Record<string, unknown>
    } else if (decision === 'block' && BLOCKABLE.has(event)) {
      blockReasons.push(reason ?? `blocked by hook '${outcome.command}'`)
    }
  }

  if (event === 'PreToolUse' && permission === 'deny') {
    blockReasons.unshift(permissionReason ?? 'denied by a PreToolUse hook')
  }
  return {
    ...(stop !== undefined ? { stop } : {}),
    ...(blockReasons.length > 0 ? { block: { reason: blockReasons.join('\n') } } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(permissionReason !== undefined ? { permissionReason } : {}),
    ...(updatedInput !== undefined ? { updatedInput } : {}),
    ...(context.length > 0 ? { additionalContext: context.join('\n\n') } : {}),
    userMessages,
  }
}

/** Run every hook in parallel (Claude semantics) and keep outcomes in config order. */
export async function runHooks(hooks: readonly ResolvedHook[], input: Record<string, unknown>, options: HookRunOptions = {}): Promise<HookOutcome[]> {
  return Promise.all(hooks.map((hook) => runHook(hook, input, options)))
}

/** The user-facing text one outcome carries (`systemMessage`, error stderr, stop reason), capped. */
export function outcomeMessage(outcome: HookOutcome, cap = 500): string | undefined {
  let text: string | undefined
  if (outcome.timedOut) text = 'timed out'
  else if (outcome.exitCode !== 0) text = outcome.stderr.trim() !== '' ? outcome.stderr.trim() : `exit ${outcome.exitCode ?? 'killed'}`
  else {
    const json = outcome.json
    const parts = [json?.['systemMessage'], json?.['continue'] === false ? json?.['stopReason'] : undefined]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    text = parts.length > 0 ? parts.join(' — ') : undefined
  }
  return text === undefined ? undefined : text.length > cap ? `${text.slice(0, cap - 1)}…` : text
}

/** Compact label for the durable audit record. */
export function auditDecision(event: ClaudeHookEvent, outcome: HookOutcome): string {
  if (outcome.timedOut) return 'timeout'
  if (outcome.exitCode === null) return 'killed'
  if (outcome.exitCode === 2) return 'block'
  if (outcome.exitCode !== 0) return `error:${outcome.exitCode}`
  const json = outcome.json
  if (json === undefined) return outcome.stdout.trim() !== '' && STDOUT_IS_CONTEXT.has(event) ? 'context' : 'ok'
  if (json['continue'] === false) return 'stop'
  const specific = json['hookSpecificOutput'] as Record<string, unknown> | undefined
  if (event === 'PreToolUse') {
    const decision = specific?.['permissionDecision'] ?? (json['decision'] === 'approve' ? 'allow' : json['decision'] === 'block' ? 'deny' : undefined)
    if (typeof decision === 'string') return specific?.['updatedInput'] !== undefined ? `${decision}+rewrite` : decision
    if (specific?.['updatedInput'] !== undefined) return 'rewrite'
  }
  if (json['decision'] === 'block') return 'block'
  if (specific?.['additionalContext'] !== undefined) return 'context'
  return 'ok'
}
