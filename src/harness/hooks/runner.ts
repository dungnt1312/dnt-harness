/**
 * Hooks runner (G5): `command`-type hooks execute as direct
 * `command + args` spawns — never via the Bash tool or shell adapter.
 * Payload JSON arrives on stdin; stdout may carry a structured decision;
 * exit codes follow the Claude convention (0 allow/ok, 2 block, 1
 * non-blocking failure). Timeouts are strict; recursion into MCP/model is
 * structurally impossible from here (plain child process, no harness access).
 */
import { spawn } from 'node:child_process'
import { scrubbedChildEnv } from '../child-env.ts'
import type { HookBinding } from '../mcp/config.ts'

/** Hook output past this many characters per stream is discarded. */
const HOOK_OUTPUT_CAP = 256 * 1024

export interface HookDecision {
  readonly exitCode: number | null
  /** PreToolUse: block the tool call. */
  readonly blocked: boolean
  /** PreToolUse: rewritten input arguments (re-enters the gate). */
  readonly updatedInput?: Record<string, unknown>
  /** UserPromptSubmit: injected context. */
  readonly injected?: string
  /** PostToolUse: flag/annotation for the audit trail. */
  readonly flagged?: string
  /** Human-readable diagnostics from stderr. */
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

/** A hook command string is split on whitespace (no shell quoting) — direct spawn. */
function splitCommand(command: string): { file: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter((part) => part !== '')
  const [file = '', ...args] = parts
  return { file: file ?? '', args }
}

/**
 * Run one hook binding. Timed out or spawn-failed hooks follow the
 * binding's onFailure policy — the runner reports what happened; the
 * caller (the gate listener) decides deny vs allow from it.
 */
export function runHook(binding: HookBinding, payload: Record<string, unknown>, defaultTimeoutMs = 3_000): Promise<HookDecision> {
  const started = Date.now()
  // Prefer explicit args (direct command+args contract). Legacy command
  // strings are split only when args is absent.
  const parsed = splitCommand(binding.command)
  const file = binding.args !== undefined ? binding.command : parsed.file
  const args = binding.args !== undefined ? [...binding.args] : parsed.args
  const timeoutMs = binding.timeoutMs ?? defaultTimeoutMs
  return new Promise<HookDecision>((resolve) => {
    let settled = false
    let stderr = ''
    let stdout = ''
    let timedOut = false
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let decision: HookDecision = {
        exitCode,
        blocked: false,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      }
      // Structured stdout decisions (best effort parse; plain output ignored).
      const structured = parseStdout(stdout)
      if (structured !== undefined) {
        if (structured['updatedInput'] !== null && typeof structured['updatedInput'] === 'object' && !Array.isArray(structured['updatedInput'])) {
          decision = { ...decision, updatedInput: structured['updatedInput'] as Record<string, unknown> }
        }
        if (typeof structured['injected'] === 'string') decision = { ...decision, injected: structured['injected'] }
        if (typeof structured['flagged'] === 'string') decision = { ...decision, flagged: structured['flagged'] }
      }
      resolve(decision)
    }
    let child
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: scrubbedChildEnv(), windowsHide: true })
    } catch {
      // Spawn failures are non-blocking failures (exit 1 semantics); the
      // caller applies onFailure.
      resolve({ exitCode: 1, blocked: false, stderr: `hook spawn failed: ${binding.command}`, durationMs: 0, timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()
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
    child.on('close', (code: number | null) => {
      finish(code)
    })
    // Payload JSON via stdin, then close. Exit code 2 = block (Claude
    // convention); enforced at the caller via isBlockingDecision().
    child.stdin?.write(JSON.stringify(payload))
    child.stdin?.end()
    void settled
  })
}

/** Exit-code semantics: 0 = ok, 2 = block, other = non-blocking failure. */
export function isBlockingDecision(decision: HookDecision): boolean {
  return decision.exitCode === 2 || decision.blocked
}

/** Non-zero non-2 exit / timeout / spawn error → the onFailure policy applies. */
export function isFailureDecision(decision: HookDecision): boolean {
  return decision.timedOut || decision.exitCode === null || (decision.exitCode !== 0 && decision.exitCode !== 2)
}

function parseStdout(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}
