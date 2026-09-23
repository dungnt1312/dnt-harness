/**
 * The terminal HTTP surface: REST lifecycle, the multiplexed SSE stream, the
 * gates (disabled host, non-loopback bind, missing PTY backend), and shutdown.
 *
 * A fake PTY backend is injected throughout, so these tests assert the web
 * host's behaviour rather than a native module's.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'mini-dsh'
import {
  TerminalError,
  type PtyHandle,
  type PtySpawner,
  type PtySpawnOptions,
} from '../../src/web/terminals.ts'

let server: WebServer | undefined
let root = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root !== '') await fs.rm(root, { recursive: true, force: true })
  root = ''
})

class FakePty implements PtyHandle {
  data: ((chunk: string) => void) | undefined
  exit: ((event: { exitCode: number }) => void) | undefined
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  killed = false

  constructor(readonly options: PtySpawnOptions) {}

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
}

const spawned: FakePty[] = []
const fakeSpawner: PtySpawner = {
  spawn(_file, _args, options) {
    const pty = new FakePty(options)
    spawned.push(pty)
    return pty
  },
}

async function start(extra: Partial<Parameters<typeof createWebServer>[0]> = {}): Promise<string> {
  spawned.length = 0
  root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-terminals-'))
  // `defaultCwd` is only known once the temp root exists, so terminal options
  // are merged rather than replaced by a caller's override.
  const { terminals: terminalOverride, ...rest } = extra
  server = await createWebServer({
    home: path.join(root, 'data'),
    configFile: path.join(root, 'providers.json'),
    ...rest,
    terminals: { spawner: fakeSpawner, defaultCwd: root, ...terminalOverride },
  })
  return server.url
}

/** The durable workspace the host boots with. */
async function workspaceId(baseUrl: string): Promise<string> {
  const rows = (await (await fetch(`${baseUrl}/api/workspaces`)).json()) as Array<{ id: string }>
  const id = rows[0]?.id
  if (id === undefined) throw new Error('test setup: no workspace')
  return id
}

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
const fromB64 = (value: string): string => Buffer.from(value, 'base64').toString('utf8')

/**
 * One persistent SSE reader. Successive `until` calls share the stream: a
 * fresh `getReader()` per read would lock the body and lose buffered frames.
 */
class TerminalSse {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private readonly queued: Record<string, unknown>[] = []
  private buffer = ''

  constructor(response: Response) {
    const body = response.body
    if (body === null) throw new Error('test setup: no SSE body')
    this.reader = body.getReader()
  }

  async until(match: (frame: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const ready = this.queued.findIndex(match)
      if (ready >= 0) return this.queued.splice(0, ready + 1).at(-1) as Record<string, unknown>
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('sse timeout')
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sse timeout')), remaining)),
      ])
      if (chunk.done) throw new Error('sse ended before the expected frame')
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
      let boundary = this.buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        boundary = this.buffer.indexOf('\n\n')
        const line = raw.split('\n').find((candidate) => candidate.startsWith('data: '))
        if (line !== undefined) this.queued.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
      }
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined)
  }
}

