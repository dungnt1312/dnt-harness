/**
 * Branch, upstream and per-file status as the Git panel reads them: the Zed
 * status model (`git/src/status.rs:144-203`) over real repository states.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  classifyStatus,
  gitExecutable,
  gitStatus,
  parseAheadBehind,
  parseUpstreamTrack,
  type GitStatusReport,
} from '../../src/web/project-git.ts'

describe('porcelain branch header ahead/behind', () => {
  it('parses ahead, behind, both, and none', () => {
    expect(parseAheadBehind('## main...origin/main')).toEqual({})
    expect(parseAheadBehind('## main...origin/main [ahead 1]')).toEqual({ ahead: 1 })
    expect(parseAheadBehind('## main...origin/main [behind 2]')).toEqual({ behind: 2 })
    expect(parseAheadBehind('## main...origin/main [ahead 3, behind 4]')).toEqual({ ahead: 3, behind: 4 })
    expect(parseAheadBehind('## main (no upstream)')).toEqual({})
  })
})

describe('upstream tracking', () => {
  it('reads for-each-ref %(upstream:track)', () => {
    expect(parseUpstreamTrack('')).toEqual({ kind: 'tracked', ahead: 0, behind: 0 })
    expect(parseUpstreamTrack('[ahead 1]')).toEqual({ kind: 'tracked', ahead: 1, behind: 0 })
    expect(parseUpstreamTrack('[behind 2]')).toEqual({ kind: 'tracked', ahead: 0, behind: 2 })
    expect(parseUpstreamTrack('[ahead 1, behind 2]')).toEqual({ kind: 'tracked', ahead: 1, behind: 2 })
    expect(parseUpstreamTrack('[gone]')).toEqual({ kind: 'gone' })
  })
})

describe('classifyStatus (Zed FileStatus)', () => {
  it('derives staging, created, deleted and conflicted from the XY code', () => {
    const table: [string, Record<string, unknown>][] = [
      ['??', { status: 'untracked', staging: 'unstaged', created: true, deleted: false, conflicted: false }],
      ['A ', { status: 'added', staging: 'staged', created: true, deleted: false, conflicted: false }],
      ['AM', { status: 'modified', staging: 'partial', created: true, deleted: false, conflicted: false }],
      ['M ', { status: 'modified', staging: 'staged', created: false, deleted: false, conflicted: false }],
      [' M', { status: 'modified', staging: 'unstaged', created: false, deleted: false, conflicted: false }],
      ['MM', { status: 'modified', staging: 'partial', created: false, deleted: false, conflicted: false }],
      ['D ', { status: 'deleted', staging: 'staged', created: false, deleted: true, conflicted: false }],
      [' D', { status: 'deleted', staging: 'unstaged', created: false, deleted: true, conflicted: false }],
      ['MD', { status: 'deleted', staging: 'partial', created: false, deleted: true, conflicted: false }],
      // Deleted in the index and re-added in the worktree is not a deletion.
      ['DA', { created: true, deleted: false }],
      ['T ', { staging: 'staged', created: false, deleted: false }],
      ['UU', { status: 'conflict', staging: 'unstaged', created: false, deleted: false, conflicted: true }],
      ['AA', { status: 'conflict', staging: 'unstaged', conflicted: true }],
      ['DD', { status: 'conflict', staging: 'unstaged', conflicted: true }],
      ['DU', { status: 'conflict', conflicted: true }],
      ['UD', { status: 'conflict', conflicted: true }],
      ['AU', { status: 'conflict', conflicted: true }],
      ['UA', { status: 'conflict', conflicted: true }],
    ]
    for (const [code, expected] of table) expect(classifyStatus(code), code).toMatchObject(expected)
  })
})

let scratch = ''
let repo = ''
let remote = ''
let report: GitStatusReport

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitExecutable() as string, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-status-')))
  remote = path.join(scratch, 'remote.git')
  repo = path.join(scratch, 'repo')
  await fs.mkdir(repo)
  git(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'remote', 'add', 'origin', remote)
  const write = (name: string, body: string): Promise<void> => fs.writeFile(path.join(repo, name), body)
  await write('staged.txt', 'one\n')
  await write('partial.txt', 'one\n')
  await write('gone.txt', 'one\n')
  await write('unstaged.txt', 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'push', '-q', '-u', 'origin', 'main')

  // Behind by two: two commits pushed from a second clone.
  const other = path.join(scratch, 'other')
  git(scratch, 'clone', '-q', remote, other)
  git(other, 'config', 'user.email', 't@t')
  git(other, 'config', 'user.name', 't')
  for (const n of [1, 2]) {
    await fs.writeFile(path.join(other, `remote-${n}.txt`), `${n}\n`)
    git(other, 'add', '.')
    git(other, 'commit', '-qm', `remote ${n}`)
  }
  git(other, 'push', '-q')
  git(repo, 'fetch', '-q')

  // Ahead by one, with a message that is the head subject.
  await write('local.txt', 'local\n')
  git(repo, 'add', 'local.txt')
  git(repo, 'commit', '-qm', 'latest')

  // The states the panel has to tell apart.
  await write('staged.txt', 'two\n')
  git(repo, 'add', 'staged.txt')
  await write('partial.txt', 'two\n')
  git(repo, 'add', 'partial.txt')
  await write('partial.txt', 'three\n')
  await write('unstaged.txt', 'two\n')
  await fs.rm(path.join(repo, 'gone.txt'))
  await write('untracked.txt', 'new\n')
  await write('with space.txt', 'new\n')
  await write('added.txt', 'new\n')
  git(repo, 'add', 'added.txt')
  await fs.mkdir(path.join(repo, 'dir'))
  await write('dir/nested.txt', 'new\n')

  report = await gitStatus(repo)
})

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('gitStatus over real repository states', () => {
  const change = (file: string) => {
    const found = report.changes.find((entry) => entry.path === file)
    if (found === undefined) throw new Error(`no change for ${file}: ${report.changes.map((entry) => entry.path).join(', ')}`)
    return found
  }

  it('reports the Zed staging and created flags and the raw codes', () => {
    expect(change('staged.txt')).toMatchObject({ staging: 'staged', created: false, indexStatus: 'M', worktreeStatus: ' ', status: 'modified' })
    expect(change('partial.txt')).toMatchObject({ staging: 'partial', created: false, indexStatus: 'M', worktreeStatus: 'M' })
    expect(change('unstaged.txt')).toMatchObject({ staging: 'unstaged', created: false, indexStatus: ' ', worktreeStatus: 'M' })
    expect(change('untracked.txt')).toMatchObject({ staging: 'unstaged', created: true, status: 'untracked', indexStatus: '?', worktreeStatus: '?' })
    expect(change('added.txt')).toMatchObject({ staging: 'staged', created: true, status: 'added' })
    expect(change('gone.txt')).toMatchObject({ staging: 'unstaged', deleted: true, status: 'deleted' })
  })

  it('lists untracked files one by one, including spaces and nested directories', () => {
    expect(report.changes.map((entry) => entry.path)).toEqual(expect.arrayContaining(['with space.txt', 'dir/nested.txt']))
    expect(report.changes.map((entry) => entry.path)).not.toContain('dir/')
  })

  it('reports the branch with its upstream and tracking', () => {
    expect(report.branchInfo).toMatchObject({
      name: 'main',
      upstream: { remote: 'origin', branch: 'main' },
      upstreamTrack: { kind: 'tracked', ahead: 1, behind: 2 },
    })
  })

  it('keeps the top-level branch a plain string for existing consumers', () => {
    expect(report.branch).toBe('main')
  })

  it('keeps top-level ahead and behind for the Environment panel', () => {
    expect(report.ahead).toBe(1)
    expect(report.behind).toBe(2)
  })

  it('reports the latest commit', () => {
    expect(report.head).toMatchObject({ subject: 'latest', hasParent: true })
    expect(report.head?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reports the full message of the latest commit, body included', async () => {
    expect(report.head?.message).toBe('latest')
    const multi = path.join(scratch, 'multi')
    await fs.mkdir(multi)
    git(multi, 'init', '-q', '-b', 'main')
    git(multi, 'config', 'user.email', 't@t')
    git(multi, 'config', 'user.name', 't')
    await fs.writeFile(path.join(multi, 'x.txt'), 'x\n')
    git(multi, 'add', '.')
    git(multi, 'commit', '-q', '-m', 'subject line', '-m', 'body line one\nbody line two')
    expect((await gitStatus(multi)).head).toMatchObject({ subject: 'subject line', message: 'subject line\n\nbody line one\nbody line two' })
  })

  it('keeps line counts against HEAD', () => {
    expect(change('unstaged.txt')).toMatchObject({ added: 1, removed: 1 })
  })

  it('a resolved conflict is an ordinary staged change, an unresolved one is a conflict', async () => {
    const conflict = path.join(scratch, 'conflict')
    await fs.mkdir(conflict)
    git(conflict, 'init', '-q', '-b', 'main')
    git(conflict, 'config', 'user.email', 't@t')
    git(conflict, 'config', 'user.name', 't')
    await fs.writeFile(path.join(conflict, 'c.txt'), 'base\n')
    git(conflict, 'add', '.')
    git(conflict, 'commit', '-qm', 'base')
    git(conflict, 'checkout', '-q', '-b', 'side')
    await fs.writeFile(path.join(conflict, 'c.txt'), 'side\n')
    git(conflict, 'commit', '-qam', 'side')
    git(conflict, 'checkout', '-q', 'main')
    await fs.writeFile(path.join(conflict, 'c.txt'), 'main\n')
    git(conflict, 'commit', '-qam', 'main')
    try { git(conflict, 'merge', 'side') } catch { /* the conflict is the point */ }

    const during = await gitStatus(conflict)
    expect(during.changes.find((entry) => entry.path === 'c.txt')).toMatchObject({ status: 'conflict', conflicted: true, staging: 'unstaged' })

    await fs.writeFile(path.join(conflict, 'c.txt'), 'resolved\n')
    git(conflict, 'add', 'c.txt')
    const resolved = await gitStatus(conflict)
    expect(resolved.changes.find((entry) => entry.path === 'c.txt')).toMatchObject({ conflicted: false, staging: 'staged' })
  })

  it('reports gone, none and detached upstreams', async () => {
    const lonely = path.join(scratch, 'lonely')
    await fs.mkdir(lonely)
    git(lonely, 'init', '-q', '-b', 'main')
    git(lonely, 'config', 'user.email', 't@t')
    git(lonely, 'config', 'user.name', 't')
    expect((await gitStatus(lonely)).head).toBeNull()
    expect((await gitStatus(lonely)).branchInfo).toMatchObject({ name: 'main', upstreamTrack: { kind: 'none' } })
    expect((await gitStatus(lonely)).branch).toBe('main')
    await fs.writeFile(path.join(lonely, 'x.txt'), 'x\n')
    git(lonely, 'add', '.')
    git(lonely, 'commit', '-qm', 'root')
    expect((await gitStatus(lonely)).head).toMatchObject({ subject: 'root', hasParent: false })
    expect((await gitStatus(lonely)).ahead).toBeUndefined()

    git(lonely, 'remote', 'add', 'origin', remote)
    git(lonely, 'branch', '-q', 'topic')
    git(lonely, 'config', 'branch.topic.remote', 'origin')
    git(lonely, 'config', 'branch.topic.merge', 'refs/heads/deleted-upstream')
    git(lonely, 'update-ref', 'refs/remotes/origin/deleted-upstream', 'HEAD')
    git(lonely, 'checkout', '-q', 'topic')
    git(lonely, 'update-ref', '-d', 'refs/remotes/origin/deleted-upstream')
    expect((await gitStatus(lonely)).branchInfo).toMatchObject({ name: 'topic', upstreamTrack: { kind: 'gone' } })
    expect((await gitStatus(lonely)).branch).toBe('topic')

    git(lonely, 'checkout', '-q', '--detach')
    const detached = await gitStatus(lonely)
    expect(detached.branch).toBeNull()
    expect(detached.branchInfo).toBeNull()
    expect(detached.head).toMatchObject({ subject: 'root' })
  })

  it('a folder that is not a repository is an empty report', async () => {
    const plain = await fs.mkdtemp(path.join(scratch, 'plain-'))
    expect(await gitStatus(plain)).toEqual({ branch: null, branchInfo: null, head: null, changes: [], truncated: false })
  })
})
