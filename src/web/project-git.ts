/**
 * Git status and diffs for the workbench Git view, and the one place a git
 * process is built.
 *
 * Every call goes through {@link buildGitCommand}, a port of Zed's
 * `GitBinary::build_command` (`crates/git/src/repository.rs:3994`): the project
 * root is the working directory, the environment is the user's login-shell
 * environment for that directory, and the arguments carry a fixed set of `-c`
 * overrides that depend on whether the project is *trusted*. Paths are checked
 * against the registered project root before git sees them and again on the
 * way out, so a symlink checkout or a crafted path cannot report a file
 * outside it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { detectLoginShell, loginShellArgs } from '../capabilities/shell/detect.ts'
import { resolveGrantedPath } from '../capabilities/fs/tools.ts'
import { hunksFor } from './project-git-hunks.ts'
import { parseConflicts, type GitConflict } from './project-git-conflicts.ts'

/** One changed path, in the shape the Git view lists. */
export interface GitChange {
  /** Root-relative path with `/` separators — the path the row opens. */
  readonly path: string
  /** Previous path of a rename or copy; never set now that status runs with `--no-renames`. */
  readonly previousPath?: string
  /** Coarse status kept for existing consumers; derived from the raw codes below. */
  readonly status: GitStatus
  /** Raw index (X) column of the porcelain code; `' '` when unmodified, `'?'` when untracked. */
  readonly indexStatus: string
  /** Raw worktree (Y) column of the porcelain code. */
  readonly worktreeStatus: string
  /** Zed `FileStatus::is_created`: added to the index or the worktree, or untracked. */
  readonly created: boolean
  /** Zed `FileStatus::is_deleted`. */
  readonly deleted: boolean
  /** Zed `FileStatus::is_conflicted`: unmerged. */
  readonly conflicted: boolean
  /** Zed `FileStatus::staging`. */
  readonly staging: GitStaging
  /** Lines added against HEAD; absent when git reported no count (a binary). */
  readonly added?: number
  /** Lines removed against HEAD; absent when git reported no count. */
  readonly removed?: number
}

export type GitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict'

/** Zed `StageStatus`. */
export type GitStaging = 'staged' | 'unstaged' | 'partial'

/** How the current branch relates to its upstream (Zed `UpstreamTracking`). */
export type GitUpstreamTrack =
  | { readonly kind: 'tracked'; readonly ahead: number; readonly behind: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'none' }

export interface GitBranchReport {
  readonly name: string
  readonly upstream?: { readonly remote: string; readonly branch: string }
  readonly upstreamTrack: GitUpstreamTrack
}

/** The latest commit on HEAD; absent from the report in a repository with no commit. */
export interface GitHeadReport {
  readonly sha: string
  readonly subject: string
  /** The full commit message (subject and body), for Amend and Uncommit. */
  readonly message: string
  /** False for a root commit: there is nothing to uncommit to. */
  readonly hasParent: boolean
}

export interface GitStatusReport {
  /** Current branch name (compatibility with existing consumers); `null` when detached or not a repository. */
  readonly branch: string | null
  /** Current branch with its upstream and tracking; `null` when detached or not a repository. */
  readonly branchInfo: GitBranchReport | null
  /** Latest commit; `null` when there is none. */
  readonly head: GitHeadReport | null
  readonly changes: readonly GitChange[]
  /** True when the walk stopped at {@link MAX_CHANGES}; the list is then partial. */
  readonly truncated: boolean
  /** Commits ahead of the upstream, when the branch tracks one (compatibility with the Environment panel). */
  readonly ahead?: number
  /** Commits behind the upstream, when the branch tracks one (compatibility with the Environment panel). */
  readonly behind?: number
  /** A merge/cherry-pick/rebase/revert/apply is in progress (any `*_HEAD` file resolves). */
  readonly mergeHeads?: boolean
  /** `MERGE_MSG` (comment lines stripped) while a merge message exists. */
  readonly mergeMessage?: string
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
  /** The displayed hunks with their staging status; empty when hunk controls are not offered. */
  readonly hunks?: readonly import('./project-git-hunks.ts').GitHunk[]
  /** Conflict blocks of a conflicted file; always present (empty) for a clean shape. */
  readonly conflicts?: readonly GitConflict[]
}

