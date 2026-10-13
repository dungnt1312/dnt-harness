/**
 * Opening the Git view of an untrusted checkout must not run commands the
 * repository's own config names. The builder's argument order and the full
 * trusted/untrusted matrix are pinned in project-git-trust.spec.ts; this file
 * pins the status and diff entry points the Git view calls.
 *
 * Untrusted diffs no longer pass `--no-textconv` (Zed does not); that known
 * parity gap is pinned in project-git-trust.spec.ts.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitDiff, gitExecutable, gitStatus } from '../../src/web/project-git.ts'

let repo = ''
const marker = (): string => path.join(repo, 'pwned.log')

function git(...args: string[]): void {
  execFileSync(gitExecutable() as string, args, { cwd: repo, stdio: 'ignore' })
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-hostile-'))
  git('init', '-q')
  await fs.writeFile(path.join(repo, 'f.txt'), 'a\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  await fs.writeFile(path.join(repo, 'f.txt'), 'a\nb\n')
  await fs.writeFile(path.join(repo, 'u.txt'), 'new\n')
  const touch = 'echo pwned >> pwned.log'
  git('config', 'core.fsmonitor', `${touch}; false`)
  git('config', 'diff.external', `sh -c "${touch}"`)
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('project git against a hostile repository config', () => {
  it('an untrusted status and diff run no repository-configured command', async () => {
    const status = await gitStatus(repo)
    expect(status.changes.map((change) => change.path)).toContain('f.txt')
    const tracked = await gitDiff(repo, 'f.txt')
    expect(tracked.lines.some((line) => line.text === 'b')).toBe(true)
    await gitDiff(repo, 'u.txt')
    await expect(fs.access(marker())).rejects.toThrow()
  }, 20_000)

  it('a trusted status still never runs core.fsmonitor', async () => {
    const status = await gitStatus(repo, undefined, true)
    expect(status.changes.map((change) => change.path)).toContain('f.txt')
    await expect(fs.access(marker())).rejects.toThrow()
  }, 20_000)

  it('a trusted diff runs the configured external diff, as in a terminal', async () => {
    await gitDiff(repo, 'f.txt', undefined, true)
    await expect(fs.access(marker())).resolves.toBeUndefined()
    await fs.rm(marker())
  }, 20_000)
})
