/**
 * Branches for the Git panel, against real repositories: the for-each-ref
 * list, the default branch, and switch / create / delete (Zed `change_branch`,
 * `create_branch`, `delete_branch`).
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitExecutable, runGitCommand, type GitRunner } from '../../src/web/project-git.ts'
import { listProjectGitBranches, parseBranchRecords } from '../../src/web/project-git-branches.ts'
import { runProjectGitOperation, type GitOperationRequest } from '../../src/web/project-git-ops.ts'

let scratch = ''
let home = ''
const saved: Record<string, string | undefined> = {}
let counter = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitExecutable() as string, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-branches-')))
  home = path.join(scratch, 'home')
  await fs.mkdir(home)
  // A hermetic login shell: the project environment is loaded from this HOME.
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

function operate(repo: Repo, request: GitOperationRequest, options: { run?: GitRunner } = {}) {
  return runProjectGitOperation(repo.dir, true, request, undefined, options.run === undefined ? {} : { run: options.run })
}

/** A runner that records every git argument list it is asked to run, then runs it. */
function spy(): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: (root, args, options) => { calls.push([...args]); return runGitCommand(root, args, options) } }
}

describe('branch list', () => {
  it('parses for-each-ref records', () => {
    const rec = (head: string, ref: string, up: string, time: string, subject: string) =>
      [head, 'sha', '', ref, up, '', time, 'me', subject].join('\0')
    const out = [rec('*', 'refs/heads/main', 'refs/remotes/origin/main', '200', 'tip'),
      rec(' ', 'refs/remotes/origin/main', '', '200', 'tip'),
      rec(' ', 'refs/remotes/origin/HEAD', '', '200', 'tip'),
      rec(' ', 'refs/heads/old', '', '100', 'old')].join('\n')
    expect(parseBranchRecords(out)).toEqual([
      { name: 'main', remote: false, current: true, upstream: 'origin/main', unixTime: 200, subject: 'tip' },
      { name: 'origin/main', remote: true, current: false, unixTime: 200, subject: 'tip' },
      { name: 'old', remote: false, current: false, unixTime: 100, subject: 'old' },
    ])
  })

  it('lists branches and the default branch of a real repo', async () => {
    const repo = await makeRepo(); const bare = addRemote(repo, 'origin')
    repo.git('push', '-q', '-u', 'origin', 'main'); repo.git('remote', 'set-head', 'origin', 'main')
    repo.git('branch', 'feature')
    const list = await listProjectGitBranches(repo.dir, true)
    expect(list.branches.map((b) => b.name).sort()).toEqual(['feature', 'main', 'origin/main'])
    expect(list.defaultBranch).toBe('main'); void bare
    expect(list.error).toBeUndefined()
  })

  it('prefers the upstream remote HEAD over origin HEAD', async () => {
    const repo = await makeRepo()
    for (const [remote, branch] of [['origin', 'main'], ['upstream', 'dev']] as const) {
      repo.git('update-ref', `refs/remotes/${remote}/${branch}`, 'HEAD')
      repo.git('symbolic-ref', `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`)
    }
    expect((await listProjectGitBranches(repo.dir, true)).defaultBranch).toBe('dev')
  })

  it('without a remote HEAD falls back to init.defaultBranch, main, master, then nothing', async () => {
    const repo = await makeRepo()
    expect((await listProjectGitBranches(repo.dir, true)).defaultBranch).toBe('main')
    repo.git('branch', 'trunk'); repo.git('config', 'init.defaultBranch', 'trunk')
    expect((await listProjectGitBranches(repo.dir, true)).defaultBranch).toBe('trunk')
    repo.git('config', 'init.defaultBranch', 'absent')
    expect((await listProjectGitBranches(repo.dir, true)).defaultBranch).toBe('main')
    repo.git('branch', '-m', 'main', 'master')
    expect((await listProjectGitBranches(repo.dir, true)).defaultBranch).toBe('master')
    repo.git('branch', '-m', 'master', 'other'); repo.git('branch', '-D', 'trunk')
    expect((await listProjectGitBranches(repo.dir, true)).defaultBranch).toBeUndefined()
  })

  it('reports a failed listing in error and keeps what parsed', async () => {
    const repo = await makeRepo()
    const failing: GitRunner = async (root, args, options) => {
      const result = await runGitCommand(root, args, options)
      return args.some((a) => a.startsWith('--format=%(HEAD)')) ? { ...result, code: 128, stderr: Buffer.from('fatal: broken ref\n') } : result
    }
    const list = await listProjectGitBranches(repo.dir, true, failing)
    expect(list.error).toBe('fatal: broken ref')
    expect(list.branches.map((b) => b.name)).toEqual(['main'])
  })
})