export class ProjectGitError extends Error {}

/** Changed paths kept from one status; past this the report says it stopped. */
export const MAX_CHANGES = 500
/** Diff text kept for one file. */
const MAX_DIFF_BYTES = 1024 * 1024
/** Output one query may produce before it is cut off — memory safety, not a time limit. */
const MAX_QUERY_BYTES = 64 * 1024 * 1024
/** Bound on the login shell only; a git command itself never times out. */
const ENV_LOAD_TIMEOUT_MS = 30_000

// ── executable ──────────────────────────────────────────────────

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

/**
 * Git on the project environment's `PATH` (Zed `store.rs:788`), so a git the
 * user's shell profile puts first is the one that runs. Falls back to the
 * host-wide lookup when the captured `PATH` has none. Only an executable
 * regular file in an absolute directory counts: a relative entry would make
 * the choice depend on the server's working directory.
 */
function gitOnPath(env: Readonly<Record<string, string>>): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
  for (const dir of (key === undefined ? '' : env[key] ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // missing, unreadable or not executable: keep looking
      }
    }
  }
  return gitExecutable() ?? 'git'
}

// ── project environment (Zed project/src/environment.rs) ────────

/**
 * Parse `env -0` output: NUL-separated `NAME=value` records. Only the first
 * `=` splits, so a value may contain more; an empty value is kept; a record
 * with no name or no `=` is dropped.
 */
export function parseNullEnvironment(buffer: Buffer): Record<string, string> {
  const entries: [string, string][] = []
  for (const record of buffer.toString('utf8').split('\0')) {
    const equals = record.indexOf('=')
    if (equals <= 0) continue
    entries.push([record.slice(0, equals), record.slice(equals + 1)])
  }
  return Object.fromEntries(entries)
}

