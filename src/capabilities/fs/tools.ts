/**
 * Filesystem capability consumers: the `Read`/`Write`/`Edit`/`Glob`/`Grep`
 * tools, confined to explicitly granted folders — the primary root plus any
 * additional granted roots (see `grants.ts`). Relative paths resolve against
 * the primary root; every path must stay inside a granted folder — lexically
 * and through real symlinks/junctions — with write access where it writes,
 * and paths inside `deniedRoots` (application-internal storage) are refused
 * even when they sit under a granted folder. Escaping is a tool failure, not
 * a silent redirect.
 *
 * These checks are application-level containment, not an OS sandbox and not
 * a guarantee against hostile external filesystem races.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PathIntent, ToolDefinition, ToolExecution } from '../../harness/tools/types.ts'
import { displayPath, resolveInGrants, within } from './grants.ts'
import { canonical, digest, observe, replaceFile, requirementFor, withFileLock } from './observation.ts'

export { resolveGrantedPath, resolveWithin } from './grants.ts'

const OUTPUT_CAP = 60_000
const GLOB_CAP = 100
const GREP_CAP = 250
const WALK_BUDGET = 20_000

/**
 * Generated/dependency folders the search walk skips by default: VCS
 * internals, package directories, build outputs, and tool caches. They are
 * huge, machine-generated, and almost never the target of a search — yet they
 * would flood results and exhaust the walk budget first. A pattern that names
 * one as an explicit segment, `includeIgnored: true`, or a search `path`
 * pointing inside one, all search them anyway.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  // version-control internals
  '.git', '.svn', '.hg',
  // package managers and vendored dependencies
  'node_modules', 'bower_components', 'vendor', 'Pods',
  // build outputs
  'dist', 'build', 'out', 'target', 'obj',
  // framework and bundler caches
  '.next', '.nuxt', '.output', '.svelte-kit', '.vite', '.turbo', '.parcel-cache', '.cache', '.docusaurus',
  // test coverage
  'coverage', '.nyc_output',
  // python environments and tooling
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.nox', '.eggs',
  // jvm, terraform, editor state
  '.gradle', '.terraform', '.idea', '.vscode',
]
const DEFAULT_IGNORED_SET: ReadonlySet<string> = new Set(DEFAULT_IGNORED_DIRS)
const NO_IGNORED: ReadonlySet<string> = new Set()

/** The model-visible output cap for this execution (limits-overridable). */
function limitOf(exec: ToolExecution): number {
  return exec.outputLimit ?? OUTPUT_CAP
}

function granted(exec: ToolExecution, target: string, intent: PathIntent): Promise<string> {
  return resolveInGrants(exec, target, intent)
}

/** Truncate a tool output to its cap, keeping the head and a marker. */
function cap(output: string, limit: number): string {
  if (output.length <= limit) return output
  return `${output.slice(0, limit)}\n… [truncated ${output.length - limit} chars]`
}

/**
 * Walk `dir` recursively, yielding file paths (depth-first, sorted).
 * Symlinks are never followed; the run's abort signal is honored between
 * directories; the node budget keeps a huge tree from being materialized
 * just to truncate it afterwards; directories named in `ignored` are pruned
 * during the walk so their subtrees never consume the budget.
 */
async function walk(
  dir: string,
  deniedRoots: readonly string[] | undefined,
  signal: AbortSignal | undefined,
  budget = { left: WALK_BUDGET },
  ignored: ReadonlySet<string> = DEFAULT_IGNORED_SET,
): Promise<string[]> {
  // Indirect through a function: the signal can abort during any await, and
  // control-flow narrowing must not hide that from later checks.
  const stopped = (): boolean => signal?.aborted === true
  const found: string[] = []
  if (stopped()) throw new Error('cancelled: stop requested during search')
  if (budget.left <= 0 || deniedRoots?.some((denied) => within(denied, dir))) return found
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (stopped()) throw new Error('cancelled: stop requested during search')
    if (budget.left <= 0) break
    budget.left -= 1
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) continue
      found.push(...(await walk(full, deniedRoots, signal, budget, ignored)))
    } else if (entry.isFile()) {
      found.push(full)
    }
  }
  return found
}

