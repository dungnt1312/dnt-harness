/**
 * Git askpass sessions, ported from Zed `crates/askpass/src/askpass.rs`.
 *
 * A session owns a private temp directory holding the script git/ssh run as
 * `GIT_ASKPASS`/`SSH_ASKPASS` and — on Unix, when a gpg binary is on `PATH` — a
 * `gpg-wrapper.sh` for `gpg.program`. The script forwards its arguments through
 * `git-askpass-client.mjs` to the session endpoint (a Unix socket in the temp
 * directory, or a random named pipe on Windows) and prints whatever comes back.
 * Each connection becomes one prompt: registered under a random id, announced
 * through `onPrompt`, then answered (password bytes written, connection closed)
 * or cancelled (the operation is killed and the connection is left open and
 * silent until git's process dies or the session is disposed; the client exits
 * non-zero if the connection ends without any byte). Passwords are written to the
 * connection and nowhere else.
 */
import { randomBytes } from 'node:crypto'
import { accessSync, constants as fsConstants, promises as fs, statSync } from 'node:fs'
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

/** Who may answer the prompts of a session (the workspace and project the operation runs in). */
export interface AskpassOwner {
  readonly workspaceId: string
  readonly projectId: string
}

export interface AskpassSession {
  readonly tempDir: string
  /** Unix socket path, or the Windows named pipe, the client connects to. */
  readonly endpoint: string
  readonly env: Readonly<Record<string, string>>
  /** Path for git's `gpg.program` (Zed `gpg_wrapper_path`); absent when unavailable. */
  readonly gpgWrapperPath?: string
  readonly owner?: AskpassOwner
  readonly cancelled: boolean
  answer(promptId: string, password: string): boolean
  cancel(promptId: string): boolean
  /** Cancel the operation: every pending prompt, and the operation itself via `onCancel`. */
  cancelAll(): void
  dispose(): Promise<void>
}

/** Seams and scope; production passes `path`, `owner` and `onCancel`. */
export interface AskpassSessionOptions {
  /** The captured project `PATH` searched for gpg. */
  readonly path?: string
  readonly owner?: AskpassOwner
  /**
   * Called synchronously, once, when the user cancels a prompt or the session is
   * cancelled. The cancelled connection stays open with no bytes (Zed) until the
   * operation's process dies or the session is disposed, so git never receives
   * an answer it could retry with.
   */
  readonly onCancel?: () => void
}

const ASKPASS_SCRIPT_NAME = 'askpass.sh'
const ASKPASS_CMD_NAME = 'askpass.cmd'
const GPG_WRAPPER_SCRIPT_NAME = 'gpg-wrapper.sh'
const SOCKET_NAME = 'askpass.sock'
/** A prompt is one line of text; anything this large is not a prompt. */
const MAX_PROMPT_BYTES = 64 * 1024

const CLIENT_PATH = fileURLToPath(new URL('./git-askpass-client.mjs', import.meta.url))

interface PendingPrompt {
  readonly session: NetAskpassSession
  readonly socket: net.Socket
}

/** Every pending prompt across sessions, keyed by its random id. */
const registry = new Map<string, PendingPrompt>()

type AskpassAnswer = { password: string } | { cancel: true }

/** Exactly `{password: string}` or `{cancel: true}`; nothing else counts as an answer. */
function isAnswer(value: unknown): value is AskpassAnswer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1) return false
  const record = value as Record<string, unknown>
  if (keys[0] === 'password') return typeof record['password'] === 'string'
  if (keys[0] === 'cancel') return record['cancel'] === true
  return false
}

function sameOwner(a: AskpassOwner | undefined, b: AskpassOwner | undefined): boolean {
  return a !== undefined && b !== undefined && a.workspaceId === b.workspaceId && a.projectId === b.projectId
}

/**
 * Answer or cancel a pending prompt by id, whichever session owns it. When the
 * prompt's session has an owner, `owner` must be given and equal it; when
 * `owner` is given the session must have that owner. Anything else is refused,
 * and so is a malformed answer — it never cancels or throws.
 */
