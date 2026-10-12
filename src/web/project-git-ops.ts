/**
 * Repository operations for the Git panel: stage, unstage, discard, trash,
 * commit, uncommit and the remote commands (a port of Zed's `GitStore` jobs).
 *
 * Every operation runs through one serial queue per real repository root, so
 * two browser actions cannot race on `.git/index`. Git's own failures (an
 * `index.lock` left by a terminal command, a failing hook) come back unchanged
 * in `stderr`. Client-supplied paths pass through `contain()` and always follow
 * `--`; client-supplied remote and branch names are checked against Git before
 * they can appear in an argument list, so none of them can become an option.
 */
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  contain,
  gitStatus,
  projectGitEnvironment,
  ProjectGitError,
  runGitCommand,
  type GitChange,
  type GitRunner,
  type GitStatusReport,
} from './project-git.ts'

export type GitOperationRequest =
  | { type: 'stage' | 'unstage' | 'discard' | 'trash'; paths: readonly string[] }
  | { type: 'stage-all' | 'unstage-all' | 'uncommit' | 'fetch-all' }
  | { type: 'commit'; message: string; amend: boolean; signoff: boolean; noVerify: boolean; tracked: boolean }
  | { type: 'fetch'; remote: string }
  | { type: 'pull'; remote: string; branch?: string; rebase: boolean }
  | { type: 'push'; remote: string; branch: string; upstreamBranch: string; setUpstream: boolean; force: boolean }

export interface GitOperationResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Status read after the operation, inside the same queue slot. */
  readonly status: GitStatusReport
  readonly cancelled?: true
}

/** What an askpass session contributes: the variables that route prompts to the browser. */
export interface GitOperationAskpass {
  readonly env: Readonly<Record<string, string>>
}

/** Seams for tests; production passes none. */
export interface GitOperationDeps {
  readonly run?: GitRunner
  readonly trashPath?: (abs: string) => Promise<void>
  readonly deniedRoots?: readonly string[]
}

// ── per-repository serial queue (Zed `send_job`) ────────────────

const queues = new Map<string, Promise<unknown>>()

function queueKey(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

/**
 * Run `job` after every earlier job for the same real root has settled. A
 * failure is delivered to its own caller and never blocks the next job.
 */
function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve()
  const result = tail.then(job, job)
  const settled = result.then(() => undefined, () => undefined)
  queues.set(key, settled)
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
  return result
}

// ── execution context ───────────────────────────────────────────

