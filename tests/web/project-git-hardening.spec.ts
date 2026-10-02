/**
 * Opening the Git view of an untrusted checkout must not run commands the
 * repository's own config or attributes name.
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
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt diff=evil\n')
  const touch = 'echo pwned >> pwned.log'
  git('config', 'core.fsmonitor', `${touch}; false`)
  git('config', 'diff.external', `sh -c "${touch}"`)
  git('config', 'diff.evil.textconv', `sh -c '${touch}; cat "$1"' --`)
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('project git against a hostile repository config', () => {
  it('status and diff run no repository-configured command', async () => {
    const status = await gitStatus(repo)
    expect(status.changes.map((change) => change.path)).toContain('f.txt')
    const tracked = await gitDiff(repo, 'f.txt')
    expect(tracked.lines.some((line) => line.text === 'b')).toBe(true)
    await gitDiff(repo, 'u.txt')
    await expect(fs.access(marker())).rejects.toThrow()
  }, 20_000)
})
