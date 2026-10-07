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
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PathIntent, ToolDefinition, ToolExecution } from '../../harness/tools/types.ts'
import { displayPath, resolveInGrants } from './grants.ts'
import { expandGlob, searchFiles, searchOutput } from './search.ts'
import { canonical, observe, replaceFile, requirementFor, withFileLock } from './observation.ts'
import { findEditMatch, foldEol, formatLines, type MatchStrategy } from './edit-match.ts'
import { GrepTimeoutError, runGrep } from './grep-worker.ts'
import {
  BinaryFileError,
  decodeDocument,
  documentLines,
  encodeForWrite,
  encodeRaw,
  hashBytes,
  lineOf,
  spliceDocument,
  type Splice,
  type TextDocument,
} from './text-document.ts'

export { resolveGrantedPath, resolveWithin } from './grants.ts'
export { DEFAULT_IGNORED_DIRS } from './search.ts'

const OUTPUT_CAP = 60_000
const GLOB_CAP = 100
const GREP_CAP = 250
/** Grep does not search files larger than this. */
const GREP_MAX_FILE_BYTES = 16 * 1024 * 1024
/** Wall-clock budget for one Grep (the worker is terminated past it). */
const GREP_TIMEOUT_MS = 20_000
/**
 * Read/Write/Edit load whole files (the observation hash covers every byte),
 * so a multi-gigabyte log would exhaust the host's memory. Larger files are
 * refused with a pointer to a streaming alternative.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/** The model-visible output cap for this execution (limits-overridable). */
function limitOf(exec: ToolExecution): number {
  return exec.outputLimit ?? OUTPUT_CAP
}

function granted(exec: ToolExecution, target: string, intent: PathIntent): Promise<string> {
  return resolveInGrants(exec, target, intent)
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

/** True only when the boolean argument is present and true. */
function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  return argBoolean(args, key) === true
}

const READ_DEFAULT_LINES = 2_000
const READ_MAX_LINE = 2_000
const EDIT_SNIPPET_CONTEXT = 2
const EDIT_SNIPPET_MAX = 24

/** Read the stored bytes, or undefined when the file does not exist. */
async function readBytes(abs: string, rel: string): Promise<Buffer | undefined> {
  try {
    const { size } = await fs.stat(abs)
    if (size > MAX_FILE_BYTES) {
      throw new Error(`${rel} is ${(size / (1024 * 1024)).toFixed(1)} MiB, over the ${MAX_FILE_BYTES / (1024 * 1024)} MiB file-tool limit; inspect it with Bash (head, tail, sed -n) or Grep instead`)
    }
    return await fs.readFile(abs)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'EISDIR') throw new Error(`${rel} is a directory, not a file`)
    throw error
  }
}

/** Refuse a mutation the executing session has not earned (never read, or changed since). */
function assertObserved(exec: ToolExecution, target: string, rel: string, currentHash: string, explicit: unknown, verb: string): void {
  const requirement = requirementFor(exec, target, explicit)
  if (requirement.kind === 'missing') {
    throw new Error(`conflict: ${rel} was never read by this conversation; Read it before ${verb} it`)
  }
  if (requirement.kind === 'check' && currentHash !== requirement.hash) {
    throw new Error(`conflict: ${rel} changed on disk since this conversation last read it (another session, a command, or the user); re-read it, then retry`)
  }
}

function positiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`argument '${key}' must be a number`)
  return Math.max(Math.floor(value), key === 'offset' ? 1 : 0)
}

function countLines(text: string): number {
  return documentLines(text.replace(/\r\n/g, '\n')).length
}

