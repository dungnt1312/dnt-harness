/**
 * Repository operations for the Git panel, against real repositories: the
 * per-root queue, stage/unstage/discard/trash, commit and its hooks, remote
 * resolution and the push/pull/fetch commands (Zed `GitStore` jobs).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  gitExecutable,
  gitStatus,
  runGitCommand,
  type GitResult,
  type GitRunner,
} from '../../src/web/project-git.ts'
import {
  listProjectGitRemotes,
  pushedTo,
  runProjectGitOperation,
  trashInvocation,
  type GitOperationRequest,
} from '../../src/web/project-git-ops.ts'

let scratch = ''
let home = ''
const saved: Record<string, string | undefined> = {}
let counter = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitExecutable() as string, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-ops-')))
  home = path.join(scratch, 'home')
  await fs.mkdir(home)
  // A hermetic login shell, as in the trust spec: the project environment is
  // loaded from this HOME, never from the developer's own rc files.
  await fs.writeFile(path.join(home, '.bash_profile'), '')
  for (const key of ['HOME', 'SHELL']) saved[key] = process.env[key]
  process.env['HOME'] = home
  process.env['SHELL'] = '/bin/bash'
})

afterAll(async () => {
  for (const key of ['HOME', 'SHELL']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

interface Repo {
  readonly dir: string
  readonly write: (name: string, body: string) => Promise<void>
  readonly git: (...args: string[]) => string
}

/** A repository with one commit (`a.txt`) on `main`. */
async function makeRepo(label = 'repo'): Promise<Repo> {
  counter += 1
  const dir = path.join(scratch, `${label}-${counter}`)
  await fs.mkdir(dir)
  const run = (...args: string[]): string => git(dir, ...args)
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  const write = async (name: string, body: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), body)
  }
  await write('a.txt', 'a\n')
  run('add', '.')
  run('commit', '-qm', 'init')
  return { dir, write, git: run }
}

/** A bare remote called `name` added to `repo`. */
function addRemote(repo: Repo, name: string): string {
  const bare = path.join(scratch, `${name}-${counter}-${Math.random().toString(36).slice(2, 8)}.git`)
  git(scratch, 'init', '-q', '--bare', '-b', 'main', bare)
  repo.git('remote', 'add', name, bare)
  return bare
}

function operate(
  repo: Repo,
  request: GitOperationRequest,
  options: { trusted?: boolean; run?: GitRunner; trashPath?: (abs: string) => Promise<void> } = {},
) {
  return runProjectGitOperation(repo.dir, options.trusted ?? true, request, undefined, {
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.trashPath === undefined ? {} : { trashPath: options.trashPath }),
  })
}

/** A runner that records every git argument list it is asked to run, then runs it. */
function spy(): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: (root, args, options) => { calls.push([...args]); return runGitCommand(root, args, options) } }
}

const statusOf = (repo: Repo) => gitStatus(repo.dir, undefined, true)
const changeOf = async (repo: Repo, file: string) => (await statusOf(repo)).changes.find((change) => change.path === file)

