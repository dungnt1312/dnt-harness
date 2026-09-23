/**
 * What one recorded tool call did, in the shape an activity row reads: the
 * target it acted on and one phrase for what came back.
 *
 * Every digest is derived from what the log already holds — lines counted in
 * the recorded output, or the markers the built-in tools write themselves
 * (`[exit code: N]`, `overwrote … (N bytes written)`, `no matches`). Nothing
 * here infers an outcome the log did not record, and a call without a result
 * carries no digest at all.
 */
import { formatBytes, shortCommand, shortPath, toolTarget } from './format.ts'
import type { ToolCall } from './types.ts'

/** The recorded outcome a digest is read from. */
export interface ToolResultView {
  readonly ok: boolean
  readonly output: string
}

/** The window a call opened a file at — carried to the workbench viewer. */
export interface FileFocus {
  /** 1-based first line. */
  readonly line: number
  /** Lines the window covers; 1 when the call named a single line. */
  readonly lines?: number
}

export interface ToolFacts {
  /** Display name: an MCP call drops its `mcp__<server>__` prefix. */
  readonly name: string
  /** Row-width target: `src/x.ts:100-160`, a pattern, an elided command. */
  readonly target: string
  /** The untruncated target, for the row's tooltip. */
  readonly fullTarget: string
  /** The path this call names, when it names one. */
  readonly path?: string
  /** The window a `Read` opened, when it read one. */
  readonly focus?: FileFocus
  /** One phrase for the recorded result; absent while the call is running. */
  readonly digest?: string
  /** The digest reports a failure — an error excerpt or a non-zero exit. */
  readonly digestFailed?: boolean
}

/** `mcp__<server>__<tool>` (the Claude convention) — undefined for built-ins. */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const boundary = rest.indexOf('__')
  return boundary > 0 ? rest.slice(0, boundary) : undefined
}

/**
 * The name a row shows. An MCP tool's server is already its own chip, so the
 * prefix would only spend row width the target needs.
 */
export function toolDisplayName(name: string): string {
  const server = mcpServerOf(name)
  return server === undefined ? name : name.slice(`mcp__${server}__`.length)
}

const PATH_KEYS = ['path', 'file_path'] as const
/** The marker `cap()` appends when a tool output was cut to its limit. */
const TRUNCATION = /\n… \[truncated \d+ chars\]$/

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
}

function argPath(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = str(args, key)
    if (value !== undefined) return value
  }
  return undefined
}

/** Lines in a recorded output, ignoring one trailing newline. */
function countLines(output: string): number {
  if (output === '') return 0
  return output.replace(/\n$/, '').split('\n').length
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}

/** The first line that says something, narrow enough for a row. */
function excerpt(output: string, max = 72): string {
  const line = output.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * A digest for output with no tool-specific shape: a short single line speaks
 * for itself, anything longer is measured instead of guessed at.
 */
function genericDigest(output: string): string {
  const trimmed = output.trim()
  if (trimmed === '') return 'empty'
  const lines = countLines(trimmed)
  if (lines === 1 && trimmed.length <= 48) return trimmed
  return plural(lines, 'line')
}

/** Body lines of a list output, without the truncation marker. */
function listLines(output: string): string[] {
  return output.replace(TRUNCATION, '').split('\n').filter((line) => line.trim() !== '')
}

function readDigest(output: string): string {
  const truncated = TRUNCATION.test(output)
  const lines = countLines(output.replace(TRUNCATION, ''))
  if (lines === 0) return 'empty'
  return `${plural(lines, 'line')}${truncated ? ' · truncated' : ''}`
}

function writeDigest(output: string): string {
  const overwrote = /\((\d+) bytes written\)/.exec(output)
  if (overwrote?.[1] !== undefined) return `overwrote · ${formatBytes(Number(overwrote[1]))}`
  if (output.startsWith('created ')) return 'created'
  return genericDigest(output)
}

/** `Edit` reports its own size: the replacement is in the arguments, exactly. */
function editDigest(args: Record<string, unknown>): string | undefined {
  const removed = str(args, 'old')
  const added = str(args, 'new')
  if (removed === undefined && added === undefined) return undefined
  return `-${countLines(removed ?? '')} +${countLines(added ?? '')} lines`
}

function globDigest(output: string): string {
  if (output.startsWith('no matches')) return 'no matches'
  return plural(listLines(output).length, 'file')
}

function grepDigest(output: string): string {
  if (output.startsWith('no matches')) return 'no matches'
  const lines = listLines(output)
  const files = new Set<string>()
  for (const line of lines) {
    const match = /^(.*?):\d+: /.exec(line)
    if (match?.[1] !== undefined) files.add(match[1])
  }
  const matches = plural(lines.length, 'match', 'matches')
  return files.size > 1 ? `${matches} · ${plural(files.size, 'file')}` : matches
}

/** `Bash` always settles as a recorded result; the exit code is the outcome. */
function bashDigest(output: string): { digest: string; failed: boolean } {
  const exit = /\[exit code: (-?\d+)\]\s*$/.exec(output)
  if (exit?.[1] !== undefined) {
    const code = Number(exit[1])
    return { digest: `exit ${code}`, failed: code !== 0 }
  }
  if (/\[terminated[^\]]*\]\s*$/.test(output)) return { digest: 'terminated', failed: true }
  if (output.startsWith('cancelled:')) return { digest: 'cancelled', failed: true }
  if (output.startsWith('error:')) return { digest: excerpt(output), failed: true }
  return { digest: genericDigest(output), failed: false }
}

