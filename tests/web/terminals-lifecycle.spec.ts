/**
 * RH3-B: terminal teardown orchestration against a scriptable fake PTY and a
 * fake process inspector. These prove the state machine (running → closing →
 * exited | failedTeardown), event exactly-once, retry, escalation ordering,
 * identity re-checks, concurrency budget and timer hygiene.
 *
 * RH3-E: they do NOT replace real POSIX process tests — see
 * tests/web/terminals-posix.spec.ts and scripts/pty-probes.mjs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTerminalService,
  TerminalError,
  TerminalTeardownError,
  type PtyHandle,
  type PtySpawner,
  type PtySpawnOptions,
  type TerminalEvent,
  type TerminalService,
} from '../../src/web/terminals.ts'
import { parseProcStat, parsePsListing, type ProcessIdentity, type ProcessInspector, type TeardownSignal } from '../../src/web/pty-session.ts'
import type { WorkspaceId } from '../../src/util/brand.ts'

const WS = 'workspace-a' as WorkspaceId
const FAST = { escalateMs: 40, killGraceMs: 40, pollMs: 5 }

type Behaviour = 'exit-on-hup' | 'ignore-hup' | 'ignore-all'

let nextPid = 10_000

/** A fake PTY whose reaction to HUP/KILL is scripted. */
class ScriptedPty implements PtyHandle {
  readonly pid = nextPid++
  data: ((chunk: string) => void) | undefined
  exit: ((event: { exitCode: number }) => void) | undefined
  readonly calls: string[] = []
  exited = false
  disposed = 0
  throwOnKill = false
  throwOnClose = false

  constructor(public behaviour: Behaviour, readonly options: PtySpawnOptions) {}

  onData(listener: (chunk: string) => void): { dispose(): void } {
    this.data = listener
    return { dispose: () => { this.disposed += 1; this.data = undefined } }
  }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exit = listener
    return { dispose: () => { this.disposed += 1 } }
  }
  write(data: string): void { this.calls.push(`write:${data}`) }
  resize(cols: number, rows: number): void { this.calls.push(`resize:${cols}x${rows}`) }
  closeTerminal(): void {
    this.calls.push('close')
    if (this.throwOnClose) throw new Error('close failed')
  }
  kill(): void {
    this.calls.push('hup')
    if (this.throwOnKill) throw new Error('hup failed')
    if (this.behaviour === 'exit-on-hup') this.die(129)
  }
  signal(signal: TeardownSignal): void {
    this.calls.push(signal)
    if (signal === 'SIGCONT') return
    if (this.exited) throw new Error('signalled after exit')
    if (signal === 'SIGKILL' && this.behaviour !== 'ignore-all') this.die(137)
  }
  /** The process ends (on its own or from a signal). Delivered asynchronously like a real PTY. */
  die(code: number): void {
    if (this.exited) return
    this.exited = true
    setTimeout(() => this.exit?.({ exitCode: code }), 1)
  }
  emit(chunk: string): void { this.data?.(chunk) }
}

function harness(behaviour: Behaviour = 'exit-on-hup', extra: Parameters<typeof createTerminalService>[0] = {}) {
  const spawned: ScriptedPty[] = []
  const spawner: PtySpawner = {
    spawn(_file, _args, options) {
      const pty = new ScriptedPty(behaviour, options)
      spawned.push(pty)
      return pty
    },
  }
  const terminals = createTerminalService({ spawner, inspector: null, teardown: FAST, ...extra })
  const events: TerminalEvent[] = []
  terminals.subscribe(WS, (event) => events.push(event))
  created.push(terminals)
  return { terminals, spawned, events }
}

const created: TerminalService[] = []
afterEach(async () => {
  for (const service of created.splice(0)) await service.disposeAll({ budgetMs: 500 }).catch(() => {})
})

