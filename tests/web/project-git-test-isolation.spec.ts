import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitExecutable } from '../../src/web/project-git.ts'
import { credentialProbe, gitShellPath, isolatedGitEnvironment } from '../helpers/git-test-process.ts'

let scratch = ''
let emptyConfig = ''
let env: Record<string, string>

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dnt-git-isolation-'space ")))
  emptyConfig = path.join(scratch, 'empty.gitconfig')
  await fs.writeFile(emptyConfig, '')
  env = isolatedGitEnvironment(process.env, emptyConfig)
})

afterAll(async () => { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

describe('credential test isolation', () => {
  it('removes inherited command config and askpass without mutating the caller', () => {
    const base = { GIT_CONFIG_PARAMETERS: 'injected', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'helper-selector', Git_Config: 'developer.gitconfig', Git_Dir: 'developer/.git', GIT_WORK_TREE: 'developer', GIT_COMMON_DIR: 'developer/.git', GIT_INDEX_FILE: 'developer.index', GIT_OBJECT_DIRECTORY: 'developer/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'developer/objects', GIT_ASKPASS: 'popup', SSH_ASKPASS: 'popup', KEEP: 'yes' }
    const isolated = isolatedGitEnvironment(base, emptyConfig)
    expect(isolated).toMatchObject({ KEEP: 'yes', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' })
    for (const key of ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'Git_Config', 'Git_Dir', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) expect(isolated).not.toHaveProperty(key)
    expect(base.GIT_CONFIG_COUNT).toBe('1')
  })

  it('never executes helpers inherited from system or global config', async () => {
    const repo = path.join(scratch, 'repo')
    await fs.mkdir(repo)
    const marker = path.join(scratch, 'inherited-helper-ran')
    const config = path.join(scratch, 'developer.gitconfig')
    const helper = `!echo inherited > ${gitShellPath(marker)}`
    execFileSync(gitExecutable() as string, ['config', '--file', config, 'credential.helper', helper], { env, windowsHide: true })
    const isolated = isolatedGitEnvironment({ ...env, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config }, emptyConfig)
    execFileSync(gitExecutable() as string, ['init', '-q', repo], { env: isolated, windowsHide: true })
    expect((await credentialProbe(repo, true, isolated)).code).not.toBe(0)
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('kills a stalled helper and its child instead of leaving orphan processes', async () => {
    const repo = path.join(scratch, 'stalled')
    await fs.mkdir(repo)
    execFileSync(gitExecutable() as string, ['init', '-q', repo], { env, windowsHide: true })
    const pidFile = path.join(scratch, 'child.pid')
    const helper = path.join(scratch, 'stalled-helper.cjs')
    await fs.writeFile(helper, `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`)
    execFileSync(gitExecutable() as string, ['-C', repo, 'config', 'credential.helper', `!${gitShellPath(process.execPath)} ${gitShellPath(helper)}`], { env, windowsHide: true })
    await expect(credentialProbe(repo, true, env, 3000)).rejects.toThrow('credential probe timed out')
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    await expect.poll(() => {
      try { process.kill(pid, 0); return true } catch { return false }
    }, { timeout: 3000 }).toBe(false)
  }, 15_000)
})