/** The line window a `Read` names: `:100-160`, `:100+`, or nothing. */
function readWindow(offset?: number, limit?: number): { label: string; focus?: FileFocus } {
  if (offset === undefined && limit === undefined) return { label: '' }
  const start = Math.max(offset ?? 1, 1)
  if (limit === undefined) return { label: `:${start}+`, focus: { line: start } }
  const span = Math.max(limit, 1)
  return { label: `:${start}-${start + span - 1}`, focus: { line: start, lines: span } }
}

/** A value that looks like a path shortens as one; anything else is a phrase. */
function shortenTarget(target: string): string {
  const pathLike = /[\\/]/.test(target) && !/\s/.test(target)
  return pathLike ? shortPath(target) : shortCommand(target)
}

/**
 * Read one recorded call. `result` is the outcome the log holds, or undefined
 * while the call is still running.
 */
export function toolFacts(call: ToolCall, result?: ToolResultView): ToolFacts {
  const args = call.args
  const builtin = mcpServerOf(call.name) === undefined ? call.name.toLowerCase() : ''
  const name = toolDisplayName(call.name)
  const failed = result !== undefined && !result.ok

  let fullTarget = ''
  let target = ''
  let path = argPath(args)
  let focus: FileFocus | undefined
  let digest: string | undefined
  let digestFailed = failed

  switch (builtin) {
    case 'read': {
      const window = readWindow(int(args, 'offset'), int(args, 'limit'))
      focus = window.focus
      fullTarget = `${path ?? ''}${window.label}`
      target = `${path !== undefined ? shortPath(path) : ''}${window.label}`
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : readDigest(result.output)
      break
    }
    case 'write':
    case 'edit': {
      fullTarget = path ?? ''
      target = path !== undefined ? shortPath(path) : ''
      digest = result === undefined
        ? undefined
        : failed
          ? excerpt(result.output)
          : builtin === 'write' ? writeDigest(result.output) : editDigest(args) ?? genericDigest(result.output)
      break
    }
    case 'glob': {
      fullTarget = str(args, 'pattern') ?? ''
      target = shortCommand(fullTarget)
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : globDigest(result.output)
      break
    }
    case 'grep': {
      const pattern = str(args, 'pattern') ?? ''
      const scope = str(args, 'path')
      fullTarget = scope !== undefined ? `${pattern} in ${scope}` : pattern
      target = `${shortCommand(pattern, 40)}${scope !== undefined ? ` in ${shortPath(scope)}` : ''}`
      // A Grep's `path` scopes the search; it is not a file to open.
      path = undefined
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : grepDigest(result.output)
      break
    }
    case 'bash': {
      fullTarget = str(args, 'command') ?? ''
      target = shortCommand(fullTarget)
      if (result !== undefined) {
        if (failed) digest = excerpt(result.output)
        else {
          const read = bashDigest(result.output)
          digest = read.digest
          digestFailed = read.failed
        }
      }
      break
    }
    default: {
      fullTarget = toolTarget(args)
      target = shortenTarget(fullTarget)
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : genericDigest(result.output)
      break
    }
  }

  return {
    name,
    target,
    fullTarget,
    ...(path !== undefined ? { path } : {}),
    ...(focus !== undefined ? { focus } : {}),
    ...(digest !== undefined && digest !== '' ? { digest, digestFailed } : {}),
  }
}