/** Create a file that must not exist yet: two racing creators cannot clobber each other. */
async function createExclusive(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(file, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The `Read` tool: a numbered line window of a text file. */
export function readTool(): ToolDefinition {
  return {
    name: 'Read',
    description: [
      'Read a text file inside the workspace or a granted folder.',
      "Output lines are \"<line number><TAB><text>\"; the number and tab are NOT part of the file, so never copy them into Edit's `old`.",
      `Returns up to ${READ_DEFAULT_LINES} lines from \`offset\` (1-based); a footer says when more lines remain and which offset continues.`,
      "Line endings are shown as plain newlines whatever the file uses; edits keep the file's own line endings.",
      'Reading records the file for a later Write/Edit by this conversation.',
    ].join(' '),
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root, or absolute inside a granted folder' },
        offset: { type: 'number', description: '1-based line number to start from (default 1)' },
        limit: { type: 'number', description: `maximum number of lines to return (default ${READ_DEFAULT_LINES})` },
      },
      required: ['path'],
    },
    async execute(args, exec) {
      const rel = argString(args, 'path')
      const abs = await granted(exec, rel, 'read')
      const bytes = await readBytes(abs, rel)
      if (bytes === undefined) throw new Error(`no such file: ${rel}`)
      const doc = decodeDocument(bytes, rel)
      observe(exec, await canonical(abs), doc.hash)

      const lines = documentLines(doc.text)
      if (lines.length === 0) return `(${rel} is empty)`
      const offset = positiveInteger(args, 'offset') ?? 1
      const limit = positiveInteger(args, 'limit') ?? READ_DEFAULT_LINES
      if (offset > lines.length) throw new Error(`${rel} has ${lines.length} lines; offset ${offset} is past the end`)

      const budget = limitOf(exec)
      const start = offset - 1
      const wantedEnd = Math.min(lines.length, start + limit)
      const width = String(wantedEnd).length
      const out: string[] = []
      let used = 0
      let end = start
      for (let index = start; index < wantedEnd; index++) {
        let line = lines[index] ?? ''
        // A single line never exceeds the per-line cap nor the whole output budget.
        const lineCap = Math.max(1, Math.min(READ_MAX_LINE, budget - width - 64))
        if (line.length > lineCap) line = `${line.slice(0, lineCap)}… [line truncated, ${line.length} chars]`
        const rendered = `${String(index + 1).padStart(width, ' ')}\t${line}`
        if (out.length > 0 && used + rendered.length + 1 > budget) break
        out.push(rendered)
        used += rendered.length + 1
        end = index + 1
      }
      if (end < lines.length) {
        out.push(`… [showing lines ${offset}-${end} of ${lines.length}; continue with offset ${end + 1}]`)
      }
      if (!doc.writable) out.push('… [this file is not valid UTF-8; it can be read but not edited]')
      return out.join('\n')
    },
  }
}

/** The `Write` tool: create or replace a complete file, detecting external changes. */
export function writeTool(): ToolDefinition {
  return {
    name: 'Write',
    description:
      'Create a file, or replace an existing file completely, inside the workspace or a read-write granted folder. Overwriting requires that this conversation Read the file first and that it has not changed since; prefer Edit for partial changes. An existing file keeps its encoding, BOM, and line-ending style.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root, or absolute inside a granted folder' },
        content: { type: 'string', description: 'the complete new file content' },
      },
      required: ['path', 'content'],
    },
    async execute(args, exec) {
      const rel = argString(args, 'path')
      const content = argString(args, 'content')
      const abs = await granted(exec, rel, 'write')
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const target = await canonical(abs)
      return withFileLock(target, exec.signal, async () => {
        // Revalidate containment after waiting: an alias/junction changed
        // while this call was queued must not redirect the mutation.
        const now = await granted(exec, rel, 'write')
        if (await canonical(now) !== target) throw new Error(`conflict: ${rel} changed path after observation; Read it again before writing`)
        const current = await readBytes(now, rel)
        if (current === undefined) {
          const bytes = encodeForWrite(content, undefined)
          await createExclusive(now, bytes)
          observe(exec, target, hashBytes(bytes))
          return `created ${rel} (${countLines(content)} lines)`
        }
        assertObserved(exec, target, rel, hashBytes(current), args['expectedSha256'], 'overwriting')
        let existing: TextDocument | undefined
        try {
          existing = decodeDocument(current, rel)
        } catch (error) {
          if (!(error instanceof BinaryFileError)) throw error
        }
        const bytes = encodeForWrite(content, existing)
        await replaceFile(now, bytes)
        observe(exec, target, hashBytes(bytes))
        return `overwrote ${rel} (${bytes.length} bytes written)`
      })
    },
  }
}

