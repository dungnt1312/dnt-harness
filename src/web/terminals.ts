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
 * `node-pty` is imported lazily and its absence is a reported state, never a
 * boot failure: the rest of the product must serve normally on a machine where
 * the native module never built.
 */
import { randomUUID } from 'node:crypto'
import { shellCatalog, type ShellId, type ShellOption } from '../capabilities/shell/detect.ts'
import type { ProjectId, WorkspaceId } from '../util/brand.ts'

/** Live terminals allowed per workspace. */
const MAX_PER_WORKSPACE = 4
/** Scrollback retained per terminal, in characters. */
const SCROLLBACK_CHARS = 256_000
/** Output is coalesced into one frame per this many ms, never one per chunk. */
const FLUSH_INTERVAL_MS = 16
/** A single flush larger than this is truncated: a runaway `yes` must not grow the queue. */
const FLUSH_CEILING_CHARS = 1_000_000
/** Terminals idle longer than this are reaped. */
const IDLE_MS = 30 * 60 * 1000
/** How often the reaper looks for idle terminals. */
const REAP_INTERVAL_MS = 60_000

/** Why a terminal ended. */
export type TerminalExitReason = 'exit' | 'killed' | 'idle'

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
}

/** One multiplexed event about some terminal in a subscribed workspace. */
export type TerminalEvent =
  | { readonly kind: 'created'; readonly terminal: TerminalInfo }
  | { readonly kind: 'data'; readonly terminalId: string; readonly data: string }
  | { readonly kind: 'exit'; readonly terminalId: string; readonly exitCode: number; readonly reason: TerminalExitReason }

export type TerminalListener = (event: TerminalEvent) => void