/** Glob segment pattern (`*`, `**`, literals) to a regular expression. */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  let i = 0
  while (i < pattern.length) {
    const char: string = pattern[i] ?? ''
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i += 2
        if (pattern[i] === '/') i++
      } else {
        source += '[^/]*'
        i++
      }
    } else {
      source += escapeLiteral(char)
      i++
    }
  }
  return new RegExp(`^${source}$`)
}

function escapeLiteral(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`argument '${key}' must be a string`)
  }
  return value
}

function argBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`argument '${key}' must be a boolean`)
  return value
}

/** True when a glob pattern names a default-ignored folder as an explicit path segment (its own slash-delimited segment). */
function namesIgnoredDir(pattern: string): boolean {
  return pattern.split('/').some((segment) => segment !== '**' && DEFAULT_IGNORED_SET.has(segment))
}

/** The ignored-dir set for a search: none when explicitly included or when the glob pattern names one, else the defaults. */
function searchIgnore(args: Record<string, unknown>, pattern?: string): ReadonlySet<string> {
  if (argBoolean(args, 'includeIgnored') === true || (pattern !== undefined && namesIgnoredDir(pattern))) return NO_IGNORED
  return DEFAULT_IGNORED_SET
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Verify the caller's previously observed state still matches. `expectedSha256`
 * arrives from the model's last read; a mismatch means the file changed
 * externally and the mutation refuses instead of clobbering.
 */
async function assertObservedState(abs: string, expectedSha256: unknown): Promise<void> {
  if (expectedSha256 === undefined) return
  if (typeof expectedSha256 !== 'string') {
    throw new Error("argument 'expectedSha256' must be a string when provided")
  }
  let current: string
  try {
    current = await fs.readFile(abs, 'utf8')
  } catch {
    // The caller observed content that is now gone: that IS a change.
    throw new Error('conflict: the file was deleted after it was observed; re-read before writing')
  }
  const actual = sha256(current)
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `conflict: the file changed since it was observed (expected sha256 ${expectedSha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…); re-read before writing`,
    )
  }
}

/** The `Read` tool: file content (optionally a 1-based line window), size-capped. */
export function readTool(): ToolDefinition {
  return {
    name: 'Read',
    description:
      'Read a text file inside the workspace or a granted folder and return its content. The executing conversation records the observed bytes for a later guarded Write/Edit. Optional `offset` (1-based line) and `limit` (line count) read a window. Large reads are truncated and marked.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root, or absolute inside a granted folder' },
        offset: { type: 'number', description: '1-based line number to start from' },
        limit: { type: 'number', description: 'maximum number of lines to return' },
      },
      required: ['path'],
    },
    async execute(args, exec) {
      const abs = await granted(exec, argString(args, 'path'), 'read')
      let content: string
      try {
        content = await fs.readFile(abs, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`no such file: ${argString(args, 'path')}`)
        if (code === 'EISDIR') throw new Error(`${argString(args, 'path')} is a directory, not a file`)
        throw error
      }
      observe(exec, await canonical(abs), content)
      const offset = typeof args['offset'] === 'number' ? Math.floor(args['offset']) : undefined
      const limit = typeof args['limit'] === 'number' ? Math.floor(args['limit']) : undefined
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n')
        const start = Math.max((offset ?? 1) - 1, 0)
        const end = limit !== undefined ? start + Math.max(limit, 0) : lines.length
        content = lines.slice(start, end).join('\n')
      }
      return cap(content, limitOf(exec))
    },
  }
}

