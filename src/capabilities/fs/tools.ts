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
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PathIntent, ToolDefinition, ToolExecution } from '../../harness/tools/types.ts'
import { displayPath, resolveInGrants } from './grants.ts'
import { expandGlob, searchFiles, searchOutput } from './search.ts'
import { canonical, observe, replaceFile, requirementFor, withFileLock } from './observation.ts'
import { findEditMatch, foldEol, formatLines, type MatchStrategy } from './edit-match.ts'
import { GrepTimeoutError, runGrep, type GrepMode } from './grep-worker.ts'
import { sniffImage } from '../../harness/tools/image-tools.ts'
import { parsePatch, type PatchFileReceipt, type PatchReceipt } from './patch.ts'
import { patchSplices } from './patch-match.ts'
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
    throw new Error(`conflict: ${rel} was never read by this conversation; Read it before ${verb} it, using the Read tool (output from cat, sed or other Bash commands does not count)`)
  }
  if (requirement.kind === 'check' && currentHash !== requirement.hash) {
    throw new Error(`conflict: ${rel} changed on disk since this conversation last read it (another session, a command, or the user); re-read it with the Read tool, then retry`)
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

/** Turns image bytes into text for `Read` (host-provided: a vision model). */
export type DescribeImageFile = (image: { readonly bytes: Buffer; readonly mediaType: string }, exec: ToolExecution) => Promise<string>

export interface FsToolsOptions {
  /** When set, `Read` on a png/jpeg/gif/webp returns this description instead of refusing the binary. */
  readonly describeImage?: DescribeImageFile
}

/** The `Read` tool: a numbered line window of a text file. */
export function readTool(options: FsToolsOptions = {}): ToolDefinition {
  return {
    name: 'Read',
    description: [
      'Read a text file inside the workspace or a granted folder.',
      `Returns up to ${READ_DEFAULT_LINES} lines from \`offset\` (1-based); a footer says when more lines remain and which offset continues.`,
      'To read only part of a file, pass `offset` and `limit`: lines A to B are offset=A, limit=B-A+1.',
      ...(options.describeImage !== undefined ? ['An image file (png, jpeg, gif, webp) returns a text description from the vision model instead; offset/limit do not apply.'] : []),
      "Output lines are \"<line number><TAB><text>\"; the number and tab are NOT part of the file, so never copy them into Edit's `old`.",
      "Line endings are shown as plain newlines whatever the file uses; edits keep the file's own line endings.",
      'Reading records the file for a later Write/Edit by this conversation. A successful Write, Edit or ApplyPatch records it too, so do not Read a file again just to verify your own change.',
    ].join(' '),
    requiresRoot: true,
    readOnly: true,
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
      const mediaType = options.describeImage !== undefined ? sniffImage(bytes) : null
      if (mediaType !== null) return `[image ${rel} (${mediaType}), described by the vision model]\n${await options.describeImage!({ bytes, mediaType }, exec)}`
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
      'Create a file, or replace an existing file completely, inside the workspace or a read-write granted folder. Creating a new file needs no Read. Overwriting an existing file requires that this conversation observed it (a successful Read, Write, Edit or ApplyPatch) and that it has not changed since; prefer Edit for partial changes. An existing file keeps its encoding, BOM, and line-ending style. For a long file (more than about 400 lines, such as a plan or spec), Write a short skeleton first and then add one section per Edit call: a single huge call can exceed the model output limit and is then lost unrun.',
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
      'Replace text in a file inside the workspace or a read-write granted folder. This conversation must have observed the file (a successful Read, Write, Edit or ApplyPatch), and it must not have changed since.',
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
      'Find files by path or name pattern; prefer this over `find` or `ls` in Bash. Patterns: `*` within a segment, `**` for zero or more segments, `{a,b}` for choices (at most 64 expansions, no nested braces). Project .gitignore rules and common generated folders are skipped by default. Explicit file/directory patterns or a path inside an ignored folder override ignores only for that scope; includeIgnored searches all. Incomplete searches carry an explicit warning, not an exhaustive no matches. Paths inside the workspace are shown relative to it; paths in other granted folders are absolute.',
    requiresRoot: true,
    readOnly: true,
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
      return searchOutput(files, search.incomplete, limitOf(exec), { totalMatches: matches.length })
    },
  }
}

/** Most context lines Grep shows on either side of a match. */
const GREP_MAX_CONTEXT = 50

/**
 * File-type shorthands for Grep's `type` argument (ripgrep-style names),
 * each a set of file-name extensions.
 */
