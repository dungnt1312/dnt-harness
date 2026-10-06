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
import { formatBytes, pathBasename, shortCommand, shortPath, toolTarget } from './format.ts'
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
  /**
   * A file call reads as the reference row: the file name is the title and
   * its directory sits beside it. Absent for commands, patterns and MCP calls.
   */
  readonly file?: { readonly name: string; readonly directory: string }
  /** Lines an Edit replaced, counted from the recorded arguments. */
  readonly lines?: { readonly added: number; readonly removed: number }
}

/**
 * A call that was refused — by policy, a hook, or the reader's own Deny — and
 * never ran. The pipeline records it as `ok: false` with `denied: <reason>`;
 * it is a decision, not a fault, so it is not reported as a failure.
 */
export function isDenied(result?: ToolResultView): boolean {
  return result !== undefined && !result.ok && result.output.startsWith('denied:')
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
function editLines(args: Record<string, unknown>): { added: number; removed: number } | undefined {
  const removed = str(args, 'old')
  const added = str(args, 'new')
  if (removed === undefined && added === undefined) return undefined
  return { added: countLines(added ?? ''), removed: countLines(removed ?? '') }
}

/** A directory longer than this elides its head: past it the row cannot show it whole anyway. */
const DIRECTORY_MAX = 48

/**
 * A long directory elides its head, not its tail — the segments nearest the
 * file are the ones a row is scanned for, and CSS truncation would cut the
 * tail first. Short directories pass through untouched.
 */
function shortDirectory(directory: string): string {
  if (directory.length <= DIRECTORY_MAX) return directory
  const separator = directory.includes('\\') ? '\\' : '/'
  const parts = directory.split(/[\\/]/).filter((part) => part !== '')
  let kept = parts.slice(-1).join(separator)
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const candidate = `${parts[index]}${separator}${kept}`
    if (`…${separator}${candidate}`.length > DIRECTORY_MAX) break
    kept = candidate
  }
  return `…${separator}${kept}`
}

/**
 * The file a row leads with. `Read` may append a line window to the name;
 * the directory is everything before the last segment, head-elided when it
 * runs long (the tooltip keeps the whole path).
 */
function fileParts(path: string, window = ''): { name: string; directory: string } {
  const name = pathBasename(path)
  const directory = shortDirectory(path.slice(0, path.length - name.length).replace(/[\/]+$/, ''))
  return { name: `${name}${window}`, directory }
}

