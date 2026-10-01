/**
 * Read-only git status and diffs for the workbench Git view.
 *
 * Every call is a query: `git status` and `git diff` only, with no config,
 * no pager and no write flags. Paths are checked against the registered
 * project root before git sees them and again on the way out, so a symlink
 * checkout or a crafted path cannot report a file outside it.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveGrantedPath } from '../capabilities/fs/tools.ts'

/** One changed path, in the shape the Git view lists. */
export interface GitChange {
  /** Root-relative path with `/` separators — the path the row opens. */
  readonly path: string
  /** Previous path of a rename or copy; absent otherwise. */
  readonly previousPath?: string
  readonly status: GitStatus
  /** Lines added against HEAD; absent when git reported no count (a binary). */
  readonly added?: number
  /** Lines removed against HEAD; absent when git reported no count. */
  readonly removed?: number
}

export type GitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict'

export interface GitStatusReport {
  readonly branch: string | null
  readonly changes: readonly GitChange[]
  /** True when the walk stopped at {@link MAX_CHANGES}; the list is then partial. */
  readonly truncated: boolean
  /** Commits ahead of the upstream, when the branch tracks one. */
  readonly ahead?: number
  /** Commits behind the upstream, when the branch tracks one. */
  readonly behind?: number
}

/** Ahead/behind from a `git status -b` header; absent when there is no upstream. */
export function parseAheadBehind(header: string): { ahead?: number; behind?: number } {
  const match = /\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/.exec(header)
  if (match === null) return {}
  const result: { ahead?: number; behind?: number } = {}
  if (match[1] !== undefined) result.ahead = Number(match[1])
  if (match[2] !== undefined) result.behind = Number(match[2])
  if (match[3] !== undefined) result.behind = Number(match[3])
  return result
}

/** One line of a rendered diff. `text` excludes the leading marker. */
export interface GitDiffLine {
  readonly kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'
  readonly text: string
}

export interface GitDiffReport {
  readonly path: string
  /** Unified diff, capped and flagged when git produced more than the cap. */
  readonly lines: readonly GitDiffLine[]
  readonly truncated: boolean
  /** No textual diff: a binary, or a change git can name but not print. */
  readonly binary: boolean
}

export class ProjectGitError extends Error {}

/** Changed paths kept from one status; past this the report says it stopped. */
export const MAX_CHANGES = 500
/** Diff text kept for one file. */
const MAX_DIFF_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 20_000

/** Locate a git executable. Memoized: it does not move between requests. */
export function gitExecutable(): string | undefined {
  if (gitCache !== undefined) return gitCache
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? ''
    candidates.push(
      path.join(local, 'Programs', 'Git', 'cmd', 'git.exe'),
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
    )
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git')
  }
  gitCache = candidates.find((candidate) => candidate !== '' && existsSync(candidate)) ?? 'git'
  return gitCache
}

let gitCache: string | undefined

/** One finished git query. `code` is git's own exit code, never a launch failure. */
interface GitResult {
  readonly stdout: Buffer
  readonly code: number
}

/**
 * Run one git query inside `cwd`. A missing executable or a launch that
 * produces nothing rejects; a non-zero exit resolves, because git uses those
 * as answers (`diff --no-index` exits 1 when the sides differ, `status`
 * exits 128 outside a work tree).
 */
function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  const executable = gitExecutable()
  if (executable === undefined) return Promise.reject(new ProjectGitError('git is not installed on this host'))
  return new Promise((resolve, reject) => {
    execFile(executable, ['-c', 'core.quotepath=false', ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_DIFF_BYTES + 64 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    }, (error, stdout) => {
      const launched = (error as NodeJS.ErrnoException | null)?.code
      if (launched === 'ENOENT') {
        reject(new ProjectGitError('git is not installed on this host'))
        return
      }
      const status = (error as { status?: number } | null)?.status
      // No exit code and no output means git never ran (a timeout, a kill).
      if (error !== null && status === undefined && !Buffer.isBuffer(stdout)) {
        reject(new ProjectGitError(`git failed: ${error.message}`))
        return
      }
      resolve({ stdout: stdout ?? Buffer.alloc(0), code: status ?? (error === null ? 0 : 1) })
    })
  })
}

/** Split NUL-delimited git output, dropping the trailing empty record. */
function records(buffer: Buffer): string[] {
  const parts = buffer.toString('utf8').split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

const STATUS_OF: Readonly<Record<string, GitStatus>> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked',
}

/** Porcelain v1 code to a status. Anything unmerged (U, or a doubled letter) is a conflict. */
function statusOf(code: string): GitStatus {
  const index = code[0] ?? ' '
  const work = code[1] ?? ' '
  if (index === '?') return 'untracked'
  if (index === 'U' || work === 'U' || (index !== ' ' && index === work && index !== '?')) return 'conflict'
  return STATUS_OF[work] ?? STATUS_OF[index] ?? 'modified'
}

/**
 * `git status` for a project root. Not a git checkout is an empty report, not
 * an error: a project folder simply may not be one.
 */