const GREP_TYPES: Readonly<Record<string, readonly string[]>> = {
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  kotlin: ['.kt', '.kts'],
  swift: ['.swift'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
  cs: ['.cs'],
  rb: ['.rb'],
  php: ['.php'],
  sh: ['.sh', '.bash', '.zsh'],
  json: ['.json', '.jsonc'],
  yaml: ['.yaml', '.yml'],
  toml: ['.toml'],
  md: ['.md', '.mdx'],
  css: ['.css', '.scss', '.sass', '.less'],
  html: ['.html', '.htm'],
  sql: ['.sql'],
  vue: ['.vue'],
  svelte: ['.svelte'],
}

function grepInteger(args: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = positiveInteger(args, key)
  return value === undefined ? undefined : Math.min(value, max)
}

function grepMode(args: Record<string, unknown>): GrepMode {
  const value = args['output_mode']
  if (value === undefined) return 'content'
  if (value === 'content' || value === 'files_with_matches' || value === 'count') return value
  throw new Error("argument 'output_mode' must be 'content', 'files_with_matches' or 'count'")
}

/** Narrow the candidate files by `glob` (file-name or relative-path glob) and `type`. */
function grepFileFilter(args: Record<string, unknown>, base: string): ((full: string) => boolean) | undefined {
  const globArg = args['glob']
  const typeArg = args['type']
  if (globArg !== undefined && typeof globArg !== 'string') throw new Error("argument 'glob' must be a string")
  if (typeArg !== undefined && typeof typeArg !== 'string') throw new Error("argument 'type' must be a string")
  let extensions: readonly string[] | undefined
  if (typeArg !== undefined && typeArg !== '') {
    extensions = GREP_TYPES[typeArg.toLowerCase()]
    if (extensions === undefined) throw new Error(`unknown Grep type '${typeArg}'; known types: ${Object.keys(GREP_TYPES).join(', ')}`)
  }
  // `*.ts` matches a file name anywhere (as ripgrep's --glob does); a glob
  // with a `/` matches the path relative to the search base.
  const globs = globArg !== undefined && globArg !== '' ? expandGlob(globArg).map((choice) => ({ regex: globRegExp(choice), byPath: choice.includes('/') })) : undefined
  if (extensions === undefined && globs === undefined) return undefined
  return (full) => {
    const name = path.basename(full)
    if (extensions !== undefined && !extensions.some((ext) => name.toLowerCase().endsWith(ext))) return false
    if (globs !== undefined) {
      const relative = path.relative(base, full).split(path.sep).join('/')
      if (!globs.some(({ regex, byPath }) => regex.test(byPath ? relative : name))) return false
    }
    return true
  }
}

/** `*` stays inside a segment, `**` crosses segments; everything else is literal. */
function globRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string
    if (char === '*' && glob[index + 1] === '*') {
      // `**/` also matches zero folders.
      if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2 } else { source += '.*'; index += 1 }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** The `Grep` tool: regex search across workspace files. */
export function grepTool(): ToolDefinition {
  return {
    name: 'Grep',
    description:
      'Search file contents with a JavaScript regular expression, across a folder or within one file. Prefer this over `grep` or `rg` in Bash: its results link to files and respect the project ignore rules. output_mode `content` (default) returns `path:line: text` rows (context lines as `path-line- text`, groups split by `--`); `files_with_matches` lists matching files; `count` gives `path:N` per file. Narrow with `path` (a folder or one file), `glob` and `type`. Project .gitignore rules and common generated folders are skipped; point path inside an ignored folder or set includeIgnored to search it. Incomplete searches carry an explicit warning, not an exhaustive no matches. Paths inside the workspace are shown relative to it; paths in other granted folders are absolute.',
    requiresRoot: true,
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to search for (JavaScript syntax; escape literal braces/parens)' },
        path: { type: 'string', description: 'optional folder or single file to search (default: the workspace root); may be absolute inside a granted folder' },
        glob: { type: 'string', description: 'only search files matching this glob, e.g. `*.tsx`, `*.{ts,tsx}` or `src/**/*.ts` (a glob with `/` matches the path relative to `path`)' },
        type: { type: 'string', description: `only search this file type: ${Object.keys(GREP_TYPES).join(', ')}` },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'content (default): matching lines; files_with_matches: file paths only; count: matches per file' },
        '-i': { type: 'boolean', description: 'case-insensitive search' },
        '-A': { type: 'number', description: `lines of context after each match (content mode, max ${GREP_MAX_CONTEXT})` },
        '-B': { type: 'number', description: `lines of context before each match (content mode, max ${GREP_MAX_CONTEXT})` },
        '-C': { type: 'number', description: `lines of context before and after each match (content mode, max ${GREP_MAX_CONTEXT})` },
        head_limit: { type: 'number', description: `stop after this many matches (content) or files (other modes); default and max ${GREP_CAP}` },
        includeIgnored: { type: 'boolean', description: 'set true to bypass .gitignore and default generated-folder exclusions; an explicit path can enter an ignored folder' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const pattern = argString(args, 'pattern')
      const ignoreCase = optionalBoolean(args, '-i')
      // Validate here so a bad pattern fails as before, not inside the worker.
      void new RegExp(pattern, ignoreCase ? 'i' : '')
      const mode = grepMode(args)
      const around = grepInteger(args, '-C', GREP_MAX_CONTEXT)
      const before = grepInteger(args, '-B', GREP_MAX_CONTEXT) ?? around ?? 0
      const after = grepInteger(args, '-A', GREP_MAX_CONTEXT) ?? around ?? 0
      const limit = Math.max(1, grepInteger(args, 'head_limit', GREP_CAP) ?? GREP_CAP)
      const base = await searchBase(args, exec)
      const search = await searchFiles(base, exec, { includeIgnored: argBoolean(args, 'includeIgnored') === true })
      const filter = grepFileFilter(args, base)
      const files = filter === undefined ? search.files : search.files.filter(filter)
      let run
      try {
        run = await runGrep(pattern, files.map((full) => ({ full })), {
          maxHits: limit,
          maxFileBytes: GREP_MAX_FILE_BYTES,
          timeoutMs: GREP_TIMEOUT_MS,
          mode,
          ignoreCase,
          ...(mode === 'content' ? { before, after } : {}),
          ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
        })
      } catch (error) {
        if (error instanceof GrepTimeoutError) {
          throw new Error(`Grep ${error.message}; the pattern may backtrack catastrophically (e.g. nested quantifiers) or the search is too wide — simplify the pattern or narrow 'path'`)
        }
        throw error
      }
      const shown = (file: number): string => displayPath(exec.root, files[file] as string)
      const clip = (text: string): string => text.length > READ_MAX_LINE ? `${text.slice(0, READ_MAX_LINE)}… [line truncated]` : text
      const lines = run.rows.map((row) => {
        switch (row.kind) {
          case 'match': return `${shown(row.file)}:${row.line}: ${clip(row.text)}`
          case 'context': return `${shown(row.file)}-${row.line}- ${clip(row.text)}`
          case 'separator': return '--'
          case 'file': return shown(row.file)
          case 'count': return `${shown(row.file)}:${row.count}`
        }
      })
      const notes: string[] = []
      if (run.truncated) notes.push(mode === 'content' ? '… [more matches truncated]' : '… [more files truncated]')
      if (run.skippedLarge > 0) notes.push(`… [${run.skippedLarge} file(s) over ${GREP_MAX_FILE_BYTES / (1024 * 1024)} MiB not searched]`)
      return searchOutput(lines, search.incomplete, limitOf(exec), { notes })
    },
  }
}

