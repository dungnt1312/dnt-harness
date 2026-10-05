/**
 * The diff of a file git has no HEAD record for — a freshly written,
 * never-staged one — must show as all additions, while an unchanged tracked
 * file must stay an empty diff rather than look like a new file.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitDiff, gitExecutable } from '../../src/web/project-git.ts'

let repo = ''

function git(...args: string[]): void {
  execFileSync(gitExecutable() as string, args, { cwd: repo, stdio: 'ignore' })
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-diff-'))
  git('init', '-q')
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'a\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('gitDiff of a file without a HEAD record', () => {
  it('an untracked file diffs as all additions against the empty device', async () => {
    await fs.writeFile(path.join(repo, 'new.txt'), 'hello\nworld\n')
    const diff = await gitDiff(repo, 'new.txt')
    expect(diff.binary).toBe(false)
    expect(diff.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'meta:--- /dev/null',
      'meta:+++ b/new.txt',
      'hunk:@@ -0,0 +1,2 @@',
      'add:hello',
      'add:world',
    ])
  })

  it('a nested untracked file diffs under its project-relative path', async () => {
    await fs.mkdir(path.join(repo, 'deep/dir'), { recursive: true })
    await fs.writeFile(path.join(repo, 'deep/dir/new.txt'), 'x\n')
    const diff = await gitDiff(repo, 'deep/dir/new.txt')
    expect(diff.lines.some((line) => line.kind === 'add' && line.text === 'x')).toBe(true)
  })

  it('a staged file in a repository with no commit yet diffs against the empty state', async () => {
    await fs.writeFile(path.join(repo, 'first.txt'), 'seed\n')
    git('add', '.')
    const diff = await gitDiff(repo, 'first.txt')
    expect(diff.lines.some((line) => line.kind === 'add' && line.text === 'seed')).toBe(true)
    git('reset', '-q')
  })

  it('an unchanged tracked file is an empty diff, not a fake new file', async () => {
    const diff = await gitDiff(repo, 'tracked.txt')
    expect(diff.binary).toBe(false)
    expect(diff.lines).toEqual([])
  })

  it('a modified tracked file still shows both sides', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'b\n')
    const diff = await gitDiff(repo, 'tracked.txt')
    expect(diff.lines.some((line) => line.kind === 'del' && line.text === 'a')).toBe(true)
    expect(diff.lines.some((line) => line.kind === 'add' && line.text === 'b')).toBe(true)
  })
})
