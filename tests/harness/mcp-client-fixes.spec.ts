import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerClient, MCP_PROTOCOL_VERSION } from '../../src/harness/mcp/client.ts'
import { assertOutboundUrl } from '../../src/harness/mcp/outbound-policy.ts'
import { MCP_LIMITS } from '../../src/harness/mcp/limits.ts'
import { fileURLToPath } from 'node:url'

const clients: McpServerClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect()
  vi.restoreAllMocks()
})
function httpClient(tokens?: () => Promise<string | undefined>, runtime = {}) {
  const client = new McpServerClient('fx', { name: 'fx', transport: 'http', url: 'https://example.test/mcp', enabled: true }, { tokenSource: tokens }, () => {}, runtime)
  clients.push(client)
  return client
}
function mockHttp(tools: unknown[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const rpc = JSON.parse(String(init?.body)) as { id?: number; method: string }
    if (rpc.id === undefined) return new Response(null, { status: 202 })
    return new Response(JSON.stringify({ id: rpc.id, result: rpc.method === 'initialize'
      ? { protocolVersion: MCP_PROTOCOL_VERSION }
      : rpc.method === 'tools/list' ? { tools } : { content: [] } }), { headers: { 'content-type': 'application/json' } })
  })
}
interface Internals {
  transport?: {
    stop(): Promise<void>
    child?: { pid: number; stdout: { emit(event: string, chunk: Buffer): void }; exitCode: number | null; signalCode: string | null }
    state: string
  }
  recoveryTimer?: ReturnType<typeof setTimeout>
  recoveryRunning: boolean
  breakerState: string
  breakerUntil: number
  openBreaker(callback?: () => Promise<void>): void
  recordSuccess(): void
  ensureConnected: (halfOpen?: boolean) => Promise<void>
}
const internal = (client: McpServerClient) => client as unknown as Internals
async function stdioClient(resourceLimits?: { maxLifetimeMs: number; enforcement: 'best_effort' }) {
  const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))
  const client = new McpServerClient('fx', { name: 'fx', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true, ...(resourceLimits ? { resourceLimits } : {}) }, {}, () => {})
  clients.push(client)
  await client.listTools()
  return client
}

describe('MCP client audit regressions', () => {
  it('#5 rejects private IPv4 embedded in normalized IPv6', () => {
    for (const host of ['::ffff:10.0.0.1', '::ffff:a00:1', '::a00:1', '64:ff9b::a00:1', '::ffff:169.254.169.254']) {
      expect(() => assertOutboundUrl(`https://[${host}]/`)).toThrow(/prohibited/)
    }
    expect(assertOutboundUrl('http://[::ffff:127.0.0.1]/', { allowLoopbackHttp: true }).protocol).toBe('http:')
    expect(() => assertOutboundUrl('http://[::ffff:127.0.0.1]/')).toThrow(/plain HTTP/)
    expect(assertOutboundUrl('https://[::ffff:808:808]/').protocol).toBe('https:')
  })

  it('#6 bounds hanging token resolution by the call deadline without dispatch', async () => {
    let hang = false
    const fetch = mockHttp()
    const client = httpClient(async () => hang ? new Promise(() => {}) : undefined)
    await client.listTools()
    hang = true
    fetch.mockClear()
    const result = await Promise.race([
      client.callTool('query', {}, 30).catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('still hanging'), 150)),
    ])
    expect(result).toMatchObject({ receipt: { kind: 'not_dispatched' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('#6 aborts hanging token resolution before dispatch', async () => {
    let hang = false
    const fetch = mockHttp()
    const client = httpClient(async () => hang ? new Promise(() => {}) : undefined)
    await client.listTools()
    hang = true
    fetch.mockClear()
    const abort = new AbortController()
    const call = client.callTool('query', {}, 5_000, abort.signal).catch((error: unknown) => error)
    abort.abort()
    const result = await Promise.race([call, new Promise((resolve) => setTimeout(() => resolve('still hanging'), 150))])
    expect(result).toMatchObject({ receipt: { kind: 'not_dispatched' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('#7 does not reopen recovery after disconnect during an awaited probe', async () => {
    const client = httpClient(undefined, { breakerDurationMs: 1, reconnectJitterMs: 0 })
    let reject!: (error: Error) => void
    internal(client).ensureConnected = () => new Promise<void>((_resolve, fail) => { reject = fail })
    internal(client).openBreaker(async () => {})
    await expect.poll(() => internal(client).recoveryRunning).toBe(true)
    await client.disconnect()
    reject(new Error('probe failed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(internal(client).recoveryTimer).toBeUndefined()
    expect(client.state).toBe('disabled')
  })

  it('#7 retirement cancels pending recovery and prevents reopening', () => {
    const client = httpClient(undefined, { breakerDurationMs: 60_000 })
    internal(client).openBreaker(async () => {})
    client.retire()
    expect(internal(client).recoveryTimer).toBeUndefined()
    const until = client.breakerOpenUntil
    internal(client).openBreaker(async () => {})
    expect(client.breakerOpenUntil).toBe(until)
  })

  it('#8 success cancels stale recovery instead of stopping the recovered transport', async () => {
    mockHttp()
    const client = httpClient(undefined, { breakerDurationMs: 10, reconnectJitterMs: 100 })
    internal(client).openBreaker(async () => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    await client.callTool('query', {}, 1_000)
    const transport = internal(client).transport!
    const stop = vi.spyOn(transport, 'stop')
    expect(internal(client).recoveryTimer).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(stop).not.toHaveBeenCalled()
    expect(client.transportsStarted).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('#9 stop kills the owned group even when its leader already exited', async () => {
    const client = await stdioClient()
    const child = internal(client).transport!.child!
    // Deterministically model the exit event arriving before stop; the live
    // group lets us assert cleanup without leaving an orphan in a failing run.
    const kill = vi.spyOn(process, 'kill')
    const previous = child.exitCode
    child.exitCode = 0
    try {
      await internal(client).transport!.stop()
      expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    } finally {
      child.exitCode = previous
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  it('#20 lifetime watchdog marks resource kills sticky instead of respawning', async () => {
    const client = await stdioClient({ maxLifetimeMs: 500, enforcement: 'best_effort' })
    await expect.poll(() => client.state, { timeout: 3_000 }).toBe('failed')
    expect(client.watchdogKills).toBe(1)
    await expect(client.callTool('query', {}, 1_000)).rejects.toThrow(/resource limit/)
    expect(client.transportsStarted).toBe(1)
  })

  it('#21 limits individual stdio frames, not the combined chunk and partial frame', async () => {
    const client = await stdioClient()
    const stdout = internal(client).transport!.child!.stdout
    const half = Math.floor(MCP_LIMITS.maxFrameBytes / 2)
    stdout.emit('data', Buffer.from('x'.repeat(half)))
    stdout.emit('data', Buffer.from('x'.repeat(half - 1) + '\n' + 'y'.repeat(half)))
    stdout.emit('data', Buffer.from('\n'))
    expect(client.state).toBe('ready')
    expect((await client.callTool('query', {}, 1_000)).isError).toBe(false)
  })

  it('#22 rejects excessive schema depth during discovery consistently with unusable names', async () => {
    let schema: unknown = { type: 'string' }
    for (let depth = 0; depth <= MCP_LIMITS.maxSchemaDepth; depth++) schema = { nested: schema }
    mockHttp([{ name: 'deep', inputSchema: schema }])
    await expect(httpClient().listTools()).rejects.toThrow(/schema is too deep/)
  })
})
