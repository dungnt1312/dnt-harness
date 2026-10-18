/**
 * Interactive PTY terminals for the web Workbench.
 *
 * This is a **web-host resource, not a harness capability**. It deliberately
 * touches none of the agent machinery: no `agentScope`, no `session/event`, no
 * approval bridge, no tool registry. The user types the commands here, so
 * per-command approval would be theatre; the agent's `Bash` tool keeps its own
 * captured-output contract and its own `ask` gate, unchanged.
 *
 * Nothing here is durable. Terminal output is a byte firehose — a single `cat`
 * of a large file would wreck the session log's snapshot-replay guarantee — so
 * scrollback lives in a capped in-memory ring per terminal and dies with the
 * host. A page reload replays that ring and reattaches; a host restart does not.
 *
 * Backends: Bun's built-in PTY on POSIX, `bun-pty` (prebuilt Rust library via
 * `bun:ffi`) on Windows. `bun-pty` is imported lazily and its absence is a
 * reported state, never a boot failure: the rest of the product must serve
 * normally on a host where the library cannot load.
 *
 * Lifecycle (RH-3): `running → closing → exited | failedTeardown`. Every close
 * path — delete, idle reap, natural exit, shutdown — goes through one shared,
 * idempotent teardown that only reports `exited` once the shell and its
 * session's ordinary jobs are physically gone. A teardown that cannot prove
 * that keeps the record as `failedTeardown` (input blocked) so it can be
 * retried explicitly, by the reaper, or by `disposeAll`.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { shellCatalog, type ShellId, type ShellOption } from '../capabilities/shell/detect.ts'
import type { ProjectId, WorkspaceId } from '../util/brand.ts'
import { platformInspector, type ProcessIdentity, type ProcessInspector, type TeardownSignal } from './pty-session.ts'

/** Scrollback retained per terminal, in characters. */
const SCROLLBACK_CHARS = 256_000
/** Output is coalesced into one frame per this many ms, never one per chunk. */
const FLUSH_INTERVAL_MS = 16
/** A single flush larger than this is truncated: a runaway `yes` must not grow the queue. */
const FLUSH_CEILING_CHARS = 1_000_000
/** Terminals idle longer than this are reaped. */
const IDLE_MS = 30 * 60 * 1000
/** How often the reaper looks for idle terminals (and retries failed teardowns). */
const REAP_INTERVAL_MS = 60_000
/** After the PTY is closed and HUP sent, how long before KILL escalation. */
const ESCALATE_MS = 1_000
/**
 * After KILL, how long to wait for exit confirmation before declaring the
 * teardown failed. Windows has no KILL path (closing the ConPTY is the kill),
 * and a shell killed while still starting was measured to report its exit only
 * after ~2.5s with 16 terminals at once, so it gets a longer confirmation wait.
 */
const KILL_GRACE_MS = process.platform === 'win32' ? 2_500 : 1_000
/** Poll interval while waiting for session members to disappear. */
const POLL_MS = 50
/**
 * Total budget `disposeAll` gets during host shutdown. All terminals tear down
 * concurrently inside it. It covers one escalation round (ESCALATE_MS +
 * KILL_GRACE_MS: 2s POSIX, 3.5s Windows) plus slack for process enumeration.
 * The web host starts it first and runs it concurrently with its other
 * bounded cleanup steps (see the budget table in server.ts `close()`).
 */
export const TERMINAL_SHUTDOWN_BUDGET_MS = 4_000

/** Why a terminal ended. */
export type TerminalExitReason = 'exit' | 'killed' | 'idle'

/** Lifecycle state of a terminal record. */
export type TerminalState = 'running' | 'closing' | 'exited' | 'failedTeardown'

/** A terminal as described to a client. */
export interface TerminalInfo {
  readonly id: string
  readonly workspaceId: WorkspaceId
  /**
   * The project whose folder this shell was opened in. Absent for a terminal
   * opened with no project, which starts in the host's default folder. The
   * shell may `cd` afterwards; this records where it belongs, not where it is.
   */
  readonly projectId?: ProjectId
  readonly shellId: ShellId
  readonly label: string
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly createdAt: number
  /**
   * Lifecycle state when described. Optional for backward compatibility;
   * `failedTeardown` marks a terminal whose close could not be proven (input
   * blocked, close may be retried).
   */
  readonly state?: TerminalState
}

/** One multiplexed event about some terminal in a subscribed workspace. */
export type TerminalEvent =
  | { readonly kind: 'created'; readonly terminal: TerminalInfo }
  | { readonly kind: 'data'; readonly terminalId: string; readonly data: string }
  | { readonly kind: 'exit'; readonly terminalId: string; readonly exitCode: number; readonly reason: TerminalExitReason }

