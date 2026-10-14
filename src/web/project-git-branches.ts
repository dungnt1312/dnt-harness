/**
 * Branches for the Git panel: the list behind the branch picker and the
 * switch, create and delete operations (a port of Zed's `branches`,
 * `change_branch`, `create_branch` and `delete_branch` repository jobs).
 *
 * The list is a read-only query. The operations run inside the repository's
 * queue (`runProjectGitOperation`); a name the client got wrong throws
 * `ProjectGitError`, while Git's own refusal (an unmerged branch) comes back
 * as a failed step with Git's stderr.
 */
import { ProjectGitError, runGitCommand, type GitRunner } from './project-git.ts'
import { checkedBranch, git, sequence, type Context, type Step } from './project-git-ops.ts'

export interface GitBranch {
  readonly name: string
  readonly remote: boolean
  readonly current: boolean
  readonly upstream?: string
  readonly unixTime?: number
  readonly subject?: string
}

export interface GitBranchList {
  readonly branches: readonly GitBranch[]
  readonly defaultBranch?: string
  /** Git's stderr when listing failed (Zed `branch_list_error`); `branches` holds whatever parsed. */
  readonly error?: string
}

const FORMAT = '%(HEAD)%00%(objectname)%00%(parent)%00%(refname)%00%(upstream)%00%(upstream:track)%00%(committerdate:unix)%00%(authorname)%00%(contents:subject)'

/** Parse `for-each-ref` records written with {@link FORMAT}; `origin/HEAD` symrefs are dropped. */
export function parseBranchRecords(stdout: string): GitBranch[] {
  const out: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    const f = line.split('\0')
    if (f.length < 9) continue
    const [head, , , ref = '', upstream = '', , time = '', , subject = ''] = f
    const remote = ref.startsWith('refs/remotes/')
    if (!remote && !ref.startsWith('refs/heads/')) continue
    if (remote && ref.endsWith('/HEAD')) continue
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    const unix = Number(time)
    out.push({
      name,
      remote,
      current: head === '*',
      ...(upstream.startsWith('refs/remotes/') ? { upstream: upstream.slice('refs/remotes/'.length) } : {}),
      ...(time !== '' && Number.isFinite(unix) ? { unixTime: unix } : {}),
      ...(subject !== '' ? { subject } : {}),
    })
  }
  return out
}

/**
 * Zed `default_branch`: the `upstream` remote's HEAD, then `origin`'s, then a
 * local `init.defaultBranch`, `main` or `master` that exists as a branch.
 */
async function defaultBranchOf(root: string, trusted: boolean, run: GitRunner): Promise<string | undefined> {
  const query = (args: readonly string[]) => run(root, args, { trusted, stdin: 'ignore' })
  const listed = await query(['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/remotes/upstream/HEAD', 'refs/remotes/origin/HEAD', 'refs/heads/'])
  const refs = new Map<string, string>()
  if (listed.code === 0) {
    for (const line of listed.stdout.toString('utf8').split('\n')) {
      const tab = line.indexOf('\t')
      if (tab >= 0) refs.set(line.slice(0, tab), line.slice(tab + 1))
    }
  }
  for (const remote of ['upstream', 'origin']) {
    const prefix = `refs/remotes/${remote}/`
    const target = refs.get(`${prefix}HEAD`)
    if (target?.startsWith(prefix) === true) return target.slice(prefix.length)
  }
  const localExists = (branch: string): boolean => branch !== '' && refs.has(`refs/heads/${branch}`)
  const configured = await query(['config', 'init.defaultBranch'])
  if (configured.code === 0) {
    const name = configured.stdout.toString('utf8').trim()
    if (localExists(name)) return name
  }
  return ['main', 'master'].find(localExists)
}

