/**
 * Hunks of one file's diff, against real repositories: the staged / unstaged /
 * partial status of each displayed hunk, and stage / unstage / restore of one
 * hunk through the index (Zed `stage_hunks`, `unstage_hunks`, `set_index_text`).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitDiff, gitExecutable, runGitCommand, type GitRunner } from '../../src/web/project-git.ts'
import {
  hunkFingerprint,
  hunkStatus,
  matchHunk,
  parseHunks,
  rangeOf,
  rangesOverlap,
  replaceLines,
  type GitHunkRef,
} from '../../src/web/project-git-hunks.ts'
import { runProjectGitOperation, type GitOperationRequest } from '../../src/web/project-git-ops.ts'

const STALE = 'The file changed since the diff was shown. Refresh and try again.'

let scratch = ''
let home = ''
const saved: Record<string, string | undefined> = {}
let counter = 0

function git(cwd: string, args: readonly string[], input?: Buffer | string): string {
  return execFileSync(gitExecutable() as string, args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-hunks-')))
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
  readonly write: (name: string, body: string | Buffer) => Promise<void>
  readonly read: (name: string) => Promise<string>
  readonly git: (...args: string[]) => string
  /** Put `body` into the index for `name` without touching the worktree (test setup only). */
  readonly stageText: (name: string, body: string) => void
}

/** An empty repository on `main`, no commit yet. */
async function makeRepo(): Promise<Repo> {
  counter += 1
  const dir = path.join(scratch, `repo-${counter}`)
  await fs.mkdir(dir)
  const run = (...args: string[]): string => git(dir, args)
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  return {
    dir,
    git: run,
    write: async (name, body) => {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await fs.writeFile(path.join(dir, name), body)
    },
    read: (name) => fs.readFile(path.join(dir, name), 'utf8'),
    stageText: (name, body) => {
      const sha = git(dir, ['hash-object', '-w', '--stdin'], body).trim()
      run('update-index', '--cacheinfo', `100644,${sha},${name}`)
    },
  }
}

/** `l1\n` … `l<n>\n`. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, index) => `l${index + 1}\n`).join('')
}

function operate(repo: Repo, request: GitOperationRequest, options: { run?: GitRunner } = {}) {
  return runProjectGitOperation(repo.dir, true, request, undefined, options.run === undefined ? {} : { run: options.run })
}

/** A runner that records every git argument list it is asked to run, then runs it. */
function spy(): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: (root, args, options) => { calls.push([...args]); return runGitCommand(root, args, options) } }
}

const statuses = async (repo: Repo, file = 'f.txt') => (await gitDiff(repo.dir, file, undefined, true)).hunks?.map((hunk) => hunk.status)

/** A committed 30-line `f.txt` with lines 3 and 20 edited in the worktree: two display hunks. */
async function twoHunks(): Promise<Repo> {
  const repo = await makeRepo()
  await repo.write('f.txt', lines(30)); repo.git('add', '.'); repo.git('commit', '-qm', 'f')
  await repo.write('f.txt', lines(30).replace('l3\n', 'L3\n').replace('l20\n', 'L20\n'))
  return repo
}

