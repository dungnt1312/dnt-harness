/**
 * PTY session membership for terminal teardown (RH-3).
 *
 * A POSIX PTY shell is started as a session leader (`setsid` + controlling
 * tty), so every ordinary job it starts — foreground or background, whatever
 * process group job control puts it in — stays in that session. Teardown
 * enumerates exactly those processes and nothing else: never an arbitrary
 * process group, never `kill(-pid)`.
 *
 * PID reuse: each member is recorded with its start time, and the identity is
 * re-read immediately before every signal. A process whose start time or
 * session changed is not the one we enumerated and is left alone.
 *
 * Linux reads `/proc/<pid>/stat`. macOS lists processes with `ps` and reads
 * each one's session id with getsid(2); see `createDarwinInspector`.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

/** One process as seen at a moment: PID, opaque session token, start-time identity. */
export interface ProcessIdentity {
  readonly pid: number
  /** Session token: the numeric session id (the leader's PID) on Linux and macOS. */
  readonly session: string
  /** Start-time identity. Linux: `/proc/<pid>/stat` field 22; macOS: `ps lstart`. */
  readonly start: string
  /** Parent PID (Linux stat field 4; macOS `ps ppid`). Used to admit newcomers only by descent. */
  readonly ppid?: number
}

export type TeardownSignal = 'SIGHUP' | 'SIGCONT' | 'SIGKILL'

/** Platform process inspection used by terminal teardown. Injectable for tests. */
export interface ProcessInspector {
  /**
   * Whether the session token stays bound to this terminal after its PTY is
   * closed. Linux and macOS session ids cannot be reallocated while any member
   * lives, so rescanning and re-checking the session are safe. An inspector
   * keyed on something reusable (a tty name) must say `false`: then only the
   * pre-close snapshot is trusted and identity is pid + start time.
   */
  readonly sessionStable: boolean
  /** Identity of a live (non-zombie) process, or `undefined` when gone. */
  identity(pid: number): Promise<ProcessIdentity | undefined>
  /** Live, non-zombie members of `session`. */
  members(session: string): Promise<ProcessIdentity[]>
  /** Whether `self` (the shell) owns a session the host process is not part of. */
  ownsSession(self: ProcessIdentity): Promise<boolean>
  /** Deliver `signal`; a vanished process (ESRCH) is not an error. */
  signal(pid: number, signal: TeardownSignal): void
}

function deliver(pid: number, signal: TeardownSignal): void {
  // Defence in depth: whatever enumeration said, never signal the host itself
  // or a non-positive PID (which would address a whole process group).
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Parse `/proc/<pid>/stat`. `comm` may contain spaces and parens, so split after the last `)`. */
export function parseProcStat(pid: number, raw: string): (ProcessIdentity & { readonly state: string }) | undefined {
  const close = raw.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = raw.slice(close + 2).trim().split(/\s+/)
  // fields[0] is stat field 3 (state); stat field N is fields[N - 3].
  const state = fields[0]
  const ppid = fields[1]
  const session = fields[3]
  const start = fields[19]
  if (state === undefined || ppid === undefined || session === undefined || start === undefined) return undefined
  return { pid, state, session, start, ppid: Number(ppid) }
}

const dead = (state: string): boolean => state === 'Z' || state === 'X' || state === 'x'

async function procStat(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const parsed = parseProcStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8'))
    if (parsed === undefined || dead(parsed.state)) return undefined
    return { pid: parsed.pid, session: parsed.session, start: parsed.start, ...(parsed.ppid !== undefined ? { ppid: parsed.ppid } : {}) }
  } catch {
    return undefined
  }
}

/**
 * One `/proc` scan shared by every concurrent caller for a few ms: sixteen
 * terminals polling during shutdown must not each walk `/proc` every tick.
 */
let scan: { readonly at: number; readonly result: Promise<ProcessIdentity[]> } | undefined
const SCAN_REUSE_MS = 20

async function scanProc(): Promise<ProcessIdentity[]> {
  const entries = await readdir('/proc')
  const stats = await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map((name) => procStat(Number(name))))
  return stats.filter((stat): stat is ProcessIdentity => stat !== undefined)
}

export const linuxInspector: ProcessInspector = {
  sessionStable: true,
  identity: procStat,
  async members(session) {
    const now = Date.now()
    if (scan === undefined || now - scan.at > SCAN_REUSE_MS) scan = { at: now, result: scanProc() }
    return (await scan.result).filter((stat) => stat.session === session)
  },
  async ownsSession(self) {
    // Session leader: its session id is its own PID, which is not the host's.
    return self.session === String(self.pid) && self.pid !== process.pid
  },
  signal: deliver,
}

