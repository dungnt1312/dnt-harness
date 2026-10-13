/**
 * Conflicts and merge state, against real repositories: parsing conflict
 * markers (two-way and diff3), the ours/theirs/both rewrites, `MERGE_MSG`
 * / merge-head detection in the status, and the Add-to-.gitignore operation.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitDiff, gitExecutable, gitStatus, runGitCommand, type GitRunner } from '../../src/web/project-git.ts'
import { parseConflicts, resolveConflict, resolveConflictText } from '../../src/web/project-git-conflicts.ts'
import { runProjectGitOperation, type GitOperationRequest } from '../../src/web/project-git-ops.ts'

const STALE = 'The file changed since the diff was shown. Refresh and try again.'
const TWO_WAY = 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nz\n'
const DIFF3 = 'a\n<<<<<<< ours\nmine\n||||||| base\norig\n=======\ntheirs\n>>>>>>> theirs\nz\n'

let scratch = ''
let home = ''
const saved: Record<string, string | undefined> = {}
let counter = 0

function git(cwd: string, args: readonly string[], opts: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(gitExecutable() as string, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (opts.allowFailure === true) return ''
    throw error
  }
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-conflicts-')))
  home = path.join(scratch, 'home')
  await fs.mkdir(home)
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
  readonly read: (name: string) => Promise<string>
  readonly git: (...args: string[]) => string
}

async function makeRepo(label = 'repo'): Promise<Repo> {
  counter += 1
  const dir = path.join(scratch, `${label}-${counter}`)
  await fs.mkdir(dir)
  const run = (...args: string[]): string => git(dir, args)
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  const write = async (name: string, body: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), body)
  }
  return { dir, write, read: (name) => fs.readFile(path.join(dir, name), 'utf8'), git: run }
}

const operate = (repo: Repo, request: GitOperationRequest, options: { run?: GitRunner } = {}) =>
  runProjectGitOperation(repo.dir, true, request, undefined, options.run === undefined ? {} : { run: options.run })

/** A repository whose merge of `feature` into `main` conflicts over `f.txt`. */
async function conflictedRepo(): Promise<Repo> {
  const repo = await makeRepo('merge')
  await repo.write('f.txt', 'x\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'base')
  repo.git('switch', '-q', '-c', 'feature'); await repo.write('f.txt', 'feature\n')
  repo.git('commit', '-qam', 'feature')
  repo.git('switch', '-q', 'main'); await repo.write('f.txt', 'main\n')
  repo.git('commit', '-qam', 'main')
  git(repo.dir, ['merge', 'feature'], { allowFailure: true })
  return repo
}

describe('pure parsing', () => {
  it('parses two-way and diff3 conflicts', () => {
    expect(parseConflicts(TWO_WAY)).toMatchObject([{ index: 0, startLine: 2, endLine: 6, ours: 'mine\n', theirs: 'theirs\n', oursName: 'HEAD', theirsName: 'feature' }])
    expect(parseConflicts(DIFF3)[0]).toMatchObject({ ours: 'mine\n', theirs: 'theirs\n', oursName: 'ours', theirsName: 'theirs' })
    expect(parseConflicts('<<<<<<<\nx\n=======\ny\n>>>>>>>\n')[0]).toMatchObject({ oursName: 'HEAD', theirsName: 'Origin' })
  })

  it('resolves ours, theirs and both', () => {
    const [conflict] = parseConflicts(TWO_WAY)
    expect(resolveConflictText(TWO_WAY, conflict!, 'ours')).toBe('a\nmine\nz\n')
    expect(resolveConflictText(TWO_WAY, conflict!, 'theirs')).toBe('a\ntheirs\nz\n')
    expect(resolveConflictText(TWO_WAY, conflict!, 'both')).toBe('a\nmine\ntheirs\nz\n')
  })
})

describe('merge state in the status', () => {
  it('reports merge state, MERGE_MSG and conflicts of a real merge', async () => {
    const repo = await conflictedRepo()
    const status = await gitStatus(repo.dir, undefined, true)
    expect(status.mergeHeads).toBe(true)
    expect(status.mergeMessage).toMatch(/^Merge branch 'feature'/)
    const diff = await gitDiff(repo.dir, 'f.txt', undefined, true)
    expect(diff.conflicts).toHaveLength(1)
    expect(diff.hunks).toEqual([])
    const done = await operate(repo, { type: 'resolve-conflict', path: 'f.txt', index: 0, fingerprint: (diff.conflicts ?? [])[0]!.fingerprint, choice: 'theirs' })
    expect(done.ok).toBe(true)
    expect(await fs.readFile(path.join(repo.dir, 'f.txt'), 'utf8')).toBe('feature\n')
    // Zed edits the buffer only: the file stays conflicted until it is staged.
    expect(done.status.changes.find((change) => change.path === 'f.txt')?.conflicted).toBe(true)
  })

  it('refuses a stale conflict', async () => {
    const repo = await conflictedRepo()
    const diff = await gitDiff(repo.dir, 'f.txt', undefined, true)
    await fs.writeFile(path.join(repo.dir, 'f.txt'), 'a\n<<<<<<< HEAD\nother\n=======\nthing\n>>>>>>> feature\n')
    await expect(operate(repo, { type: 'resolve-conflict', path: 'f.txt', index: 0, fingerprint: (diff.conflicts ?? [])[0]!.fingerprint, choice: 'ours' })).rejects.toThrow(STALE)
  })

  it('a clean repo has no merge state', async () => {
    const repo = await makeRepo('clean')
    await repo.write('a.txt', 'a\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'a')
    const status = await gitStatus(repo.dir, undefined, true)
    expect(status.mergeHeads).toBe(false)
    expect(status.mergeMessage).toBeUndefined()
  })
})

describe('Add to .gitignore', () => {
  it('appends untracked paths to .gitignore, creating it when absent', async () => {
    const repo = await makeRepo('ignore')
    await repo.write('seed.txt', 'seed\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'seed')
    await repo.write('tmp/x.log', 'x\n')
    const done = await operate(repo, { type: 'ignore', paths: ['tmp/x.log'] })
    expect(done.ok).toBe(true)
    expect(await repo.read('.gitignore')).toBe('/tmp/x.log\n')
    expect(done.status.changes.find((change) => change.path === '.gitignore')?.created).toBe(true)
  })

  it('inserts a newline before appending to a file without one', async () => {
    const repo = await makeRepo('ignore2')
    await repo.write('seed.txt', 'seed\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'seed')
    await repo.write('.gitignore', '/built') // no final newline
    await repo.write('tmp/y.log', 'y\n')
    const done = await operate(repo, { type: 'ignore', paths: ['tmp/y.log'] })
    expect(done.ok).toBe(true)
    expect(await repo.read('.gitignore')).toBe('/built\n/tmp/y.log\n')
  })

  it('refuses a tracked path', async () => {
    const repo = await makeRepo('ignore3')
    await repo.write('seed.txt', 'seed\n'); repo.git('add', '.'); repo.git('commit', '-qm', 'seed')
    await expect(operate(repo, { type: 'ignore', paths: ['seed.txt'] })).rejects.toThrow("'seed.txt' is not an untracked file")
  })
})

describe('resolveConflict helper', () => {
  it('rewrites the file with the kept sides', async () => {
    const repo = await conflictedRepo()
    const text = await repo.read('f.txt')
    const [conflict] = parseConflicts(text)
    await resolveConflict(repo.dir, 'f.txt', conflict!.index, conflict!.fingerprint, 'both')
    // ours (main) then theirs (feature), with the markers gone.
    expect(await repo.read('f.txt')).toBe('main\nfeature\n')
    // and the index is untouched: staging is the user's next click.
    expect(repo.git('status', '--porcelain', '--', 'f.txt')).toBe('UU f.txt\n')
  })
})