describe('switch branch', () => {
  it('switches to a local branch with checkout', async () => {
    const repo = await makeRepo(); repo.git('branch', 'feature'); const { run, calls } = spy()
    const done = await operate(repo, { type: 'switch-branch', name: 'feature' }, { run })
    expect(done.ok).toBe(true); expect(done.status.branch).toBe('feature')
    expect(calls).toContainEqual(['checkout', 'feature'])
  })

  it('switches to a remote branch by creating a tracking branch', async () => {
    const repo = await makeRepo(); addRemote(repo, 'origin')
    repo.git('push', '-q', 'origin', 'main:topic'); repo.git('fetch', '-q', 'origin'); const { run, calls } = spy()
    const done = await operate(repo, { type: 'switch-branch', name: 'origin/topic' }, { run })
    expect(done.ok).toBe(true); expect(done.status.branch).toBe('topic')
    expect(calls).toContainEqual(['branch', '--track', 'topic', 'origin/topic'])
    expect(done.status.branchInfo?.upstream).toEqual({ remote: 'origin', branch: 'topic' })
  })

  it('re-points an existing local branch when switching to its remote twin', async () => {
    const repo = await makeRepo(); addRemote(repo, 'origin')
    repo.git('push', '-q', 'origin', 'main:topic'); repo.git('fetch', '-q', 'origin'); repo.git('branch', 'topic')
    const { run, calls } = spy()
    const done = await operate(repo, { type: 'switch-branch', name: 'origin/topic' }, { run })
    expect(done.ok).toBe(true); expect(done.status.branch).toBe('topic')
    expect(calls).toContainEqual(['branch', '--set-upstream-to', 'origin/topic', 'topic'])
  })

  it('follows a remote symref such as origin/HEAD to its target', async () => {
    const repo = await makeRepo(); addRemote(repo, 'origin')
    repo.git('push', '-q', 'origin', 'main:topic'); repo.git('fetch', '-q', 'origin'); repo.git('remote', 'set-head', 'origin', 'topic')
    const { run, calls } = spy()
    const done = await operate(repo, { type: 'switch-branch', name: 'origin/HEAD' }, { run })
    expect(done.ok).toBe(true); expect(done.status.branch).toBe('topic')
    expect(calls).toContainEqual(['branch', '--track', 'topic', 'origin/topic'])
  })

  it('refuses a remote ref without a remote name', async () => {
    const repo = await makeRepo(); repo.git('update-ref', 'refs/remotes/weird', 'HEAD')
    await expect(operate(repo, { type: 'switch-branch', name: 'weird' })).rejects.toThrow('Unexpected branch format: weird')
  })

  it('refuses an unknown branch', async () => {
    const repo = await makeRepo()
    await expect(operate(repo, { type: 'switch-branch', name: 'nope' })).rejects.toThrow("Branch 'nope' not found")
  })
})

describe('create branch', () => {
  it('creates and switches with switch -c, optionally from a base', async () => {
    const repo = await makeRepo(); repo.git('branch', 'base'); const { run, calls } = spy()
    expect((await operate(repo, { type: 'create-branch', name: 'new' }, { run })).status.branch).toBe('new')
    expect(calls).toContainEqual(['switch', '-c', 'new'])
    await operate(repo, { type: 'create-branch', name: 'new2', base: 'base' }, { run })
    expect(calls).toContainEqual(['switch', '-c', 'new2', 'base'])
  })

  it('refuses option-like or invalid names', async () => {
    const repo = await makeRepo()
    await expect(operate(repo, { type: 'create-branch', name: '-f' })).rejects.toThrow(/not a valid branch name/)
    await expect(operate(repo, { type: 'create-branch', name: 'a b' })).rejects.toThrow(/not a valid branch name/)
    await expect(operate(repo, { type: 'create-branch', name: 'x', base: '--orphan' })).rejects.toThrow(/not a branch/)
  })
})

describe('delete branch', () => {
  it('deletes merged branches and reports unmerged ones', async () => {
    const repo = await makeRepo(); repo.git('branch', 'merged')
    repo.git('switch', '-q', '-c', 'side'); await repo.write('s.txt', 's\n'); repo.git('add', '.'); repo.git('commit', '-qm', 's'); repo.git('switch', '-q', 'main')
    expect((await operate(repo, { type: 'delete-branch', name: 'merged', remote: false, force: false })).ok).toBe(true)
    const refused = await operate(repo, { type: 'delete-branch', name: 'side', remote: false, force: false })
    expect(refused.ok).toBe(false); expect(refused.stderr).toMatch(/not fully merged/)
    const { run, calls } = spy()
    expect((await operate(repo, { type: 'delete-branch', name: 'side', remote: false, force: true }, { run })).ok).toBe(true)
    expect(calls).toContainEqual(['branch', '-D', 'side'])
  })

  it('deletes a remote-tracking branch with -dr', async () => {
    const repo = await makeRepo(); addRemote(repo, 'origin')
    repo.git('push', '-q', 'origin', 'main:topic'); repo.git('fetch', '-q', 'origin'); const { run, calls } = spy()
    expect((await operate(repo, { type: 'delete-branch', name: 'origin/topic', remote: true, force: false }, { run })).ok).toBe(true)
    expect(calls).toContainEqual(['branch', '-dr', 'origin/topic'])
    expect(repo.git('branch', '-r')).not.toMatch(/origin\/topic/)
  })
})