describe('pure helpers', () => {
  it('parses hunk headers, counts and marked lines', () => {
    expect(parseHunks('@@ -3 +3 @@\n-l3\n+L3\n')).toEqual([{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-l3', '+L3'] }])
    expect(parseHunks('@@ -0,0 +1,2 @@\n+a\n+b\n')).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }])
    const text = [
      'diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f',
      '@@ -1,3 +1,3 @@ ctx', ' a', '-b', '+B', ' c', '@@ -9,2 +9 @@', '-x', ' y', '\\ No newline at end of file', '',
    ].join('\n')
    expect(parseHunks(text)).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      { oldStart: 9, oldLines: 2, newStart: 9, newLines: 1, lines: ['-x', ' y'] },
    ])
  })

  it('fingerprints the -/+ lines only', () => {
    const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')
    expect(hunkFingerprint([' a', '-b', '+B', ' c'])).toBe(sha1('-b\n+B'))
  })

  it('maps git ranges to half-open intervals and overlaps them', () => {
    expect(rangeOf(5, 0)).toEqual([6, 6])
    expect(rangeOf(5, 2)).toEqual([5, 7])
    expect(rangesOverlap(rangeOf(5, 0), [6, 7])).toBe(true)
    expect(rangesOverlap(rangeOf(5, 0), [7, 8])).toBe(false)
    expect(rangesOverlap([1, 5], [5, 6])).toBe(false)
    expect(rangesOverlap([1, 5], [4, 6])).toBe(true)
    expect(rangesOverlap([1, 5], rangeOf(4, 0))).toBe(true)
    expect(rangesOverlap(rangeOf(0, 0), rangeOf(0, 0))).toBe(true)
  })

  it('derives the hunk status from the overlapping zero-context hunks', () => {
    const display = { oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, lines: [] }
    const at3 = { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: [] }
    const at20 = { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: [] }
    expect(hunkStatus(display, [at3], [])).toBe('unstaged')
    expect(hunkStatus(display, [at20], [at3])).toBe('staged')
    expect(hunkStatus(display, [at3], [at3])).toBe('partial')
  })

  it('replaces and inserts lines byte for byte', () => {
    expect(replaceLines(Buffer.from('a\nb\nc'), 2, 1, [Buffer.from('B\n')]).toString()).toBe('a\nB\nc')
    expect(replaceLines(Buffer.from('a\nb\nc'), 1, 0, [Buffer.from('x\n')]).toString()).toBe('a\nx\nb\nc')
    expect(replaceLines(Buffer.from('a\nb\nc'), 0, 0, [Buffer.from('x\n')]).toString()).toBe('x\na\nb\nc')
    expect(replaceLines(Buffer.from('a\r\nb\r\nc'), 3, 1, [Buffer.from('c\r\n'), Buffer.from('d')]).toString()).toBe('a\r\nb\r\nc\r\nd')
    expect(replaceLines(Buffer.from('a\nb\nc\n'), 2, 2, []).toString()).toBe('a\n')
  })
})

