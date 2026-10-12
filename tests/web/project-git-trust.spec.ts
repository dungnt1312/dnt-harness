/**
 * The trust-aware git foundation: project trust persistence, the command
 * builder (Zed `build_command`), and the login-shell project environment.
 *
 * Trust decides whether the repository's own config may run commands. An
 * untrusted project must run none of them; a trusted one runs them as a
 * terminal would. `core.fsmonitor` is the exception: Zed disables it for both.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceService } from 'dnt-harness'
import {
  buildGitCommand,
  gitCommandArgs,
  gitExecutable,
  parseNullEnvironment,
  projectGitEnvironment,
  runGitQuery,
} from '../../src/web/project-git.ts'

let scratch = ''
let home = ''
let repo = ''
let markers = ''
const saved: Record<string, string | undefined> = {}

/** Which repository-configured commands ran, by the marker each one leaves. */
async function markerNames(): Promise<string[]> {
  return (await fs.readdir(markers)).sort()
}

async function clearMarkers(): Promise<void> {
  for (const name of await fs.readdir(markers)) await fs.rm(path.join(markers, name))
}

async function script(name: string, body: string): Promise<string> {
  const file = path.join(scratch, `${name}.sh`)
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

function git(...args: string[]): void {
  execFileSync(gitExecutable() as string, args, { cwd: repo, stdio: 'ignore' })
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-trust-')))
  home = path.join(scratch, 'home')
  repo = path.join(scratch, 'repo')
  markers = path.join(scratch, 'markers')
  await Promise.all([fs.mkdir(home), fs.mkdir(repo), fs.mkdir(markers)])
  // A hermetic login shell: bash reads $HOME/.bash_profile, so the sentinel
  // below can only have come from the login-shell environment loader.
  await fs.writeFile(path.join(home, '.bash_profile'), 'export DNT_GIT_ENV_SENTINEL=from-login-shell\n')
  for (const key of ['HOME', 'SHELL']) saved[key] = process.env[key]
  process.env['HOME'] = home
  process.env['SHELL'] = '/bin/bash'

  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-qm', 'init')

  const mark = async (name: string): Promise<string> => script(name, `touch '${path.join(markers, name)}'`)
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\nchanged\n')
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt diff=evil\n')
  git('config', 'core.fsmonitor', await mark('fsmonitor'))
  git('config', 'core.sshCommand', await script('ssh', `touch '${path.join(markers, 'sshCommand')}'; exit 1`))
  git('config', 'credential.helper', `!${await script('credential', `touch '${path.join(markers, 'credential')}'`)}`)
  git('config', 'diff.external', await mark('external-diff'))
  git('config', 'diff.evil.textconv', await script('textconv', `touch '${path.join(markers, 'textconv')}'; cat "$1"`))
  await fs.copyFile(await mark('pre-commit'), path.join(repo, '.git', 'hooks', 'pre-commit'))
  await fs.chmod(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755)
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('project git trust persistence', () => {
  it('a project record without gitTrusted is untrusted, and the toggle survives a reload', async () => {
    const data = await fs.mkdtemp(path.join(scratch, 'ws-'))
    const service = new WorkspaceService(data)
    await service.boot()
    const ws = await service.create('Trust')
    const project = await service.createProject(ws.id, 'p', repo)

    // A record written before the field existed.
    const file = service.projectPath(ws.id, project.id)
    const legacy = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    delete legacy['gitTrusted']
    await fs.writeFile(file, JSON.stringify(legacy))
    const legacyService = new WorkspaceService(data)
    await legacyService.boot()
    expect(legacyService.getProject(project.id, ws.id).gitTrusted).toBeUndefined()

    expect(service.getProject(project.id, ws.id).gitTrusted).toBeUndefined()
    const trusted = await service.setProjectGitTrusted(project.id, ws.id, true)
    expect(trusted.gitTrusted).toBe(true)

    const reloaded = new WorkspaceService(data)
    await reloaded.boot()
    expect(reloaded.getProject(project.id, ws.id).gitTrusted).toBe(true)
    await reloaded.setProjectGitTrusted(project.id, ws.id, false)
    expect(reloaded.getProject(project.id, ws.id).gitTrusted).toBe(false)
    const again = new WorkspaceService(data)
    await again.boot()
    expect(again.getProject(project.id, ws.id).gitTrusted).toBe(false)
  })

  it('refuses a project of another workspace', async () => {
    const data = await fs.mkdtemp(path.join(scratch, 'ws-'))
    const service = new WorkspaceService(data)
    await service.boot()
    const one = await service.create('One')
    const two = await service.create('Two')
    const project = await service.createProject(one.id, 'p', repo)
    await expect(service.setProjectGitTrusted(project.id, two.id, true)).rejects.toMatchObject({ code: 'scope-mismatch' })
  })
})

describe('git command arguments', () => {
  it('an untrusted diff carries every override in Zed order, with --no-ext-diff right after diff', () => {
    expect(gitCommandArgs(['diff', '--', 'a.txt'], false)).toEqual([
      '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
      '--no-optional-locks', '--no-pager',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh',
      '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never',
      '-c', 'diff.external=', 'diff', '--no-ext-diff', '--', 'a.txt',
    ])
  })

  it('a trusted command keeps only the always-on overrides and leaves diff alone', () => {
    expect(gitCommandArgs(['diff', '--', 'a.txt'], true)).toEqual([
      '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
      '--no-optional-locks', '--no-pager',
      'diff', '--', 'a.txt',
    ])
  })

  it('only the diff subcommand gets --no-ext-diff', () => {
    expect(gitCommandArgs(['status'], false).slice(-1)).toEqual(['status'])
    expect(gitCommandArgs(['log', '-p'], false).includes('--no-ext-diff')).toBe(false)
  })

  it('does not mutate the caller args', () => {
    const args = ['diff', 'x'] as const
    gitCommandArgs(args, false)
    expect(args).toEqual(['diff', 'x'])
  })
})

describe('repository-configured commands', () => {
  it('an untrusted status runs none of them, and neither does a trusted one: fsmonitor is always off', async () => {
    await clearMarkers()
    await runGitQuery(repo, ['status', '--porcelain=v1'], false)
    expect(await markerNames()).toEqual([])
    await runGitQuery(repo, ['status', '--porcelain=v1'], true)
    expect(await markerNames()).toEqual([])
  }, 20_000)

  it('an untrusted diff runs no external diff; a trusted one does', async () => {
    await clearMarkers()
    const untrusted = await runGitQuery(repo, ['diff', 'HEAD', '--', 'a.txt'], false)
    expect(untrusted.stdout.toString('utf8')).toContain('+changed')
    expect(await markerNames()).not.toContain('external-diff')
    await clearMarkers()
    await runGitQuery(repo, ['diff', 'HEAD', '--', 'a.txt'], true)
    expect(await markerNames()).toContain('external-diff')
  }, 20_000)

  it('a textconv driver still runs on an untrusted diff: Zed does not pass --no-textconv (known parity gap)', async () => {
    await clearMarkers()
    await runGitQuery(repo, ['diff', 'HEAD', '--', 'a.txt'], false)
    expect(await markerNames()).toContain('textconv')
  }, 20_000)

  it('an untrusted commit runs no hook; a trusted one runs it', async () => {
    await clearMarkers()
    await runGitQuery(repo, ['commit', '-q', '--allow-empty', '-m', 'one'], false)
    expect(await markerNames()).not.toContain('pre-commit')
    await clearMarkers()
    await runGitQuery(repo, ['commit', '-q', '--allow-empty', '-m', 'two'], true)
    expect(await markerNames()).toContain('pre-commit')
  }, 20_000)

  it('an untrusted ls-remote does not use the configured sshCommand; a trusted one does', async () => {
    await clearMarkers()
    await runGitQuery(repo, ['ls-remote', 'ssh://127.0.0.1:1/none'], false)
    expect(await markerNames()).not.toContain('sshCommand')
    await runGitQuery(repo, ['ls-remote', 'ssh://127.0.0.1:1/none'], true)
    expect(await markerNames()).toContain('sshCommand')
  }, 30_000)

  it('an untrusted credential lookup does not reach the configured helper; a trusted one does', async () => {
    await clearMarkers()
    const ask = async (trusted: boolean): Promise<void> => {
      const env = { ...await projectGitEnvironment(repo), GIT_TERMINAL_PROMPT: '0' }
      const child = await buildGitCommand(repo, ['credential', 'fill'], { trusted, env })
      child.stdin.end('protocol=https\nhost=example.invalid\n\n')
      child.stdout.resume()
      child.stderr.resume()
      await new Promise((resolve) => child.on('close', resolve))
    }
    await ask(false)
    expect(await markerNames()).not.toContain('credential')
    await ask(true)
    expect(await markerNames()).toContain('credential')
  }, 20_000)
})

describe('buildGitCommand', () => {
  it('runs in the project root with stdin closed on request', async () => {
    const child = await buildGitCommand(repo, ['rev-parse', '--show-toplevel'], { trusted: false, stdin: 'ignore' })
    expect(child.stdin).toBeNull()
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    await new Promise((resolve) => child.on('close', resolve))
    expect(Buffer.concat(out).toString('utf8').trim()).toBe(repo)
  })

  it('uses the supplied environment instead of the project one', async () => {
    const child = await buildGitCommand(repo, ['var', 'GIT_AUTHOR_IDENT'], {
      trusted: true,
      stdin: 'ignore',
      env: { PATH: process.env['PATH'] ?? '', HOME: home, GIT_AUTHOR_NAME: 'from-options', GIT_AUTHOR_EMAIL: 'o@o' },
    })
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    await new Promise((resolve) => child.on('close', resolve))
    expect(Buffer.concat(out).toString('utf8')).toContain('from-options')
  })
})

describe('login-shell project environment', () => {
  it('parseNullEnvironment splits on NUL, keeps later "=" in the value and empty values', () => {
    expect(parseNullEnvironment(Buffer.from('A=1\0B=x=y=z\0EMPTY=\0PATH=/usr/bin:/bin\0'))).toEqual({
      A: '1',
      B: 'x=y=z',
      EMPTY: '',
      PATH: '/usr/bin:/bin',
    })
  })

  it('parseNullEnvironment drops records without a name or an "=" and tolerates no trailing NUL', () => {
    expect(parseNullEnvironment(Buffer.from('=novalue\0junk\0K=v'))).toEqual({ K: 'v' })
    expect(parseNullEnvironment(Buffer.alloc(0))).toEqual({})
  })

  it('parseNullEnvironment keeps a newline inside a value', () => {
    expect(parseNullEnvironment(Buffer.from('MULTI=a\nb\0'))).toEqual({ MULTI: 'a\nb' })
  })

  it('carries what the login shell startup file exports, and PATH', async () => {
    const env = await projectGitEnvironment(repo)
    expect(env['DNT_GIT_ENV_SENTINEL']).toBe('from-login-shell')
    expect(env['PATH']).toBeTruthy()
  }, 20_000)

  it('is cached per directory: a second call returns the same object', async () => {
    const [first, second] = await Promise.all([projectGitEnvironment(repo), projectGitEnvironment(repo)])
    expect(first).toBe(second)
  }, 20_000)

  it('a hook sees the login-shell variable when the project is trusted', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    await fs.writeFile(hook, `#!/bin/sh\necho "$DNT_GIT_ENV_SENTINEL" > '${path.join(markers, 'hook-env')}'\n`, { mode: 0o755 })
    await clearMarkers()
    await runGitQuery(repo, ['commit', '-q', '--allow-empty', '-m', 'env'], true)
    expect((await fs.readFile(path.join(markers, 'hook-env'), 'utf8')).trim()).toBe('from-login-shell')
  }, 20_000)

  it('falls back to the server environment when the login shell cannot run', async () => {
    const original = process.env['SHELL']
    const missing = await fs.mkdtemp(path.join(scratch, 'fallback-'))
    // A shell that exists but prints no environment.
    process.env['SHELL'] = await script('broken-shell', 'exit 1')
    try {
      const env = await projectGitEnvironment(missing)
      expect(env['PATH']).toBe(process.env['PATH'])
      expect(env['DNT_GIT_ENV_SENTINEL']).toBeUndefined()
    } finally {
      process.env['SHELL'] = original
    }
  }, 20_000)
})