interface Step {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

interface Context {
  readonly root: string
  readonly trusted: boolean
  readonly run: GitRunner
  readonly env: Readonly<Record<string, string>>
  readonly deniedRoots: readonly string[] | undefined
}

const DONE: Step = { ok: true, stdout: '', stderr: '' }

/** Treat every path argument as a literal file name, never as a glob or `:(magic)` pathspec. */
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' } as const

async function makeContext(root: string, trusted: boolean, run: GitRunner | undefined, extraEnv: Readonly<Record<string, string>> | undefined, deniedRoots: readonly string[] | undefined): Promise<Context> {
  const base = await projectGitEnvironment(root)
  return { root, trusted, run: run ?? runGitCommand, env: { ...base, ...extraEnv }, deniedRoots }
}

/** One git command; stdin is always closed so nothing can wait on it (no timeout exists). */
async function git(ctx: Context, args: readonly string[]): Promise<Step> {
  const result = await ctx.run(ctx.root, args, { trusted: ctx.trusted, stdin: 'ignore', env: ctx.env })
  return { ok: result.code === 0, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
}

/** Run steps in order, concatenating their output, and stop at the first failure. */
async function sequence(...steps: ReadonlyArray<() => Promise<Step>>): Promise<Step> {
  let stdout = ''
  let stderr = ''
  for (const step of steps) {
    const result = await step()
    stdout += result.stdout
    stderr += result.stderr
    if (!result.ok) return { ok: false, stdout, stderr }
  }
  return { ok: true, stdout, stderr }
}

// ── paths ───────────────────────────────────────────────────────

/** Root-relative forms of client paths; a path outside the project is refused, not skipped. */
async function relativePaths(ctx: Context, paths: readonly string[]): Promise<string[]> {
  const rels: string[] = []
  for (const raw of paths) {
    const rel = typeof raw === 'string' ? await contain(ctx.root, raw, ctx.deniedRoots) : null
    if (rel === null || rel === '') throw new ProjectGitError(`path '${String(raw)}' is not a file inside this project`)
    if (!rels.includes(rel)) rels.push(rel)
  }
  return rels
}

/** The status entries for the requested paths, in request order; unknown (clean or ignored) paths are dropped. */
async function entriesFor(ctx: Context, paths: readonly string[]): Promise<GitChange[]> {
  const rels = await relativePaths(ctx, paths)
  if (rels.length === 0) return []
  const { changes } = await gitStatus(ctx.root, ctx.deniedRoots, ctx.trusted)
  const byPath = new Map(changes.map((change) => [change.path, change]))
  return rels.flatMap((rel) => byPath.get(rel) ?? [])
}

const stageRels = (ctx: Context, rels: readonly string[]): Promise<Step> =>
  rels.length === 0 ? Promise.resolve(DONE) : git(ctx, ['update-index', '--add', '--remove', '--', ...rels])

const unstageRels = (ctx: Context, rels: readonly string[]): Promise<Step> =>
  rels.length === 0 ? Promise.resolve(DONE) : git(ctx, ['reset', '--quiet', '--', ...rels])

const paths = (entries: readonly GitChange[]): string[] => entries.map((entry) => entry.path)

// ── remotes and refs ────────────────────────────────────────────

/** Remote names from `git remote -v`, each once, in listing order. */
async function remoteNames(ctx: Context): Promise<string[]> {
  const { ok, stdout } = await git(ctx, ['remote', '-v'])
  if (!ok) return []
  const names: string[] = []
  for (const line of stdout.split('\n')) {
    const name = /^(\S+)\s/.exec(line)?.[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/** A remote the repository really has; this is what keeps a client string from becoming an option. */
async function checkedRemote(ctx: Context, remote: string): Promise<string> {
  if (remote === '' || remote.startsWith('-') || !(await remoteNames(ctx)).includes(remote)) {
    throw new ProjectGitError(`'${remote}' is not a remote of this repository`)
  }
  return remote
}

/** A syntactically valid branch name that cannot be read as an option. */
async function checkedBranch(ctx: Context, name: string): Promise<string> {
  if (name === '' || name.startsWith('-') || !(await git(ctx, ['check-ref-format', `refs/heads/${name}`])).ok) {
    throw new ProjectGitError(`'${name}' is not a valid branch name`)
  }
  return name
}

/**
 * Remotes to offer for `branch` (Zed `store.rs:9134`): the one its push or
 * pull is already bound to, else every remote.
 */
export async function listProjectGitRemotes(root: string, trusted: boolean, branch: string, push: boolean): Promise<string[]> {
  const ctx = await makeContext(root, trusted, undefined, undefined, undefined)
  const all = await remoteNames(ctx)
  const name = await checkedBranch(ctx, branch)
  if (push) {
    const { ok, stdout } = await git(ctx, ['rev-parse', '--abbrev-ref', `${name}@{push}`])
    const ref = stdout.trim()
    // `origin/main`: the longest remote name that is a path prefix of it.
    const bound = ok ? all.filter((remote) => ref.startsWith(`${remote}/`)).sort((a, b) => b.length - a.length)[0] : undefined
    if (bound !== undefined) return [bound]
  } else {
    const { ok, stdout } = await git(ctx, ['config', '--get', `branch.${name}.remote`])
    const bound = stdout.trim()
    if (ok && all.includes(bound)) return [bound]
  }
  return all
}

/** Remote-tracking refs that contain HEAD (`refs/remotes/origin/main`), without the `origin/HEAD` symref. */
export async function pushedTo(root: string, trusted: boolean): Promise<string[]> {
  const ctx = await makeContext(root, trusted, undefined, undefined, undefined)
  const { ok, stdout } = await git(ctx, ['for-each-ref', '--format=%(refname)', '--contains', 'HEAD', 'refs/remotes/'])
  if (!ok) return []
  return stdout.split('\n').filter((ref) => ref !== '' && !ref.endsWith('/HEAD'))
}

// ── OS trash (Zed `fs.trash`) ───────────────────────────────────

export interface TrashInvocation {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

const MACOS_TRASH = '/usr/bin/trash'

const FINDER_DELETE = [
  '-e', 'on run argv',
  '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
  '-e', 'end run',
]

const RECYCLE_SCRIPT = 'Add-Type -AssemblyName Microsoft.VisualBasic; '
  + '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:DNT_TRASH_PATH, '
  + '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, '
  + '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)'

/**
 * The process that moves `abs` to the trash on `platform`. The path is one
 * argument (or, for PowerShell, an environment variable), never part of a
 * command string.
 */
export function trashInvocation(abs: string, platform: NodeJS.Platform = process.platform, hasTrashBinary: boolean = existsSync(MACOS_TRASH)): TrashInvocation {
  if (platform === 'darwin') {
    return hasTrashBinary
      ? { file: MACOS_TRASH, args: [abs] }
      : { file: 'osascript', args: [...FINDER_DELETE, abs] }
  }
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], env: { DNT_TRASH_PATH: abs } }
  }
  return { file: 'gio', args: ['trash', abs] }
}

export function trashPath(abs: string): Promise<void> {
  const { file, args, env } = trashInvocation(abs)
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { env: { ...process.env, ...env }, windowsHide: true }, (error, _stdout, stderr) => {
      if (error === null) { resolve(); return }
      reject(new Error(stderr.trim() !== '' ? stderr.trim() : error.message))
    })
  })
}