async function patchCanonical(file: string): Promise<string> {
  try { return await fs.realpath(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(await patchCanonical(parent), path.basename(file))
  }
}

/** Publish a complete new file without overwriting a racing creator. */
async function createPatchFile(file: string, bytes: Buffer, mode?: number): Promise<void> {
  const temporary = path.join(path.dirname(file), `.patch-${randomUUID()}`)
  try {
    await createExclusive(temporary, bytes)
    if (mode !== undefined) await fs.chmod(temporary, mode)
    await fs.link(temporary, file)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

/** Structured multi-region/file edits, fully verified before publication. */
export function applyPatchTool(): ToolDefinition {
  return {
    name: 'ApplyPatch',
    description: 'Apply multiple local diff hunks or file changes in one call. Prefer this over repeated Edit calls for distant regions. Input must start with *** Begin Patch and end with *** End Patch. Use *** Update File: path, then @@ (optionally followed by an exact context line), then lines prefixed with space (context), - (remove), + (add). Multiple @@ hunks use original-file order and exact unique context, not numeric git diff headers. *** End of File anchors a hunk to EOF. *** Add File: path uses + content lines; *** Delete File: path deletes a file; *** Move to: path immediately after Update moves it to a new, absent destination. Existing files must have been observed (a successful Read, Write, Edit or ApplyPatch) and unchanged since. Preserves encoding/BOM/EOL and final-newline state. All files are verified before writes; I/O failure can leave partial changes, recorded in the error receipt. Re-read before retrying a partial failure. Do not use shell scripts to bypass verification.',
    requiresRoot: true,
    parameters: { type: 'object', properties: { patch_text: { type: 'string', description: 'Complete structured patch text, including Begin/End Patch markers' } }, required: ['patch_text'] },
    async execute(args, exec) {
      const sections = parsePatch(argString(args, 'patch_text'))
      const targets = new Map<string, string>()
      for (const section of sections) {
        for (const rel of [section.path, ...(section.movePath !== undefined ? [section.movePath] : [])]) {
          const target = await patchCanonical(await granted(exec, rel, 'write'))
          const key = process.platform === 'win32' ? target.toLowerCase() : target
          if ([...targets.values()].some((value) => (process.platform === 'win32' ? value.toLowerCase() : value) === key)) throw new Error(`duplicate patch target: ${rel}`)
          targets.set(rel, target)
        }
      }
      const locks = [...targets.values()].sort()
      const locked = async (index: number): Promise<string> => index < locks.length
        ? withFileLock(locks[index]!, exec.signal, () => locked(index + 1))
        : apply()
      const apply = async (): Promise<string> => {
        const checked = async (rel: string): Promise<string> => {
          const now = await granted(exec, rel, 'write')
          if (await patchCanonical(now) !== targets.get(rel)) throw new Error(`conflict: ${rel} changed path; Read it again`)
          return now
        }
        const absent = async (rel: string): Promise<void> => {
          try { await fs.lstat(await checked(rel)) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            throw error
          }
          throw new Error(`file already exists: ${rel}`)
        }
        const plans: { receipt: PatchFileReceipt; bytes?: Buffer; hash?: string }[] = []
        for (const section of sections) {
          const abs = await checked(section.path)
          if (section.type === 'add') {
            await absent(section.path)
            const content = section.content ?? ''
            plans.push({ receipt: { path: section.path, type: 'add', edits: [{ old: '', new: content, oldLine: 1, newLine: 1 }] }, bytes: encodeForWrite(content, undefined) })
            continue
          }
          const current = await readBytes(abs, section.path)
          if (current === undefined) throw new Error(`no such file: ${section.path}`)
          const doc = decodeDocument(current, section.path)
          assertObserved(exec, targets.get(section.path)!, section.path, doc.hash, undefined, 'patching')
          if (!doc.writable) throw new Error(`${section.path} is not valid UTF-8; refusing to patch`)
          if (section.type === 'delete') {
            plans.push({ receipt: { path: section.path, type: 'delete', edits: [{ old: doc.text, new: '', oldLine: 1, newLine: 1 }] }, hash: doc.hash })
            continue
          }
          const { splices, edits } = patchSplices(doc.text, section.hunks)
          const bytes = encodeRaw(spliceDocument(doc, splices), doc)
          if (section.movePath !== undefined) await absent(section.movePath)
          else if (hashBytes(bytes) === doc.hash) throw new Error(`no change: ${section.path}`)
          plans.push({ receipt: { path: section.path, type: section.movePath !== undefined ? 'move' : 'update', ...(section.movePath !== undefined ? { movePath: section.movePath } : {}), edits }, bytes, hash: doc.hash })
        }
        const landed: PatchFileReceipt[] = []
        try {
          for (const plan of plans) {
            if (exec.signal?.aborted) throw new Error('cancelled: stop requested during patch')
            const file = plan.receipt
            const source = await checked(file.path)
            if (plan.hash !== undefined) {
              const current = await readBytes(source, file.path)
              if (current === undefined || hashBytes(current) !== plan.hash) throw new Error(`conflict: ${file.path} changed during patch`)
            }
            if (file.type === 'delete') {
              await fs.unlink(source)
              landed.push(file)
            } else {
              const dest = file.movePath ?? file.path
              if (file.type === 'add' || file.type === 'move') {
                await absent(dest)
                await fs.mkdir(path.dirname(await checked(dest)), { recursive: true })
                await createPatchFile(await checked(dest), plan.bytes!, file.type === 'move' ? (await fs.stat(source)).mode & 0o7777 : undefined)
                observe(exec, targets.get(dest)!, hashBytes(plan.bytes!))
                if (file.type === 'move') {
                  // Record the destination even if removing the source subsequently fails.
                  landed.push({ path: dest, type: 'add', edits: [{ old: '', new: decodeDocument(plan.bytes!, dest).text, oldLine: 1, newLine: 1 }] })
                  await fs.unlink(await checked(file.path))
                  landed.pop()
                }
              } else {
                await replaceFile(source, plan.bytes!)
                observe(exec, targets.get(dest)!, hashBytes(plan.bytes!))
              }
              landed.push(file)
            }
          }
        } catch (error) {
          const receipt: PatchReceipt = { tool: 'ApplyPatch', files: landed, error: String(error) }
          throw new Error(JSON.stringify(receipt))
        }
        return JSON.stringify({ tool: 'ApplyPatch', files: landed } satisfies PatchReceipt)
      }
      return locked(0)
    },
  }
}

/** All filesystem tools (root resolved per execution from the granted scope). */
export function fsTools(options: FsToolsOptions = {}): ToolDefinition[] {
  return [readTool(options), writeTool(), editTool(), applyPatchTool(), globTool(), grepTool()]
}