/** The `Edit` tool: replace one exact (or conservatively normalized) occurrence. */
export function editTool(): ToolDefinition {
  return {
    name: 'Edit',
    description: [
      'Replace text in a file inside the workspace or a read-write granted folder. This conversation must have Read the file, and it must not have changed since.',
      '`old` must appear exactly once (copy it from Read output WITHOUT the line-number prefix, keeping indentation); add surrounding lines to make it unique, or set `replaceAll` to change every occurrence.',
      'Line endings are handled automatically. When `old` is not found, the error shows the closest current lines.',
      'An empty `old` creates a new file (or fills an empty one) with `new`.',
    ].join(' '),
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root, or absolute inside a granted folder' },
        old: { type: 'string', description: 'the exact text to replace; must match exactly one location unless replaceAll is true' },
        new: { type: 'string', description: 'the replacement text (must differ from old)' },
        replaceAll: { type: 'boolean', description: 'replace every occurrence of old (default false)' },
      },
      required: ['path', 'old', 'new'],
    },
    async execute(args, exec) {
      const rel = argString(args, 'path')
      const old = foldEol(argString(args, 'old'))
      const replacement = foldEol(argString(args, 'new'))
      const replaceAll = optionalBoolean(args, 'replaceAll')
      if (old === replacement) throw new Error('no change: old and new are identical')
      const abs = await granted(exec, rel, 'write')
      if (old === '') await fs.mkdir(path.dirname(abs), { recursive: true })
      const target = await canonical(abs)
      return withFileLock(target, exec.signal, async () => {
        const now = await granted(exec, rel, 'write')
        if (await canonical(now) !== target) throw new Error(`conflict: ${rel} changed path after observation; Read it again before editing`)
        const current = await readBytes(now, rel)
        if (current === undefined) {
          if (old !== '') throw new Error(`no such file: ${rel} (to create it, use Write or an Edit with an empty old)`)
          const bytes = encodeForWrite(replacement, undefined)
          await createExclusive(now, bytes)
          observe(exec, target, hashBytes(bytes))
          return `created ${rel} (${countLines(replacement)} lines)`
        }
        const doc = decodeDocument(current, rel)
        assertObserved(exec, target, rel, doc.hash, args['expectedSha256'], 'editing')
        if (!doc.writable) throw new Error(`${rel} is not valid UTF-8; refusing to edit it`)

        let splices: readonly Splice[]
        let strategy: MatchStrategy = 'exact'
        if (old === '') {
          if (doc.text.trim() !== '') throw new Error(`old must not be empty: ${rel} already has content`)
          splices = [{ start: 0, end: doc.text.length, text: replacement }]
        } else {
          const match = findEditMatch(doc.text, old, replacement, replaceAll)
          if (match.kind === 'not-found') {
            const hint = match.hint !== undefined ? `\nClosest lines in the current file:\n${match.hint}` : ''
            throw new Error(`old text not found in ${rel}. Copy it from the current file exactly (without line-number prefixes), or Read the region again.${hint}`)
          }
          if (match.kind === 'ambiguous') {
            throw new Error(`ambiguous edit: old matches ${match.lines.length} places in ${rel} (lines ${match.lines.slice(0, 10).join(', ')}); include more surrounding lines to make it unique, or set replaceAll to true`)
          }
          splices = match.splices
          strategy = match.strategy
        }

        const bytes = encodeRaw(spliceDocument(doc, splices), doc)
        await replaceFile(now, bytes)
        observe(exec, target, hashBytes(bytes))
        const note = strategy === 'exact' ? '' : ` (matched after normalizing ${STRATEGY_NOTE[strategy]})`
        if (splices.length > 1) return `edited ${rel}: replaced ${splices.length} occurrences${note}`
        return `edited ${rel}${note}\n${editSnippet(doc.text, splices[0])}`
      })
    },
  }
}

const STRATEGY_NOTE: Readonly<Record<MatchStrategy, string>> = {
  'exact': 'nothing',
  'line-numbers-stripped': 'pasted line-number prefixes',
  'trailing-whitespace': 'trailing whitespace',
  'indentation': 'indentation; the replacement was re-indented to match',
  'quotes': 'typographic quotes',
}