/** The note `Glob` appends once it has listed its cap: `… [+523 more matches]`. */
const GLOB_MORE = /\n… \[\+(\d+) more matches\]\s*$/
/** A note a list tool writes about itself (`… [more matches truncated]`), not a match. */
const NOTE_LINE = /^… \[/

function globDigest(output: string): string {
  if (output.startsWith('no matches')) return 'no matches'
  const body = output.replace(TRUNCATION, '')
  const more = GLOB_MORE.exec(body)
  const shown = listLines(body.replace(GLOB_MORE, '')).length
  // The note is a count, not a file: it is never listed, and the total it
  // reports is what the reader wants to know.
  if (more?.[1] !== undefined) return `${shown} of ${shown + Number(more[1])} files`
  return `${plural(shown, 'file')}${TRUNCATION.test(output) ? ' · truncated' : ''}`
}

function grepDigest(output: string): string {
  if (output.startsWith('no matches')) return 'no matches'
  const lines = listLines(output)
  const hits = lines.filter((line) => !NOTE_LINE.test(line))
  const files = new Set<string>()
  for (const line of hits) {
    const match = /^(.*?):\d+: /.exec(line)
    if (match?.[1] !== undefined) files.add(match[1])
  }
  const truncated = hits.length < lines.length || TRUNCATION.test(output)
  const matches = plural(hits.length, 'match', 'matches')
  const where = files.size > 1 ? ` · ${plural(files.size, 'file')}` : ''
  return `${matches}${where}${truncated ? ' · truncated' : ''}`
}

/** What `Bash` writes when it cut its own output. */
const BASH_CUT = /\n… \[(?:truncated \d+ chars|output truncated during capture)\]/

/** `Bash` always settles as a recorded result; the exit code is the outcome. */
function bashDigest(output: string): { digest: string; failed: boolean } {
  const exit = /\[exit code: (-?\d+)\]\s*$/.exec(output)
  if (exit?.[1] !== undefined) {
    const code = Number(exit[1])
    return { digest: `exit ${code}${BASH_CUT.test(output) ? ' · truncated' : ''}`, failed: code !== 0 }
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

function parseJson(output: string): unknown {
  try { return JSON.parse(output) } catch { return undefined }
}

/** `spawn · explorer`, `wait`: what an `Agent` call asked for. */
function agentTarget(args: Record<string, unknown>): string {
  const action = str(args, 'action') ?? 'spawn'
  const role = action === 'spawn' ? str(args, 'definition') : undefined
  return role !== undefined ? `${action} · ${role}` : action
}

/**
 * `Agent` answers in JSON. The row says what that JSON means — a status, a
 * count per child state — instead of echoing it.
 */
function agentDigest(action: string, output: string): string {
  const data = parseJson(output)
  if (typeof data !== 'object' || data === null) return genericDigest(output)
  const record = data as Record<string, unknown>
  if (action === 'spawn') {
    const status = record['status']
    return typeof status === 'string' ? status : 'started'
  }
  const roles = record['roles']
  if (action === 'catalog' && Array.isArray(roles)) return plural(roles.length, 'role')
  const children = record['children']
  if (!Array.isArray(children)) return genericDigest(output)
  if (children.length === 0) return 'no children'
  const counts = new Map<string, number>()
  for (const child of children) {
    const status = typeof child === 'object' && child !== null ? (child as Record<string, unknown>)['status'] : undefined
    const key = typeof status === 'string' ? status : 'unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([status, count]) => `${count} ${status}`).join(' · ')
}

/**
 * The Skill tool's own receipts: a load answers `loaded (hash …)`, a miss is a
 * normal result, a catalog answers with one row per skill plus an optional
 * `… N more` note.
 */
function skillDigest(output: string): string {
  if (/^skill '.+' loaded /.test(output)) return 'loaded'
  if (/^skill '.+' not found/.test(output)) return 'not found'
  if (output.startsWith('no skills')) return 'no matches'
  const rows = output.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('… '))
  return plural(rows.length, 'skill')
}

/** The memory tools write their own one-line receipts; the row reads them. */
function memoryDigest(builtin: string, output: string): string {
  switch (builtin) {
    case 'memorysearch':
      return output.startsWith('no memory matches') ? 'no matches' : plural(countLines(output), 'entry', 'entries')
    case 'memoryread': {
      const title = /^# (.+)$/m.exec(output)?.[1]
      return title !== undefined ? excerpt(title, 40) : genericDigest(output)
    }
    case 'memorycreate': return output.startsWith('created memory') ? 'created' : genericDigest(output)
    case 'memoryupdate': return output.startsWith('updated memory') ? 'updated' : genericDigest(output)
    case 'memoryforget': return output.startsWith('forgot ') ? 'forgot' : genericDigest(output)
    default: return genericDigest(output)
  }
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
  // A refusal still shows its reason on the row, but it is not a fault: the
  // digest keeps the quiet color instead of the failure one.
  const denied = isDenied(result)

  let fullTarget = ''
  let target = ''
  let path = argPath(args)
  let focus: FileFocus | undefined
  let digest: string | undefined
  let digestFailed = failed && !denied
  let file: { name: string; directory: string } | undefined
  let lines: { added: number; removed: number } | undefined

  switch (builtin) {
    case 'read': {
      const window = readWindow(int(args, 'offset'), int(args, 'limit'))
      focus = window.focus
      fullTarget = `${path ?? ''}${window.label}`
      target = `${path !== undefined ? shortPath(path) : ''}${window.label}`
      if (path !== undefined) file = fileParts(path, window.label)
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : readDigest(result.output)
      break
    }
    case 'write':
    case 'edit': {
      fullTarget = path ?? ''
      target = path !== undefined ? shortPath(path) : ''
      if (path !== undefined) file = fileParts(path)
      if (builtin === 'edit') lines = editLines(args)
      digest = result === undefined
        ? undefined
        : failed
          ? excerpt(result.output)
          : builtin === 'write' ? writeDigest(result.output) : undefined
      break
    }
    case 'glob': {
      const pattern = str(args, 'pattern') ?? ''
      const scope = str(args, 'path')
      fullTarget = scope !== undefined ? `${pattern} in ${scope}` : pattern
      target = scope !== undefined ? `${shortCommand(pattern, 40)} in ${shortPath(scope)}` : shortCommand(pattern)
      // Like Grep, a Glob's `path` scopes the search; it is not a file to open.
      path = undefined
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : globDigest(result.output)
      break
    }
    case 'agent': {
      fullTarget = agentTarget(args)
      target = shortCommand(fullTarget)
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : agentDigest(str(args, 'action') ?? 'spawn', result.output)
      break
    }
    case 'skill': {
      const skill = str(args, 'name')
      const action = (str(args, 'action') ?? (skill !== undefined ? 'load' : 'catalog')).toLowerCase()
      const query = str(args, 'query')
      // The skill name is the row's read; the action stays a qualifier at most,
      // in the full target the row's tooltip holds.
      fullTarget = action === 'load' ? `load ${skill ?? ''}` : `catalog${query !== undefined ? ` ${query}` : ''}`
      target = action === 'load' ? shortCommand(skill ?? '') : shortCommand(fullTarget)
      path = undefined
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : skillDigest(result.output)
      break
    }
    case 'memorysearch':
    case 'memoryread':
    case 'memorycreate':
    case 'memoryupdate':
    case 'memoryforget': {
      fullTarget = str(args, 'id') ?? str(args, 'query') ?? ''
      target = shortenTarget(fullTarget)
      digest = result === undefined ? undefined : failed ? excerpt(result.output) : memoryDigest(builtin, result.output)
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
    case 'todowrite': {
      const todos = Array.isArray(args['todos']) ? (args['todos'] as unknown[]) : []
      fullTarget = `${todos.length} ${todos.length === 1 ? 'task' : 'tasks'}`
      target = fullTarget
      path = undefined
      if (result !== undefined) {
        if (failed) digest = excerpt(result.output)
        else {
          const completed = todos.filter((entry) => (entry as Record<string, unknown> | null)?.['status'] === 'completed').length
          const inProgress = todos.filter((entry) => (entry as Record<string, unknown> | null)?.['status'] === 'in_progress').length
          digest = `${completed} done${inProgress > 0 ? ` · ${inProgress} in progress` : ''}`
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
    ...(file !== undefined ? { file } : {}),
    ...(lines !== undefined ? { lines } : {}),
  }
}