export function answerGitAskpass(promptId: string, answer: AskpassAnswer, owner?: AskpassOwner): boolean {
  if (typeof promptId !== 'string' || !isAnswer(answer)) return false
  const pending = registry.get(promptId)
  if (pending === undefined) return false
  // A session with an owner answers only its owner; a caller that names an owner
  // reaches only a session that has that same owner.
  const sessionOwner = pending.session.owner
  if ((sessionOwner !== undefined || owner !== undefined) && !sameOwner(sessionOwner, owner)) return false
  return 'password' in answer ? pending.session.answer(promptId, answer.password) : pending.session.cancel(promptId)
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

/** `cmd.exe` double-quote a word; `%` would expand inside a batch file. */
function cmdQuote(word: string): string {
  return `"${word.replaceAll('%', '%%')}"`
}

/**
 * The Windows askpass script: the prompt arrives as git's arguments (`%*`),
 * which the client joins with NUL.
 */
export function generateWindowsAskpassScript(node: string, client: string, pipe: string): string {
  return `@echo off\r\n${cmdQuote(node)} ${cmdQuote(client)} --askpass=${pipe} %*\r\n`
}

/** A fresh, unguessable Windows named pipe for one session. */
export function windowsPipeName(): string {
  return `\\\\.\\pipe\\dnt-harness-askpass-${randomBytes(16).toString('hex')}`
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
is_signing=
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

/**
 * Zed `find_gpg_program`: `gpg`, then `gpg2`, on the given `PATH`. Only an
 * executable regular file in an absolute directory counts; a relative entry
 * would make the choice depend on the server's working directory.
 */
function findGpgProgram(searchPath: string): string | undefined {
  for (const name of ['gpg', 'gpg2']) {
    for (const dir of searchPath.split(path.delimiter)) {
      if (dir === '' || !path.isAbsolute(dir)) continue
      const candidate = path.join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // missing, unreadable or not executable: keep looking
      }
    }
  }
  return undefined
}

class NetAskpassSession implements AskpassSession {
  readonly env: Readonly<Record<string, string>>
  readonly gpgWrapperPath?: string
  readonly owner?: AskpassOwner
  #cancelled = false
  #cancelSignalled = false
  #disposed: Promise<void> | undefined
  /** Prompts of this session still waiting for an answer. */
  readonly #pending = new Set<string>()
  /** Every connection still open, prompting or queued behind one. */
  readonly #sockets = new Set<net.Socket>()
  /** Zed serves one connection at a time; this chains them. */
  #queue: Promise<void> = Promise.resolve()

  constructor(
    readonly tempDir: string,
    readonly endpoint: string,
    readonly operation: string,
    private readonly server: net.Server,
    private readonly onPrompt: (frame: AskpassFrame) => void,
    scriptPath: string,
    gpgWrapperPath: string | undefined,
    owner: AskpassOwner | undefined,
    private readonly onCancel: (() => void) | undefined,
  ) {
    this.env = { GIT_ASKPASS: scriptPath, SSH_ASKPASS: scriptPath, SSH_ASKPASS_REQUIRE: 'force' }
    if (gpgWrapperPath !== undefined) this.gpgWrapperPath = gpgWrapperPath
    if (owner !== undefined) this.owner = { workspaceId: owner.workspaceId, projectId: owner.projectId }
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
    // The client never half-closes while it waits for the answer, so EOF means
    // it is gone (killed, timed out): drop its prompt and let the next one run.
    socket.on('end', () => socket.destroy())
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
      registry.set(promptId, { session: this, socket })
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
    if (registry.get(promptId)?.session === this) registry.delete(promptId)
  }

  #take(promptId: string): net.Socket | undefined {
    if (!this.#pending.has(promptId)) return undefined
    const socket = registry.get(promptId)?.socket
    this.#forget(promptId)
    // A client that already left cannot receive an answer.
    return socket === undefined || socket.destroyed || !socket.writable ? undefined : socket
  }

  /** Tell the operation to stop, once; an error in the hook must not stop the cleanup. */
  #signalCancel(): void {
    this.#cancelled = true
    if (this.#cancelSignalled) return
    this.#cancelSignalled = true
    try {
      this.onCancel?.()
    } catch {
      // the hook is best-effort; the connection is closed regardless
    }
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
    // Zed: signal the kill but leave the connection open and silent. It closes
    // when the operation's process dies (the client is in its group) or on
    // dispose, so no empty answer can reach a git that would retry with it.
    this.#signalCancel()
    // Nothing is served after a cancel; waiting clients get no answer either.
    for (const other of this.#sockets) if (other !== socket) other.destroy()
    return true
  }

  cancelAll(): void {
    this.#signalCancel()
    for (const promptId of [...this.#pending]) this.cancel(promptId)
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      for (const promptId of [...this.#pending]) this.#forget(promptId)
      for (const socket of this.#sockets) socket.destroy()
      this.#sockets.clear()
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
      // A just-closed socket or a busy file system can fail the first attempt.
      await fs.rm(this.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    })()
    return this.#disposed
  }
}

/** Read up to the first NUL (Zed `read_until(b'\0')`); `undefined` when the peer leaves before it. */
function readPrompt(socket: net.Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (value: string | undefined): void => {
      socket.off('data', onData)
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
    const onClose = (): void => finish(undefined)
    socket.on('data', onData)
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
  const windows = process.platform === 'win32'
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-askpass-'))
  const server = net.createServer({ allowHalfOpen: true })
  try {
    await fs.chmod(tempDir, 0o700)
    const endpoint = windows ? windowsPipeName() : path.join(tempDir, SOCKET_NAME)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (!windows) await fs.chmod(endpoint, 0o600)

    const scriptPath = path.join(tempDir, windows ? ASKPASS_CMD_NAME : ASKPASS_SCRIPT_NAME)
    const script = windows
      ? generateWindowsAskpassScript(process.execPath, CLIENT_PATH, endpoint)
      : generateAskpassScript(CLIENT_PATH, endpoint)
    await fs.writeFile(scriptPath, script, { mode: 0o700 })
    await fs.chmod(scriptPath, 0o700)

    // A wrapper that cannot be written is not fatal (Zed logs and drops it).
    // The wrapper is a POSIX shell script, so Windows signs through git's own gpg.
    let gpgWrapperPath: string | undefined
    const gpg = windows ? undefined : findGpgProgram(options.path ?? process.env.PATH ?? '')
    if (gpg !== undefined) {
      const wrapper = path.join(tempDir, GPG_WRAPPER_SCRIPT_NAME)
      try {
        await fs.writeFile(wrapper, generateGpgWrapperScript(gpg, CLIENT_PATH, endpoint), { mode: 0o700 })
        await fs.chmod(wrapper, 0o700)
        gpgWrapperPath = wrapper
      } catch {
        gpgWrapperPath = undefined
      }
    }
    return new NetAskpassSession(tempDir, endpoint, operation, server, onPrompt, scriptPath, gpgWrapperPath, options.owner, options.onCancel)
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDir, { recursive: true, force: true })
    throw error
  }
}
