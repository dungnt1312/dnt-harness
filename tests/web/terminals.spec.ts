/**
 * The terminal service: lifecycle, scrollback ring,
 * output coalescing and flood truncation, idle reaping, multiplexed
 * subscription, and shutdown.
 *
 * Every test drives a fake PTY, so the suite proves the service's own
 * behaviour and never depends on a native module being built.
 */
import { describe, expect, it } from 'vitest'
import { spawn as spawnChild } from 'node:child_process'
import {
  bunPtyLibSpawner,
  bunPtySpawner,
  type BunPtyModule,
  type BunPtyRuntime,
  createTerminalService,
  TerminalError,
  type PtyHandle,
  type PtySpawner,
  type PtySpawnOptions,
  type TerminalEvent,
} from '../../src/web/terminals.ts'
import type { WorkspaceId } from '../../src/util/brand.ts'

const WS = 'workspace-a' as WorkspaceId
const OTHER = 'workspace-b' as WorkspaceId

/** A PTY that records what it was told and lets a test push output back. */
class FakePty implements PtyHandle {
  data: ((chunk: string) => void) | undefined
  exit: ((event: { exitCode: number }) => void) | undefined
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  killed = false

  constructor(readonly file: string, readonly args: readonly string[], readonly options: PtySpawnOptions) {}

  onData(listener: (chunk: string) => void): void {
    this.data = listener
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener
  }
  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(): void {
    this.killed = true
    // A real PTY reports the exit shortly after a hang-up.
    queueMicrotask(() => this.exit?.({ exitCode: 0 }))
  }
  /** Push output as the real PTY would. */
  emit(chunk: string): void {
    this.data?.(chunk)
  }
}

function fakeSpawner(): { spawner: PtySpawner; spawned: FakePty[] } {
  const spawned: FakePty[] = []
  return {
    spawned,
    spawner: {
      spawn(file, args, options) {
        const pty = new FakePty(file, args, options)
        spawned.push(pty)
        return pty
      },
    },
  }
}

function service(overrides: Parameters<typeof createTerminalService>[0] = {}) {
  const { spawner, spawned } = fakeSpawner()
  return { spawned, terminals: createTerminalService({ spawner, inspector: null, ...overrides }) }
}

/** Let the 16 ms coalescing timer fire. */
const flushed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