/** The subset of a `node-pty` process this service relies on. */
export interface PtyHandle {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** Options passed through to the PTY implementation. */
export interface PtySpawnOptions {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Record<string, string>
  /**
   * Windows only. node-pty's default kill path forks a
   * `conpty_console_list_agent` helper to enumerate console processes; once
   * the shell has already exited that helper dies with `AttachConsole failed`
   * and prints a stack trace, which would appear on every terminal close and
   * four times over on shutdown. The DLL path forks nothing. Both were
   * measured to reap a backgrounded grandchild, so this buys quiet without
   * giving up cleanup. The DLL ships with the same post-install step that
   * places the native binding, so if `node-pty` imported at all, it is there.
   */
  readonly useConptyDll?: boolean
}

/** Injectable PTY backend — the test suite supplies a fake, so the suite needs no native module. */
export interface PtySpawner {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyHandle
}

/** Failure kinds the HTTP layer maps onto status codes. */
export type TerminalErrorCode = 'unavailable' | 'cap' | 'not-found' | 'bad-shell'

export class TerminalError extends Error {
  constructor(readonly code: TerminalErrorCode, message: string) {
    super(message)
    this.name = 'TerminalError'
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
  readonly maxPerWorkspace?: number
  readonly scrollbackChars?: number
  readonly idleMs?: number
  readonly reapIntervalMs?: number
}

export interface TerminalService {
  /** Whether a PTY backend resolved. Unknown until `probe()` or the first `create()`. */
  readonly available: boolean
  probe(): Promise<{ available: boolean; hint: string }>
  shells(): ShellOption[]
  list(workspaceId: WorkspaceId): TerminalInfo[]
  get(id: string): TerminalInfo | undefined
  create(input: CreateTerminalInput): Promise<TerminalInfo>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  scrollback(id: string): string
  subscribe(workspaceId: WorkspaceId, listener: TerminalListener): () => void
  disposeAll(): void
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
  closed: boolean
}

/** The default backend: `node-pty`, loaded on first use. */
function nodePtySpawner(): { spawner: PtySpawner; load: () => Promise<string | undefined> } {
  let loaded: { spawn: (file: string, args: string[], opts: unknown) => PtyHandle } | undefined
  let failure: string | undefined
  const load = async (): Promise<string | undefined> => {
    if (loaded !== undefined || failure !== undefined) return failure
    try {
      loaded = (await import('node-pty')) as unknown as typeof loaded
      return undefined
    } catch (error) {
      // Mirrors how the Bash tool disables itself: an actionable reason, never
      // a silent substitution.
      failure =
        `node-pty is not available (${String(error)}); install it and allow its build ` +
        `(pnpm: allowBuilds, npm: 'npm install-scripts approve node-pty')`
      return failure
    }
  }
  return {
    load,
    spawner: {
      spawn(file, args, options) {
        if (loaded === undefined) throw new TerminalError('unavailable', failure ?? 'node-pty is not loaded')
        return loaded.spawn(file, [...args], options)
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

export function createTerminalService(options: TerminalServiceOptions = {}): TerminalService {
  const maxPerWorkspace = options.maxPerWorkspace ?? MAX_PER_WORKSPACE
  const scrollbackChars = options.scrollbackChars ?? SCROLLBACK_CHARS
  const idleMs = options.idleMs ?? IDLE_MS
  const reapIntervalMs = options.reapIntervalMs ?? REAP_INTERVAL_MS

  const fallback = nodePtySpawner()
  const injected = options.spawner
  const terminals = new Map<string, LiveTerminal>()
  const listeners = new Map<WorkspaceId, Set<TerminalListener>>()
  let available = injected !== undefined
  let hint = injected !== undefined ? 'injected spawner' : 'not probed'

  function emit(workspaceId: WorkspaceId, event: TerminalEvent): void {
    const set = listeners.get(workspaceId)
    if (set === undefined) return
    for (const listener of set) listener(event)
  }

  function flush(live: LiveTerminal): void {
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
      live.scrollback = live.scrollback.slice(live.scrollback.length - scrollbackChars)
    }
    emit(live.info.workspaceId, { kind: 'data', terminalId: live.info.id, data: payload })
  }

  function onData(live: LiveTerminal, chunk: string): void {
    // A killed PTY can still emit buffered output. Without this the terminal
    // would publish a `data` frame after its own `exit`, and a dead record
    // would keep scheduling flushes.
    if (live.closed) return
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

  function close(live: LiveTerminal, exitCode: number, reason: TerminalExitReason): void {
    if (live.closed) return
    live.closed = true
    if (live.flushTimer !== undefined) {
      clearTimeout(live.flushTimer)
      live.flushTimer = undefined
    }
    flush(live)
    terminals.delete(live.info.id)
    emit(live.info.workspaceId, { kind: 'exit', terminalId: live.info.id, exitCode, reason })
  }

  function lookup(id: string): LiveTerminal {
    const live = terminals.get(id)
    if (live === undefined) throw new TerminalError('not-found', `unknown terminal '${id}'`)
    return live
  }

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const live of [...terminals.values()]) {
      if (now - live.lastActivity < idleMs) continue
      try {
        live.pty.kill()
      } catch {
        // Already gone; the close below still notifies subscribers.
      }
      close(live, 0, 'idle')
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
      hint = failure ?? 'node-pty'
      return { available, hint }
    },

    shells() {
      return shellCatalog()
    },

    list(workspaceId) {
      return [...terminals.values()]
        .filter((live) => live.info.workspaceId === workspaceId)
        .map((live) => live.info)
    },

    get(id) {
      return terminals.get(id)?.info
    },

    async create(input) {
      if (injected === undefined) {
        const failure = await fallback.load()
        available = failure === undefined
        hint = failure ?? 'node-pty'
        if (failure !== undefined) throw new TerminalError('unavailable', failure)
      }
      const open = [...terminals.values()].filter((live) => live.info.workspaceId === input.workspaceId)
      if (open.length >= maxPerWorkspace) {
        throw new TerminalError('cap', `this workspace already has ${maxPerWorkspace} terminals open`)
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
          ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
        })
      } catch (error) {
        // A raw spawn failure would escape as a 500 carrying the shell path and
        // command line. Report the fact, not the host's layout.
        if (error instanceof TerminalError) throw error
        throw new TerminalError('bad-shell', `could not start ${shell.label} in '${input.cwd}'`)
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
        closed: false,
      }
      terminals.set(info.id, live)
      pty.onData((chunk) => onData(live, chunk))
      pty.onExit((event) => close(live, event.exitCode, 'exit'))
      emit(input.workspaceId, { kind: 'created', terminal: info })
      return info
    },

    write(id, data) {
      const live = lookup(id)
      live.lastActivity = Date.now()
      live.pty.write(data)
    },

    resize(id, cols, rows) {
      const live = lookup(id)
      live.lastActivity = Date.now()
      live.pty.resize(cols, rows)
      // `info` is the client's view of the terminal, so it must follow the PTY.
      live.info = { ...live.info, cols, rows }
    },

    kill(id) {
      const live = lookup(id)
      try {
        live.pty.kill()
      } catch {
        // Already dead; subscribers still need the exit.
      }
      close(live, 0, 'killed')
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

    disposeAll() {
      clearInterval(reaper)
      for (const live of [...terminals.values()]) {
        try {
          live.pty.kill()
        } catch {
          // Best effort: the host is going down either way.
        }
        close(live, 0, 'killed')
      }
      listeners.clear()
    },
  }
}