/** The edited region as it now reads, numbered like Read, so no re-read is needed. */
function editSnippet(before: string, splice: Splice | undefined): string {
  if (splice === undefined) return ''
  const after = before.slice(0, splice.start) + splice.text + before.slice(splice.end)
  const lines = documentLines(after)
  if (lines.length === 0) return '(the file is now empty)'
  const first = Math.min(lineOf(after, splice.start), lines.length)
  const last = Math.min(lines.length, Math.max(first, lineOf(after, splice.start + Math.max(splice.text.length - 1, 0))))
  const from = Math.max(1, first - EDIT_SNIPPET_CONTEXT)
  const to = Math.min(lines.length, last + EDIT_SNIPPET_CONTEXT, from + EDIT_SNIPPET_MAX - 1)
  return formatLines(lines.slice(from - 1, to), from)
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
      'List files matching a glob pattern (`*` within a segment, `**` for zero or more segments, `{a,b}` for choices; at most 64 expansions, no nested braces). Project .gitignore rules and common generated folders are skipped by default. Explicit file/directory patterns or a path inside an ignored folder override ignores only for that scope; includeIgnored searches all. Incomplete searches carry an explicit warning, not an exhaustive no matches. Paths inside the workspace are shown relative to it; paths in other granted folders are absolute.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob pattern relative to the search directory' },
        path: { type: 'string', description: 'optional directory to search within (default: the workspace root); may be absolute inside a granted folder' },
        includeIgnored: { type: 'boolean', description: 'set true to bypass .gitignore and default generated-folder exclusions; explicit file/directory patterns also override their own scope' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const base = await searchBase(args, exec)
      const pattern = argString(args, 'pattern')
      const search = await searchFiles(base, exec, { patterns: expandGlob(pattern), includeIgnored: argBoolean(args, 'includeIgnored') === true })
      const matches = search.files
      const files = matches.slice(0, GLOB_CAP).map((full) => displayPath(exec.root, full))
      if (matches.length > GLOB_CAP) files.push(`… [+${matches.length - GLOB_CAP} more matches]`)
      return searchOutput(files, search.incomplete, limitOf(exec))
    },
  }
}

/** The `Grep` tool: regex search across workspace files, `path:line: text`. */
export function grepTool(): ToolDefinition {
  return {
    name: 'Grep',
    description:
      'Search files with a regular expression; returns `path:line: text` matches. Project .gitignore rules and common generated folders are skipped; point path inside an ignored folder or set includeIgnored to search it. Incomplete searches carry an explicit warning, not an exhaustive no matches. Paths inside the workspace are shown relative to it; paths in other granted folders are absolute.',
    requiresRoot: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to search for' },
        path: { type: 'string', description: 'optional directory to search within; may be absolute inside a granted folder' },
        includeIgnored: { type: 'boolean', description: 'set true to bypass .gitignore and default generated-folder exclusions; an explicit path can enter an ignored folder' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const pattern = argString(args, 'pattern')
      // Validate here so a bad pattern fails as before, not inside the worker.
      void new RegExp(pattern)
      const base = await searchBase(args, exec)
      const search = await searchFiles(base, exec, { includeIgnored: argBoolean(args, 'includeIgnored') === true })
      const files = search.files
      let run
      try {
        run = await runGrep(pattern, files.map((full) => ({ full })), {
          maxHits: GREP_CAP,
          maxFileBytes: GREP_MAX_FILE_BYTES,
          timeoutMs: GREP_TIMEOUT_MS,
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        })
      } catch (error) {
        if (error instanceof GrepTimeoutError) {
          throw new Error(`Grep ${error.message}; the pattern may backtrack catastrophically (e.g. nested quantifiers) or the search is too wide — simplify the pattern or narrow 'path'`)
        }
        throw error
      }
      const lines = run.hits.map((hit) => {
        const text = hit.text.length > READ_MAX_LINE ? `${hit.text.slice(0, READ_MAX_LINE)}… [line truncated]` : hit.text
        return `${displayPath(exec.root, files[hit.file] as string)}:${hit.line}: ${text}`
      })
      if (run.truncated) lines.push('… [more matches truncated]')
      if (run.skippedLarge > 0) lines.push(`… [${run.skippedLarge} file(s) over ${GREP_MAX_FILE_BYTES / (1024 * 1024)} MiB not searched]`)
      return searchOutput(lines, search.incomplete, limitOf(exec))
    },
  }
}

/** All filesystem tools (root resolved per execution from the granted scope). */
export function fsTools(): ToolDefinition[] {
  return [readTool(), writeTool(), editTool(), globTool(), grepTool()]
}