describe('terminal service', () => {
  it('creates, lists, writes, resizes and kills a terminal', async () => {
    const { terminals, spawned } = service()
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd(), cols: 100, rows: 30 })

    expect(terminals.list(WS)).toEqual([info])
    expect(spawned[0]?.options.cols).toBe(100)
    expect(spawned[0]?.options.env['TERM']).toBe('xterm-256color')

    terminals.write(info.id, 'ls\r')
    expect(spawned[0]?.writes).toEqual(['ls\r'])

    terminals.resize(info.id, 120, 40)
    expect(spawned[0]?.resizes).toEqual([[120, 40]])
    // The client's view of the terminal must follow the PTY, not drift from it.
    expect(terminals.get(info.id)).toMatchObject({ cols: 120, rows: 40 })

    await terminals.kill(info.id)
    expect(spawned[0]?.killed).toBe(true)
    expect(terminals.list(WS)).toEqual([])
  })

  it('keeps one scrollback across a resize', async () => {
    const { terminals, spawned } = service()
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    spawned[0]?.emit('before ')
    await flushed()
    terminals.resize(info.id, 120, 40)
    spawned[0]?.emit('after')
    await flushed()
    expect(terminals.scrollback(info.id)).toBe('before after')
  })

  it('opens as many terminals as asked, counting per workspace only for the record', async () => {
    const { terminals } = service()
    const created = []
    for (let index = 0; index < 6; index += 1) {
      created.push(await terminals.create({ workspaceId: WS, cwd: process.cwd() }))
    }
    expect(new Set(created.map((info) => info.id)).size).toBe(6)
    expect(terminals.list(WS)).toHaveLength(6)

    // A different workspace's shells live beside these, untouched.
    await expect(terminals.create({ workspaceId: OTHER, cwd: process.cwd() })).resolves.toBeDefined()
    expect(terminals.list(WS)).toHaveLength(6)
  })

  it('coalesces bursts into one frame instead of one frame per chunk', async () => {
    const { terminals, spawned } = service()
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    for (const chunk of ['a', 'b', 'c', 'd']) spawned[0]?.emit(chunk)
    await flushed()

    const data = events.filter((event) => event.kind === 'data')
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ data: 'abcd' })
  })

  it('truncates a flood and says so, rather than buffering without bound', async () => {
    const { terminals, spawned } = service()
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    // Two 800k chunks inside one 16ms window exceed the 1M flush ceiling.
    spawned[0]?.emit('x'.repeat(800_000))
    spawned[0]?.emit('y'.repeat(800_000))
    await flushed()

    const scrollback = terminals.scrollback(info.id)
    expect(scrollback).toContain('[output truncated: too fast]')
    expect(scrollback.length).toBeLessThanOrEqual(256_000)
  })

  it('caps scrollback at the configured ring size, keeping the newest output', async () => {
    const { terminals, spawned } = service({ scrollbackChars: 100 })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    spawned[0]?.emit('old'.repeat(100))
    await flushed()
    spawned[0]?.emit('NEWEST')
    await flushed()

    const scrollback = terminals.scrollback(info.id)
    expect(scrollback).toHaveLength(100)
    expect(scrollback.endsWith('NEWEST')).toBe(true)
  })

  it('never starts the trimmed scrollback on half of a surrogate pair', async () => {
    const { terminals, spawned } = service({ scrollbackChars: 4 })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    // '😀' is two UTF-16 units; keeping the last 4 of 'a😀bcd' starts on its low half.
    spawned[0]?.emit('a😀bcd')
    await flushed()

    const scrollback = terminals.scrollback(info.id)
    const first = scrollback.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    expect(scrollback).toBe('bcd')
  })

  it('reports the shell exit to subscribers and forgets the terminal', async () => {
    const { terminals, spawned } = service()
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    spawned[0]?.exit?.({ exitCode: 3 })
    await flushed()

    expect(events.at(-1)).toEqual({ kind: 'exit', terminalId: info.id, exitCode: 3, reason: 'exit' })
    expect(terminals.list(WS)).toEqual([])
    expect(() => terminals.write(info.id, 'x')).toThrow(TerminalError)
  })

  it('ignores output a killed PTY still emits, so no data frame follows the exit', async () => {
    const { terminals, spawned } = service()
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    await terminals.kill(info.id)
    // A PTY backend can still deliver buffered output after the kill returns.
    spawned[0]?.emit('late output')
    await flushed()

    expect(events.at(-1)).toMatchObject({ kind: 'exit', reason: 'killed' })
    expect(events.some((event) => event.kind === 'data' && event.data === 'late output')).toBe(false)
  })

  it('reaps a terminal that has been idle past the limit', async () => {
    const { terminals, spawned } = service({ idleMs: 10, reapIntervalMs: 5 })
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(spawned[0]?.killed).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'exit', reason: 'idle' })
    expect(terminals.list(WS)).toEqual([])
  })

  it('multiplexes one subscription across every terminal in its workspace, and no other', async () => {
    const { terminals, spawned } = service()
    const mine: TerminalEvent[] = []
    const dispose = terminals.subscribe(WS, (event) => mine.push(event))

    const first = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    const second = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await terminals.create({ workspaceId: OTHER, cwd: process.cwd() })

    spawned[0]?.emit('one')
    spawned[1]?.emit('two')
    spawned[2]?.emit('elsewhere')
    await flushed()

    const ids = mine.filter((event) => event.kind === 'data').map((event) => (event as { terminalId: string }).terminalId)
    expect(new Set(ids)).toEqual(new Set([first.id, second.id]))
    expect(mine.some((event) => event.kind === 'data' && event.data === 'elsewhere')).toBe(false)

    dispose()
    spawned[0]?.emit('after dispose')
    await flushed()
    expect(mine.some((event) => event.kind === 'data' && event.data === 'after dispose')).toBe(false)
  })

  it('kills every terminal on shutdown so none outlives the host', async () => {
    const { terminals, spawned } = service()
    await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await terminals.create({ workspaceId: OTHER, cwd: process.cwd() })

    await terminals.disposeAll()

    expect(spawned.every((pty) => pty.killed)).toBe(true)
    expect(terminals.list(WS)).toEqual([])
    expect(terminals.list(OTHER)).toEqual([])
  })

  it('rejects an unknown terminal id rather than failing silently', async () => {
    const { terminals } = service()
    expect(() => terminals.write('terminal-nope', 'x')).toThrow(/unknown terminal/)
    expect(() => terminals.resize('terminal-nope', 80, 24)).toThrow(TerminalError)
    await expect(terminals.kill('terminal-nope')).rejects.toThrow(TerminalError)
  })

  it('rejects a shell this host cannot launch', async () => {
    const { terminals } = service()
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      terminals.create({ workspaceId: WS, cwd: process.cwd(), shellId: 'nonesuch' as any }),
    ).rejects.toMatchObject({ code: 'bad-shell' })
  })

  it('reports the underlying spawn failure, not just the shell and cwd', async () => {
    const terminals = createTerminalService({
      spawner: {
        spawn() {
          throw new Error('posix_spawnp failed.')
        },
      },
    })
    await expect(terminals.create({ workspaceId: WS, cwd: process.cwd() })).rejects.toThrow(
      /could not start .*: posix_spawnp failed\./,
    )
    await terminals.disposeAll()
  })

  it('reports unavailability instead of throwing on boot when no PTY backend loads', async () => {
    // No injected spawner: the real lazy import runs. Whether it resolves
    // depends on the machine, which is exactly the state `probe()` reports.
    const terminals = createTerminalService()
    const probe = await terminals.probe()
    expect(typeof probe.available).toBe('boolean')
    expect(probe.hint).toBeTruthy()
    if (!probe.available) {
      await expect(terminals.create({ workspaceId: WS, cwd: process.cwd() })).rejects.toMatchObject({
        code: 'unavailable',
      })
    }
    await terminals.disposeAll()
  })

  it('adapts Bun.spawn({ terminal }) to the PTY handle contract', async () => {
    const calls: { cmd: string[]; writes: string[]; resizes: number[][]; signals: unknown[]; closed: number } = { cmd: [], writes: [], resizes: [], signals: [], closed: 0 }
    let emit: (chunk: Uint8Array) => void = () => {}
    let finish: () => void = () => {}
    const proc = {
      pid: 4242,
      exitCode: null as number | null,
      exited: new Promise<number | null>((resolve) => { finish = () => resolve(proc.exitCode) }),
      terminal: {
        write: (d: string) => { calls.writes.push(d) },
        resize: (c: number, r: number) => { calls.resizes.push([c, r]) },
        close: () => { calls.closed += 1 },
      },
      kill: (signal?: number | string) => { calls.signals.push(signal) },
    }
    const runtime: BunPtyRuntime = {
      spawn(cmd, options) {
        calls.cmd = cmd
        emit = (chunk) => options.terminal.data(undefined, chunk)
        return proc
      },
    }
    const pty = bunPtySpawner(runtime).spawn('/bin/zsh', ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: {} })
    const data: string[] = []
    const exits: number[] = []
    pty.onData((chunk) => data.push(chunk))
    pty.onExit((event) => exits.push(event.exitCode))
    // A UTF-8 character split across two chunks must decode once, whole.
    const bytes = new TextEncoder().encode('é')
    emit(bytes.slice(0, 1))
    emit(bytes.slice(1))
    pty.write('ls\n')
    pty.resize(100, 30)
    pty.closeTerminal?.()
    pty.kill()
    pty.signal?.('SIGKILL')
    proc.exitCode = 7
    finish()
    await proc.exited
    await Promise.resolve()
    // kill() is an explicit hang-up, never Bun's default SIGTERM (an interactive bash ignores TERM).
    expect(calls).toEqual({ cmd: ['/bin/zsh', '-l'], writes: ['ls\n'], resizes: [[100, 30]], signals: ['SIGHUP', 'SIGKILL'], closed: 1 })
    expect(pty.pid).toBe(4242)
    expect(data.join('')).toBe('é')
    expect(exits).toEqual([7])
  })

  it('stops delivering output to a data listener once its disposable is released', () => {
    let emit: (chunk: Uint8Array) => void = () => {}
    const runtime: BunPtyRuntime = {
      spawn(_cmd, options) {
        emit = (chunk) => options.terminal.data(undefined, chunk)
        return { pid: 1, exitCode: null, exited: new Promise(() => {}), terminal: { write() {}, resize() {}, close() {} }, kill() {} }
      },
    }
    const pty = bunPtySpawner(runtime).spawn('/bin/sh', [], { name: 'x', cols: 80, rows: 24, cwd: '/', env: {} })
    const seen: string[] = []
    const handle = pty.onData((chunk) => seen.push(chunk)) as { dispose(): void }
    emit(new TextEncoder().encode('a'))
    handle.dispose()
    emit(new TextEncoder().encode('b'))
    expect(seen).toEqual(['a'])
  })
})

