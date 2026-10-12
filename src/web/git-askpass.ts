/**
 * Git askpass sessions on Unix, ported from Zed `crates/askpass/src/askpass.rs`.
 *
 * A session owns a private temp directory holding a Unix socket, the
 * `askpass.sh` script git/ssh run as `GIT_ASKPASS`/`SSH_ASKPASS`, and — when a
 * gpg binary is on `PATH` — a `gpg-wrapper.sh` for `gpg.program`. The script
 * pipes its arguments into `git-askpass-client.mjs`, which forwards them to
 * the socket and prints whatever comes back. Each connection becomes one
 * prompt: registered under a random id, announced through `onPrompt`, then
 * answered (password bytes written, socket closed) or cancelled (socket closed
 * with no answer). Passwords are written to the socket and nowhere else.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fs, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AskpassFrame {
  readonly type: 'askpass'
  readonly promptId: string
  readonly operation: string
  readonly prompt: string
}

export interface AskpassSession {
  readonly tempDir: string
  readonly env: Readonly<Record<string, string>>
  /** Path for git's `gpg.program` (Zed `gpg_wrapper_path`); absent when no gpg is on `PATH`. */
  readonly gpgWrapperPath?: string
  readonly cancelled: boolean
  answer(promptId: string, password: string): boolean
  cancel(promptId: string): boolean
  cancelAll(): void
  dispose(): Promise<void>
}

/** Seams; production passes none. `path` is the captured project `PATH` searched for gpg. */
export interface AskpassSessionOptions {
  readonly path?: string
}

const ASKPASS_SCRIPT_NAME = 'askpass.sh'
const GPG_WRAPPER_SCRIPT_NAME = 'gpg-wrapper.sh'
const SOCKET_NAME = 'askpass.sock'
/** A prompt is one line of text; anything this large is not a prompt. */
const MAX_PROMPT_BYTES = 64 * 1024

const CLIENT_PATH = fileURLToPath(new URL('./git-askpass-client.mjs', import.meta.url))

interface PendingPrompt {
  readonly owner: UnixAskpassSession
  readonly socket: net.Socket
}

/** Every pending prompt across sessions, keyed by its random id. */
const registry = new Map<string, PendingPrompt>()

/** Answer or cancel a pending prompt by id, whichever session owns it. */
export function answerGitAskpass(promptId: string, answer: { password: string } | { cancel: true }): boolean {
  const pending = registry.get(promptId)
  if (pending === undefined) return false
  return 'password' in answer ? pending.owner.answer(promptId, answer.password) : pending.owner.cancel(promptId)
}

export function promptRegistrySize(): number {
  return registry.size
}

/** POSIX single-quote a word (Zed `ShellKind::Posix` quoting). */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** The askpass program: this Node binary running the client script. */
function askpassProgram(client: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(client)}`
}

/** Zed `generate_askpass_script`. */
function generateAskpassScript(client: string, socket: string): string {
  const printArgs = `printf '%s\\0' "$@"`
  return `#!/bin/sh\n${printArgs} | ${askpassProgram(client)} --askpass=${shellQuote(socket)} 2> /dev/null \n`
}

/**
 * Zed `generate_gpg_wrapper_script`, verbatim apart from quoted paths. Only
 * signing invocations are intercepted; they try `--pinentry-mode error`, then
 * the configured pinentry, then loopback with the passphrase from askpass on fd 3.
 */