/** Printed before the environment so rc-file chatter on stdout cannot corrupt it. */
const ENV_MARKER = 'DNT_GIT_ENV_BEGIN'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The command the login shell runs: enter the directory, then dump the environment. */
function environmentCommand(shell: string, root: string): string {
  if (/(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(shell)) {
    return `Set-Location -LiteralPath '${root.replaceAll("'", "''")}'; `
      + `[Console]::Out.Write('${ENV_MARKER}' + [char]0); `
      + 'Get-ChildItem Env: | ForEach-Object { [Console]::Out.Write($_.Name + \'=\' + $_.Value + [char]0) }'
  }
  return `cd -- ${shellQuote(root)}; printf '%s\\0' ${ENV_MARKER}; env -0`
}

function serverEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function loadLoginShellEnvironment(root: string, shell: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, loginShellArgs(shell, environmentCommand(shell, root)), {
      cwd: root,
      env: serverEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the login shell did not finish within ${ENV_LOAD_TIMEOUT_MS / 1000}s`))
    }, ENV_LOAD_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.resume()
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks)
      const marker = output.lastIndexOf(`${ENV_MARKER}\0`)
      if (marker < 0) { reject(new Error('the login shell printed no environment')); return }
      const environment = parseNullEnvironment(output.subarray(marker + ENV_MARKER.length + 1))
      if (Object.keys(environment).length === 0) { reject(new Error('the login shell printed an empty environment')); return }
      resolve(environment)
    })
  })
}

const environments = new Map<string, Promise<Readonly<Record<string, string>>>>()

/**
 * The detected login shell, kept for the server's lifetime: on macOS an unset
 * `$SHELL` makes the detector spawn `dscl`, which every git command would pay.
 * The result is tied to the `$SHELL` it was detected under, so changing `$SHELL`
 * detects again.
 */
let shellMemo: { readonly shellVariable: string | undefined; readonly detection: ReturnType<typeof detectLoginShell> } | undefined

function loginShell(): ReturnType<typeof detectLoginShell> {
  const shellVariable = process.env['SHELL']
  if (shellMemo === undefined || shellMemo.shellVariable !== shellVariable) {
    shellMemo = { shellVariable, detection: detectLoginShell() }
  }
  return shellMemo.detection
}

/**
 * The environment a terminal opened in `root` would have: the account's login
 * shell, started as a login and interactive shell, `cd`'d into the directory.
 * Cached per (shell, real directory) for the server's lifetime. When the shell
 * cannot be run the failure is logged and the server's own environment is used
 * (Zed logs and uses the default).
 */
export function projectGitEnvironment(root: string): Promise<Readonly<Record<string, string>>> {
  const shell = loginShell().executable ?? '/bin/sh'
  const keyed = fs.realpath(root).catch(() => path.resolve(root))
  return keyed.then((real) => {
    const key = `${shell}\0${real}`
    let cached = environments.get(key)
    if (cached === undefined) {
      cached = loadLoginShellEnvironment(real, shell).catch((error: unknown) => {
        console.error(`[git] could not load the login-shell environment for ${real}: ${error instanceof Error ? error.message : String(error)}; using the server environment`)
        return serverEnvironment()
      })
      environments.set(key, cached)
    }
    return cached
  })
}

// ── command builder (Zed repository.rs:3994) ────────────────────

/** Added to every git command, trusted or not. */
const ALWAYS_CONFIG: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '--no-optional-locks',
  '--no-pager',
]

/**
 * Added only while the project is not trusted (Zed Restricted Mode). A cloned
 * repository's own config could otherwise run commands from reads and writes
 * the panel performs: hooks, a credential helper, an ssh command, external
 * diff drivers.
 */
const UNTRUSTED_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.sshCommand=ssh',
  '-c', 'credential.helper=',
  '-c', 'protocol.ext.allow=never',
  '-c', 'diff.external=',
]

/** The full argument list for `git`, in the order Zed passes it. Exposed as a test seam. */
export function gitCommandArgs(args: readonly string[], trusted: boolean): string[] {
  const subcommand = !trusted && args[0] === 'diff' ? ['diff', '--no-ext-diff', ...args.slice(1)] : [...args]
  return [...ALWAYS_CONFIG, ...(trusted ? [] : UNTRUSTED_CONFIG), ...subcommand]
}

export interface GitCommandOptions {
  readonly trusted: boolean
  /** `'ignore'` closes stdin (a push must never wait on it); default `'pipe'`. A Buffer is written, then closed. */
  readonly stdin?: 'pipe' | 'ignore' | Buffer
  /** Replaces the project environment, e.g. when the caller adds askpass variables to it. */
  readonly env?: Readonly<Record<string, string>>
  /** Start git as its own process group leader (not on Windows), so the whole tree can be killed. */
  readonly detached?: boolean
  /** Called synchronously with the child right after it starts. */
  readonly onSpawn?: (child: ChildProcessWithoutNullStreams) => void
}

/**
 * Start one git process in `root`. No timeout: it ends when git exits (Zed
 * `run_askpass_command`, `repo.rs:4089`). With `stdin: 'ignore'` the child's
 * `stdin` is null at runtime even though the type is the piped one.
 */
export async function buildGitCommand(
  root: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<ChildProcessWithoutNullStreams> {
  const env = options.env ?? await projectGitEnvironment(root)
  // A Buffer stdin means "pipe and feed it"; anything else names the stdio itself.
  const stdioIn: 'pipe' | 'ignore' = options.stdin === undefined || Buffer.isBuffer(options.stdin) ? 'pipe' : options.stdin
  const child = spawn(gitOnPath(env), gitCommandArgs(args, options.trusted), {
    cwd: root,
    env: { ...env },
    stdio: [stdioIn, 'pipe', 'pipe'],
    windowsHide: true,
    detached: options.detached === true && process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams
  options.onSpawn?.(child)
  return child
}

/** One finished git query. `code` is git's own exit code, never a launch failure. */
export interface GitResult {
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly code: number
}

/**
 * Run one git command to completion inside `root`. A missing executable or a
 * launch that never produces an exit code rejects; a non-zero exit resolves,
 * because git uses those as answers (`diff --no-index` exits 1 when the sides
 * differ, `status` exits 128 outside a work tree).
 */
export async function runGitQuery(root: string, args: readonly string[], trusted: boolean): Promise<GitResult> {
  return runGitCommand(root, args, { trusted, stdin: 'ignore' })
}

/** Runs one git command to completion; the seam operations inject a runner through. */
export type GitRunner = (root: string, args: readonly string[], options: GitCommandOptions) => Promise<GitResult>

/** {@link runGitQuery} with the full command options (environment, stdin). */
export const runGitCommand: GitRunner = async (root, args, options) => {
  const child = await buildGitCommand(root, args, options)
  // A Buffer stdin is written once and closed; a plain 'pipe' (no data) is
  // closed empty as soon as git reads, and 'ignore' never had one.
  if (options.stdin !== undefined && options.stdin !== 'pipe' && options.stdin !== 'ignore') {
    child.stdin.end(options.stdin)
  } else if (options.stdin === 'pipe') {
    child.stdin.end()
  }
  return new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_QUERY_BYTES) {
        child.kill('SIGKILL')
        fail(new ProjectGitError('git produced more output than can be shown'))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(new ProjectGitError(error.code === 'ENOENT' ? 'git is not installed on this host' : `git failed: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code === null) { reject(new ProjectGitError(`git failed: killed by ${signal ?? 'a signal'}`)); return }
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code })
    })
  })
}

