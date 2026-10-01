/**
 * Shell capability consumer: the `Bash` tool. Bash means Bash — an explicit
 * adapter resolves the actual executable (Git Bash's `bash.exe` on Windows,
 * `/bin/bash` elsewhere, or `MINI_DSH_BASH`); when none exists the tool
 * disables itself with an actionable error instead of silently substituting
 * another shell.
 *
 * One command, captured output, wall-clock timeout, cancellation via the
 * run's abort signal, and verified cleanup: the whole process tree dies
 * (process-group kill on POSIX; `taskkill /T` plus an environment-tag sweep
 * for orphaned MSYS forks on Windows), and spawn errors
 * settle the call instead of hanging it. Path checks confine file tools,
 * not shell access — a shell command can leave the workspace and nothing
 * here claims otherwise.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { detectShell } from './detect.ts'
import type { ToolDefinition, ToolExecution } from '../../harness/tools/types.ts'

const OUTPUT_CAP = 60_000
/** Capture stops shortly past the cap so the marker can note the discard. */
const CAPTURE_SLACK = 4_000

/** Options for the bash tool. */
export interface BashToolOptions {
  /** Wall-clock kill for one command; defaults to the harness limit (30s). */
  readonly timeoutMs?: number
  /**
   * Compatibility fallback for direct calls lacking an execution root. Pipeline
   * calls always use `ToolExecution.root` as the authoritative working folder.
   */
  readonly cwd?: string | (() => string)
  /** Explicit executable; overrides detection (e.g. a pinned Git Bash path). */
  readonly executable?: string
}

/** Environment marker every process of one Bash call inherits (Windows only). */
export const TREE_TAG_ENV = 'MINI_DSH_BASH_TREE'

/**
 * An MSYS script that SIGKILLs every process whose environment carries the
 * tag. It sweeps for a fixed window rather than stopping at the first empty
 * pass: under load, a shell the launcher was still creating when taskkill
 * ran can appear later. Builtins only inside a pass — a fork per process
 * would make each pass seconds long on Windows. The sweeper is spawned
 * without the tag, so it never matches itself.
 */
export function sweepByTag(treeTag: string): string {
  const entry = `${TREE_TAG_ENV}=${treeTag}`
  return [
    'for pass in 1 2 3 4 5 6 7 8 9 10 11 12; do',
    '  for d in /proc/[0-9]*; do',
    '    while IFS= read -r -d "" e; do',
    `      if [ "$e" = '${entry}' ]; then kill -9 "\${d#/proc/}" 2>/dev/null; break; fi`,
    '    done < "$d/environ" 2>/dev/null',
    '  done',
    '  sleep 0.25',
    'done',
  ].join('\n')
}

/**
 * Kill a spawned process tree. Best effort — the caller verifies through
 * the exit/close events, and the tool settles on `exit` after a kill so a
 * straggler grandchild holding the stdio pipes cannot stall the result.
 * Exported for the background-process registry, which owns long-lived trees.
 */