// ── operations (Zed panel.rs / repository.rs) ───────────────────

async function discard(ctx: Context, requested: readonly string[]): Promise<Step> {
  const entries = await entriesFor(ctx, requested)
  // A staged entry is unstaged first, so the checkout starts from the index == HEAD.
  const staged = entries.filter((entry) => entry.staging !== 'unstaged')
  // A created entry has no copy in HEAD; once unstaged it is an untracked file for Trash.
  const tracked = entries.filter((entry) => !entry.created)
  return sequence(
    () => unstageRels(ctx, paths(staged)),
    () => tracked.length === 0 ? Promise.resolve(DONE) : git(ctx, ['checkout', 'HEAD', '--', ...paths(tracked)]),
  )
}

async function trash(ctx: Context, requested: readonly string[], move: (abs: string) => Promise<void>): Promise<Step> {
  // Only files Git reports as new; ignored and tracked files are never trashed.
  const entries = (await entriesFor(ctx, requested)).filter((entry) => entry.created)
  const unstaged = await unstageRels(ctx, paths(entries.filter((entry) => entry.staging !== 'unstaged')))
  if (!unstaged.ok) return unstaged
  for (const entry of entries) {
    try {
      await move(path.join(ctx.root, entry.path))
    } catch (error) {
      return { ok: false, stdout: '', stderr: `could not move '${entry.path}' to the trash: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return DONE
}

async function commit(ctx: Context, request: Extract<GitOperationRequest, { type: 'commit' }>): Promise<Step> {
  const run = (): Promise<Step> => git(ctx, [
    'commit', '--quiet', '-m', request.message, '--cleanup=strip',
    ...(request.amend ? ['--amend'] : []),
    ...(request.signoff ? ['--signoff'] : []),
    ...(request.noVerify ? ['--no-verify'] : []),
  ])
  if (!request.tracked) return run()
  // Commit Tracked: stage every tracked change that is not fully staged. An
  // unmerged file stays out so Git itself refuses the commit.
  const { changes } = await gitStatus(ctx.root, ctx.deniedRoots, ctx.trusted)
  const tracked = changes.filter((change) => !change.created && !change.conflicted && change.staging !== 'staged')
  return sequence(() => stageRels(ctx, paths(tracked)), run)
}

async function push(ctx: Context, request: Extract<GitOperationRequest, { type: 'push' }>): Promise<Step> {
  const remote = await checkedRemote(ctx, request.remote)
  const branch = await checkedBranch(ctx, request.branch)
  const upstream = await checkedBranch(ctx, request.upstreamBranch === '' ? request.branch : request.upstreamBranch)
  return git(ctx, [
    'push',
    ...(request.force ? ['--force-with-lease'] : []),
    ...(request.setUpstream ? ['--set-upstream'] : []),
    remote,
    `${branch}:${upstream}`,
  ])
}

async function pull(ctx: Context, request: Extract<GitOperationRequest, { type: 'pull' }>): Promise<Step> {
  const remote = await checkedRemote(ctx, request.remote)
  const branch = request.branch === undefined || request.branch === '' ? undefined : await checkedBranch(ctx, request.branch)
  return git(ctx, ['pull', ...(request.rebase ? ['--rebase'] : []), remote, ...(branch === undefined ? [] : [branch])])
}

async function dispatch(ctx: Context, request: GitOperationRequest, move: (abs: string) => Promise<void>): Promise<Step> {
  switch (request.type) {
    case 'stage':
      return stageRels(ctx, await relativePaths(ctx, request.paths))
    case 'unstage':
      return unstageRels(ctx, await relativePaths(ctx, request.paths))
    case 'stage-all':
      return stageRels(ctx, paths((await gitStatus(ctx.root, ctx.deniedRoots, ctx.trusted)).changes.filter((change) => change.staging !== 'staged')))
    case 'unstage-all':
      return unstageRels(ctx, paths((await gitStatus(ctx.root, ctx.deniedRoots, ctx.trusted)).changes.filter((change) => change.staging !== 'unstaged')))
    case 'discard':
      return discard(ctx, request.paths)
    case 'trash':
      return trash(ctx, request.paths, move)
    case 'commit':
      return commit(ctx, request)
    case 'uncommit':
      return git(ctx, ['reset', '--soft', 'HEAD^'])
    case 'fetch-all':
      return git(ctx, ['fetch', '--all'])
    case 'fetch':
      return git(ctx, ['fetch', await checkedRemote(ctx, request.remote)])
    case 'pull':
      return pull(ctx, request)
    case 'push':
      return push(ctx, request)
  }
}

/** The operations whose Git process may ask for a password, a passphrase or a signing key. */
const PROMPTING: ReadonlySet<GitOperationRequest['type']> = new Set(['commit', 'fetch', 'fetch-all', 'pull', 'push'])

/**
 * Run one panel operation inside the repository's queue. Resolves with Git's
 * own exit verdict and output, and the status read afterwards; rejects only
 * for a request that is invalid (a path outside the project, a name that is
 * not a remote or branch) or when git cannot be started.
 */
export function runProjectGitOperation(
  root: string,
  trusted: boolean,
  request: GitOperationRequest,
  askpass?: GitOperationAskpass,
  deps: GitOperationDeps = {},
): Promise<GitOperationResult> {
  return enqueue(queueKey(root), async () => {
    // Path operations get literal pathspecs; the prompting ones run hooks and
    // child git processes, which keep the environment a terminal would give them.
    const extraEnv = PROMPTING.has(request.type) ? askpass?.env : LITERAL_PATHSPECS
    const ctx = await makeContext(root, trusted, deps.run, extraEnv, deps.deniedRoots)
    const step = await dispatch(ctx, request, deps.trashPath ?? trashPath)
    const status = await gitStatus(root, deps.deniedRoots, trusted)
    return { ok: step.ok, stdout: step.stdout, stderr: step.stderr, status }
  })
}