/** Split NUL-delimited git output, dropping the trailing empty record. */
function records(buffer: Buffer): string[] {
  const parts = buffer.toString('utf8').split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

// ── status (Zed repository.rs:3767, git/src/status.rs:144-203) ──

/** Fields Zed derives from one `XY` porcelain code. */
export interface GitStatusClass {
  readonly status: GitStatus
  readonly created: boolean
  readonly deleted: boolean
  readonly conflicted: boolean
  readonly staging: GitStaging
}

const STATUS_OF: Readonly<Record<string, GitStatus>> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked',
}

/**
 * `FileStatus::from_bytes`: `??` is untracked, `AA`, `DD` and any code with a
 * `U` in it are unmerged, everything else is tracked with an index and a
 * worktree column.
 */
function isUnmerged(index: string, work: string): boolean {
  return (index === 'A' && work === 'A') || (index === 'D' && work === 'D') || index === 'U' || work === 'U'
}

/** The Zed `FileStatus` predicates for one two-character porcelain code. */
export function classifyStatus(code: string): GitStatusClass {
  const index = code[0] ?? ' '
  const work = code[1] ?? ' '
  if (index === '?' && work === '?') {
    return { status: 'untracked', created: true, deleted: false, conflicted: false, staging: 'unstaged' }
  }
  if (isUnmerged(index, work)) {
    return { status: 'conflict', created: false, deleted: false, conflicted: true, staging: 'unstaged' }
  }
  const staging: GitStaging = index === ' ' ? 'unstaged' : work === ' ' ? 'staged' : 'partial'
  return {
    status: STATUS_OF[work === ' ' ? index : work] ?? STATUS_OF[index] ?? 'modified',
    created: index === 'A' || work === 'A',
    deleted: (index === 'D' && work !== 'A') || work === 'D',
    conflicted: false,
    staging,
  }
}

