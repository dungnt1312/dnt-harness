/**
 * The login shell is detected once per server, not once per git command: on
 * macOS an unset `$SHELL` makes the detector spawn `dscl`.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const detect = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../../src/capabilities/shell/detect.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/capabilities/shell/detect.ts')>()
  return {
    ...original,
    detectLoginShell: () => {
      detect.calls += 1
      return original.detectLoginShell()
    },
  }
})

import { gitExecutable, projectGitEnvironment, runGitQuery } from '../../src/web/project-git.ts'

let scratch = ''
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-shell-memo-')))
  const home = path.join(scratch, 'home')
  await fs.mkdir(home)
  for (const key of ['HOME', 'SHELL']) saved[key] = process.env[key]
  process.env['HOME'] = home
  process.env['SHELL'] = '/bin/bash'
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('login shell detection', () => {
  it('runs once across several git commands and several project folders', async () => {
    const repos: string[] = []
    for (const name of ['one', 'two']) {
      const dir = path.join(scratch, name)
      await fs.mkdir(dir)
      execFileSync(gitExecutable() as string, ['init', '-q'], { cwd: dir, stdio: 'ignore' })
      repos.push(dir)
    }
    detect.calls = 0
    for (const repo of repos) {
      await runGitQuery(repo, ['status', '--porcelain=v1'], false)
      await runGitQuery(repo, ['rev-parse', '--show-toplevel'], true)
      await projectGitEnvironment(repo)
    }
    expect(detect.calls).toBe(1)
    await runGitQuery(repos[0] as string, ['status'], false)
    expect(detect.calls).toBe(1)
  }, 60_000)
})
