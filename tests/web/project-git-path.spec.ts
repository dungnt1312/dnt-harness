/**
 * Which `git` the project environment's `PATH` selects: only an executable
 * regular file in an absolute directory counts (as `findGpgProgram` in
 * git-askpass.ts), never one the server's working directory would decide.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildGitCommand, gitExecutable } from '../../src/web/project-git.ts'

let scratch = ''
let marker = ''

/** A `git` that leaves a marker file instead of running anything. */
async function fakeGit(dir: string, mode: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'git'), `#!/bin/sh\ntouch '${marker}'\necho fake\n`, { mode })
}

async function version(pathValue: string): Promise<string> {
  const child = await buildGitCommand(scratch, ['--version'], { trusted: true, stdin: 'ignore', env: { PATH: pathValue } })
  const out: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.resume()
  await new Promise((resolve) => child.on('close', resolve))
  return Buffer.concat(out).toString('utf8')
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-path-')))
  marker = path.join(scratch, 'fake-git-ran')
})

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('git on the project PATH', () => {
  const realDir = (): string => path.dirname(gitExecutable() as string)

  it('skips a relative PATH entry holding a git, even one reachable from the working directory', async () => {
    const dir = path.join(scratch, 'relative-bin')
    await fakeGit(dir, 0o755)
    const relative = path.relative(process.cwd(), dir)
    expect(path.isAbsolute(relative)).toBe(false)
    const output = await version([relative, realDir()].join(path.delimiter))
    expect(output).toContain('git version')
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('skips an absolute git that is not executable, and a directory named git', async () => {
    await fakeGit(path.join(scratch, 'plain-bin'), 0o644)
    await fs.mkdir(path.join(scratch, 'dir-bin', 'git'), { recursive: true })
    const output = await version([path.join(scratch, 'plain-bin'), path.join(scratch, 'dir-bin'), realDir()].join(path.delimiter))
    expect(output).toContain('git version')
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still takes an executable git from an absolute entry, first one wins', async () => {
    await fakeGit(path.join(scratch, 'good-bin'), 0o755)
    const output = await version([path.join(scratch, 'good-bin'), realDir()].join(path.delimiter))
    expect(output.trim()).toBe('fake')
    await fs.stat(marker)
  })
})