/** Local and remote-tracking branches, and the default branch. A failed listing is reported in `error` next to whatever parsed. */
export async function listProjectGitBranches(root: string, trusted: boolean, run: GitRunner = runGitCommand): Promise<GitBranchList> {
  // Zed passes the patterns before `--format`.
  const listed = await run(root, ['for-each-ref', 'refs/heads/**/*', 'refs/remotes/**/*', `--format=${FORMAT}`], { trusted, stdin: 'ignore' })
  let branches = parseBranchRecords(listed.stdout.toString('utf8'))
  const error = listed.code === 0 ? undefined : listed.stderr.toString('utf8').trim() || `git for-each-ref exited with code ${listed.code}`
  if (branches.length === 0) {
    // An unborn branch has no ref yet; HEAD still names it.
    const head = await run(root, ['symbolic-ref', '--quiet', 'HEAD'], { trusted, stdin: 'ignore' })
    const ref = head.code === 0 ? head.stdout.toString('utf8').trim() : ''
    if (ref.startsWith('refs/heads/')) branches = [{ name: ref.slice('refs/heads/'.length), remote: false, current: true }]
  }
  const defaultBranch = await defaultBranchOf(root, trusted, run)
  return { branches, ...(defaultBranch === undefined ? {} : { defaultBranch }), ...(error === undefined ? {} : { error }) }
}

const exists = async (ctx: Context, ref: string): Promise<boolean> => (await git(ctx, ['show-ref', '--verify', '--quiet', ref])).ok

/** Check out a local branch, or a remote one through a (new or re-pointed) tracking branch. */
export async function switchBranch(ctx: Context, name: string): Promise<Step> {
  if (name.startsWith('-')) throw new ProjectGitError(`Branch '${name}' not found`)
  // The trailing `--` makes the name a revision, never a path.
  if (await exists(ctx, `refs/heads/${name}`)) return git(ctx, ['checkout', name, '--'])
  if (await exists(ctx, `refs/remotes/${name}`)) {
    // A remote symref such as `origin/HEAD` follows to the branch it points at.
    const resolved = await git(ctx, ['symbolic-ref', `refs/remotes/${name}`])
    const target = resolved.ok ? resolved.stdout.trim() : ''
    const full = target.startsWith('refs/remotes/') ? target.slice('refs/remotes/'.length) : name
    const slash = full.indexOf('/')
    if (slash <= 0) throw new ProjectGitError(`Unexpected branch format: ${full}`)
    // The local name is whatever the REMOTE calls its branch: a hostile remote
    // can publish `-D`, so it passes the same check as a name typed by the user.
    const branch = await checkedBranch(ctx, full.slice(slash + 1))
    const link = (await exists(ctx, `refs/heads/${branch}`))
      ? ['branch', '--set-upstream-to', full, branch]
      : ['branch', '--track', branch, full]
    return sequence(() => git(ctx, link), () => git(ctx, ['checkout', branch, '--']))
  }
  throw new ProjectGitError(`Branch '${name}' not found`)
}

/** `git switch -c`, optionally from an existing local or remote-tracking branch. */
export async function createBranch(ctx: Context, name: string, base?: string): Promise<Step> {
  const checked = await checkedBranch(ctx, name)
  if (base !== undefined && base !== '') {
    if (base.startsWith('-') || !((await exists(ctx, `refs/heads/${base}`)) || (await exists(ctx, `refs/remotes/${base}`)))) {
      throw new ProjectGitError(`'${base}' is not a branch`)
    }
    return git(ctx, ['switch', '-c', checked, base])
  }
  return git(ctx, ['switch', '-c', checked])
}

/** `git branch -d|-D`, with `-r` for a remote-tracking branch. */
export async function deleteBranch(ctx: Context, name: string, remote: boolean, force: boolean): Promise<Step> {
  if (name === '' || name.startsWith('-') || !(await exists(ctx, `${remote ? 'refs/remotes/' : 'refs/heads/'}${name}`))) {
    throw new ProjectGitError(`Branch '${name}' not found`)
  }
  return git(ctx, ['branch', `-${force ? 'D' : 'd'}${remote ? 'r' : ''}`, name])
}