/** `for-each-ref` output for the HEAD branch: the structured branch report. */
async function branchReport(root: string, trusted: boolean, name: string): Promise<GitBranchReport> {
  const format = '%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track)%00%(upstream:short)'
  const { stdout, code } = await runGitQuery(root, ['for-each-ref', `--format=${format}`, `refs/heads/${name}`], trusted)
  if (code === 0) {
    for (const line of stdout.toString('utf8').split('\n')) {
      const [refname, upstream, remotename, remoteref, track, short] = line.split('\0')
      if (refname !== `refs/heads/${name}` || upstream === undefined || upstream === '') continue
      let remote = remotename ?? ''
      let branch = (remoteref ?? '').replace(/^refs\/heads\//, '')
      if (remote === '' || branch === '') {
        const slash = (short ?? '').indexOf('/')
        if (slash > 0) { remote = short?.slice(0, slash) ?? ''; branch = short?.slice(slash + 1) ?? '' }
      }
      return {
        name,
        ...(remote !== '' && branch !== '' ? { upstream: { remote, branch } } : {}),
        upstreamTrack: parseUpstreamTrack(track ?? ''),
      }
    }
  }
  return { name, upstreamTrack: { kind: 'none' } }
}

/** `%(upstream:track)`: `""` in sync, `[gone]`, or `[ahead N]`, `[behind M]`, `[ahead N, behind M]`. */
export function parseUpstreamTrack(track: string): GitUpstreamTrack {
  if (track === '[gone]') return { kind: 'gone' }
  const { ahead, behind } = parseAheadBehind(track)
  return { kind: 'tracked', ahead: ahead ?? 0, behind: behind ?? 0 }
}

/** Latest commit via `git log -1`; null when the repository has none. */
async function headReport(root: string, trusted: boolean): Promise<GitHeadReport | null> {
  const { stdout, code } = await runGitQuery(root, ['log', '-1', '--format=%H%x00%s%x00%P%x00%B'], trusted)
  if (code !== 0) return null
  const [sha, subject, parents, message] = stdout.toString('utf8').split('\0')
  if (sha === undefined || sha === '') return null
  return { sha, subject: subject ?? '', message: (message ?? subject ?? '').replace(/\s+$/, ''), hasParent: (parents ?? '').trim() !== '' }
}

/**
 * The porcelain walk behind {@link gitStatus}: same command, same
 * classification, and `limit` entries at most (default none). Null when the
 * root is not a git checkout. The panel list passes {@link MAX_CHANGES}; an
 * explicit operation must read every entry and so passes no limit.
 */
export async function readStatusChanges(
  root: string,
  deniedRoots?: readonly string[],
  trusted = false,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<{ changes: GitChange[]; truncated: boolean } | null> {
  const { stdout, code } = await runGitQuery(root, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z', '--', '.'], trusted)
  if (code !== 0) return null
  const changes: GitChange[] = []
  let truncated = false
  for (const record of records(stdout)) {
    // `XY path`; with `--no-renames` there are no continuation records.
    if (record.length < 4 || record[2] !== ' ') continue
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    if (indexStatus === '!' && worktreeStatus === '!') continue
    if (changes.length >= limit) { truncated = true; break }
    const rel = await contain(root, record.slice(3), deniedRoots)
    if (rel === null) continue
    changes.push({ path: rel, indexStatus, worktreeStatus, ...classifyStatus(record.slice(0, 2)) })
  }
  return { changes, truncated }
}

/**
 * `git status` for a project root. Not a git checkout is an empty report, not
 * an error: a project folder simply may not be one.
 */
export async function gitStatus(root: string, deniedRoots?: readonly string[], trusted = false): Promise<GitStatusReport> {
  const read = await readStatusChanges(root, deniedRoots, trusted, MAX_CHANGES)
  if (read === null) return { branch: null, branchInfo: null, head: null, changes: [], truncated: false }
  const { changes, truncated } = read
  const symbolic = await runGitQuery(root, ['symbolic-ref', '--short', '-q', 'HEAD'], trusted)
  const name = symbolic.code === 0 ? symbolic.stdout.toString('utf8').trim() : ''
  const branchInfo = name === '' ? null : await branchReport(root, trusted, name)
  const head = await headReport(root, trusted)
  const counted = await lineCounts(root, trusted)
  const merge = await mergeState(root, trusted)
  const track = branchInfo?.upstreamTrack
  return {
    branch: branchInfo?.name ?? null,
    branchInfo,
    head,
    truncated,
    ...(track?.kind === 'tracked' ? { ahead: track.ahead, behind: track.behind } : {}),
    ...(merge.heads ? { mergeHeads: true } : { mergeHeads: false }),
    ...(merge.message !== undefined ? { mergeMessage: merge.message } : {}),
    changes: changes.map((change) => {
      const count = counted.get(change.path)
      return count === undefined ? change : { ...change, ...count }
    }),
  }
}

/** The `*_HEAD` sentinel files and `MERGE_MSG` of an in-progress sequence, in one git call. */
async function mergeState(root: string, trusted: boolean): Promise<{ heads: boolean; message?: string }> {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'REVERT_HEAD', 'APPLY_HEAD', 'MERGE_MSG']
  const { stdout, code } = await runGitQuery(root, ['rev-parse', ...names.flatMap((name) => ['--git-path', name])], trusted)
  if (code !== 0) return { heads: false }
  const paths = stdout.toString('utf8').split('\n').filter((line) => line !== '')
  let heads = false
  for (const gitPath of paths.slice(0, 5)) {
    try {
      await fs.access(path.resolve(root, gitPath))
      heads = true
      break
    } catch { /* not present */ }
  }
  let message: string | undefined
  const mergeMsg = paths[5]
  if (mergeMsg !== undefined) {
    try {
      const raw = await fs.readFile(path.resolve(root, mergeMsg), 'utf8')
      const stripped = raw.split('\n').filter((line) => !line.startsWith('#')).join('\n').replace(/\s+$/, '')
      if (stripped !== '') message = stripped
    } catch { /* no merge message */ }
  }
  return { heads, ...(message !== undefined ? { message } : {}) }
}

/**
 * Added and removed lines per current path, from `git diff --numstat -z HEAD`.
 * A plain record is `added\tremoved\tpath`. A rename is `added\tremoved\t`,
 * then the old path, then the new one. Binaries (`-`) contribute no count.
 */
async function lineCounts(root: string, trusted: boolean): Promise<Map<string, { added: number; removed: number }>> {
  const counts = new Map<string, { added: number; removed: number }>()
  const { stdout, code } = await runGitQuery(root, ['diff', '--numstat', '-z', '--find-renames', 'HEAD'], trusted)
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
export async function gitDiff(root: string, rawPath: string, deniedRoots?: readonly string[], trusted = false): Promise<GitDiffReport> {
  const rel = await contain(root, rawPath, deniedRoots)
  if (rel === null || rel === '') throw new ProjectGitError('path must be a file inside this project')
  // A repository with no commit yet has no HEAD for `diff` to name; the
  // staged index against the empty state is the whole story there.
  const hasHead = (await runGitQuery(root, ['rev-parse', '--verify', '-q', 'HEAD'], trusted)).code === 0
  const { stdout, code } = await runGitQuery(root, hasHead
    ? ['diff', '--no-color', '--unified=3', '--find-renames', 'HEAD', '--', rel]
    : ['diff', '--no-color', '--unified=3', '--cached', '--', rel], trusted)
  if (code !== 0) throw new ProjectGitError(`git cannot diff '${rel}'`)
  let text = stdout.toString('utf8')
  // A path with no HEAD diff is either unchanged-tracked or never staged.
  // Only the never-staged one has content to show: an all-additions diff
  // against the empty device, spelled per platform (NUL on Windows,
  // /dev/null elsewhere — git must be able to open it). It exits 1 because
  // the sides differ, which is the result rather than a failure.
  if (text.trim() === '') {
    const { stdout: tracked } = await runGitQuery(root, ['ls-files', '-z', '--', rel], trusted)
    if (tracked.length === 0) {
      const empty = process.platform === 'win32' ? 'NUL' : '/dev/null'
      const added = await runGitQuery(root, ['diff', '--no-color', '--unified=3', '--no-index', '--', empty, rel], trusted)
      if (added.stdout.length > 0) text = added.stdout.toString('utf8')
    }
  }
  const truncated = Buffer.byteLength(text) > MAX_DIFF_BYTES
  if (truncated) text = text.slice(0, MAX_DIFF_BYTES)
  const binary = text.includes('Binary files ') || text.includes('GIT binary patch')
  if (binary || truncated) return { path: rel, lines: binary ? [] : parseDiff(text), truncated, binary, hunks: [] }
  // A conflicted file shows its conflict blocks instead of hunks: the markers
  // live in the worktree file, not in any git diff of it.
  const change = (await readStatusChanges(root, deniedRoots, trusted))?.changes.find((entry) => entry.path === rel)
  if (change?.conflicted === true) {
    let conflicts: GitConflict[] = []
    try {
      conflicts = parseConflicts(await fs.readFile(path.join(root, rel), 'utf8'))
    } catch { /* unreadable: no blocks */ }
    return { path: rel, lines: parseDiff(text), truncated, binary, hunks: [], conflicts }
  }
  const hunks = await hunksFor(root, rel, trusted, text,
    (args) => runGitQuery(root, args, trusted), hasHead, false)
  return { path: rel, lines: parseDiff(text), truncated, binary, hunks }
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
export async function contain(root: string, raw: string, deniedRoots?: readonly string[]): Promise<string | null> {
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