describe('stage and unstage', () => {
  it('stages and unstages a path, with the exact commands', async () => {
    const repo = await makeRepo()
    await repo.write('a.txt', 'changed\n')
    const { run, calls } = spy()
    const staged = await operate(repo, { type: 'stage', paths: ['a.txt'] }, { run })
    expect(staged.ok).toBe(true)
    expect(calls[0]).toEqual(['update-index', '--add', '--remove', '--', 'a.txt'])
    expect((await changeOf(repo, 'a.txt'))?.staging).toBe('staged')
    expect(staged.status.changes.find((change) => change.path === 'a.txt')?.staging).toBe('staged')

    const unstaged = await operate(repo, { type: 'unstage', paths: ['a.txt'] }, { run })
    expect(unstaged.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'reset')).toEqual(['reset', '--quiet', '--', 'a.txt'])
    expect((await changeOf(repo, 'a.txt'))?.staging).toBe('unstaged')
  })

  it('stage-all and unstage-all enumerate the entries that need it', async () => {
    const repo = await makeRepo()
    await repo.write('b.txt', 'b\n')
    await repo.write('c.txt', 'c\n')
    await repo.write('a.txt', 'changed\n')
    repo.git('add', 'b.txt')
    const { run, calls } = spy()
    await operate(repo, { type: 'stage-all' }, { run })
    // b.txt was already fully staged, so it is not named again.
    expect(calls.find((args) => args[0] === 'update-index')).toEqual(['update-index', '--add', '--remove', '--', 'a.txt', 'c.txt'])
    expect((await statusOf(repo)).changes.every((change) => change.staging === 'staged')).toBe(true)
    await operate(repo, { type: 'unstage-all' }, { run })
    expect((await statusOf(repo)).changes.every((change) => change.staging === 'unstaged')).toBe(true)
  })

  it('stages a path named -rf, one with spaces and one with a newline as paths', async () => {
    const repo = await makeRepo()
    for (const name of ['-rf', 'a b.txt', 'line\nbreak.txt', '*.txt']) await repo.write(name, 'x\n')
    const result = await operate(repo, { type: 'stage', paths: ['-rf', 'a b.txt', 'line\nbreak.txt', '*.txt'] })
    expect(result.ok).toBe(true)
    const staged = (await statusOf(repo)).changes.filter((change) => change.staging === 'staged').map((change) => change.path)
    expect(staged.sort()).toEqual(['*.txt', '-rf', 'a b.txt', 'line\nbreak.txt'].sort())
    await operate(repo, { type: 'unstage', paths: ['-rf'] })
    expect((await changeOf(repo, '-rf'))?.staging).toBe('unstaged')
  })

  it('treats a glob-looking path as a literal name', async () => {
    const repo = await makeRepo()
    await repo.write('a.txt', 'changed\n')
    await repo.write('*.txt', 'star\n')
    repo.git('add', '.')
    await operate(repo, { type: 'unstage', paths: ['*.txt'] })
    expect((await changeOf(repo, 'a.txt'))?.staging).toBe('staged')
    expect((await changeOf(repo, '*.txt'))?.staging).toBe('unstaged')
  })

  it('refuses a path outside the project without running git', async () => {
    const repo = await makeRepo()
    const { run, calls } = spy()
    await expect(operate(repo, { type: 'stage', paths: ['../outside.txt'] }, { run })).rejects.toThrow(/inside this project/)
    await expect(operate(repo, { type: 'stage', paths: ['/etc/passwd'] }, { run })).rejects.toThrow(/inside this project/)
    expect(calls.some((args) => args[0] === 'update-index')).toBe(false)
  })

  it('returns Git\'s index.lock error unchanged', async () => {
    const repo = await makeRepo()
    await repo.write('b.txt', 'b\n')
    await fs.writeFile(path.join(repo.dir, '.git', 'index.lock'), '')
    const result = await operate(repo, { type: 'stage', paths: ['b.txt'] })
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('index.lock')
    expect(result.stderr).toContain('File exists')
    await fs.rm(path.join(repo.dir, '.git', 'index.lock'))
    expect((await operate(repo, { type: 'stage', paths: ['b.txt'] })).ok).toBe(true)
  })
})