export async function gitStatus(root: string, deniedRoots?: readonly string[]): Promise<GitStatusReport> {
  const { stdout, code } = await git(root, ['status', '--porcelain=v1', '-z', '-b', '-uall'])
  if (code !== 0) return { branch: null, changes: [], truncated: false }
  const parts = records(stdout)
  const header = parts[0] ?? ''
  const branch = header.startsWith('## ') ? header.slice(3).split('...')[0]?.trim() || null : null
  const changes: GitChange[] = []
  let truncated = false
  for (let index = header.startsWith('## ') ? 1 : 0; index < parts.length; index += 1) {
    const record = parts[index] ?? ''
    if (record.length < 3) continue
    const status = statusOf(record.slice(0, 2))
    // Porcelain -z emits a rename or copy as the new path, then a second
    // record holding only the old path.
    const renamed = status === 'renamed' || status === 'copied'
    const previous = renamed ? parts[index + 1] : undefined
    if (renamed) index += 1
    if (changes.length >= MAX_CHANGES) { truncated = true; break }
    const rel = await contain(root, record.slice(3), deniedRoots)
    if (rel === null) continue
    const previousPath = previous !== undefined ? await contain(root, previous, deniedRoots) : null
    changes.push({ path: rel, status, ...(previousPath !== null && previousPath !== undefined ? { previousPath } : {}) })
  }
  const counted = await lineCounts(root)
  return {
    branch,
    truncated,
    ...parseAheadBehind(header),
    changes: changes.map((change) => {
      const count = counted.get(change.path)
      return count === undefined ? change : { ...change, ...count }
    }),
  }
}

/**
 * Added and removed lines per current path, from `git diff --numstat -z HEAD`.
 * A plain record is `added\tremoved\tpath`. A rename is `added\tremoved\t`,
 * then the old path, then the new one. Binaries (`-`) contribute no count.
 */
async function lineCounts(root: string): Promise<Map<string, { added: number; removed: number }>> {
  const counts = new Map<string, { added: number; removed: number }>()
  const { stdout, code } = await git(root, ['diff', '--numstat', '-z', '--find-renames', 'HEAD'])
  if (code !== 0) return counts
  const parts = records(stdout)
  for (let index = 0; index < parts.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[index] ?? '')
    if (match === null) continue
    const added = match[1] === '-' ? undefined : Number(match[1])
    const removed = match[2] === '-' ? undefined : Number(match[2])
    if (added === undefined && removed === undefined) continue
    const count = { added: added ?? 0, removed: removed ?? 0 }
    const named = match[3] ?? ''
    if (named !== '') { counts.set(named, count); continue }
    // Rename: the destination, the second record after this one, is the row.
    const destination = parts[index + 2]
    index += 2
    if (destination !== undefined && destination !== '') counts.set(destination, count)
  }
  return counts
}

/**
 * Unified diff of one root-relative path against HEAD, worktree included.
 * The path is resolved inside the project before git is asked, and refused
 * when it leaves it.
 */
export async function gitDiff(root: string, rawPath: string, deniedRoots?: readonly string[]): Promise<GitDiffReport> {
  const rel = await contain(root, rawPath, deniedRoots)
  if (rel === null || rel === '') throw new ProjectGitError('path must be a file inside this project')
  const { stdout, code } = await git(root, ['diff', '--no-color', '--unified=3', '--find-renames', 'HEAD', '--', rel])
  if (code !== 0) throw new ProjectGitError(`git cannot diff '${rel}'`)
  let text = stdout.toString('utf8')
  // Untracked files have no HEAD diff. `git diff --no-index` against NUL
  // prints them as a new file and exits 1 because the sides differ, which is
  // the result rather than a failure.
  if (text.trim() === '') {
    const added = await git(root, ['diff', '--no-color', '--unified=3', '--no-index', '--', 'NUL', rel])
    if (added.stdout.length > 0) text = added.stdout.toString('utf8')
  }
  const truncated = Buffer.byteLength(text) > MAX_DIFF_BYTES
  if (truncated) text = text.slice(0, MAX_DIFF_BYTES)
  const binary = text.includes('Binary files ') || text.includes('GIT binary patch')
  return { path: rel, lines: binary ? [] : parseDiff(text), truncated, binary }
}

/** Turn unified diff text into rows. The `diff --git` header is dropped. */
export function parseDiff(text: string): GitDiffLine[] {
  const lines: GitDiffLine[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^(diff --git|index |new file|deleted file|similarity |rename |copy |old mode|new mode)/.test(raw)) continue
    if (raw.startsWith('@@')) lines.push({ kind: 'hunk', text: raw })
    else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) lines.push({ kind: 'meta', text: raw })
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1) })
    else lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  while (lines.length > 0 && lines[lines.length - 1]?.text === '') lines.pop()
  return lines
}

/**
 * A path git reported, kept only when it resolves inside the project root.
 * Returns the root-relative `/` form, or null when it escapes.
 */
async function contain(root: string, raw: string, deniedRoots?: readonly string[]): Promise<string | null> {
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalized === '' || normalized.split('/').includes('..')) return null
  try {
    const abs = await resolveGrantedPath(root, normalized, deniedRoots)
    const relative = path.relative(root, abs)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return relative.replaceAll('\\', '/')
  } catch {
    return null
  }
}