export function generateGpgWrapperScript(gpg: string, client: string, socket: string): string {
  const gpgProgram = shellQuote(gpg)
  const program = askpassProgram(client)
  const askpassSocket = shellQuote(socket)
  const prompt = shellQuote('Enter passphrase for your Git signing key:')
  return `#!/bin/sh
for arg in "$@"; do
    case "$arg" in
        # Long-form signing options.
        --sign|--detach-sign|--clearsign|--clear-sign) is_signing=1 ;;
        # Skip other long options so flags like \`--status-fd\` don't match below.
        --*) ;;
        # Short-flag clusters containing \`s\`, e.g. git's \`-bsau\`.
        -*s*) is_signing=1 ;;
    esac
done

# Not a signing request: run gpg as-is, leaving its prompting untouched.
if [ -z "\${is_signing}" ]; then
    exec ${gpgProgram} "$@"
fi

# Signing. Buffer stdin (the payload) and each attempt's output
# so we can retry cleanly on failure without git seeing partial output.
tmpdir=$(mktemp -d) || exit 1
trap 'rm -rf "$tmpdir"' EXIT
payload="$tmpdir/payload"
signature="$tmpdir/signature"
status="$tmpdir/status"
cat > "$payload" || exit 1

# Stage 1: fully silent. Only succeeds if gpg-agent already has the passphrase
# cached or the key is unprotected; \`--pinentry-mode error\` forbids launching
# any pinentry, so this can never prompt anywhere.
if ${gpgProgram} --pinentry-mode error "$@" < "$payload" > "$signature" 2> "$status"; then
    cat "$status" >&2
    cat "$signature"
    exit 0
fi

# Stage 2: let gpg launch the configured pinentry, matching terminal git. GUI
# pinentries work without a TTY and may fetch the passphrase from an OS
# keychain silently (or show their native dialog); TTY pinentries fail fast
# with "Inappropriate ioctl for device" since gpg has no TTY here.
if ${gpgProgram} "$@" < "$payload" > "$signature" 2> "$status"; then
    cat "$status" >&2
    cat "$signature"
    exit 0
fi

# Stage 3: gpg cannot obtain the passphrase on its own. Ask for it, then
# hand it to gpg on fd 3 using loopback mode so no pinentry/terminal is
# required.
passphrase=$(printf '%s\\0' ${prompt} | ${program} --askpass=${askpassSocket} 2>/dev/null)
printf '%s\\n' "$passphrase" |
${gpgProgram} --pinentry-mode loopback --passphrase-fd 3 "$@" 3<&0 < "$payload"
`
}

/** Zed `find_gpg_program`: `gpg`, then `gpg2`, on the given `PATH`. */
function findGpgProgram(searchPath: string): string | undefined {
  for (const name of ['gpg', 'gpg2']) {
    for (const dir of searchPath.split(path.delimiter)) {
      if (dir === '') continue
      const candidate = path.join(dir, name)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // unreadable entry: keep looking
      }
    }
  }
  return undefined
}

class UnixAskpassSession implements AskpassSession {
  readonly env: Readonly<Record<string, string>>
  readonly gpgWrapperPath?: string
  #cancelled = false
  #disposed: Promise<void> | undefined
  /** Prompts of this session still waiting for an answer. */
  readonly #pending = new Set<string>()
  /** Every connection still open, prompting or queued behind one. */
  readonly #sockets = new Set<net.Socket>()
  /** Zed serves one connection at a time; this chains them. */
  #queue: Promise<void> = Promise.resolve()