/**
 * A stand-in for bun-pty 0.5.1 that reproduces what was measured on Windows:
 * `kill()` fires a synthetic `onExit({ exitCode: 0 })` synchronously, and the
 * real exit is never reported after a kill. `pid` is a real process the test
 * controls, so "the PID is gone" is checked against the OS, not a flag.
 */
function fakeBunPty(pid: number, onKill: () => void = () => {}) {
  const exitListeners: ((event: { exitCode: number }) => void)[] = []
  const dataListeners: ((data: string) => void)[] = []
  const calls = { writes: [] as string[], resizes: [] as number[][], kills: 0, spawned: [] as unknown[] }
  let closing = false
  const lib: BunPtyModule = {
    spawn(file, args, options) {
      calls.spawned.push({ file, args, options })
      return {
        pid,
        onData: (listener) => { dataListeners.push(listener); return { dispose: () => {} } },
        onExit: (listener) => { exitListeners.push(listener); return { dispose: () => {} } },
        write: (data) => { calls.writes.push(data) },
        resize: (cols, rows) => { calls.resizes.push([cols, rows]) },
        kill: () => {
          if (closing) return
          closing = true
          calls.kills++
          onKill()
          for (const listener of exitListeners) listener({ exitCode: 0 })
        },
      }
    },
  }
  return {
    lib,
    calls,
    naturalExit: (exitCode: number) => { for (const listener of exitListeners) listener({ exitCode }) },
    data: (chunk: string) => { for (const listener of dataListeners) listener(chunk) },
  }
}

