/**
 * The terminal service: lifecycle, per-workspace caps, scrollback ring,
 * output coalescing and flood truncation, idle reaping, multiplexed
 * subscription, and shutdown.
 *
 * Every test drives a fake PTY, so the suite proves the service's own
 * behaviour and never depends on a native module being built.
 */
import { describe, expect, it } from 'vitest'
import {
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
  return { spawned, terminals: createTerminalService({ spawner, ...overrides }) }
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

    terminals.kill(info.id)
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

  it('refuses to open more than the per-workspace cap, and counts per workspace', async () => {
    const { terminals } = service({ maxPerWorkspace: 2 })
    await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    await expect(terminals.create({ workspaceId: WS, cwd: process.cwd() })).rejects.toMatchObject({ code: 'cap' })
    // A different workspace has its own budget.
    await expect(terminals.create({ workspaceId: OTHER, cwd: process.cwd() })).resolves.toBeDefined()
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

  it('reports the shell exit to subscribers and forgets the terminal', async () => {
    const { terminals, spawned } = service()
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    spawned[0]?.exit?.({ exitCode: 3 })

    expect(events.at(-1)).toEqual({ kind: 'exit', terminalId: info.id, exitCode: 3, reason: 'exit' })
    expect(terminals.list(WS)).toEqual([])
    expect(() => terminals.write(info.id, 'x')).toThrow(TerminalError)
  })

  it('ignores output a killed PTY still emits, so no data frame follows the exit', async () => {
    const { terminals, spawned } = service()
    const events: TerminalEvent[] = []
    terminals.subscribe(WS, (event) => events.push(event))
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })

    terminals.kill(info.id)
    // node-pty can still deliver buffered output after the kill returns.
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

    terminals.disposeAll()

    expect(spawned.every((pty) => pty.killed)).toBe(true)
    expect(terminals.list(WS)).toEqual([])
    expect(terminals.list(OTHER)).toEqual([])
  })

  it('rejects an unknown terminal id rather than failing silently', async () => {
    const { terminals } = service()
    expect(() => terminals.write('terminal-nope', 'x')).toThrow(/unknown terminal/)
    expect(() => terminals.resize('terminal-nope', 80, 24)).toThrow(TerminalError)
    expect(() => terminals.kill('terminal-nope')).toThrow(TerminalError)
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
    terminals.disposeAll()
  })

  it('reports unavailability instead of throwing on boot when node-pty is missing', async () => {
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
    terminals.disposeAll()
  })
})