  constructor(
    readonly tempDir: string,
    readonly operation: string,
    private readonly server: net.Server,
    private readonly onPrompt: (frame: AskpassFrame) => void,
    scriptPath: string,
    gpgWrapperPath: string | undefined,
  ) {
    this.env = { GIT_ASKPASS: scriptPath, SSH_ASKPASS: scriptPath, SSH_ASKPASS_REQUIRE: 'force' }
    if (gpgWrapperPath !== undefined) this.gpgWrapperPath = gpgWrapperPath
    server.on('connection', (socket) => this.#accept(socket))
  }

  get cancelled(): boolean {
    return this.#cancelled
  }

  #accept(socket: net.Socket): void {
    if (this.#disposed !== undefined) {
      socket.destroy()
      return
    }
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    const prompt = readPrompt(socket)
    this.#queue = this.#queue.then(async () => {
      const text = await prompt
      if (text === undefined || socket.destroyed) return
      // After a cancel the operation is over (Zed stops serving); refuse quietly.
      if (this.#cancelled || this.#disposed !== undefined) {
        socket.destroy()
        return
      }
      await this.#ask(socket, text)
    })
  }

  /** Register the prompt, announce it, and wait until the connection closes. */
  #ask(socket: net.Socket, prompt: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const promptId = randomBytes(16).toString('hex')
      registry.set(promptId, { owner: this, socket })
      this.#pending.add(promptId)
      socket.once('close', () => {
        this.#forget(promptId)
        resolve()
      })
      try {
        this.onPrompt({ type: 'askpass', promptId, operation: this.operation, prompt })
      } catch {
        this.cancel(promptId)
      }
    })
  }

  #forget(promptId: string): void {
    this.#pending.delete(promptId)
    if (registry.get(promptId)?.owner === this) registry.delete(promptId)
  }

  #take(promptId: string): net.Socket | undefined {
    if (!this.#pending.has(promptId)) return undefined
    const socket = registry.get(promptId)?.socket
    this.#forget(promptId)
    return socket
  }

  answer(promptId: string, password: string): boolean {
    const socket = this.#take(promptId)
    if (socket === undefined) return false
    socket.end(Buffer.from(password, 'utf8'))
    return true
  }

  cancel(promptId: string): boolean {
    const socket = this.#take(promptId)
    if (socket === undefined) return false
    this.#cancelled = true
    socket.end()
    return true
  }

  cancelAll(): void {
    for (const promptId of [...this.#pending]) this.cancel(promptId)
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      for (const promptId of [...this.#pending]) this.#forget(promptId)
      for (const socket of this.#sockets) socket.destroy()
      this.#sockets.clear()
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
      await fs.rm(this.tempDir, { recursive: true, force: true })
    })()
    return this.#disposed
  }
}

/** Read up to the first NUL (Zed `read_until(b'\0')`); `undefined` when the peer leaves early. */
function readPrompt(socket: net.Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (value: string | undefined): void => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onClose)
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      const nul = chunk.indexOf(0)
      chunks.push(nul < 0 ? chunk : chunk.subarray(0, nul))
      size += chunk.length
      if (nul >= 0) {
        // Anything after the NUL is ignored; the socket keeps flowing so a close is seen.
        finish(Buffer.concat(chunks).toString('utf8'))
      } else if (size > MAX_PROMPT_BYTES) {
        socket.destroy()
        finish(undefined)
      }
    }
    const onEnd = (): void => finish(Buffer.concat(chunks).toString('utf8'))
    const onClose = (): void => finish(undefined)
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onClose)
  })
}

/**
 * Create a session for one git operation (Zed `PasswordProxy::new`). The
 * caller must `dispose()` it once the operation's process has exited.
 */
export async function createAskpassSession(
  operation: string,
  onPrompt: (frame: AskpassFrame) => void,
  options: AskpassSessionOptions = {},
): Promise<AskpassSession> {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-askpass-'))
  const server = net.createServer({ allowHalfOpen: true })
  try {
    await fs.chmod(tempDir, 0o700)
    const socketPath = path.join(tempDir, SOCKET_NAME)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await fs.chmod(socketPath, 0o600)

    const scriptPath = path.join(tempDir, ASKPASS_SCRIPT_NAME)
    await fs.writeFile(scriptPath, generateAskpassScript(CLIENT_PATH, socketPath), { mode: 0o700 })
    await fs.chmod(scriptPath, 0o700)

    // A wrapper that cannot be written is not fatal (Zed logs and drops it).
    let gpgWrapperPath: string | undefined
    const gpg = findGpgProgram(options.path ?? process.env.PATH ?? '')
    if (gpg !== undefined) {
      const wrapper = path.join(tempDir, GPG_WRAPPER_SCRIPT_NAME)
      try {
        await fs.writeFile(wrapper, generateGpgWrapperScript(gpg, CLIENT_PATH, socketPath), { mode: 0o700 })
        await fs.chmod(wrapper, 0o700)
        gpgWrapperPath = wrapper
      } catch {
        gpgWrapperPath = undefined
      }
    }
    return new UnixAskpassSession(tempDir, operation, server, onPrompt, scriptPath, gpgWrapperPath)
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDir, { recursive: true, force: true })
    throw error
  }
}
