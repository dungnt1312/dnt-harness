/**
 * The model's control surface over background Bash processes: read the
 * captured output of one it started, and kill one it started. Lookups are
 * scoped by the executing session — a process id from another session is
 * unknown here. Both are always allowed without approval: they only touch
 * processes the agent itself spawned, and neither needs a granted root.
 */
import type { ProcessRegistry } from '../../harness/processes/registry.ts'
import type { ToolDefinition, ToolExecution } from '../../harness/tools/types.ts'

const OUTPUT_CAP = 30_000

function knownIds(processes: ProcessRegistry, exec: ToolExecution): string {
  const running = processes.snapshot(exec.sessionId as never).filter((row) => row.status === 'running')
  return running.map((row) => row.id).join(', ') || '(none running)'
}

export function bashOutputTool(options: { readonly processes: ProcessRegistry }): ToolDefinition {
  return {
    name: 'BashOutput',
    description: 'Read the captured stdout/stderr and status of one background process started with Bash run_in_background.',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'the process id returned by Bash' },
        block: { type: 'boolean', description: 'wait for completion; default false' },
        timeoutMs: { type: 'number', description: 'wait budget, default 30000, max 600000; never kills the process' },
      },
      required: ['processId'],
    },
    async execute(args, exec) {
      const processId = args['processId']
      if (typeof processId !== 'string' || processId === '') {
        return "error: argument 'processId' must be a non-empty string"
      }
      if (exec.sessionId === undefined) return 'error: no session scope for background processes'
      const requested = args['timeoutMs']
      const waitMs = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(requested, 600_000) : 30_000
      const read = args['block'] === true
        ? await options.processes.wait(exec.sessionId, processId, { timeoutMs: waitMs, ...(exec.signal !== undefined ? { signal: exec.signal } : {}) })
        : options.processes.read(exec.sessionId, processId)
      if (read === undefined) {
        return `error: unknown processId '${processId}' in this session; running: ${knownIds(options.processes, exec)}`
      }
      const status = read.status === 'running' ? 'running' : `${read.status}${read.exitCode !== null ? ` (exit code: ${read.exitCode})` : ''}`
      const limit = exec.outputLimit ?? OUTPUT_CAP
      const body = read.output.length > limit ? `${read.output.slice(0, limit)}\n… [truncated ${read.output.length - limit} chars]` : read.output
      const truncated = read.outputTruncated ? '\n… [output truncated during capture]' : ''
      return `[status: ${status}]\n${body}${truncated}`
    },
  }
}

export function killShellTool(options: { readonly processes: ProcessRegistry }): ToolDefinition {
  return {
    name: 'KillShell',
    description: 'Kill one background process started with Bash run_in_background (whole process tree).',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'the process id returned by Bash run_in_background' },
      },
      required: ['processId'],
    },
    async execute(args, exec) {
      const processId = args['processId']
      if (typeof processId !== 'string' || processId === '') {
        return "error: argument 'processId' must be a non-empty string"
      }
      if (exec.sessionId === undefined) return 'error: no session scope for background processes'
      const outcome = await options.processes.kill(exec.sessionId, processId)
      if (outcome.outcome === 'not-found') {
        return `error: unknown processId '${processId}' in this session; running: ${knownIds(options.processes, exec)}`
      }
      if (outcome.outcome === 'already-ended') {
        return `process ${processId} already ended (status: ${outcome.status}); nothing to kill`
      }
      return `process ${processId} killed`
    },
  }
}