describe('serial queue', () => {
  /** A runner that only pretends: it records the interval each update-index spans. */
  function slow(intervals: { root: string; start: number; end: number }[], fail = false): GitRunner {
    let first = true
    return async (root, args, options): Promise<GitResult> => {
      if (args[0] !== 'update-index') return runGitCommand(root, args, options)
      const start = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 80))
      intervals.push({ root, start, end: performance.now() })
      if (fail && first) { first = false; throw new Error('boom') }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
    }
  }

  it('never overlaps two operations on one root but overlaps different roots', async () => {
    const one = await makeRepo()
    const two = await makeRepo()
    await one.write('b.txt', 'b\n')
    await two.write('b.txt', 'b\n')
    const intervals: { root: string; start: number; end: number }[] = []
    const run = slow(intervals)
    await Promise.all([
      operate(one, { type: 'stage', paths: ['a.txt'] }, { run }),
      operate(one, { type: 'stage', paths: ['b.txt'] }, { run }),
    ])
    const same = intervals.filter((interval) => interval.root === one.dir)
    expect(same).toHaveLength(2)
    expect(same[1]!.start).toBeGreaterThanOrEqual(same[0]!.end)

    intervals.length = 0
    await Promise.all([
      operate(one, { type: 'stage', paths: ['a.txt'] }, { run }),
      operate(two, { type: 'stage', paths: ['b.txt'] }, { run }),
    ])
    expect(intervals).toHaveLength(2)
    const [first, second] = intervals as [typeof intervals[number], typeof intervals[number]]
    expect(Math.min(first.end, second.end)).toBeGreaterThan(Math.max(first.start, second.start))
  })

  it('queues through a symlinked path to the same real root', async () => {
    const repo = await makeRepo()
    const link = path.join(scratch, `link-${counter}`)
    await fs.symlink(repo.dir, link)
    await repo.write('b.txt', 'b\n')
    const intervals: { root: string; start: number; end: number }[] = []
    const run = slow(intervals)
    await Promise.all([
      runProjectGitOperation(repo.dir, true, { type: 'stage', paths: ['a.txt'] }, undefined, { run }),
      runProjectGitOperation(link, true, { type: 'stage', paths: ['b.txt'] }, undefined, { run }),
    ])
    expect(intervals).toHaveLength(2)
    expect(intervals[1]!.start).toBeGreaterThanOrEqual(intervals[0]!.end)
  })

  it('a failed job does not poison the next one', async () => {
    const repo = await makeRepo()
    await repo.write('b.txt', 'b\n')
    const run = slow([], true)
    const failing = operate(repo, { type: 'stage', paths: ['a.txt'] }, { run })
    const next = operate(repo, { type: 'stage', paths: ['b.txt'] }, { run })
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toMatchObject({ ok: true })
  })
})

describe('discard and trash', () => {
  async function fixture() {
    const repo = await makeRepo()
    await repo.write('.gitignore', '*.log\n')
    await repo.write('a b.txt', 'one\n')
    await repo.write('del.txt', 'one\n')
    await repo.write('staged-mod.txt', 'one\n')
    repo.git('add', '.')
    repo.git('commit', '-qm', 'base')
    await repo.write('a b.txt', 'two\n')
    await fs.rm(path.join(repo.dir, 'del.txt'))
    await repo.write('staged-mod.txt', 'two\n')
    repo.git('add', 'staged-mod.txt')
    await repo.write('staged-new.txt', 'new\n')
    repo.git('add', 'staged-new.txt')
    await repo.write('-rf', 'untracked\n')
    await repo.write('ignored.log', 'ignored\n')
    return repo
  }

  it('unstages staged entries, then checks tracked entries out from HEAD', async () => {
    const repo = await fixture()
    const { run, calls } = spy()
    const result = await operate(repo, { type: 'discard', paths: ['a b.txt', 'del.txt', 'staged-mod.txt', 'staged-new.txt'] }, { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'reset')).toEqual(['reset', '--quiet', '--', 'staged-mod.txt', 'staged-new.txt'])
    expect(calls.find((args) => args[0] === 'checkout')).toEqual(['checkout', 'HEAD', '--', 'a b.txt', 'del.txt', 'staged-mod.txt'])
    expect(await fs.readFile(path.join(repo.dir, 'a b.txt'), 'utf8')).toBe('one\n')
    expect(await fs.readFile(path.join(repo.dir, 'del.txt'), 'utf8')).toBe('one\n')
    expect(await fs.readFile(path.join(repo.dir, 'staged-mod.txt'), 'utf8')).toBe('one\n')
    // The staged-added file has no HEAD copy: it is unstaged and kept, ready to trash.
    expect(existsSync(path.join(repo.dir, 'staged-new.txt'))).toBe(true)
    const paths = result.status.changes.map((change) => [change.path, change.staging, change.created])
    expect(paths).toContainEqual(['staged-new.txt', 'unstaged', true])
    expect(result.status.changes.some((change) => change.path === 'a b.txt')).toBe(false)
    expect(result.status.changes.some((change) => change.path === 'del.txt')).toBe(false)
  })

  it('moves untracked files to the trash, recoverably, and leaves ignored and tracked files alone', async () => {
    const repo = await fixture()
    const bin = path.join(scratch, `trash-${counter}`)
    await fs.mkdir(bin)
    const moved: string[] = []
    const trashPath = async (abs: string): Promise<void> => {
      moved.push(abs)
      await fs.rename(abs, path.join(bin, path.basename(abs)))
    }
    const result = await operate(repo, { type: 'trash', paths: ['-rf', 'staged-new.txt', 'ignored.log', 'a b.txt'] }, { trashPath })
    expect(result.ok).toBe(true)
    expect(moved.sort()).toEqual([path.join(repo.dir, '-rf'), path.join(repo.dir, 'staged-new.txt')].sort())
    expect(existsSync(path.join(repo.dir, '-rf'))).toBe(false)
    expect(await fs.readFile(path.join(bin, '-rf'), 'utf8')).toBe('untracked\n')
    expect(existsSync(path.join(repo.dir, 'ignored.log'))).toBe(true)
    expect(existsSync(path.join(repo.dir, 'a b.txt'))).toBe(true)
    // The staged-added entry left no index entry behind.
    expect(result.status.changes.some((change) => change.path === 'staged-new.txt')).toBe(false)
    expect(repo.git('ls-files', '--', 'staged-new.txt')).toBe('')
  })

  it('reports a trash failure as a failed operation', async () => {
    const repo = await fixture()
    const result = await operate(repo, { type: 'trash', paths: ['-rf'] }, { trashPath: () => Promise.reject(new Error('no trash here')) })
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain("could not move '-rf' to the trash: no trash here")
    expect(existsSync(path.join(repo.dir, '-rf'))).toBe(true)
  })
})