export type TerminalListener = (event: TerminalEvent) => void

/**
 * The subset of a PTY process this service relies on. Both adapters provide the
 * required members; the optional ones are teardown hooks only the built-in Bun
 * (POSIX) adapter provides.
 */
export interface PtyHandle {
  /** May return a disposable (`{ dispose() }`), which is released once the terminal has exited. */
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Request termination with the backend's own close semantics (bun-pty: ConPTY close; Bun adapter: SIGHUP). */
  kill(): void
  /** Shell PID. Used on POSIX to own the PTY session's processes. */
  readonly pid?: number
  /** Close the PTY master. Idempotent. */
  closeTerminal?(): void
  /** Signal the direct child through the backend, which must refuse once the child is reaped. */
  signal?(signal: TeardownSignal): void
}

/** Options passed through to the PTY implementation. */
export interface PtySpawnOptions {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Record<string, string>
}

/** Injectable PTY backend — the test suite supplies a fake, so the suite needs no native module. */
export interface PtySpawner {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyHandle
}

/** Failure kinds the HTTP layer maps onto status codes. */
export type TerminalErrorCode = 'unavailable' | 'not-found' | 'bad-shell' | 'closing' | 'teardown-failed'

export class TerminalError extends Error {
  constructor(readonly code: TerminalErrorCode, message: string) {
    super(message)
    this.name = 'TerminalError'
  }
}

/** What a failed teardown left behind. PIDs are operator diagnostics: log them, never send them to a client. */
export interface TeardownReport {
  readonly terminalId: string
  readonly shellPid: number | undefined
  readonly session: string | undefined
  readonly remainingPids: readonly number[]
  readonly detail: string
}

/** Thrown by `disposeAll` when some terminal could not be proven gone inside the budget. */
export class TerminalTeardownError extends Error {
  constructor(readonly reports: readonly TeardownReport[]) {
    super(
      `terminal teardown incomplete for ${reports.length} terminal(s): ` +
        reports.map((r) => `${r.terminalId} shell=${r.shellPid ?? '?'} session=${r.session ?? '?'} remaining=[${r.remainingPids.join(',')}] (${r.detail})`).join('; '),
    )
    this.name = 'TerminalTeardownError'
  }
}

/** Input for opening a terminal. `cwd` is resolved by the caller, which owns project binding. */
export interface CreateTerminalInput {
  readonly workspaceId: WorkspaceId
  readonly cwd: string
  /** Set when the shell belongs to a project; omitted for the host default folder. */
  readonly projectId?: ProjectId
  readonly shellId?: ShellId
  readonly cols?: number
  readonly rows?: number
}

export interface TerminalServiceOptions {
  readonly spawner?: PtySpawner
  readonly scrollbackChars?: number
  readonly idleMs?: number
  readonly reapIntervalMs?: number
  /**
   * POSIX session inspection. Defaults to the platform's (`/proc` on Linux,
   * `ps` on macOS, none on Windows). `null` disables session-member teardown.
   */
  readonly inspector?: ProcessInspector | null
  /** Teardown timings (tests shorten them). */
  readonly teardown?: { readonly escalateMs?: number; readonly killGraceMs?: number; readonly pollMs?: number }
}

export interface TerminalService {
  /** Whether a PTY backend resolved. Unknown until `probe()` or the first `create()`. */
  readonly available: boolean
  probe(): Promise<{ available: boolean; hint: string }>
  shells(): ShellOption[]
  /** Every record still held, including `closing` and `failedTeardown` ones. */
  list(workspaceId: WorkspaceId): TerminalInfo[]
  get(id: string): TerminalInfo | undefined
  state(id: string): TerminalState | undefined
  create(input: CreateTerminalInput): Promise<TerminalInfo>
  /** Throws `closing` once teardown has begun: input stops at the first close request. */
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /**
   * Physically tear the terminal down. Resolves once the shell and its
   * session's ordinary jobs are gone; rejects with `teardown-failed` (record
   * kept, retry allowed) otherwise. Concurrent calls share one teardown.
   */
  kill(id: string): Promise<void>
  scrollback(id: string): string
  subscribe(workspaceId: WorkspaceId, listener: TerminalListener): () => void
  /** Stop the reaper and tear every terminal down concurrently within `budgetMs`. */
  disposeAll(options?: { readonly budgetMs?: number }): Promise<void>
}