/** One `ps` row: PID, parent PID and start-time identity. Zombies are dropped. */
export interface PsRow {
  readonly pid: number
  readonly ppid: number
  readonly start: string
}

/** Parse `ps -o pid=,ppid=,stat=,lstart=` lines. `lstart` contains spaces, so it is the tail. */
export function parsePsListing(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (match === null) continue
    const [, pid, ppid, state, start] = match
    if (pid === undefined || ppid === undefined || state === undefined || start === undefined) continue
    if (state.startsWith('Z')) continue
    rows.push({ pid: Number(pid), ppid: Number(ppid), start })
  }
  return rows
}

const PS_FIELDS = 'pid=,ppid=,stat=,lstart='

function ps(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', [...args], { encoding: 'utf8', timeout: 2_000 }, (error, stdout) => {
      if (error === null) return resolve(stdout)
      // `ps -p <gone>` exits 1 with an empty listing: "no such process".
      if ((error as { code?: unknown }).code === 1 && stdout.trim() === '') return resolve('')
      reject(error)
    })
  })
}

/** What the macOS inspector needs from the OS. Injectable so its logic is testable without real processes. */
export interface DarwinProcessSource {
  /** Run `ps` with these arguments and return its stdout (empty when no process matched). */
  ps(args: readonly string[]): Promise<string>
  /** getsid(2): the session id of `pid`, or -1 when it is gone. */
  getsid(pid: number): number
}

/**
 * macOS inspector. `ps` reports no usable session id there (its `sess` column
 * is always 0), and the controlling tty is no anchor either: the moment the
 * session leader exits, the kernel revokes the tty and every job left behind
 * shows `??` with parent 1 — exactly the jobs a natural-exit sweep is for. So
 * membership comes from getsid(2), which keeps answering for those orphans.
 * Like Linux, XNU never hands out a PID that is still in use as a session id,
 * so the session token stays bound to this terminal while any member lives.
 */
export function createDarwinInspector(source: DarwinProcessSource): ProcessInspector {
  let scanned: { readonly at: number; readonly result: Promise<ProcessIdentity[]> } | undefined
  const withSession = (rows: readonly PsRow[]): ProcessIdentity[] => {
    const out: ProcessIdentity[] = []
    for (const row of rows) {
      const sid = source.getsid(row.pid)
      if (sid > 0) out.push({ pid: row.pid, session: String(sid), start: row.start, ppid: row.ppid })
    }
    return out
  }
  return {
    sessionStable: true,
    async identity(pid) {
      return withSession(parsePsListing(await source.ps(['-o', PS_FIELDS, '-p', String(pid)])).filter((row) => row.pid === pid))[0]
    },
    async members(session) {
      // One `ps -A` shared by concurrent callers, as on Linux.
      const now = Date.now()
      if (scanned === undefined || now - scanned.at > SCAN_REUSE_MS) {
        scanned = { at: now, result: source.ps(['-A', '-o', PS_FIELDS]).then((text) => withSession(parsePsListing(text))) }
      }
      return (await scanned.result).filter((row) => row.session === session)
    },
    async ownsSession(self) {
      return self.session === String(self.pid) && self.pid !== process.pid
    },
    signal: deliver,
  }
}

type GetSid = (pid: number) => number
let getsid: GetSid | null | undefined

/** getsid(2) through `bun:ffi`, or `null` where it cannot load (not Bun, no libSystem). */
function loadGetSid(): GetSid | null {
  if (getsid !== undefined) return getsid
  getsid = null
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (bun === undefined) return getsid
  try {
    // A variable specifier: the repo carries no Bun type package, and this
    // path only runs under Bun. Bun resolves `bun:` modules synchronously.
    const ffiModule = 'bun:ffi'
    const ffi = createRequire(import.meta.url)(ffiModule) as {
      dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: Record<string, (...args: number[]) => number> }
    }
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', { getsid: { args: ['i32'], returns: 'i32' } })
    const call = lib.symbols['getsid']
    if (call !== undefined) getsid = (pid) => call(pid)
  } catch {
    getsid = null
  }
  return getsid
}

let darwinCached: ProcessInspector | null | undefined

/** The macOS inspector, or `null` when getsid(2) is unavailable (the terminals then run under Bun only anyway). */
export function darwinInspector(): ProcessInspector | null {
  if (darwinCached !== undefined) return darwinCached
  const sid = loadGetSid()
  darwinCached = sid === null ? null : createDarwinInspector({ ps, getsid: sid })
  return darwinCached
}

/** The inspector for this platform, or `null` where teardown relies on the PTY backend alone (Windows; macOS outside Bun). */
export function platformInspector(): ProcessInspector | null {
  if (process.platform === 'linux') return linuxInspector
  if (process.platform === 'darwin') return darwinInspector()
  return null
}