describe('terminal HTTP surface', () => {
  it('opens an unbound terminal at an absolute path even from a relative root', async () => {
    const baseUrl = await start({ terminals: { defaultCwd: '.' } })
    const wid = await workspaceId(baseUrl)
    const created = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(201)
    expect(((await created.json()) as { cwd: string }).cwd).toBe(process.cwd())
  })

  it('runs the create → write → resize → kill lifecycle', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)

    const created = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    })
    expect(created.status).toBe(201)
    const info = (await created.json()) as { id: string; cwd: string; shellId: string }
    // Absolute, even though a host may have been started with a relative root.
    expect(info.cwd).toBe(path.resolve(root))

    const listed = (await (await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`)).json()) as {
      terminals: Array<{ id: string }>
      shells: Array<{ id: string }>
      max: number
    }
    expect(listed.terminals.map((row) => row.id)).toEqual([info.id])
    expect(listed.shells.length).toBeGreaterThan(0)
    expect(listed.max).toBe(4)

    const input = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/${info.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: b64('ls\r') }),
    })
    expect(input.status).toBe(202)
    expect(spawned[0]?.writes).toEqual(['ls\r'])

    const resized = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/${info.id}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 120, rows: 40 }),
    })
    expect(resized.status).toBe(200)
    expect(spawned[0]?.resizes).toEqual([[120, 40]])

    const killed = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/${info.id}`, { method: 'DELETE' })
    expect(killed.status).toBe(200)
    expect(spawned[0]?.killed).toBe(true)
  })

  it('streams a snapshot with scrollback, then live output and the exit', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    const info = (await (
      await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      })
    ).json()) as { id: string }

    // Output produced before anyone connects must still reach a late client.
    spawned[0]?.data?.('early output')
    await new Promise((resolve) => setTimeout(resolve, 40))

    const sse = new TerminalSse(await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/events`))
    try {
      const snapshot = (await sse.until((frame) => frame['kind'] === 'snapshot')) as unknown as {
        terminals: Array<{ id: string; scrollback: string }>
      }
      expect(snapshot.terminals[0]?.id).toBe(info.id)
      expect(fromB64(snapshot.terminals[0]?.scrollback ?? '')).toBe('early output')

      spawned[0]?.data?.('live output')
      const data = (await sse.until((frame) => frame['kind'] === 'data')) as unknown as { data: string }
      expect(fromB64(data.data)).toBe('live output')

      spawned[0]?.exit?.({ exitCode: 7 })
      const exit = await sse.until((frame) => frame['kind'] === 'exit')
      expect(exit).toMatchObject({ kind: 'exit', terminalId: info.id, exitCode: 7, reason: 'exit' })
    } finally {
      await sse.close()
    }
  })

  it('opens a project terminal in that project folder and remembers which project', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    const folder = path.join(root, 'proj')
    await fs.mkdir(folder)
    const project = (await (
      await fetch(`${baseUrl}/api/workspaces/${wid}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Proj', path: folder }),
      })
    ).json()) as { id: string }

    const created = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    })
    expect(created.status).toBe(201)
    const info = (await created.json()) as { projectId?: string; cwd: string }
    expect(info.projectId).toBe(project.id)
    // Windows reports the 8.3 form of the temp dir, so compare the real path.
    const real = await fs.realpath(folder)
    expect(info.cwd).toBe(real)
    expect(spawned[0]?.options.cwd).toBe(real)

    // An unknown project is a 404, not a shell opened somewhere else.
    const missing = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-missing' }),
    })
    expect(missing.status).toBe(404)
    expect(spawned).toHaveLength(1)
  })

  it('refuses to exceed the per-workspace cap', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    const open = async (): Promise<Response> =>
      fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      })

    for (let index = 0; index < 4; index += 1) expect((await open()).status).toBe(201)
    const rejected = await open()
    expect(rejected.status).toBe(400)
    expect(((await rejected.json()) as { error: string }).error).toMatch(/4 terminals/)
  })

  it('fails closed on unknown workspaces and unknown terminals', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)

    expect((await fetch(`${baseUrl}/api/workspaces/nope/terminals`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/terminal-nope`, { method: 'DELETE' })).status)
      .toBe(404)
    const input = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/terminal-nope/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: b64('x') }),
    })
    expect(input.status).toBe(404)
  })

  it('will not let one workspace drive another workspace\'s terminal', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    const info = (await (
      await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string }

    const other = (await (
      await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'second' }),
      })
    ).json()) as { id: string }

    // A real id, addressed through a workspace that does not own it.
    for (const [path, init] of [
      [`terminals/${info.id}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: b64('x') }) }],
      [`terminals/${info.id}/resize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cols: 80, rows: 24 }) }],
      [`terminals/${info.id}`, { method: 'DELETE' }],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/workspaces/${other.id}/${path}`, init)
      expect(response.status).toBe(404)
    }
    // Untouched: it is still listed and alive under its real owner.
    expect(spawned[0]?.killed).toBe(false)
    expect(spawned[0]?.writes).toEqual([])
  })

  it('rejects a non-finite or absurd terminal geometry', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    const info = (await (
      await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string }

    // `NaN < 1` is false, so these must be rejected explicitly rather than
    // reaching the PTY and surfacing as a 500.
    for (const body of [{ cols: null, rows: 24 }, { cols: 1e400, rows: 24 }, { cols: 99_999, rows: 24 }]) {
      const response = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/${info.id}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(spawned[0]?.resizes).toEqual([])
  })

  it('rejects malformed input and resize bodies', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    const info = (await (
      await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string }

    const badInput = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/${info.id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 42 }),
    })
    expect(badInput.status).toBe(400)

    const badResize = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals/${info.id}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 0, rows: 24 }),
    })
    expect(badResize.status).toBe(400)
  })

  it('hides the family entirely when terminals are disabled', async () => {
    const baseUrl = await start({ terminals: { enabled: false } })
    const wid = await workspaceId(baseUrl)
    expect((await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`)).status).toBe(404)
  })

  it('refuses a non-loopback bind before listening', async () => {
    // No authenticated TLS profile exists, so acknowledging the risk does not
    // open the port. Terminals never become reachable on a network bind.
    await expect(start({ host: '0.0.0.0', unsafeNetworkBind: true })).rejects.toThrow(/authenticated TLS profile/)
  })

  it('answers 501 when no PTY backend is available', async () => {
    const baseUrl = await start({
      terminals: {
        spawner: {
          spawn() {
            throw new TerminalError('unavailable', 'node-pty is not available (test)')
          },
        },
      },
    })
    const wid = await workspaceId(baseUrl)
    const response = await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    })
    expect(response.status).toBe(501)
    expect(((await response.json()) as { error: string }).error).toMatch(/node-pty/)
  })

  it('kills every terminal when the host shuts down', async () => {
    const baseUrl = await start()
    const wid = await workspaceId(baseUrl)
    for (let index = 0; index < 2; index += 1) {
      await fetch(`${baseUrl}/api/workspaces/${wid}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      })
    }
    expect(spawned).toHaveLength(2)

    await server?.close()
    server = undefined

    expect(spawned.every((pty) => pty.killed)).toBe(true)
  })
})