function longLivedChild() {
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return { child, pid: child.pid!, gone }
}

describe('bun-pty adapter (Windows backend)', () => {
  it('passes I/O and spawn options through unchanged', () => {
    const fake = fakeBunPty(process.pid)
    const pty = bunPtyLibSpawner(fake.lib).spawn('cmd.exe', ['/k'], { name: 'xterm-256color', cols: 90, rows: 30, cwd: 'C:\\', env: { A: '1' } })
    const seen: string[] = []
    pty.onData((chunk) => seen.push(chunk))
    fake.data('hello')
    pty.write('dir\r')
    pty.resize(100, 40)
    expect(seen).toEqual(['hello'])
    expect(fake.calls.writes).toEqual(['dir\r'])
    expect(fake.calls.resizes).toEqual([[100, 40]])
    expect(fake.calls.spawned).toEqual([{ file: 'cmd.exe', args: ['/k'], options: { name: 'xterm-256color', cols: 90, rows: 30, cwd: 'C:\\', env: { A: '1' } } }])
    expect(pty.pid).toBe(process.pid)
  })

  it('reports a natural exit once, with the real exit code', () => {
    const fake = fakeBunPty(process.pid)
    const pty = bunPtyLibSpawner(fake.lib).spawn('cmd.exe', [], { name: 'x', cols: 80, rows: 24, cwd: '.', env: {} })
    const exits: number[] = []
    pty.onExit((event) => exits.push(event.exitCode))
    fake.naturalExit(7)
    fake.naturalExit(7)
    expect(exits).toEqual([7])
  })

  it('holds the synthetic exit from kill() until the shell PID is actually gone', async () => {
    const { child, pid, gone } = longLivedChild()
    // The library "kills" without stopping the process: the exit must wait for the OS.
    const fake = fakeBunPty(pid)
    const pty = bunPtyLibSpawner(fake.lib, { pollMs: 10 }).spawn('cmd.exe', [], { name: 'x', cols: 80, rows: 24, cwd: '.', env: {} })
    const exits: number[] = []
    pty.onExit((event) => exits.push(event.exitCode))

    pty.kill()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(exits).toEqual([])

    child.kill('SIGKILL')
    await gone
    await expect.poll(() => exits, { timeout: 2000 }).toEqual([0])
  })

  it('never reports exit for a shell that outlives the deadline, so teardown fails explicitly', async () => {
    const { child, pid, gone } = longLivedChild()
    try {
      const fake = fakeBunPty(pid)
      const pty = bunPtyLibSpawner(fake.lib, { pollMs: 10, deadlineMs: 100 }).spawn('cmd.exe', [], { name: 'x', cols: 80, rows: 24, cwd: '.', env: {} })
      const exits: number[] = []
      pty.onExit((event) => exits.push(event.exitCode))
      pty.kill()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(exits).toEqual([])
    } finally {
      child.kill('SIGKILL')
      await gone
    }
  })

  it('releases the native handle once on a natural exit, and later kill() calls do nothing', () => {
    const fake = fakeBunPty(process.pid)
    const pty = bunPtyLibSpawner(fake.lib).spawn('cmd.exe', [], { name: 'x', cols: 80, rows: 24, cwd: '.', env: {} })
    const exits: number[] = []
    pty.onExit((event) => exits.push(event.exitCode))
    fake.naturalExit(5)
    // bun-pty frees the ConPTY/console host only in kill(): a natural exit must call it once.
    expect(fake.calls.kills).toBe(1)
    pty.kill()
    pty.kill()
    expect(fake.calls.kills).toBe(1)
    // The synthetic exit that kill() fired is not a second exit.
    expect(exits).toEqual([5])
  })

  it('re-checks after a missed deadline when kill() is retried, then reports exactly one exit', async () => {
    const { child, pid, gone } = longLivedChild()
    const fake = fakeBunPty(pid)
    const pty = bunPtyLibSpawner(fake.lib, { pollMs: 10, deadlineMs: 80 }).spawn('cmd.exe', [], { name: 'x', cols: 80, rows: 24, cwd: '.', env: {} })
    const exits: number[] = []
    pty.onExit((event) => exits.push(event.exitCode))
    pty.kill()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(exits).toEqual([])

    child.kill('SIGKILL')
    await gone
    // The service's retry: bun-pty itself is closed, so the adapter must re-check the PID.
    pty.kill()
    await expect.poll(() => exits, { timeout: 2000 }).toEqual([0])
    pty.kill()
    expect(exits).toEqual([0])
    expect(fake.calls.kills).toBe(1)
  })

  it('recovers a failed teardown through the service once the shell finally dies', async () => {
    const { child, pid, gone } = longLivedChild()
    const fake = fakeBunPty(pid)
    const terminals = createTerminalService({
      spawner: bunPtyLibSpawner(fake.lib, { pollMs: 10, deadlineMs: 50 }),
      inspector: null,
      teardown: { escalateMs: 50, killGraceMs: 100, pollMs: 10 },
    })
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await expect(terminals.kill(info.id)).rejects.toMatchObject({ code: 'teardown-failed' })
    expect(terminals.state(info.id)).toBe('failedTeardown')

    child.kill('SIGKILL')
    await gone
    await terminals.kill(info.id)
    expect(terminals.state(info.id)).toBeUndefined()
    await terminals.disposeAll()
  })

  it('stops the dispose()d exit listener from firing', () => {
    const fake = fakeBunPty(process.pid)
    const pty = bunPtyLibSpawner(fake.lib).spawn('cmd.exe', [], { name: 'x', cols: 80, rows: 24, cwd: '.', env: {} })
    const exits: number[] = []
    const handle = pty.onExit((event) => exits.push(event.exitCode)) as { dispose(): void }
    handle.dispose()
    fake.naturalExit(3)
    expect(exits).toEqual([])
  })

  it('drives the service lifecycle end to end: kill resolves only after the PID is gone', async () => {
    const { child, pid, gone } = longLivedChild()
    const fake = fakeBunPty(pid, () => { child.kill('SIGKILL') })
    const terminals = createTerminalService({
      spawner: bunPtyLibSpawner(fake.lib, { pollMs: 10 }),
      inspector: null,
      teardown: { escalateMs: 500, killGraceMs: 1500, pollMs: 10 },
    })
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await terminals.kill(info.id)
    await gone
    expect(fake.calls.kills).toBe(1)
    expect(events.filter((event) => event.kind === 'exit')).toEqual([{ kind: 'exit', terminalId: info.id, exitCode: 0, reason: 'killed' }])
    await terminals.disposeAll()
  })
})
