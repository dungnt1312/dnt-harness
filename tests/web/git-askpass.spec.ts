/**
 * Unix askpass session (Zed `crates/askpass/src/askpass.rs`): socket, client,
 * prompt registry and GPG wrapper generation. Windows is a separate task.
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  answerGitAskpass,
  createAskpassSession,
  generateGpgWrapperScript,
  promptRegistrySize,
  type AskpassFrame,
  type AskpassSession,
} from '../../src/web/git-askpass.ts'

const CLIENT = fileURLToPath(new URL('../../src/web/git-askpass-client.mjs', import.meta.url))
const unix = process.platform !== 'win32'

interface ClientResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run a command, collecting its output; `done` settles when it exits. */
function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function socketOf(session: AskpassSession): string {
  return path.join(session.tempDir, 'askpass.sock')
}

/** A queue of frames so a test can await the next one. */
function frameQueue(): { onPrompt: (frame: AskpassFrame) => void; next: () => Promise<AskpassFrame> } {
  const frames: AskpassFrame[] = []
  const waiters: ((frame: AskpassFrame) => void)[] = []
  return {
    onPrompt(frame) {
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else frames.push(frame)
    },
    next() {
      const frame = frames.shift()
      return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve))
    },
  }
}

const sessions: AskpassSession[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(sessions.splice(0).map((session) => session.dispose()))
})

async function open(operation: string, onPrompt: (frame: AskpassFrame) => void): Promise<AskpassSession> {
  const session = await createAskpassSession(operation, onPrompt)
  sessions.push(session)
  return session
}

describe.runIf(unix)('askpass session (Unix)', () => {
  it('round-trips one prompt and never logs the password', async () => {
    const logged: string[] = []
    const capture = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')) }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk))
      return (stderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
    })

    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    expect(frame).toMatchObject({ type: 'askpass', operation: 'push', prompt: 'Password:' })
    expect(frame.promptId).toMatch(/^[0-9a-f]{32}$/)
    expect(promptRegistrySize()).toBe(1)
    expect(answerGitAskpass(frame.promptId, { password: 'secret' })).toBe(true)
    const result = await client
    expect(result).toMatchObject({ code: 0, stdout: 'secret' })
    expect(promptRegistrySize()).toBe(0)
    expect(answerGitAskpass(frame.promptId, { password: 'secret' })).toBe(false)
    expect(session.cancelled).toBe(false)
    expect(logged.join('\n')).not.toContain('secret')
  })

  it('serves sequential prompts through the generated script with distinct ids', async () => {
    const queue = frameQueue()
    const session = await open('fetch', queue.onPrompt)
    expect(session.env).toMatchObject({
      GIT_ASKPASS: path.join(session.tempDir, 'askpass.sh'),
      SSH_ASKPASS: path.join(session.tempDir, 'askpass.sh'),
      SSH_ASKPASS_REQUIRE: 'force',
    })
    const script = session.env.GIT_ASKPASS as string

    const user = run(script, ["Username for 'https://example.com':"])
    const userFrame = await queue.next()
    expect(userFrame.prompt).toBe("Username for 'https://example.com':")
    expect(session.answer(userFrame.promptId, 'octocat')).toBe(true)
    expect(await user).toMatchObject({ code: 0, stdout: 'octocat' })

    const pass = run(script, ["Password for 'https://octocat@example.com':"])
    const passFrame = await queue.next()
    expect(passFrame.prompt).toBe("Password for 'https://octocat@example.com':")
    expect(passFrame.promptId).not.toBe(userFrame.promptId)
    expect(session.answer(passFrame.promptId, 'hunter2')).toBe(true)
    expect(await pass).toMatchObject({ code: 0, stdout: 'hunter2' })
    expect(promptRegistrySize()).toBe(0)
  })

  it('cancel closes the prompt without an answer and marks the session cancelled', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    expect(answerGitAskpass(frame.promptId, { cancel: true })).toBe(true)
    const result = await client
    expect(result.stdout).toBe('')
    expect(session.cancelled).toBe(true)
    expect(session.answer(frame.promptId, 'secret')).toBe(false)

    await session.dispose()
    expect(promptRegistrySize()).toBe(0)
    expect(existsSync(session.tempDir)).toBe(false)
  })

  it('cancelAll cancels the pending prompt and refuses the ones queued behind it', async () => {
    const frames: AskpassFrame[] = []
    const queue = frameQueue()
    const session = await open('pull', (frame) => { frames.push(frame); queue.onPrompt(frame) })
    const a = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Username:'])
    await queue.next()
    // Zed serves one connection at a time: a second client waits its turn.
    const b = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(promptRegistrySize()).toBe(1)
    session.cancelAll()
    expect(promptRegistrySize()).toBe(0)
    expect((await a).stdout).toBe('')
    expect((await b).stdout).toBe('')
    expect(frames).toHaveLength(1)
    expect(session.cancelled).toBe(true)
  })

  it('dispose while a prompt waits terminates the client and cleans up', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    expect(promptRegistrySize()).toBe(1)
    await session.dispose()
    const result = await client
    expect(result.stdout).toBe('')
    expect(promptRegistrySize()).toBe(0)
    expect(existsSync(session.tempDir)).toBe(false)
    expect(answerGitAskpass(frame.promptId, { password: 'secret' })).toBe(false)
    // A disposed session refuses new connections.
    const late = await run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    expect(late.code).not.toBe(0)
    expect(late.stdout).toBe('')
    await session.dispose()
  })

  it('creates a private temp dir and an owner-executable script', async () => {
    const session = await open('push', () => {})
    expect((await fs.stat(session.tempDir)).mode & 0o777).toBe(0o700)
    const script = await fs.readFile(session.env.GIT_ASKPASS as string, 'utf8')
    const mode = (await fs.stat(session.env.GIT_ASKPASS as string)).mode & 0o777
    expect(mode & 0o100).toBe(0o100)
    expect(mode & 0o077).toBe(0)
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(`printf '%s\\0' "$@" | '${process.execPath}' '${CLIENT}' --askpass='${socketOf(session)}' 2> /dev/null`)
  })

  it('exposes a GPG wrapper only when gpg is on the captured PATH', async () => {
    const bin = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-askpass-gpg-')))
    try {
      await fs.writeFile(path.join(bin, 'gpg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const withGpg = await createAskpassSession('commit', () => {}, { path: bin })
      sessions.push(withGpg)
      expect(withGpg.gpgWrapperPath).toBe(path.join(withGpg.tempDir, 'gpg-wrapper.sh'))
      const wrapper = await fs.readFile(withGpg.gpgWrapperPath as string, 'utf8')
      expect(wrapper).toContain(`exec '${path.join(bin, 'gpg')}' "$@"`)
      expect((await fs.stat(withGpg.gpgWrapperPath as string)).mode & 0o100).toBe(0o100)

      const empty = path.join(bin, 'empty')
      await fs.mkdir(empty)
      const without = await createAskpassSession('commit', () => {}, { path: empty })
      sessions.push(without)
      expect(without.gpgWrapperPath).toBeUndefined()
    } finally {
      await fs.rm(bin, { recursive: true, force: true })
    }
  })
})