/** The `Write` tool: create or replace a complete file, detecting external changes. */
export function writeTool(): ToolDefinition {
  return {
    name: 'Write',
    description:
      'Create or overwrite a text file inside the workspace or a read-write granted folder. Existing files must first be Read by this conversation; the observed bytes are checked automatically. Direct callers may pass `expectedSha256` explicitly. The result distinguishes creation from overwrite.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root, or absolute inside a granted folder' },
        content: { type: 'string', description: 'full file content to write' },
        expectedSha256: { type: 'string', description: 'sha256 of the file as last observed; a mismatch is a conflict' },
      },
      required: ['path', 'content'],
    },
    async execute(args, exec) {
      const rel = argString(args, 'path')
      const abs = await granted(exec, rel, 'write')
      const content = argString(args, 'content')
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const target = await canonical(abs)
      return withFileLock(target, exec.signal, async () => {
        // Revalidate containment after waiting: an alias/junction changed
        // while this call was queued must not redirect the mutation.
        const now = await granted(exec, rel, 'write')
        const currentTarget = await canonical(now)
        if (currentTarget !== target) throw new Error(`conflict: ${rel} changed path after observation; re-read before writing`)
        let current: string | undefined
        try {
          current = await fs.readFile(now, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (current === undefined) {
          // Exclusive creation: two roots racing to create cannot clobber.
          const handle = await fs.open(now, 'wx')
          try { await handle.writeFile(content, 'utf8'); await handle.sync() }
          finally { await handle.close() }
          observe(exec, target, content)
          return `created ${rel}`
        }
        const requirement = requirementFor(exec, target, args['expectedSha256'])
        if (requirement.kind === 'missing') throw new Error(`conflict: ${rel} was never read by this conversation; read it before overwriting`)
        if (requirement.kind === 'check' && digest(current) !== requirement.hash) {
          throw new Error(`conflict: ${rel} changed after it was observed; re-read before writing`)
        }
        await replaceFile(now, content)
        observe(exec, target, content)
        return `overwrote ${rel} (${Buffer.byteLength(content, 'utf8')} bytes written)`
      })
    },
  }
}

