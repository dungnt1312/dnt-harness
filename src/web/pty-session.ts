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
 * Linux reads `/proc/<pid>/stat`. macOS shells out to `ps` and keys membership
 * on the controlling tty; that path has no runner evidence yet (see the
 * phase-03 report) and must not back a macOS support claim until it does.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'

/** One process as seen at a moment: PID, opaque session token, start-time identity. */
export interface ProcessIdentity {
  readonly pid: number
  /** Session token. Linux: the numeric session id; macOS: `tty:<controlling tty>`. */
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
   * closed. Linux session ids cannot be reallocated while any member lives, so
   * rescanning and re-checking the session are safe; a macOS tty name can be
   * handed to the next PTY (and a revoked tty may print as `??`), so there
   * only the pre-close snapshot is trusted and identity is pid + start time.
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

/** Parse `ps -o pid=,ppid=,stat=,tty=,lstart=` lines. `lstart` contains spaces, so it is the tail. */
export function parsePsListing(text: string): ProcessIdentity[] {
  const rows: ProcessIdentity[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (match === null) continue
    const [, pid, ppid, state, tty, start] = match
    if (pid === undefined || ppid === undefined || state === undefined || tty === undefined || start === undefined) continue
    if (state.startsWith('Z')) continue
    rows.push({ pid: Number(pid), session: `tty:${tty}`, start, ppid: Number(ppid) })
  }
  return rows
}

const PS_FIELDS = 'pid=,ppid=,stat=,tty=,lstart='

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

/** macOS (no runner evidence yet). Membership = same controlling tty as the shell. */
export const darwinInspector: ProcessInspector = {
  sessionStable: false,
  async identity(pid) {
    return parsePsListing(await ps(['-o', PS_FIELDS, '-p', String(pid)])).find((row) => row.pid === pid)
  },
  async members(session) {
    return parsePsListing(await ps(['-A', '-o', PS_FIELDS])).filter((row) => row.session === session)
  },
  async ownsSession(self) {
    if (self.session === 'tty:??' || self.session === 'tty:-') return false
    const host = await darwinInspector.identity(process.pid)
    return host !== undefined && host.session !== self.session
  },
  signal: deliver,
}

/** The inspector for this platform, or `null` where teardown relies on the PTY backend alone (Windows). */
export function platformInspector(): ProcessInspector | null {
  if (process.platform === 'linux') return linuxInspector
  if (process.platform === 'darwin') return darwinInspector
  return null
}