describe('hunk status in the diff', () => {
  it('offers no hunks for untracked, added, conflicted or binary files, or without HEAD', async () => {
    const repo = await makeRepo()
    await repo.write('seed.txt', 'seed\n'); repo.git('add', '.')
    expect((await gitDiff(repo.dir, 'seed.txt', undefined, true)).hunks).toEqual([])
    repo.git('commit', '-qm', 'seed')

    await repo.write('untracked.txt', 'u\n')
    expect((await gitDiff(repo.dir, 'untracked.txt', undefined, true)).hunks).toEqual([])
    await repo.write('added.txt', 'a\n'); repo.git('add', 'added.txt')
    expect((await gitDiff(repo.dir, 'added.txt', undefined, true)).hunks).toEqual([])

    await repo.write('bin.dat', Buffer.from([0, 1, 2, 0, 3]))
    await repo.write('c.txt', 'base\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'more')
    await repo.write('bin.dat', Buffer.from([0, 1, 9, 0, 3]))
    const binary = await gitDiff(repo.dir, 'bin.dat', undefined, true)
    expect(binary.binary).toBe(true); expect(binary.hunks).toEqual([])

    repo.git('switch', '-q', '-c', 'side'); await repo.write('c.txt', 'side\n'); repo.git('commit', '-qam', 'side')
    repo.git('switch', '-q', 'main'); await repo.write('c.txt', 'main\n'); repo.git('commit', '-qam', 'main')
    expect(() => repo.git('merge', '-q', 'side')).toThrow()
    expect(repo.git('status', '--porcelain', '--', 'c.txt')).toBe('UU c.txt\n')
    expect((await gitDiff(repo.dir, 'c.txt', undefined, true)).hunks).toEqual([])
  })

  it('marks a hunk partial when part of it is staged, then stages and unstages all of it', async () => {
    const repo = await makeRepo()
    await repo.write('f.txt', lines(30)); repo.git('add', '.'); repo.git('commit', '-qm', 'f')
    // One display hunk, two zero-context hunks that change the line count: line 3 becomes two lines, line 5 goes.
    const worktree = lines(30).replace('l3\n', 'L3a\nL3b\n').replace('l5\n', '')
    await repo.write('f.txt', worktree)
    expect(await statuses(repo)).toEqual(['unstaged'])
    repo.stageText('f.txt', lines(30).replace('l3\n', 'L3a\nL3b\n'))
    const partial = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect(partial.hunks?.map((hunk) => hunk.status)).toEqual(['partial'])

    const staged = await operate(repo, { type: 'stage-hunk', path: 'f.txt', hunk: partial.hunks?.[0]! })
    expect(staged.ok).toBe(true)
    expect(repo.git('show', ':f.txt')).toBe(worktree)
    expect(await statuses(repo)).toEqual(['staged'])

    const shown = (await gitDiff(repo.dir, 'f.txt', undefined, true)).hunks?.[0]!
    const unstaged = await operate(repo, { type: 'unstage-hunk', path: 'f.txt', hunk: shown })
    expect(unstaged.ok).toBe(true)
    expect(repo.git('show', ':f.txt')).toBe(lines(30))
    expect(await statuses(repo)).toEqual(['unstaged'])
    expect(await repo.read('f.txt')).toBe(worktree)
  })
})

describe('hunk operations', () => {
  it('reports two unstaged hunks, then one staged after stage-hunk', async () => {
    const repo = await twoHunks()
    const before = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect(before.hunks?.map((h) => h.status)).toEqual(['unstaged', 'unstaged'])
    const { run, calls } = spy()
    const done = await operate(repo, { type: 'stage-hunk', path: 'f.txt', hunk: before.hunks?.[0]! }, { run })
    expect(done.ok).toBe(true)
    expect(calls.some((a) => a[0] === 'hash-object' && a.includes('--stdin'))).toBe(true)
    expect(calls.some((a) => a[0] === 'update-index' && a[1] === '--add' && a[2] === '--cacheinfo')).toBe(true)
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('f.txt')
    expect(repo.git('show', ':f.txt')).toBe(lines(30).replace('l3\n', 'L3\n'))
    expect((await gitDiff(repo.dir, 'f.txt', undefined, true)).hunks?.map((h) => h.status)).toEqual(['staged', 'unstaged'])
    expect(done.status.changes.find((c) => c.path === 'f.txt')?.staging).toBe('partial')
  })

  it('unstages one staged hunk', async () => {
    const repo = await twoHunks()
    repo.git('add', 'f.txt')
    const before = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect(before.hunks?.map((h) => h.status)).toEqual(['staged', 'staged'])
    const done = await operate(repo, { type: 'unstage-hunk', path: 'f.txt', hunk: before.hunks?.[1]! })
    expect(done.ok).toBe(true)
    expect(repo.git('show', ':f.txt')).toBe(lines(30).replace('l3\n', 'L3\n'))
    expect(await repo.read('f.txt')).toBe(lines(30).replace('l3\n', 'L3\n').replace('l20\n', 'L20\n'))
    expect(await statuses(repo)).toEqual(['staged', 'unstaged'])
  })

  it('restores one hunk in the worktree and leaves the other', async () => {
    const repo = await twoHunks()
    const before = await gitDiff(repo.dir, 'f.txt', undefined, true)
    const done = await operate(repo, { type: 'restore-hunk', path: 'f.txt', hunk: before.hunks?.[0]! })
    expect(done.ok).toBe(true)
    expect(await repo.read('f.txt')).toBe(lines(30).replace('l20\n', 'L20\n'))
    expect(repo.git('diff', '--cached', '--name-only')).toBe('')
    expect(repo.git('show', ':f.txt')).toBe(lines(30))
    expect(await statuses(repo)).toEqual(['unstaged'])
  })

  it('restores a deleted file from HEAD', async () => {
    const repo = await makeRepo()
    await repo.write('f.txt', lines(3)); repo.git('add', '.'); repo.git('commit', '-qm', 'f')
    await fs.rm(path.join(repo.dir, 'f.txt'))
    const before = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect(before.hunks?.map((h) => h.status)).toEqual(['unstaged'])
    expect((await operate(repo, { type: 'restore-hunk', path: 'f.txt', hunk: before.hunks?.[0]! })).ok).toBe(true)
    expect(await repo.read('f.txt')).toBe(lines(3))
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('stages the deletion of a deleted file by removing it from the index', async () => {
    const repo = await makeRepo()
    await repo.write('f.txt', lines(3)); repo.git('add', '.'); repo.git('commit', '-qm', 'f')
    await fs.rm(path.join(repo.dir, 'f.txt'))
    const before = await gitDiff(repo.dir, 'f.txt', undefined, true)
    const done = await operate(repo, { type: 'stage-hunk', path: 'f.txt', hunk: before.hunks?.[0]! })
    expect(done.ok).toBe(true)
    expect(repo.git('status', '--porcelain')).toBe('D  f.txt\n')
  })

  it('refuses a stale hunk', async () => {
    const repo = await twoHunks()
    const old = (await gitDiff(repo.dir, 'f.txt', undefined, true)).hunks?.[0]!
    await repo.write('f.txt', lines(30).replace('l3\n', 'X3\n').replace('l20\n', 'L20\n'))
    await expect(operate(repo, { type: 'stage-hunk', path: 'f.txt', hunk: old })).rejects.toThrow(STALE)
    await expect(operate(repo, { type: 'restore-hunk', path: 'f.txt', hunk: old })).rejects.toThrow(STALE)
    expect(repo.git('show', ':f.txt')).toBe(lines(30))
    expect(await repo.read('f.txt')).toBe(lines(30).replace('l3\n', 'X3\n').replace('l20\n', 'L20\n'))
  })

  it('keeps CRLF and a missing final newline byte for byte', async () => {
    const repo = await makeRepo()
    await repo.write('f.txt', 'a\r\nb\r\nc'); repo.git('add', '.'); repo.git('commit', '-qm', 'f')
    await repo.write('f.txt', 'a\r\nB\r\nc')
    const first = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect((await operate(repo, { type: 'stage-hunk', path: 'f.txt', hunk: first.hunks?.[0]! })).ok).toBe(true)
    expect(repo.git('show', ':f.txt')).toBe('a\r\nB\r\nc')
    repo.git('commit', '-qm', 'B')

    // The last line gains a newline and a new unterminated line follows it.
    await repo.write('f.txt', 'a\r\nB\r\nc\r\nd')
    const second = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect((await operate(repo, { type: 'stage-hunk', path: 'f.txt', hunk: second.hunks?.[0]! })).ok).toBe(true)
    expect(repo.git('show', ':f.txt')).toBe('a\r\nB\r\nc\r\nd')
    const staged = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect((await operate(repo, { type: 'unstage-hunk', path: 'f.txt', hunk: staged.hunks?.[0]! })).ok).toBe(true)
    expect(repo.git('show', ':f.txt')).toBe('a\r\nB\r\nc')
    const again = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect((await operate(repo, { type: 'restore-hunk', path: 'f.txt', hunk: again.hunks?.[0]! })).ok).toBe(true)
    expect(await repo.read('f.txt')).toBe('a\r\nB\r\nc')
  })

  it('keeps the executable bit in the index', async () => {
    const repo = await makeRepo()
    await repo.write('run.sh', lines(30)); await fs.chmod(path.join(repo.dir, 'run.sh'), 0o755)
    repo.git('add', '.'); repo.git('commit', '-qm', 'run')
    expect(repo.git('ls-files', '-s', 'run.sh')).toMatch(/^100755 /)
    await repo.write('run.sh', lines(30).replace('l3\n', 'L3\n'))
    const before = await gitDiff(repo.dir, 'run.sh', undefined, true)
    expect((await operate(repo, { type: 'stage-hunk', path: 'run.sh', hunk: before.hunks?.[0]! })).ok).toBe(true)
    expect(repo.git('ls-files', '-s', 'run.sh')).toMatch(/^100755 /)
    expect(repo.git('show', ':run.sh')).toBe(lines(30).replace('l3\n', 'L3\n'))
  })

  it('works for a project rooted in a subdirectory of the repository', async () => {
    const repo = await makeRepo()
    await repo.write('sub/f.txt', lines(30)); repo.git('add', '.'); repo.git('commit', '-qm', 'f')
    await repo.write('sub/f.txt', lines(30).replace('l3\n', 'L3\n').replace('l20\n', 'L20\n'))
    const root = path.join(repo.dir, 'sub')
    const before = await gitDiff(root, 'f.txt', undefined, true)
    expect(before.hunks?.map((h) => h.status)).toEqual(['unstaged', 'unstaged'])
    expect((await runProjectGitOperation(root, true, { type: 'stage-hunk', path: 'f.txt', hunk: before.hunks?.[1]! })).ok).toBe(true)
    expect(repo.git('show', ':sub/f.txt')).toBe(lines(30).replace('l20\n', 'L20\n'))
    expect(repo.git('ls-files')).toBe('sub/f.txt\n')
  })
})