interface LiveTerminal {
  /**
   * Mutable: `resize` updates it in place. Replacing the record instead would
   * leave the `onData`/`onExit` closures bound to the previous object while the
   * map held a new one, quietly splitting one terminal's scrollback in two.
   */
  info: TerminalInfo
  readonly pty: PtyHandle
  scrollback: string
  pending: string
  /** Set when a flush window overflowed, so the marker is emitted exactly once per window. */
  flooded: boolean
  flushTimer: ReturnType<typeof setTimeout> | undefined
  lastActivity: number
  state: TerminalState
  reason: TerminalExitReason
  exitCode: number
  /** The direct child's exit has been observed; never signal it through the backend after this. */
  processExited: boolean
  /** Shared teardown while `closing`. Cleared on failure so a retry starts a fresh one. */
  teardown: Promise<void> | undefined
  /** The shell's identity, captured after spawn; owned=false disables session-member teardown. */
  identity: Promise<{ self: ProcessIdentity; owned: boolean } | undefined>
  /** Disposables returned by the backend's `onData`/`onExit`. */
  readonly disposables: unknown[]
  lastReport: TeardownReport | undefined
}

/**
 * The slice of Bun's built-in PTY (`Bun.spawn({ terminal })`, POSIX only) used
 * here. Verified against Bun 1.4.3 at runtime: `Subprocess` has `pid`,
 * `kill(signal)`, `exited`, `exitCode`, `terminal`; `Terminal` has `write`,
 * `resize`, `close` (idempotent) and `closed`. `kill` after the child was
 * reaped is a no-op rather than a signal to a reused PID.
 */
export interface BunPtyRuntime {
  spawn(cmd: string[], options: {
    cwd: string
    env: Record<string, string>
    terminal: { cols: number; rows: number; name: string; data(terminal: unknown, chunk: Uint8Array): void }
  }): {
    readonly pid: number
    terminal: { write(data: string): void; resize(cols: number, rows: number): void; close(): void }
    kill(signal?: number | string): void
    exited: Promise<number | null>
    exitCode: number | null
  }
}

/** Bun's own PTY (`Bun.spawn({ terminal })`). POSIX only. */
export function bunPtySpawner(bun: BunPtyRuntime): PtySpawner {
  return {
    spawn(file, args, options) {
      const dataListeners = new Set<(data: string) => void>()
      const decoder = new TextDecoder()
      const proc = bun.spawn([file, ...args], {
        cwd: options.cwd,
        env: options.env,
        terminal: {
          cols: options.cols,
          rows: options.rows,
          name: options.name,
          data: (_terminal, chunk) => {
            const text = decoder.decode(chunk, { stream: true })
            for (const listener of dataListeners) listener(text)
          },
        },
      })
      return {
        pid: proc.pid,
        onData: (listener) => {
          dataListeners.add(listener)
          return { dispose: () => dataListeners.delete(listener) }
        },
        onExit: (listener) => void proc.exited.then(
          () => listener({ exitCode: proc.exitCode ?? 0 }),
          () => listener({ exitCode: proc.exitCode ?? 1 }),
        ),
        write: (data) => proc.terminal.write(data),
        resize: (cols, rows) => proc.terminal.resize(cols, rows),
        // An explicit hang-up, not Bun's default SIGTERM: HUP is what a closed
        // terminal means to a shell, and an interactive bash ignores TERM.
        kill: () => proc.kill('SIGHUP'),
        signal: (signal) => proc.kill(signal),
        closeTerminal: () => proc.terminal.close(),
      }
    },
  }
}

/**
 * The slice of `bun-pty`'s `IPty` used here. Behaviour verified against
 * bun-pty 0.5.1 on Windows (ConPTY via portable-pty):
 * - `kill()` terminates the child, closes the PTY handle, then fires a
 *   synthetic `onExit({ exitCode: 0 })` synchronously, and later calls are
 *   no-ops. The read loop stops, so the real exit is never reported after a
 *   kill.
 * - A natural exit fires `onExit` once, but does NOT release the native handle:
 *   only `kill()` reaches `bun_pty_close`. Without it every exited terminal
 *   keeps its ConPTY and console host alive (measured: +1 conhost per exit).
 * - Exit codes are passed through as reported. PowerShell and Git Bash report
 *   the shell's code; cmd was measured reporting 1 for `exit 0` on some runs.
 * - Background jobs of cmd/PowerShell/Git Bash died with the shell (ConPTY
 *   closes the whole console session).
 * - Importing the package swallows a failed `dlopen` (it logs and leaves the
 *   library unset), so `loadBunPty` checks the library loads before use.
 */
export interface BunPtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): {
    readonly pid: number
    onData(listener: (data: string) => void): { dispose(): void }
    onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
  }
}