const exits = (events: TerminalEvent[], id: string) => events.filter((e) => e.kind === 'exit' && e.terminalId === id)
const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Collect unhandled rejections raised during a test body. */
async function noUnhandled(body: () => Promise<void>): Promise<void> {
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown): void => { seen.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    await tick(30)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  expect(seen).toEqual([])
}

describe('terminal teardown orchestration (fake adapter)', () => {
  it('natural exit closes the PTY, disposes listeners, emits exit once and forgets the record', async () => {
    await noUnhandled(async () => {
      const { terminals, spawned, events } = harness()
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      const pty = spawned[0]!
      pty.emit('bye')
      pty.die(3)
      await tick(20)
      expect(pty.calls).toContain('close')
      // The child was reaped: nothing may be signalled through the backend.
      expect(pty.calls).not.toContain('hup')
      expect(pty.calls).not.toContain('SIGKILL')
      expect(pty.disposed).toBe(2)
      expect(exits(events, info.id)).toEqual([{ kind: 'exit', terminalId: info.id, exitCode: 3, reason: 'exit' }])
      // Output before the exit is delivered before the exit frame.
      expect(events.findIndex((e) => e.kind === 'data')).toBeLessThan(events.findIndex((e) => e.kind === 'exit'))
      expect(terminals.get(info.id)).toBeUndefined()
    })
  })

  it('double kill shares one teardown and one exit event', async () => {
    await noUnhandled(async () => {
      const { terminals, spawned, events } = harness()
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      const first = terminals.kill(info.id)
      const second = terminals.kill(info.id)
      expect(second).toBe(first)
      await Promise.all([first, second])
      expect(spawned[0]!.calls.filter((c) => c === 'hup')).toHaveLength(1)
      expect(exits(events, info.id)).toHaveLength(1)
      // After exit the id is unknown: a third kill is a clean not-found.
      await expect(terminals.kill(info.id)).rejects.toMatchObject({ code: 'not-found' })
    })
  })

  it('kill racing a natural exit yields one exit event, reason killed, and no signal after exit', async () => {
    await noUnhandled(async () => {
      const { terminals, spawned, events } = harness('ignore-hup')
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      const pty = spawned[0]!
      const closing = terminals.kill(info.id)
      pty.die(0) // the shell exits on its own while teardown is in flight
      await closing
      expect(exits(events, info.id)).toEqual([{ kind: 'exit', terminalId: info.id, exitCode: 0, reason: 'killed' }])
      expect(pty.calls).not.toContain('SIGKILL')
    })
  })

  it('natural exit racing a kill also settles once', async () => {
    await noUnhandled(async () => {
      const { terminals, spawned, events } = harness()
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      spawned[0]!.die(5)
      await tick(5)
      // The natural-exit teardown is in flight or done; kill either joins it or finds nothing.
      await terminals.kill(info.id).catch((error: unknown) => {
        expect((error as TerminalError).code).toBe('not-found')
      })
      await tick(20)
      expect(exits(events, info.id)).toHaveLength(1)
      expect(exits(events, info.id)[0]).toMatchObject({ reason: 'exit', exitCode: 5 })
    })
  })

  it('escalates to KILL after the deadline when the shell ignores HUP', async () => {
    const { terminals, spawned, events } = harness('ignore-hup')
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    const started = Date.now()
    await terminals.kill(info.id)
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.escalateMs - 5)
    expect(spawned[0]!.calls).toEqual(['close', 'hup', 'SIGCONT', 'SIGKILL'])
    expect(exits(events, info.id)).toHaveLength(1)
  })

  it('close and signal errors do not double events or escape as unhandled rejections', async () => {
    await noUnhandled(async () => {
      const { terminals, spawned, events } = harness('ignore-hup')
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      spawned[0]!.throwOnClose = true
      spawned[0]!.throwOnKill = true
      // HUP throws, close throws, KILL still works: teardown succeeds on the physical outcome.
      await terminals.kill(info.id)
      expect(exits(events, info.id)).toHaveLength(1)
    })
  })

  it('a teardown that cannot be proven becomes failedTeardown: record kept, input blocked, explicit retry works', async () => {
    await noUnhandled(async () => {
      const { terminals, spawned, events } = harness('ignore-all')
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      const pty = spawned[0]!
      await expect(terminals.kill(info.id)).rejects.toMatchObject({ code: 'teardown-failed' })
      expect(terminals.state(info.id)).toBe('failedTeardown')
      expect(terminals.list(WS).map((t) => t.id)).toEqual([info.id])
      expect(exits(events, info.id)).toEqual([])
      expect(() => terminals.write(info.id, 'x')).toThrow(expect.objectContaining({ code: 'closing' }))
      expect(() => terminals.resize(info.id, 10, 10)).toThrow(TerminalError)
      expect(pty.calls.filter((c) => c.startsWith('write'))).toEqual([])

      pty.behaviour = 'exit-on-hup'
      await terminals.kill(info.id)
      expect(terminals.state(info.id)).toBeUndefined()
      expect(exits(events, info.id)).toEqual([{ kind: 'exit', terminalId: info.id, exitCode: 0, reason: 'killed' }])
    })
  })

  it('the reaper retries a failed teardown', async () => {
    const { terminals, spawned, events } = harness('ignore-all', { reapIntervalMs: 20 })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await expect(terminals.kill(info.id)).rejects.toBeInstanceOf(TerminalError)
    spawned[0]!.behaviour = 'exit-on-hup'
    await tick(150)
    expect(terminals.state(info.id)).toBeUndefined()
    expect(exits(events, info.id)).toHaveLength(1)
  })

  it('idle reap goes through the same teardown and reports reason idle', async () => {
    const { terminals, spawned, events } = harness('exit-on-hup', { idleMs: 10, reapIntervalMs: 5 })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(80)
    expect(spawned[0]!.calls).toContain('close')
    expect(exits(events, info.id)).toEqual([{ kind: 'exit', terminalId: info.id, exitCode: 0, reason: 'idle' }])
  })

  it('disposeAll retries a failed teardown and reports what is left when it cannot', async () => {
    const { terminals, spawned } = harness('ignore-all')
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await expect(terminals.kill(info.id)).rejects.toBeInstanceOf(TerminalError)
    const error = await terminals.disposeAll({ budgetMs: 500 }).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(TerminalTeardownError)
    const report = (error as TerminalTeardownError).reports[0]
    expect(report).toMatchObject({ terminalId: info.id, shellPid: spawned[0]!.pid })
    expect((error as Error).message).toContain(String(spawned[0]!.pid))
    // disposeAll retried (a second HUP was attempted).
    expect(spawned[0]!.calls.filter((c) => c === 'hup')).toHaveLength(2)
  })

  it('tears down 16 terminals concurrently within one budget', async () => {
    const { terminals, spawned, events } = harness('ignore-hup')
    for (let i = 0; i < 16; i += 1) await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    const started = Date.now()
    await terminals.disposeAll({ budgetMs: 1_000 })
    const elapsed = Date.now() - started
    // Sequential would be ≥ 16 × escalateMs (640ms); concurrent is ~one round.
    expect(elapsed).toBeLessThan(FAST.escalateMs * 16 / 2)
    expect(spawned.every((pty) => pty.exited)).toBe(true)
    expect(events.filter((e) => e.kind === 'exit')).toHaveLength(16)
  })

  it('disposeAll gives up at the budget instead of hanging', async () => {
    const { terminals } = harness('ignore-all', { teardown: { escalateMs: 5_000, killGraceMs: 5_000, pollMs: 5 } })
    await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    const started = Date.now()
    await expect(terminals.disposeAll({ budgetMs: 100 })).rejects.toBeInstanceOf(TerminalTeardownError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('tears down a terminal whose spawn raced disposeAll instead of registering it', async () => {
    const spawned: ScriptedPty[] = []
    let terminals: TerminalService | undefined
    const spawner: PtySpawner = {
      spawn(_f, _a, options) {
        void terminals!.disposeAll()
        const pty = new ScriptedPty('exit-on-hup', options)
        spawned.push(pty)
        return pty
      },
    }
    terminals = createTerminalService({ spawner, inspector: null, teardown: FAST })
    await expect(terminals.create({ workspaceId: WS, cwd: process.cwd() })).rejects.toMatchObject({ code: 'unavailable' })
    expect(spawned[0]!.calls).toContain('hup')
    expect(spawned[0]!.disposed).toBe(2)
    expect(terminals.list(WS)).toEqual([])
  })

  it('exposes lifecycle state on described terminals', async () => {
    const { terminals } = harness('ignore-all')
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    expect(info.state).toBe('running')
    await expect(terminals.kill(info.id)).rejects.toBeInstanceOf(TerminalError)
    expect(terminals.get(info.id)?.state).toBe('failedTeardown')
    expect(terminals.list(WS)[0]?.state).toBe('failedTeardown')
  })

  it('a natural exit while failedTeardown retries immediately, without waiting for the reaper', async () => {
    const { terminals, spawned, events } = harness('ignore-all', { reapIntervalMs: 60_000 })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await expect(terminals.kill(info.id)).rejects.toBeInstanceOf(TerminalError)
    spawned[0]!.die(0)
    await tick(30)
    expect(terminals.state(info.id)).toBeUndefined()
    expect(exits(events, info.id)).toEqual([{ kind: 'exit', terminalId: info.id, exitCode: 0, reason: 'killed' }])
  })

  it('refuses new terminals once disposed', async () => {
    const { terminals } = harness()
    await terminals.disposeAll()
    await expect(terminals.create({ workspaceId: WS, cwd: process.cwd() })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('a throwing subscriber does not break teardown or other subscribers', async () => {
    const { terminals, events } = harness()
    terminals.subscribe(WS, () => { throw new Error('bad subscriber') })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await terminals.kill(info.id)
    expect(exits(events, info.id)).toHaveLength(1)
  })

  it('repeated create/close leaves no live timers or records behind', async () => {
    const { terminals, spawned } = harness()
    const handles = (): number => (process as unknown as { getActiveResourcesInfo?: () => string[] })
      .getActiveResourcesInfo?.().filter((name) => name === 'Timeout').length ?? 0
    await tick(20)
    const before = handles()
    for (let i = 0; i < 50; i += 1) {
      const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
      spawned.at(-1)!.emit('output')
      await terminals.kill(info.id)
    }
    await tick(50)
    expect(terminals.list(WS)).toEqual([])
    // Bounded, not growing with the iteration count.
    expect(handles() - before).toBeLessThanOrEqual(2)
    expect(spawned.every((pty) => pty.disposed === 2)).toBe(true)
  })
})

describe('process identity parsing', () => {
  it('reads state, session and start time from /proc/<pid>/stat even when comm has spaces and parens', () => {
    // pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
    const raw = '4321 (my (odd) cmd) S 1 4321 4300 34816 4321 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 100 18446744073709551615'
    expect(parseProcStat(4321, raw)).toEqual({ pid: 4321, state: 'S', session: '4300', start: '987654', ppid: 1 })
  })

  it('reads ps listings with a multi-word lstart and drops zombies', () => {
    const text = [
      '  501   400 Ss   ttys003  Sat Oct 17 10:00:01 2026',
      '  502   501 S+   ttys003  Sat Oct 17 10:00:05 2026',
      '  503   501 Z    ttys003  Sat Oct 17 10:00:06 2026',
    ].join('\n')
    expect(parsePsListing(text)).toEqual([
      { pid: 501, session: 'tty:ttys003', start: 'Sat Oct 17 10:00:01 2026', ppid: 400 },
      { pid: 502, session: 'tty:ttys003', start: 'Sat Oct 17 10:00:05 2026', ppid: 501 },
    ])
  })
})

/** A fake POSIX session: members, identities and signal delivery are scripted. */
class FakeSession implements ProcessInspector {
  readonly sessionStable = true
  readonly procs = new Map<number, ProcessIdentity & { ignore: Set<TeardownSignal> }>()
  readonly signals: Array<[number, TeardownSignal]> = []
  readonly session: string

  constructor(readonly leader: number) {
    this.session = String(leader)
    this.add(leader, [], this.session, 1)
  }
  add(pid: number, ignore: TeardownSignal[] = [], session = this.session, ppid = this.leader, start = `t${pid}`): void {
    this.procs.set(pid, { pid, session, start, ppid, ignore: new Set(ignore) })
  }
  private view(p: ProcessIdentity): ProcessIdentity {
    return { pid: p.pid, session: p.session, start: p.start, ...(p.ppid !== undefined ? { ppid: p.ppid } : {}) }
  }
  async identity(pid: number): Promise<ProcessIdentity | undefined> {
    const p = this.procs.get(pid)
    return p === undefined ? undefined : this.view(p)
  }
  async members(session: string): Promise<ProcessIdentity[]> {
    return [...this.procs.values()].filter((p) => p.session === session).map((p) => this.view(p))
  }
  async ownsSession(self: ProcessIdentity): Promise<boolean> {
    return self.session === String(self.pid)
  }
  signal(pid: number, signal: TeardownSignal): void {
    this.signals.push([pid, signal])
    if (signal === 'SIGCONT') return
    const p = this.procs.get(pid)
    if (p !== undefined && !p.ignore.has(signal)) this.procs.delete(pid)
  }
}

describe('session-member teardown (fake inspector)', () => {
  function sessionHarness(setup: (session: FakeSession, pty: ScriptedPty) => void, sessionStable = true) {
    let session: FakeSession | undefined
    const spawned: ScriptedPty[] = []
    const inspector: ProcessInspector = {
      sessionStable,
      identity: (pid) => session!.identity(pid),
      members: (s) => session!.members(s),
      ownsSession: (self) => session!.ownsSession(self),
      signal: (pid, sig) => session!.signal(pid, sig),
    }
    const spawner: PtySpawner = {
      spawn(_f, _a, options) {
        const pty = new ScriptedPty('exit-on-hup', options)
        session = new FakeSession(pty.pid)
        // The shell dies when the session leader is signalled away.
        const original = session.signal.bind(session)
        session.signal = (pid, sig) => {
          original(pid, sig)
          if (pid === pty.pid && !session!.procs.has(pid)) pty.die(129)
        }
        setup(session, pty)
        spawned.push(pty)
        return pty
      },
    }
    const terminals = createTerminalService({ spawner, inspector, teardown: FAST })
    created.push(terminals)
    return { terminals, spawned, session: () => session! }
  }

  it('HUPs every session member, including background jobs in other process groups', async () => {
    const { terminals, session } = sessionHarness((s) => { s.add(501); s.add(502) })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    await terminals.kill(info.id)
    expect(session().procs.size).toBe(0)
    expect(session().signals.filter(([, sig]) => sig === 'SIGHUP').map(([pid]) => pid).sort()).toEqual(
      [...new Set([501, 502, session().leader])].sort(),
    )
  })

  it('escalates to KILL for a member that traps HUP', async () => {
    const { terminals, session } = sessionHarness((s) => { s.add(601, ['SIGHUP']) })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    await terminals.kill(info.id)
    expect(session().signals).toContainEqual([601, 'SIGKILL'])
    expect(session().procs.size).toBe(0)
  })

  it('never signals a process outside the session, nor a PID reused by another session', async () => {
    const { terminals, session } = sessionHarness((s) => {
      s.add(701, ['SIGHUP'])
      s.add(999, [], 'unrelated') // a different session entirely
    })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    const closing = terminals.kill(info.id)
    // Before escalation, 701 exits and its PID is reused by an unrelated process.
    await tick(10)
    session().procs.set(701, { pid: 701, session: 'unrelated', start: 'reused', ignore: new Set(['SIGHUP', 'SIGKILL']) })
    await closing
    expect(session().signals.some(([pid]) => pid === 999)).toBe(false)
    expect(session().signals).not.toContainEqual([701, 'SIGKILL'])
  })

  it('snapshot mode (unstable session token): a reused PID with a new start time is never signalled', async () => {
    const { terminals, session } = sessionHarness((s) => { s.add(702, ['SIGHUP']) }, false)
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    const closing = terminals.kill(info.id)
    await tick(10)
    // Same token (e.g. a recycled tty name), new process: start time differs.
    session().procs.set(702, { pid: 702, session: session().session, start: 'reused', ignore: new Set(['SIGHUP', 'SIGKILL']) })
    await closing
    expect(session().signals).not.toContainEqual([702, 'SIGKILL'])
  })

  it('stops sweeping when the session id is reused (leader PID back with a new start time)', async () => {
    const { terminals, session } = sessionHarness((s) => { s.add(1001, ['SIGHUP']) })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    const closing = terminals.kill(info.id)
    await tick(10)
    // Every original member is gone and the shell's PID now leads a brand-new
    // session with the same numeric id and its own child.
    const s = session()
    s.procs.clear()
    s.add(s.leader, ['SIGHUP', 'SIGKILL'], s.session, 1, 'reused')
    s.add(1002, ['SIGHUP', 'SIGKILL'], s.session, s.leader, 't-new')
    const before = s.signals.length
    await closing
    expect(s.signals.slice(before)).toEqual([])
    expect(s.signals).not.toContainEqual([1002, 'SIGHUP'])
    expect(s.signals).not.toContainEqual([s.leader, 'SIGKILL'])
  })

  it('admits a newcomer only when its parent chain reaches a known member', async () => {
    const { terminals, session } = sessionHarness((s) => { s.add(1101, ['SIGHUP']) })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    const closing = terminals.kill(info.id)
    await tick(10)
    const s = session()
    // Forked by a known member during teardown: ours.
    s.add(1104, ['SIGHUP'], s.session, 1101)
    // Same session token, parent outside every known chain: not ours.
    s.add(1103, ['SIGHUP', 'SIGKILL'], s.session, 4242)
    await closing.catch(() => {})
    expect(s.signals).toContainEqual([1104, 'SIGKILL'])
    expect(s.signals.some(([pid]) => pid === 1103)).toBe(false)
  })

  it('continues stopped members after HUP so the hang-up is acted on', async () => {
    // A stopped job: HUP is queued, not acted on, until it is continued.
    const { terminals, session } = sessionHarness((s) => { s.add(1201, ['SIGHUP']) })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    await terminals.kill(info.id)
    const sigs = session().signals.filter(([pid]) => pid === 1201).map(([, sig]) => sig)
    expect(sigs.slice(0, 2)).toEqual(['SIGHUP', 'SIGCONT'])
  })

  it('reports surviving member PIDs when KILL does not take', async () => {
    const { terminals, session } = sessionHarness((s) => { s.add(801, ['SIGHUP', 'SIGKILL']) })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(20)
    await expect(terminals.kill(info.id)).rejects.toMatchObject({ code: 'teardown-failed' })
    const error = await terminals.disposeAll({ budgetMs: 500 }).then(() => undefined, (e: unknown) => e)
    expect((error as TerminalTeardownError).reports[0]?.remainingPids).toEqual([801])
    expect((error as TerminalTeardownError).reports[0]?.session).toBe(session().session)
  })

  it('does not sweep a session the shell does not lead', async () => {
    const { terminals, session } = sessionHarness((s, pty) => {
      // The shell shares the host's session: membership is not ours to kill.
      s.procs.set(pty.pid, { pid: pty.pid, session: 'host', start: 'x', ignore: new Set() })
      s.add(901, [], 'host')
    })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await tick(150)
    await terminals.kill(info.id)
    expect(session().signals).toEqual([])
  })
})