describe('generateGpgWrapperScript', () => {
  const script = generateGpgWrapperScript('/usr/bin/gpg', '/opt/x y/client.mjs', "/tmp/a'b/askpass.sock")

  it('runs the three Zed stages in order', () => {
    const silent = script.indexOf(`'/usr/bin/gpg' --pinentry-mode error "$@" < "$payload"`)
    const plain = script.indexOf(`'/usr/bin/gpg' "$@" < "$payload"`)
    const ask = script.indexOf(`--askpass='/tmp/a'\\''b/askpass.sock' 2>/dev/null)`)
    const loopback = script.indexOf(`'/usr/bin/gpg' --pinentry-mode loopback --passphrase-fd 3 "$@" 3<&0 < "$payload"`)
    expect(silent).toBeGreaterThan(0)
    expect(plain).toBeGreaterThan(silent)
    expect(ask).toBeGreaterThan(plain)
    expect(loopback).toBeGreaterThan(ask)
    expect(script).toContain(`passphrase=$(printf '%s\\0' 'Enter passphrase for your Git signing key:' | '${process.execPath}' '/opt/x y/client.mjs' --askpass=`)
  })

  it('only intercepts signing flags', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('--sign|--detach-sign|--clearsign|--clear-sign) is_signing=1 ;;')
    expect(script).toContain('--*) ;;')
    expect(script).toContain('-*s*) is_signing=1 ;;')
    const guard = script.indexOf(`if [ -z "\${is_signing}" ]; then\n    exec '/usr/bin/gpg' "$@"\nfi`)
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(script.indexOf('--pinentry-mode error'))
  })
})