/**
 * EPERM counts as alive: it means a process we may not signal holds the PID,
 * which after our shell exited can only be a reused PID. Reporting that as
 * "alive" errs toward a failed (retryable) teardown, never a false success.
 */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * `bun-pty` adapter (Windows). It reports exactly one exit per terminal, only
 * once the shell PID is actually gone: the synthetic exit `kill()` fires is
 * held until the process has disappeared, so teardown never confirms on an
 * event alone. A shell still alive at the deadline is not reported; the
 * service's teardown then fails explicitly, and its retry calls `kill()`
 * again, which restarts the confirmation.
 */
export function bunPtyLibSpawner(lib: BunPtyModule, options: { pollMs?: number; deadlineMs?: number } = {}): PtySpawner {
  const pollMs = options.pollMs ?? 25
  const deadlineMs = options.deadlineMs ?? 10_000
  return {
    spawn(file, args, spawnOptions) {
      const pty = lib.spawn(file, [...args], {
        name: spawnOptions.name,
        cols: spawnOptions.cols,
        rows: spawnOptions.rows,
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
      })
      const pid = pty.pid
      const exitListeners = new Set<(event: { exitCode: number }) => void>()
      let killed = false
      let reported = false
      let confirming = false
      const report = (exitCode: number): void => {
        if (reported) return
        reported = true
        for (const listener of [...exitListeners]) listener({ exitCode })
      }
      /** Report the exit once the PID is gone; give up at the deadline (a later kill() retries). */
      const confirmGone = (exitCode: number): void => {
        if (confirming || reported) return
        confirming = true
        const deadline = Date.now() + deadlineMs
        const tick = (): void => {
          if (!isAlive(pid)) {
            confirming = false
            return report(exitCode)
          }
          if (Date.now() >= deadline) {
            confirming = false
            return
          }
          const timer = setTimeout(tick, pollMs)
          timer.unref?.()
        }
        tick()
      }
      pty.onExit((event) => {
        if (killed) {
          // Synthetic exit from kill(): confirm against the OS, not the event.
          confirmGone(event.exitCode)
          return
        }
        // Natural exit: report the real code, then release the native handle.
        // bun-pty frees the ConPTY/console host only in kill(); the synthetic
        // exit that kill() fires is ignored because `reported` is already set.
        report(event.exitCode)
        killed = true
        try { pty.kill() } catch { /* the process is already gone */ }
      })
      return {
        pid,
        onData: (listener) => pty.onData(listener),
        onExit: (listener) => {
          exitListeners.add(listener)
          // The library-side listener stays: it must still release the native
          // handle on a natural exit even when nobody is listening any more.
          return { dispose: () => exitListeners.delete(listener) }
        },
        write: (data) => pty.write(data),
        resize: (cols, rows) => pty.resize(cols, rows),
        kill: () => {
          if (reported) return
          if (killed) {
            // A retry after a failed teardown: bun-pty's kill() is a no-op by
            // now, so re-check whether the shell has gone since.
            confirmGone(0)
            return
          }
          killed = true
          pty.kill()
        },
      }
    },
  }
}

/** The PTY library file bun-pty itself would load (its `BUN_PTY_LIB` override first). */
function bunPtyLibraryPath(): string {
  const override = process.env['BUN_PTY_LIB']
  if (override !== undefined && override !== '' && existsSync(override)) return override
  const pkgDir = path.dirname(createRequire(import.meta.url).resolve('bun-pty/package.json'))
  const name = process.arch === 'arm64' ? 'rust_pty_arm64.dll' : 'rust_pty.dll'
  return path.join(pkgDir, 'rust-pty', 'target', 'release', name)
}

/**
 * Load bun-pty and prove its native library opens. bun-pty's own import logs
 * and swallows a failed `dlopen` (wrong architecture, quarantined DLL), which
 * would leave the backend "available" with every spawn failing as a bad
 * shell. Opening the same file here turns that into a reported unavailability.
 */
async function loadBunPty(): Promise<BunPtyModule> {
  const file = bunPtyLibraryPath()
  if (!existsSync(file)) throw new Error(`PTY library not found at ${file}`)
  // A variable specifier: the repo carries no Bun type package, and this path
  // only runs under Bun (defaultSpawner checks for the runtime first).
  const ffiModule = 'bun:ffi'
  const ffi = (await import(ffiModule)) as {
    dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { close(): void }
  }
  ffi.dlopen(file, { bun_pty_get_pid: { args: ['i32'], returns: 'i32' } }).close()
  return (await import('bun-pty')) as unknown as BunPtyModule
}