export function killTree(child: ChildProcess, shell: string, treeTag: string): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill /T takes the tree down. A
    // second pass reaps MSYS children that were mid-spawn during the first
    // tree walk (taskkill's parent walk races Git Bash's fork chain).
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => {
      child.kill('SIGKILL')
    })
    // A process forked while the walk killed its parent is orphaned, so no
    // later tree walk reaches it. It still carries the tree tag in its
    // environment: sweep MSYS processes by that tag until none remain.
    spawn(shell, ['-c', sweepByTag(treeTag)], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    setTimeout(() => {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
      child.kill('SIGKILL')
    }, 250).unref?.()
    return
  }
  try {
    // Detached spawn put the child in its own group: a lone SIGKILL on bash
    // would leave grandchildren (e.g. `sleep`) holding the stdio pipes open.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** The `Bash` tool: one command, captured output, timeout and stop handling. */
export function bashTool(options: BashToolOptions = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? 30_000
  // Used only for direct compatibility calls without a granted root. Pipeline
  // executions must derive their working directory from `exec.root`.
  const configuredCwd = options.cwd
  const fallbackCwd = typeof configuredCwd === 'function' ? configuredCwd : () => configuredCwd ?? process.cwd()
  const detection = detectShell(options.executable)
  return {
    name: 'Bash',
    description: 'Run one bash command and return its combined stdout/stderr and exit code.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the bash command line to run' },
        timeoutMs: { type: 'number', description: `kill after this many milliseconds (default 30000, max ${timeoutMs})` },
      },
      required: ['command'],
    },
    async execute(args, exec: ToolExecution) {
      const command = args['command']
      if (typeof command !== 'string' || command === '') {
        throw new Error("argument 'command' must be a non-empty string")
      }
      if (detection.executable === undefined) {
        return `error: bash is not available on this system; ${detection.hint}`
      }
      const requested = args['timeoutMs']
      const kill = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(requested, timeoutMs)
        : timeoutMs

      return await new Promise<string>((resolve) => {
        let settled = false
        let termination: 'timeout' | 'stop' | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        const treeTag = randomUUID()
        const onAbort = (): void => {
          termination = 'stop'
          killTree(child, detection.executable as string, treeTag)
        }
        const finish = (output: string): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (graceTimer !== undefined) clearTimeout(graceTimer)
          exec.signal?.removeEventListener('abort', onAbort)
          resolve(output)
        }
        const report = (code: number | null): string => {
          // A forced tree kill reports platform-specific pseudo exit codes
          // (for example 2304 under Windows/MSYS). The category is the stable
          // contract; ordinary process exits still expose their real code.
          const suffix = termination === 'stop'
            ? `
[terminated by stop; killed]`
            : termination === 'timeout'
              ? `
[terminated by timeout; killed]`
              : code === null
                ? `
[terminated, no exit code]`
                : `
[exit code: ${code}]`
          const limit = exec.outputLimit ?? OUTPUT_CAP
          const dropped = captureCapped ? '\n… [output truncated during capture]' : ''
          const body = output.length > limit
            ? `${output.slice(0, limit)}\n… [truncated ${output.length - limit} chars]`
            : output
          return `${body}${dropped}${suffix}`
        }
        if (exec.signal?.aborted === true) {
          finish('cancelled: stop requested before this command started')
          return
        }
        // Detached so the timeout can kill the whole process tree. Some
        // platforms throw synchronously for non-executable targets — that
        // must settle the call, never hang it.
        let child: ChildProcess
        try {
          child = spawn(detection.executable as string, ['-lc', command], {
            // The tool pipeline rejects empty roots before executing this
            // requiresRoot tool. The fallback retains direct-call compatibility.
            cwd: exec.root !== '' ? exec.root : fallbackCwd(),
            detached: true,
            ...(process.platform === 'win32' ? { env: { ...process.env, [TREE_TAG_ENV]: treeTag } } : {}),
          })
        } catch (error) {
          finish(`error: bash spawn failed (${String(error)}); verify the shell at '${detection.hint}'`)
          return
        }
        let output = ''
        let captureCapped = false
        const captureCap = (exec.outputLimit ?? OUTPUT_CAP) + CAPTURE_SLACK
        const append = (chunk: Buffer): void => {
          if (captureCapped) return
          output += chunk.toString('utf8')
          if (output.length > captureCap) {
            // A firehose must not eat memory while it runs: stop capturing,
            // the model-visible result is bounded regardless.
            captureCapped = true
            output = output.slice(0, captureCap)
          }
        }
        exec.signal?.addEventListener('abort', onAbort, { once: true })

        timer = setTimeout(() => {
          termination = 'timeout'
          killTree(child, detection.executable as string, treeTag)
        }, kill)
        timer.unref?.()

        child.stdout?.on('data', append)
        child.stderr?.on('data', append)
        child.on('error', (error: Error) => {
          finish(`error: bash spawn failed (${error.message}); verify the shell at '${detection.hint}'`)
        })
        child.on('close', (code: number | null) => {
          finish(report(code))
        })
        // After a kill, settle on `exit` with a short grace for the output:
        // a straggler grandchild can hold the stdio pipes past the death of
        // the shell, and the call must not wait on it.
        child.on('exit', (code: number | null) => {
          if (termination === undefined) return
          graceTimer = setTimeout(() => finish(report(code)), 400)
          graceTimer.unref?.()
        })
      })
    },
  }
}