describe('operations beyond the 500-entry panel cap', () => {
  const COUNT = 520
  const name = (index: number, ext: string): string => `f${String(index).padStart(4, '0')}.${ext}`
  /** Write COUNT files into `repo` in one go. */
  const writeMany = (repo: Repo, ext: string, body: string): Promise<unknown> =>
    Promise.all(Array.from({ length: COUNT }, (_, index) => repo.write(name(index, ext), body)))
  const stagedCount = (repo: Repo): number => repo.git('diff', '--cached', '--name-only').split('\n').filter(Boolean).length

  it('the panel status is capped but stage-all and unstage-all cover every entry', async () => {
    const repo = await makeRepo()
    await writeMany(repo, 'txt', 'new\n')
    const capped = await statusOf(repo)
    expect(capped.truncated).toBe(true)
    expect(capped.changes).toHaveLength(500)

    const staged = await operate(repo, { type: 'stage-all' })
    expect(staged.ok).toBe(true)
    expect(stagedCount(repo)).toBe(COUNT)
    expect(repo.git('status', '--porcelain', '--untracked-files=all')).not.toContain('??')

    const unstaged = await operate(repo, { type: 'unstage-all' })
    expect(unstaged.ok).toBe(true)
    expect(stagedCount(repo)).toBe(0)
  })

  it('Commit Tracked commits every tracked change, not the first 500', async () => {
    const repo = await makeRepo()
    await writeMany(repo, 'txt', 'one\n')
    repo.git('add', '.')
    repo.git('commit', '-qm', 'many')
    await writeMany(repo, 'txt', 'two\n')
    await repo.write('untracked.txt', 'u\n')
    const result = await operate(repo, { type: 'commit', message: 'tracked', amend: false, signoff: false, noVerify: true, tracked: true })
    expect(result.ok).toBe(true)
    expect(repo.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toHaveLength(COUNT)
    expect(repo.git('status', '--porcelain', '--untracked-files=all').trim()).toBe('?? untracked.txt')
  })

  it('discards and trashes an explicitly requested path that sorts after the 500th entry', async () => {
    const repo = await makeRepo()
    await writeMany(repo, 'txt', 'one\n')
    repo.git('add', '.')
    repo.git('commit', '-qm', 'many')
    await writeMany(repo, 'txt', 'two\n')
    await writeMany(repo, 'new', 'new\n')
    const last = name(COUNT - 1, 'txt')
    const lastNew = name(COUNT - 1, 'new')
    expect((await statusOf(repo)).changes.some((change) => change.path === last || change.path === lastNew)).toBe(false)

    const discarded = await operate(repo, { type: 'discard', paths: [last] })
    expect(discarded.ok).toBe(true)
    expect(await fs.readFile(path.join(repo.dir, last), 'utf8')).toBe('one\n')

    const bin = path.join(scratch, `trash-many-${counter}`)
    await fs.mkdir(bin)
    const moved: string[] = []
    const trashPath = async (abs: string): Promise<void> => {
      moved.push(abs)
      await fs.rename(abs, path.join(bin, path.basename(abs)))
    }
    const trashed = await operate(repo, { type: 'trash', paths: [lastNew] }, { trashPath })
    expect(trashed.ok).toBe(true)
    expect(moved).toEqual([path.join(repo.dir, lastNew)])
    expect(existsSync(path.join(repo.dir, lastNew))).toBe(false)
    expect(existsSync(path.join(bin, lastNew))).toBe(true)
  })
})

describe('OS trash invocation', () => {
  it('passes the path as one argument on every platform', () => {
    const abs = "/tmp/it's $(touch pwned) \"x\".txt"
    expect(trashInvocation(abs, 'darwin', true)).toEqual({ file: '/usr/bin/trash', args: [abs] })
    const finder = trashInvocation(abs, 'darwin', false)
    expect(finder.file).toBe('osascript')
    expect(finder.args.at(-1)).toBe(abs)
    expect(finder.args.slice(0, -1).join(' ')).not.toContain('pwned')
    expect(trashInvocation(abs, 'linux')).toEqual({ file: 'gio', args: ['trash', abs] })
    const windows = trashInvocation(abs, 'win32')
    expect(windows.file).toBe('powershell.exe')
    expect(windows.env).toEqual({ DNT_TRASH_PATH: abs })
    expect(windows.args.join(' ')).toContain('SendToRecycleBin')
    expect(windows.args.join(' ')).not.toContain('pwned')
  })
})

describe('commit, amend, signoff, skip hooks, uncommit', () => {
  async function hooked() {
    const repo = await makeRepo()
    const hooks = path.join(repo.dir, '.git', 'hooks')
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "pre-commit refuses" >&2\nexit 1\n', { mode: 0o755 })
    await fs.writeFile(path.join(hooks, 'commit-msg'), `#!/bin/sh\ntouch '${path.join(repo.dir, '.git', 'commit-msg-ran')}'\n`, { mode: 0o755 })
    return repo
  }
  const commitRequest = (message: string, over: Partial<Extract<GitOperationRequest, { type: 'commit' }>> = {}): GitOperationRequest =>
    ({ type: 'commit', message, amend: false, signoff: false, noVerify: false, tracked: false, ...over })

  it('runs hooks unless skipped, signs off and amends', async () => {
    const repo = await hooked()
    await repo.write('a.txt', 'changed\n')
    repo.git('add', 'a.txt')

    const blocked = await operate(repo, commitRequest('first'))
    expect(blocked.ok).toBe(false)
    expect(blocked.stderr).toContain('pre-commit refuses')
    expect(repo.git('log', '-1', '--format=%s')).toBe('init\n')

    const { run, calls } = spy()
    const skipped = await operate(repo, commitRequest('first', { noVerify: true, signoff: true }), { run })
    expect(skipped.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'commit')).toEqual(['commit', '--quiet', '-m', 'first', '--cleanup=strip', '--signoff', '--no-verify'])
    expect(repo.git('log', '-1', '--format=%B')).toContain('Signed-off-by: t <t@t>')
    expect(existsSync(path.join(repo.dir, '.git', 'commit-msg-ran'))).toBe(false)
    expect(skipped.status.head?.subject).toBe('first')

    const before = repo.git('rev-list', '--count', 'HEAD')
    const amended = await operate(repo, commitRequest('reworded', { amend: true, noVerify: true }), { run })
    expect(amended.ok).toBe(true)
    expect(calls.filter((args) => args[0] === 'commit').at(-1)).toContain('--amend')
    expect(repo.git('log', '-1', '--format=%s')).toBe('reworded\n')
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe(before)
  })

  it('runs no hooks in an untrusted project', async () => {
    const repo = await hooked()
    await repo.write('a.txt', 'changed\n')
    repo.git('add', 'a.txt')
    const untrusted = await operate(repo, commitRequest('untrusted'), { trusted: false })
    expect(untrusted.ok).toBe(true)
    expect(existsSync(path.join(repo.dir, '.git', 'commit-msg-ran'))).toBe(false)
  })

  it('uncommit resets softly and keeps the changes staged', async () => {
    const repo = await makeRepo()
    await repo.write('a.txt', 'changed\n')
    repo.git('add', 'a.txt')
    repo.git('commit', '-qm', 'child')
    expect(await statusOf(repo)).toMatchObject({ head: { subject: 'child', hasParent: true } })
    const { run, calls } = spy()
    const result = await operate(repo, { type: 'uncommit' }, { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'reset')).toEqual(['reset', '--soft', 'HEAD^'])
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('init')
    expect(repo.git('diff', '--cached', '--name-only')).toContain('a.txt')
    expect(result.status.head).toMatchObject({ subject: 'init', hasParent: false })
  })

  it('Commit Tracked stages tracked changes and leaves untracked files out', async () => {
    const repo = await makeRepo()
    await repo.write('b.txt', 'b\n')
    repo.git('add', 'b.txt')
    repo.git('commit', '-qm', 'second')
    await repo.write('a.txt', 'changed\n')
    await fs.rm(path.join(repo.dir, 'b.txt'))
    await repo.write('untracked.txt', 'u\n')
    const { run, calls } = spy()
    const result = await operate(repo, commitRequest('tracked', { tracked: true, noVerify: true }), { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'update-index')).toEqual(['update-index', '--add', '--remove', '--', 'a.txt', 'b.txt'])
    expect(repo.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'b.txt'])
    expect(result.status.changes.map((change) => change.path)).toEqual(['untracked.txt'])
  })
})