/** The default backend: Bun's PTY on POSIX Bun, otherwise `bun-pty`, loaded on first use. */
function defaultSpawner(): { spawner: PtySpawner; load: () => Promise<string | undefined> } {
  const bun = (globalThis as { Bun?: BunPtyRuntime }).Bun
  if (bun !== undefined && process.platform !== 'win32') {
    return { spawner: bunPtySpawner(bun), load: async () => undefined }
  }
  let loaded: PtySpawner | undefined
  let failure: string | undefined
  const load = async (): Promise<string | undefined> => {
    if (loaded !== undefined || failure !== undefined) return failure
    if (bun === undefined) {
      failure = 'terminals need the Bun runtime (bun-pty loads its PTY library through bun:ffi)'
      return failure
    }
    try {
      loaded = bunPtyLibSpawner(await loadBunPty())
      return undefined
    } catch (error) {
      // Mirrors how the Bash tool disables itself: an actionable reason, never
      // a silent substitution.
      failure = `bun-pty is not available (${String(error)}); reinstall dependencies with 'bun install'`
      return failure
    }
  }
  return {
    load,
    spawner: {
      spawn(file, args, options) {
        if (loaded === undefined) throw new TerminalError('unavailable', failure ?? 'bun-pty is not loaded')
        return loaded.spawn(file, args, options)
      },
    },
  }
}

/** Environment for a PTY: the host's, minus unset keys, plus a colour-capable TERM. */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env['TERM'] = 'xterm-256color'
  return env
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

function disposeQuietly(disposable: unknown): void {
  try {
    if (typeof disposable === 'object' && disposable !== null && typeof (disposable as { dispose?: unknown }).dispose === 'function') {
      ;(disposable as { dispose(): void }).dispose()
    }
  } catch {
    // A backend's listener cleanup failing must not change the teardown outcome.
  }
}

