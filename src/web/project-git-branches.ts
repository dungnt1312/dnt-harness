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
import { ProjectGitError, runGitQuery } from './project-git.ts'
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

/** Local and remote-tracking branches, and the remote's default branch when `HEAD` of `upstream`/`origin` is known. */
export async function listProjectGitBranches(root: string, trusted: boolean): Promise<GitBranchList> {
  // Zed passes the patterns before `--format`.
  const listed = await runGitQuery(root, ['for-each-ref', 'refs/heads/**/*', 'refs/remotes/**/*', `--format=${FORMAT}`], trusted)
  let branches = listed.code === 0 ? parseBranchRecords(listed.stdout.toString('utf8')) : []
  if (branches.length === 0) {
    // An unborn branch has no ref yet; HEAD still names it.
    const head = await runGitQuery(root, ['symbolic-ref', '--quiet', 'HEAD'], trusted)
    const ref = head.code === 0 ? head.stdout.toString('utf8').trim() : ''
    if (ref.startsWith('refs/heads/')) branches = [{ name: ref.slice('refs/heads/'.length), remote: false, current: true }]
  }
  const defaults = await runGitQuery(
    root,
    ['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/remotes/upstream/HEAD', 'refs/remotes/origin/HEAD'],
    trusted,
  )
  let defaultBranch: string | undefined
  if (defaults.code === 0) {
    for (const line of defaults.stdout.toString('utf8').split('\n')) {
      const [refname = '', symref = ''] = line.split('\t')
      const remote = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(refname)?.[1]
      if (remote === undefined || symref === '') continue
      defaultBranch = symref.replace(`refs/remotes/${remote}/`, '')
      break
    }
  }
  return { branches, ...(defaultBranch === undefined ? {} : { defaultBranch }) }
}

const exists = async (ctx: Context, ref: string): Promise<boolean> => (await git(ctx, ['show-ref', '--verify', '--quiet', ref])).ok

/** Check out a local branch, or a remote one through a (new or re-pointed) tracking branch. */
export async function switchBranch(ctx: Context, name: string): Promise<Step> {
  if (name.startsWith('-')) throw new ProjectGitError(`Branch '${name}' not found`)
  if (await exists(ctx, `refs/heads/${name}`)) return git(ctx, ['checkout', name])
  if (await exists(ctx, `refs/remotes/${name}`)) {
    const slash = name.indexOf('/')
    const remote = name.slice(0, slash)
    const branch = name.slice(slash + 1)
    const link = (await exists(ctx, `refs/heads/${branch}`))
      ? ['branch', '--set-upstream-to', `${remote}/${branch}`, branch]
      : ['branch', '--track', branch, `${remote}/${branch}`]
    return sequence(() => git(ctx, link), () => git(ctx, ['checkout', branch]))
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