describe('remotes', () => {
  /** `repo` with `origin` set up and `main` pushed with upstream. */
  async function published() {
    const repo = await makeRepo()
    const origin = addRemote(repo, 'origin')
    repo.git('push', '-q', '-u', 'origin', 'main')
    return { repo, origin }
  }
  const push = (over: Partial<Extract<GitOperationRequest, { type: 'push' }>> = {}): GitOperationRequest =>
    ({ type: 'push', remote: 'origin', branch: 'main', upstreamBranch: 'main', setUpstream: false, force: false, ...over })

  it('push with no upstream sets it', async () => {
    const { repo } = await published()
    repo.git('switch', '-q', '-c', 'topic')
    expect((await statusOf(repo)).branchInfo?.upstreamTrack).toEqual({ kind: 'none' })
    const { run, calls } = spy()
    const result = await operate(repo, push({ branch: 'topic', upstreamBranch: 'topic', setUpstream: true }), { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'push')).toEqual(['push', '--set-upstream', 'origin', 'topic:topic'])
    expect(repo.git('rev-parse', '--abbrev-ref', 'topic@{upstream}').trim()).toBe('origin/topic')
    expect(result.status.branchInfo?.upstream).toEqual({ remote: 'origin', branch: 'topic' })
  })

  it('push republishes a branch whose upstream is gone', async () => {
    const { repo, origin } = await published()
    repo.git('switch', '-q', '-c', 'topic')
    repo.git('push', '-q', '-u', 'origin', 'topic')
    git(origin, 'branch', '-D', 'topic')
    repo.git('fetch', '-q', '--prune')
    expect((await statusOf(repo)).branchInfo?.upstreamTrack).toEqual({ kind: 'gone' })
    const { run, calls } = spy()
    const result = await operate(repo, push({ branch: 'topic', upstreamBranch: 'topic', setUpstream: true }), { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'push')).toEqual(['push', '--set-upstream', 'origin', 'topic:topic'])
    expect(git(origin, 'rev-parse', '--verify', 'topic')).toBe(repo.git('rev-parse', 'HEAD'))
    expect(result.status.branchInfo?.upstreamTrack).toEqual({ kind: 'tracked', ahead: 0, behind: 0 })
  })

  it('push to a tracked upstream uses the exact local:upstream refspec', async () => {
    const { repo, origin } = await published()
    repo.git('push', '-q', 'origin', 'main:other')
    repo.git('fetch', '-q')
    repo.git('switch', '-q', '-c', 'feat', '--track', 'origin/other')
    await repo.write('f.txt', 'f\n')
    repo.git('add', '.')
    repo.git('commit', '-qm', 'feat')
    const { run, calls } = spy()
    const result = await operate(repo, push({ branch: 'feat', upstreamBranch: 'other' }), { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'push')).toEqual(['push', 'origin', 'feat:other'])
    expect(git(origin, 'log', '-1', '--format=%s', 'other').trim()).toBe('feat')
  })

  it('Push To pushes to the supplied remote', async () => {
    const { repo } = await published()
    const backup = addRemote(repo, 'backup')
    const { run, calls } = spy()
    const result = await operate(repo, push({ remote: 'backup', setUpstream: true }), { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'push')).toEqual(['push', '--set-upstream', 'backup', 'main:main'])
    expect(git(backup, 'rev-parse', '--verify', 'main')).toBe(repo.git('rev-parse', 'HEAD'))
  })

  it('Force Push uses --force-with-lease and a plain push of rewritten history is refused', async () => {
    const { repo, origin } = await published()
    repo.git('commit', '-q', '--amend', '-m', 'rewritten')
    const plain = await operate(repo, push())
    expect(plain.ok).toBe(false)
    const { run, calls } = spy()
    const forced = await operate(repo, push({ force: true }), { run })
    expect(forced.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'push')).toEqual(['push', '--force-with-lease', 'origin', 'main:main'])
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('rewritten')
  })

  it('rejects a remote or branch that is not one, before running git', async () => {
    const { repo } = await published()
    const { run, calls } = spy()
    await expect(operate(repo, push({ remote: '--upload-pack=touch pwned' }), { run })).rejects.toThrow(/not a remote/)
    await expect(operate(repo, { type: 'fetch', remote: 'nonexistent' }, { run })).rejects.toThrow(/not a remote/)
    await expect(operate(repo, push({ branch: '--delete' }), { run })).rejects.toThrow(/not a valid branch/)
    await expect(operate(repo, { type: 'pull', remote: 'origin', branch: '-x', rebase: false }, { run })).rejects.toThrow(/not a valid branch/)
    expect(calls.some((args) => ['push', 'fetch', 'pull'].includes(args[0] ?? ''))).toBe(false)
  })

  it('can never force: a +-prefixed branch or upstream is refused when force is false', async () => {
    const { repo, origin } = await published()
    repo.git('commit', '-q', '--amend', '-m', 'rewritten')
    const remoteHead = git(origin, 'rev-parse', 'main')
    const { run, calls } = spy()
    await expect(operate(repo, push({ branch: '+main', upstreamBranch: 'main', force: false }), { run })).rejects.toThrow(/not a valid branch/)
    await expect(operate(repo, push({ branch: 'main', upstreamBranch: '+main', force: false }), { run })).rejects.toThrow(/not a valid branch/)
    await expect(operate(repo, push({ branch: '+main', upstreamBranch: '', force: false }), { run })).rejects.toThrow(/not a valid branch/)
    expect(calls.some((args) => args[0] === 'push')).toBe(false)
    expect(git(origin, 'rev-parse', 'main')).toBe(remoteHead)
    // Listing remotes goes through the same check.
    await expect(listProjectGitRemotes(repo.dir, true, '+main', true)).rejects.toThrow(/not a valid branch/)
  })

  it('pushes only a branch that exists under refs/heads', async () => {
    const { repo } = await published()
    repo.git('tag', 'v1')
    const { run, calls } = spy()
    await expect(operate(repo, push({ branch: 'v1', upstreamBranch: 'v1' }), { run })).rejects.toThrow(/not a local branch/)
    await expect(operate(repo, push({ branch: 'HEAD', upstreamBranch: 'main' }), { run })).rejects.toThrow(/not a local branch/)
    await expect(operate(repo, push({ branch: 'nonexistent', upstreamBranch: 'main' }), { run })).rejects.toThrow(/not a local branch/)
    expect(calls.some((args) => args[0] === 'push')).toBe(false)
  })

  /** Push one more commit to `origin` from a second clone; returns that clone. */
  async function ahead(origin: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 8)
    const other = path.join(scratch, `other-${counter}-${suffix}`)
    git(scratch, 'clone', '-q', origin, other)
    git(other, 'config', 'user.email', 't@t')
    git(other, 'config', 'user.name', 't')
    await fs.writeFile(path.join(other, `remote-${suffix}.txt`), 'r\n')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'from elsewhere')
    git(other, 'push', '-q')
    return other
  }

  it('Pull fast-forwards without --ff-only; Pull Rebase adds --rebase', async () => {
    const { repo, origin } = await published()
    await ahead(origin)
    const { run, calls } = spy()
    const pulled = await operate(repo, { type: 'pull', remote: 'origin', rebase: false }, { run })
    expect(pulled.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', 'origin'])
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('from elsewhere')

    // Diverge: one more commit upstream and one local.
    const other = await ahead(origin)
    await fs.writeFile(path.join(other, 'second.txt'), '2\n')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'second remote')
    git(other, 'push', '-q')
    await repo.write('local.txt', 'l\n')
    repo.git('add', '.')
    repo.git('commit', '-qm', 'local work')
    const rebased = await operate(repo, { type: 'pull', remote: 'origin', rebase: true }, { run })
    expect(rebased.ok).toBe(true)
    expect(calls.filter((args) => args[0] === 'pull').at(-1)).toEqual(['pull', '--rebase', 'origin'])
    expect(repo.git('log', '--merges', '--format=%s')).toBe('')
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('local work')
  })

  it('Pull names the branch when there is no upstream', async () => {
    const { repo } = await published()
    repo.git('switch', '-q', '-c', 'topic')
    repo.git('push', '-q', 'origin', 'topic')
    const { run, calls } = spy()
    const result = await operate(repo, { type: 'pull', remote: 'origin', branch: 'topic', rebase: false }, { run })
    expect(result.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', 'origin', 'topic'])
  })

  it('Fetch fetches every remote; Fetch From fetches one', async () => {
    const { repo, origin } = await published()
    const backup = addRemote(repo, 'backup')
    repo.git('push', '-q', 'backup', 'main')
    await ahead(origin)
    const { run, calls } = spy()
    const all = await operate(repo, { type: 'fetch-all' }, { run })
    expect(all.ok).toBe(true)
    expect(calls.find((args) => args[0] === 'fetch')).toEqual(['fetch', '--all'])
    expect(repo.git('rev-parse', '--verify', 'refs/remotes/backup/main')).toBe(git(backup, 'rev-parse', 'main'))
    expect((await statusOf(repo)).branchInfo?.upstreamTrack).toEqual({ kind: 'tracked', ahead: 0, behind: 1 })

    const from = await operate(repo, { type: 'fetch', remote: 'backup' }, { run })
    expect(from.ok).toBe(true)
    expect(calls.filter((args) => args[0] === 'fetch').at(-1)).toEqual(['fetch', 'backup'])
  })

  it('lists the remote a branch is bound to, else every remote once', async () => {
    const { repo } = await published()
    addRemote(repo, 'backup')
    expect(await listProjectGitRemotes(repo.dir, true, 'main', true)).toEqual(['origin'])
    expect(await listProjectGitRemotes(repo.dir, true, 'main', false)).toEqual(['origin'])
    repo.git('switch', '-q', '-c', 'topic')
    expect((await listProjectGitRemotes(repo.dir, true, 'topic', true)).sort()).toEqual(['backup', 'origin'])
    expect((await listProjectGitRemotes(repo.dir, true, 'topic', false)).sort()).toEqual(['backup', 'origin'])
    await expect(listProjectGitRemotes(repo.dir, true, '--all', true)).rejects.toThrow(/not a valid branch/)
  })

  it('pushedTo lists remote refs containing HEAD without origin/HEAD', async () => {
    const { repo } = await published()
    repo.git('remote', 'set-head', 'origin', 'main')
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/remotes/')).toContain('refs/remotes/origin/HEAD')
    expect(await pushedTo(repo.dir, true)).toEqual(['refs/remotes/origin/main'])
    await repo.write('later.txt', 'l\n')
    repo.git('add', '.')
    repo.git('commit', '-qm', 'not pushed')
    expect(await pushedTo(repo.dir, true)).toEqual([])
  })
})
