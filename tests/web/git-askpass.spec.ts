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

  /** Whether a promise is still pending after `ms`. */
  async function stillPending(promise: Promise<unknown>, ms = 300): Promise<boolean> {
    const marker = Symbol('pending')
    return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])) === marker
  }

  it('cancel leaves the connection open and silent until dispose, then the client fails with no output', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    expect(answerGitAskpass(frame.promptId, { cancel: true })).toBe(true)
    expect(session.cancelled).toBe(true)
    expect(session.answer(frame.promptId, 'secret')).toBe(false)
    // No byte, no close: the client (and so git) keeps waiting instead of reading an empty answer.
    expect(await stillPending(client)).toBe(true)

    await session.dispose()
    const result = await client
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(promptRegistrySize()).toBe(0)
    expect(existsSync(session.tempDir)).toBe(false)
  })

  it('cancelAll keeps the pending prompt open and drops the ones queued behind it', async () => {
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
    const droppedB = await b
    expect(droppedB.code).not.toBe(0)
    expect(droppedB.stdout).toBe('')
    expect(await stillPending(a)).toBe(true)
    await session.dispose()
    const endedA = await a
    expect(endedA.code).not.toBe(0)
    expect(endedA.stdout).toBe('')
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
    expect(result.code).not.toBe(0)
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

describe.runIf(unix)('askpass session lifecycle (Unix)', () => {
  it('creates the socket with mode 0600 inside a 0700 directory', async () => {
    const session = await open('push', () => {})
    expect(session.endpoint).toBe(socketOf(session))
    expect((await fs.stat(socketOf(session))).mode & 0o777).toBe(0o600)
    expect((await fs.stat(session.tempDir)).mode & 0o777).toBe(0o700)
  })

  it('drops the prompt of a client that disconnects and serves the next connection', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const first = spawn(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Username:'], { stdio: 'ignore' })
    const firstFrame = await queue.next()
    expect(promptRegistrySize()).toBe(1)
    // A second client is queued behind the first.
    const second = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    await new Promise((resolve) => setTimeout(resolve, 100))

    first.kill('SIGKILL')
    const secondFrame = await queue.next()
    expect(secondFrame.prompt).toBe('Password:')
    expect(promptRegistrySize()).toBe(1)
    // The vanished client's prompt is gone and can no longer be answered.
    expect(answerGitAskpass(firstFrame.promptId, { password: 'late' })).toBe(false)
    expect(session.cancelled).toBe(false)
    expect(answerGitAskpass(secondFrame.promptId, { password: 'next' })).toBe(true)
    expect(await second).toMatchObject({ code: 0, stdout: 'next' })
    expect(promptRegistrySize()).toBe(0)
  })

  it('drops a queued client that disconnects before its turn', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const first = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Username:'])
    const firstFrame = await queue.next()
    const queued = spawn(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Skipped:'], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    queued.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const third = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    expect(answerGitAskpass(firstFrame.promptId, { password: 'u' })).toBe(true)
    await first
    const frame = await queue.next()
    expect(frame.prompt).toBe('Password:')
    expect(answerGitAskpass(frame.promptId, { password: 'p' })).toBe(true)
    expect((await third).stdout).toBe('p')
  })

  it('signals the operation synchronously when a prompt is cancelled, once', async () => {
    const queue = frameQueue()
    let cancels = 0
    const session = await createAskpassSession('push', queue.onPrompt, { onCancel: () => { cancels += 1 } })
    sessions.push(session)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    expect(answerGitAskpass(frame.promptId, { cancel: true })).toBe(true)
    expect(cancels).toBe(1)
    session.cancelAll()
    expect(cancels).toBe(1)
    await session.dispose()
    expect((await client).stdout).toBe('')
  })

  it('the client exits non-zero, printing nothing, when the connection ends with zero bytes', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-askpass-eof-')))
    const endpoint = path.join(dir, 'eof.sock')
    const net = await import('node:net')
    let reply: Buffer | undefined
    const server = net.createServer((socket) => {
      socket.once('data', () => { if (reply) socket.end(reply); else socket.end() })
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    try {
      const empty = await run(process.execPath, [CLIENT, `--askpass=${endpoint}`, 'Password:'])
      expect(empty.code).not.toBe(0)
      expect(empty.stdout).toBe('')
      reply = Buffer.from('hunter2')
      const answered = await run(process.execPath, [CLIENT, `--askpass=${endpoint}`, 'Password:'])
      expect(answered).toMatchObject({ code: 0, stdout: 'hunter2' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('answers only a strict { password: string } or { cancel: true }', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    const malformed: unknown[] = [
      undefined, null, 'secret', 42, [], {}, { cancel: false }, { cancel: 'true' }, { cancel: 1 },
      { password: 1 }, { password: null }, { password: 'x', cancel: true }, { password: 'x', extra: 1 }, { cancel: true, extra: 1 },
    ]
    for (const answer of malformed) {
      expect(answerGitAskpass(frame.promptId, answer as { password: string })).toBe(false)
    }
    expect(answerGitAskpass(42 as unknown as string, { cancel: true })).toBe(false)
    expect(promptRegistrySize()).toBe(1)
    expect(session.cancelled).toBe(false)
    expect(answerGitAskpass(frame.promptId, { password: 'x' })).toBe(true)
    expect((await client).code).toBe(0)
  })

  it('requires the supplied owner to match the session owner', async () => {
    const queue = frameQueue()
    const owner = { workspaceId: 'w1', projectId: 'p1' }
    const session = await createAskpassSession('push', queue.onPrompt, { owner })
    sessions.push(session)
    expect(session.owner).toEqual(owner)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    for (const other of [{ workspaceId: 'w2', projectId: 'p1' }, { workspaceId: 'w1', projectId: 'p2' }]) {
      expect(answerGitAskpass(frame.promptId, { password: 'secret' }, other)).toBe(false)
      expect(answerGitAskpass(frame.promptId, { cancel: true }, other)).toBe(false)
    }
    // A session with an owner refuses answers that name no owner at all.
    expect(answerGitAskpass(frame.promptId, { password: 'secret' })).toBe(false)
    expect(answerGitAskpass(frame.promptId, { cancel: true })).toBe(false)
    expect(answerGitAskpass(frame.promptId, { password: 'secret' }, undefined)).toBe(false)
    expect(session.cancelled).toBe(false)
    expect(promptRegistrySize()).toBe(1)
    expect(answerGitAskpass(frame.promptId, { password: 'secret' }, { ...owner })).toBe(true)
    expect((await client).stdout).toBe('secret')
  })

  it('refuses an owner-scoped answer for a session that has no owner', async () => {
    const queue = frameQueue()
    const session = await open('push', queue.onPrompt)
    const client = run(process.execPath, [CLIENT, `--askpass=${socketOf(session)}`, 'Password:'])
    const frame = await queue.next()
    expect(answerGitAskpass(frame.promptId, { password: 'secret' }, { workspaceId: 'w', projectId: 'p' })).toBe(false)
    expect(answerGitAskpass(frame.promptId, { password: 'secret' })).toBe(true)
    await client
  })

  it('ignores gpg that is not executable or only found through a relative PATH entry', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-askpass-gpg2-')))
    try {
      const plain = path.join(root, 'plain')
      const exec = path.join(root, 'exec')
      await fs.mkdir(plain)
      await fs.mkdir(exec)
      await fs.writeFile(path.join(plain, 'gpg'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      await fs.chmod(path.join(plain, 'gpg'), 0o644)
      const notExecutable = await createAskpassSession('commit', () => {}, { path: plain })
      sessions.push(notExecutable)
      expect(notExecutable.gpgWrapperPath).toBeUndefined()

      await fs.writeFile(path.join(exec, 'gpg2'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const relative = path.relative(process.cwd(), exec)
      expect(path.isAbsolute(relative)).toBe(false)
      const viaRelative = await createAskpassSession('commit', () => {}, { path: relative })
      sessions.push(viaRelative)
      expect(viaRelative.gpgWrapperPath).toBeUndefined()

      // An unusable earlier entry does not hide a usable later one; gpg2 is the fallback name.
      const both = await createAskpassSession('commit', () => {}, { path: [plain, exec].join(path.delimiter) })
      sessions.push(both)
      expect(await fs.readFile(both.gpgWrapperPath as string, 'utf8')).toContain(`exec '${path.join(exec, 'gpg2')}' "$@"`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('initialises is_signing in the gpg wrapper so an inherited value cannot force signing', async () => {
    const bin = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-askpass-gpg3-')))
    try {
      const marker = path.join(bin, 'ran')
      await fs.writeFile(path.join(bin, 'gpg'), `#!/bin/sh\necho "$@" > '${marker}'\n`, { mode: 0o755 })
      const session = await createAskpassSession('commit', () => {}, { path: bin })
      sessions.push(session)
      const wrapper = await fs.readFile(session.gpgWrapperPath as string, 'utf8')
      expect(wrapper).toContain('\nis_signing=\nfor arg in "$@"; do')
      const result = await run(session.gpgWrapperPath as string, ['--version'], { ...process.env, is_signing: '1' })
      expect(result.code).toBe(0)
      expect(await fs.readFile(marker, 'utf8')).toBe('--version\n')
    } finally {
      await fs.rm(bin, { recursive: true, force: true })
    }
  })
})

describe('Windows askpass endpoint and script', () => {
  it('uses a random named pipe', async () => {
    const { windowsPipeName } = await import('../../src/web/git-askpass.ts')
    const a = windowsPipeName()
    expect(a).toMatch(/^\\\\\.\\pipe\\dnt-harness-askpass-[0-9a-f]{32}$/)
    expect(windowsPipeName()).not.toBe(a)
  })

  it('generates a .cmd that runs the Node client with the pipe and the git arguments', async () => {
    const { generateWindowsAskpassScript } = await import('../../src/web/git-askpass.ts')
    const script = generateWindowsAskpassScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\dnt\\git-askpass-client.mjs', '\\\\.\\pipe\\dnt-harness-askpass-abc')
    expect(script).toBe(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\dnt\\git-askpass-client.mjs" --askpass=\\\\.\\pipe\\dnt-harness-askpass-abc %*\r\n',
    )
    expect(generateWindowsAskpassScript('n', 'c%x', '\\\\.\\pipe\\p')).toContain('"c%%x"')
  })

  it.runIf(process.platform === 'win32')('a session listens on the pipe and writes askpass.cmd', async () => {
    const session = await open('push', () => {})
    expect(session.endpoint).toMatch(/^\\\\\.\\pipe\\dnt-harness-askpass-/)
    expect(session.env.GIT_ASKPASS).toBe(path.join(session.tempDir, 'askpass.cmd'))
    expect(session.gpgWrapperPath).toBeUndefined()
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