export function createTerminalService(options: TerminalServiceOptions = {}): TerminalService {
  const scrollbackChars = options.scrollbackChars ?? SCROLLBACK_CHARS
  const idleMs = options.idleMs ?? IDLE_MS
  const reapIntervalMs = options.reapIntervalMs ?? REAP_INTERVAL_MS
  const inspector = options.inspector === undefined ? platformInspector() : options.inspector
  const escalateMs = options.teardown?.escalateMs ?? ESCALATE_MS
  const killGraceMs = options.teardown?.killGraceMs ?? KILL_GRACE_MS
  const pollMs = options.teardown?.pollMs ?? POLL_MS

  const fallback = defaultSpawner()
  const backendName = process.platform === 'win32' ? 'bun-pty' : 'bun'
  const injected = options.spawner
  const terminals = new Map<string, LiveTerminal>()
  const listeners = new Map<WorkspaceId, Set<TerminalListener>>()
  let available = injected !== undefined
  let hint = injected !== undefined ? 'injected spawner' : 'not probed'
  let disposed = false

  function emit(workspaceId: WorkspaceId, event: TerminalEvent): void {
    const set = listeners.get(workspaceId)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must not break teardown or other subscribers.
      }
    }
  }

  function flush(live: LiveTerminal): void {
    if (live.flushTimer !== undefined) clearTimeout(live.flushTimer)
    live.flushTimer = undefined
    if (live.pending === '') return
    let payload = live.pending
    live.pending = ''
    if (live.flooded) {
      live.flooded = false
      payload += '\r\n[output truncated: too fast]\r\n'
    }
    live.scrollback += payload
    if (live.scrollback.length > scrollbackChars) {
      let start = live.scrollback.length - scrollbackChars
      // Never start on the low half of a surrogate pair: a lone half would
      // replay as U+FFFD at the head of every reattach.
      const code = live.scrollback.charCodeAt(start)
      if (code >= 0xdc00 && code <= 0xdfff) start += 1
      live.scrollback = live.scrollback.slice(start)
    }
    emit(live.info.workspaceId, { kind: 'data', terminalId: live.info.id, data: payload })
  }

  function onData(live: LiveTerminal, chunk: string): void {
    // A closing PTY can still emit buffered output. Without this the terminal
    // would publish a `data` frame after its own `exit`, and a dying record
    // would keep scheduling flushes.
    if (live.state !== 'running') return
    live.lastActivity = Date.now()
    if (live.pending.length + chunk.length > FLUSH_CEILING_CHARS) {
      // Keep the head of the window and mark the discard, rather than letting
      // an unbounded producer dictate this process's memory.
      const room = Math.max(0, FLUSH_CEILING_CHARS - live.pending.length)
      live.pending += chunk.slice(0, room)
      live.flooded = true
    } else {
      live.pending += chunk
    }
    if (live.flushTimer === undefined) {
      live.flushTimer = setTimeout(() => flush(live), FLUSH_INTERVAL_MS)
      live.flushTimer.unref?.()
    }
  }

  /** Read the shell's identity, retrying briefly while the child finishes `setsid`. */
  async function captureIdentity(pid: number | undefined): Promise<{ self: ProcessIdentity; owned: boolean } | undefined> {
    if (inspector === null || pid === undefined) return undefined
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const self = await inspector.identity(pid)
        if (self === undefined) return undefined
        if (await inspector.ownsSession(self)) return { self, owned: true }
        await sleep(20)
      }
      const self = await inspector.identity(pid)
      return self === undefined ? undefined : { self, owned: false }
    } catch {
      return undefined
    }
  }

  /** Re-read identity right before signalling; skip anything that is no longer the process we enumerated. */
  async function signalMembers(members: readonly ProcessIdentity[], signal: TeardownSignal, errors: unknown[]): Promise<void> {
    if (inspector === null) return
    await Promise.all(members.map(async (member) => {
      try {
        const current = await inspector.identity(member.pid)
        if (current === undefined || current.start !== member.start) return
        if (inspector.sessionStable && current.session !== member.session) return
        inspector.signal(member.pid, signal)
      } catch (error) {
        errors.push(error)
      }
    }))
  }

  /**
   * Anchored view of the terminal's session. A session token alone is not
   * proof of ownership, so:
   *  - if a process with the shell's PID exists with a different start time,
   *    the session (or tty) was reused: treat it as empty and stop sweeping;
   *  - a member is accepted only if it is already known (pid + start), or its
   *    parent chain inside the session reaches a known member. Known members
   *    are seeded from the shell and the pre-close snapshot.
   */
  function sessionView(owned: ProcessIdentity) {
    const known = new Map<number, string>([[owned.pid, owned.start]])
    let reused = false
    const startNumber = (start: string): number | undefined => (/^\d+$/.test(start) ? Number(start) : undefined)
    return {
      get reused() {
        return reused
      },
      async scan(seed: boolean): Promise<ProcessIdentity[]> {
        if (inspector === null || reused) return []
        const members = await inspector.members(owned.session)
        const byPid = new Map(members.map((member) => [member.pid, member]))
        const anchor = byPid.get(owned.pid)
        if (anchor !== undefined && anchor.start !== owned.start) {
          reused = true
          return []
        }
        if (seed) {
          // Pre-close snapshot. With the shell alive and matching, the whole
          // session is ours. With the shell already gone (natural exit, taken
          // within ms of the exit), only processes that cannot predate the
          // shell are seeded — Linux start times are comparable tick counts.
          const ownedStart = startNumber(owned.start)
          for (const member of members) {
            const memberStart = startNumber(member.start)
            const plausible = anchor !== undefined || ownedStart === undefined || memberStart === undefined || memberStart >= ownedStart
            if (plausible) known.set(member.pid, member.start)
          }
        }
        const admit = (member: ProcessIdentity, depth: number): boolean => {
          if (known.get(member.pid) === member.start) return true
          if (depth > 64 || member.ppid === undefined || member.ppid === member.pid) return false
          const parent = byPid.get(member.ppid)
          if (parent === undefined || !admit(parent, depth + 1)) return false
          known.set(member.pid, member.start)
          return true
        }
        return members.filter((member) => admit(member, 0))
      },
    }
  }

  /** Members still alive. Linux rescans the (stable, anchored) session; macOS re-checks the pre-close snapshot only. */
  async function remaining(view: ReturnType<typeof sessionView> | undefined, snapshot: readonly ProcessIdentity[]): Promise<ProcessIdentity[]> {
    if (inspector === null || view === undefined) return []
    if (inspector.sessionStable) return view.scan(false)
    const alive = await Promise.all(snapshot.map(async (member) => {
      const current = await inspector.identity(member.pid)
      return current !== undefined && current.start === member.start ? member : undefined
    }))
    return alive.filter((member): member is ProcessIdentity => member !== undefined)
  }

  async function runTeardown(live: LiveTerminal): Promise<void> {
    const errors: unknown[] = []
    // If the shell exited before its identity could be read (within ms of
    // spawn), there is no anchored session to sweep: only the backend's own
    // close/HUP/KILL runs. A job started in that window would be missed.
    const shell = await live.identity
    const owned = shell?.owned === true ? shell.self : undefined
    const view = owned === undefined ? undefined : sessionView(owned)
    // Snapshot before the PTY closes: on macOS the tty name stops identifying
    // this session once it is released.
    let snapshot: ProcessIdentity[] = []
    if (view !== undefined) {
      try { snapshot = await view.scan(true) } catch (error) { errors.push(error) }
    }

    try { live.pty.closeTerminal?.() } catch (error) { errors.push(error) }
    if (!live.processExited) {
      try { live.pty.kill() } catch (error) { errors.push(error) }
    }
    await signalMembers(snapshot, 'SIGHUP', errors)
    // A stopped job (Ctrl-Z) only acts on HUP once continued.
    if (!live.processExited) {
      try { live.pty.signal?.('SIGCONT') } catch (error) { errors.push(error) }
    }
    await signalMembers(snapshot, 'SIGCONT', errors)

    let left: ProcessIdentity[] = []
    const settled = async (budgetMs: number): Promise<boolean> => {
      const deadline = Date.now() + budgetMs
      while (true) {
        try {
          left = await remaining(view, snapshot)
        } catch (error) {
          errors.push(error)
          left = []
        }
        if (live.processExited && left.length === 0) return true
        const wait = deadline - Date.now()
        if (wait <= 0) return false
        await sleep(Math.min(pollMs, wait))
      }
    }

    if (!(await settled(escalateMs))) {
      if (!live.processExited) {
        try { live.pty.signal?.('SIGKILL') } catch (error) { errors.push(error) }
      }
      await signalMembers(left, 'SIGKILL', errors)
      if (!(await settled(killGraceMs))) {
        const detail = !live.processExited
          ? 'shell did not exit after HUP and KILL'
          : `${left.length} session member(s) survived KILL`
        live.lastReport = {
          terminalId: live.info.id,
          shellPid: live.pty.pid,
          session: owned?.session,
          remainingPids: left.map((member) => member.pid),
          detail: errors.length > 0 ? `${detail}; errors: ${errors.map(String).join(' | ')}` : detail,
        }
        throw new TerminalError('teardown-failed', `terminal '${live.info.id}' could not be stopped: ${detail}; retry the close`)
      }
    }
    live.lastReport = undefined
  }

  function finish(live: LiveTerminal): void {
    if (live.state === 'exited') return
    live.state = 'exited'
    live.teardown = undefined
    flush(live)
    for (const disposable of live.disposables.splice(0)) disposeQuietly(disposable)
    terminals.delete(live.info.id)
    emit(live.info.workspaceId, { kind: 'exit', terminalId: live.info.id, exitCode: live.exitCode, reason: live.reason })
  }

  /** The single close path. Idempotent while closing; a retry after `failedTeardown`. */
  function closeLive(live: LiveTerminal, reason: TerminalExitReason): Promise<void> {
    if (live.state === 'exited') return Promise.resolve()
    if (live.teardown !== undefined) return live.teardown
    if (live.state === 'running') {
      live.reason = reason
      if (reason !== 'exit') live.exitCode = 0
      // Buffered output goes out before input stops and before the exit frame.
      flush(live)
    }
    // Input stops now (`write`/`resize` require `running`).
    live.state = 'closing'
    const teardown = runTeardown(live).then(
      () => finish(live),
      (error: unknown) => {
        live.state = 'failedTeardown'
        live.teardown = undefined
        throw error instanceof TerminalError ? error : new TerminalError('teardown-failed', String(error))
      },
    )
    live.teardown = teardown
    return teardown
  }

  /** Fire-and-forget closes (natural exit, reaper) must never become unhandled rejections. */
  function closeQuietly(live: LiveTerminal, reason: TerminalExitReason): void {
    closeLive(live, reason).catch(() => {})
  }

  function describe(live: LiveTerminal): TerminalInfo {
    return { ...live.info, state: live.state }
  }

  function lookup(id: string): LiveTerminal {
    const live = terminals.get(id)
    if (live === undefined) throw new TerminalError('not-found', `unknown terminal '${id}'`)
    return live
  }

  function lookupRunning(id: string): LiveTerminal {
    const live = lookup(id)
    if (live.state !== 'running') throw new TerminalError('closing', `terminal '${id}' is ${live.state === 'failedTeardown' ? 'stuck closing; retry the close' : 'closing'}`)
    return live
  }

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const live of [...terminals.values()]) {
      if (live.state === 'failedTeardown') closeQuietly(live, live.reason)
      else if (live.state === 'running' && now - live.lastActivity >= idleMs) closeQuietly(live, 'idle')
    }
  }, reapIntervalMs)
  reaper.unref?.()

  return {
    get available() {
      return available
    },

    async probe() {
      if (injected !== undefined) return { available: true, hint }
      const failure = await fallback.load()
      available = failure === undefined
      hint = failure ?? backendName
      return { available, hint }
    },

    shells() {
      return shellCatalog()
    },

    list(workspaceId) {
      return [...terminals.values()]
        .filter((live) => live.info.workspaceId === workspaceId)
        .map(describe)
    },

    get(id) {
      const live = terminals.get(id)
      return live === undefined ? undefined : describe(live)
    },

    state(id) {
      return terminals.get(id)?.state
    },

    async create(input) {
      if (disposed) throw new TerminalError('unavailable', 'the terminal service is shutting down')
      if (injected === undefined) {
        const failure = await fallback.load()
        available = failure === undefined
        hint = failure ?? backendName
        if (failure !== undefined) throw new TerminalError('unavailable', failure)
      }
      const catalog = shellCatalog()
      const shell = input.shellId === undefined
        ? catalog[0]
        : catalog.find((option) => option.id === input.shellId)
      if (shell === undefined) {
        throw new TerminalError('bad-shell', `no usable shell for '${input.shellId ?? 'default'}' on this host`)
      }
      const cols = input.cols ?? 80
      const rows = input.rows ?? 24
      const spawner = injected ?? fallback.spawner
      let pty: PtyHandle
      try {
        pty = spawner.spawn(shell.executable, shell.args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: input.cwd,
          env: ptyEnv(),
        })
      } catch (error) {
        // A raw spawn failure would escape as a 500 carrying the shell path and
        // command line. Report the backend's own reason (e.g. bun-pty's
        // "PTY spawn failed") without the host's file layout.
        if (error instanceof TerminalError) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new TerminalError('bad-shell', `could not start ${shell.label} in '${input.cwd}': ${reason}`)
      }
      const info: TerminalInfo = {
        id: `terminal-${randomUUID()}`,
        workspaceId: input.workspaceId,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        shellId: shell.id,
        label: shell.label,
        cwd: input.cwd,
        cols,
        rows,
        createdAt: Date.now(),
      }
      const live: LiveTerminal = {
        info,
        pty,
        scrollback: '',
        pending: '',
        flooded: false,
        flushTimer: undefined,
        lastActivity: Date.now(),
        state: 'running',
        reason: 'exit',
        exitCode: 0,
        processExited: false,
        teardown: undefined,
        identity: captureIdentity(pty.pid),
        disposables: [],
        lastReport: undefined,
      }
      live.disposables.push(pty.onData((chunk) => onData(live, chunk)))
      live.disposables.push(pty.onExit((event) => {
        if (live.processExited) return
        live.processExited = true
        if (live.state === 'running') {
          live.exitCode = event.exitCode
          // Natural exit still closes the PTY, sweeps the session's jobs and
          // disposes listeners — not just forgets the record.
          closeQuietly(live, 'exit')
        } else if (live.state === 'failedTeardown') {
          // The stuck shell finally died: retry now rather than at the next reap.
          closeQuietly(live, live.reason)
        }
      }))
      // `disposeAll` may have started while the backend was loading or the
      // shell spawning; a terminal registered now would escape its sweep.
      if (disposed) {
        live.reason = 'killed'
        live.state = 'closing'
        await runTeardown(live).catch(() => {})
        for (const disposable of live.disposables.splice(0)) disposeQuietly(disposable)
        throw new TerminalError('unavailable', 'the terminal service is shutting down')
      }
      terminals.set(info.id, live)
      const described = describe(live)
      emit(input.workspaceId, { kind: 'created', terminal: described })
      return described
    },

    write(id, data) {
      const live = lookupRunning(id)
      live.lastActivity = Date.now()
      live.pty.write(data)
    },

    resize(id, cols, rows) {
      const live = lookupRunning(id)
      live.lastActivity = Date.now()
      live.pty.resize(cols, rows)
      // `info` is the client's view of the terminal, so it must follow the PTY.
      live.info = { ...live.info, cols, rows }
    },

    kill(id) {
      try {
        return closeLive(lookup(id), 'killed')
      } catch (error) {
        return Promise.reject(error)
      }
    },

    scrollback(id) {
      return lookup(id).scrollback
    },

    subscribe(workspaceId, listener) {
      let set = listeners.get(workspaceId)
      if (set === undefined) {
        set = new Set()
        listeners.set(workspaceId, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(workspaceId)
        if (current === undefined) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(workspaceId)
      }
    },

    async disposeAll(disposeOptions = {}) {
      disposed = true
      clearInterval(reaper)
      const budgetMs = disposeOptions.budgetMs ?? TERMINAL_SHUTDOWN_BUDGET_MS
      const all = [...terminals.values()]
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled(all.map((live) => closeLive(live, 'killed'))),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs) }),
        ])
      } finally {
        clearTimeout(timer)
      }
      const left = [...terminals.values()]
      listeners.clear()
      if (left.length === 0) return
      throw new TerminalTeardownError(left.map((live) => live.lastReport ?? {
        terminalId: live.info.id,
        shellPid: live.pty.pid,
        session: undefined,
        remainingPids: [],
        detail: `still ${live.state} when the ${budgetMs}ms shutdown budget ran out`,
      }))
    },
  }
}