/** The `Edit` tool: exact text replacement, rejecting missing and ambiguous matches. */
export function editTool(): ToolDefinition {
  return {
    name: 'Edit',
    description:
      'Replace one exact occurrence of `old` with `new` in a file inside the workspace or a read-write granted folder. Existing files must first be Read by this conversation; the observed bytes are checked automatically. Direct callers may pass `expectedSha256` explicitly. Fails on missing or ambiguous matches.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root, or absolute inside a granted folder' },
        old: { type: 'string', description: 'exact text to replace (must match exactly once)' },
        new: { type: 'string', description: 'replacement text' },
        expectedSha256: { type: 'string', description: 'sha256 of the file as last observed; a mismatch is a conflict' },
      },
      required: ['path', 'old', 'new'],
    },
    async execute(args, exec) {
      const rel = argString(args, 'path')
      const abs = await granted(exec, rel, 'write')
      const old = argString(args, 'old')
      const replacement = argString(args, 'new')
      const target = await canonical(abs)
      return withFileLock(target, exec.signal, async () => {
        const now = await granted(exec, rel, 'write')
        if (await canonical(now) !== target) throw new Error(`conflict: ${rel} changed path after observation; re-read before writing`)
        let content: string
        try {
          content = await fs.readFile(now, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no such file: ${rel}`)
          throw error
        }
        const requirement = requirementFor(exec, target, args['expectedSha256'])
        if (requirement.kind === 'missing') throw new Error(`conflict: ${rel} was never read by this conversation; read it before editing`)
        if (requirement.kind === 'check' && digest(content) !== requirement.hash) {
          throw new Error(`conflict: ${rel} changed after it was observed; re-read before writing`)
        }
        const first = content.indexOf(old)
        if (first < 0) throw new Error(`'${old.slice(0, 80)}' not found in ${rel}`)
        const second = content.indexOf(old, first + 1)
        if (second >= 0) throw new Error(`ambiguous edit: '${old.slice(0, 80)}' occurs more than once in ${rel}; include more surrounding context`)
        const updated = content.slice(0, first) + replacement + content.slice(first + old.length)
        await replaceFile(now, updated)
        observe(exec, target, updated)
        return `edited ${rel}`
      })
    },
  }
}

/** The search base for Glob/Grep: the optional `path` argument, else the primary root. */
function searchBase(args: Record<string, unknown>, exec: ToolExecution): Promise<string> {
  return args['path'] === undefined ? Promise.resolve(path.resolve(exec.root)) : granted(exec, argString(args, 'path'), 'read')
}

/** The `Glob` tool: match relative paths against a `*`/`**` pattern. */
export function globTool(): ToolDefinition {
  return {
    name: 'Glob',
    description:
      'List files matching a glob pattern (`*` within a segment, `**` across segments). Common generated folders (node_modules, .git, dist, build, target, __pycache__, …) are skipped unless the pattern names one explicitly or `includeIgnored` is true. Paths inside the workspace are shown relative to it; paths in other granted folders are absolute.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob pattern relative to the search directory' },
        path: { type: 'string', description: 'optional directory to search within (default: the workspace root); may be absolute inside a granted folder' },
        includeIgnored: { type: 'boolean', description: 'set true to also list default-skipped folders (node_modules, .git, dist, …); a pattern naming one explicitly already does this' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const base = await searchBase(args, exec)
      const pattern = argString(args, 'pattern')
      const regex = globToRegExp(pattern)
      const matches = (await walk(base, exec.deniedRoots, exec.signal, undefined, searchIgnore(args, pattern)))
        .filter((full) => regex.test(path.relative(base, full).split(path.sep).join('/')))
      const files = matches.slice(0, GLOB_CAP).map((full) => displayPath(exec.root, full))
      if (matches.length > GLOB_CAP) files.push(`… [+${matches.length - GLOB_CAP} more matches]`)
      return files.length === 0 ? 'no matches' : cap(files.join('\n'), OUTPUT_CAP)
    },
  }
}

/** The `Grep` tool: regex search across workspace files, `path:line: text`. */
export function grepTool(): ToolDefinition {
  return {
    name: 'Grep',
    description:
      'Search files with a regular expression; returns `path:line: text` matches. Common generated folders (node_modules, .git, dist, build, target, __pycache__, …) are skipped; point `path` inside one or set `includeIgnored` to search them. Paths inside the workspace are shown relative to it; paths in other granted folders are absolute.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to search for' },
        path: { type: 'string', description: 'optional directory to search within; may be absolute inside a granted folder' },
        includeIgnored: { type: 'boolean', description: 'set true to also search default-skipped folders (node_modules, .git, dist, …); pointing `path` inside one already does this' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const regex = new RegExp(argString(args, 'pattern'))
      const base = await searchBase(args, exec)
      const lines: string[] = []
      for (const full of await walk(base, exec.deniedRoots, exec.signal, undefined, searchIgnore(args))) {
        const rel = displayPath(exec.root, full)
        let content: string
        try {
          content = await fs.readFile(full, 'utf8')
        } catch {
          continue
        }
        const split = content.split('\n')
        for (let i = 0; i < split.length; i++) {
          if (regex.test(split[i] ?? '')) {
            lines.push(`${rel}:${i + 1}: ${split[i]}`)
            if (lines.length >= GREP_CAP) {
              lines.push('… [more matches truncated]')
              return cap(lines.join('\n'), OUTPUT_CAP)
            }
          }
        }
      }
      return lines.length === 0 ? 'no matches' : cap(lines.join('\n'), OUTPUT_CAP)
    },
  }
}

/** All filesystem tools (root resolved per execution from the granted scope). */
export function fsTools(): ToolDefinition[] {
  return [readTool(), writeTool(), editTool(), globTool(), grepTool()]
}
