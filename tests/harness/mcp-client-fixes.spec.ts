import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerClient, MCP_PROTOCOL_VERSION } from '../../src/harness/mcp/client.ts'
import { assertOutboundUrl } from '../../src/harness/mcp/outbound-policy.ts'
import { defaultOutboundHttp } from '../../src/harness/mcp/outbound-http.ts'
import { senderHttp, type SentInit } from '../support/outbound-sender.ts'
import { MCP_LIMITS } from '../../src/harness/mcp/limits.ts'
import { fileURLToPath } from 'node:url'

const clients: McpServerClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect()
  vi.restoreAllMocks()
})
type Send = (url: string, init: SentInit) => Promise<Response>
/** The final send under the outbound policy envelope; tests swap its implementation. */
let sender = vi.fn<Send>()
function httpClient(tokens?: () => Promise<string | undefined>, runtime = {}) {
  const outboundHttp = senderHttp((url, init) => sender(url, init))
  const client = new McpServerClient('fx', { name: 'fx', transport: 'http', url: 'https://example.test/mcp', enabled: true }, { tokenSource: tokens }, () => {}, { ...runtime, outboundHttp })
  clients.push(client)
  return client
}
function mockHttp(tools: unknown[] = []) {
  sender = vi.fn<Send>()
  return sender.mockImplementation(async (_url, init) => {
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

function barrier<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('MCP client audit regressions', () => {
  it('rejects DNS names resolving to private addresses at connection time', async () => {
    await expect(defaultOutboundHttp().request('https://localhost/')).rejects.toThrow()
    // A hostname distinct from the explicit localhost fixture has no private-address exception.
    await expect(defaultOutboundHttp().request('https://localhost.localdomain/')).rejects.toThrow()
  })

  it('rejects a non-string pagination cursor before requesting another page', async () => {
    const fetchMock = mockHttp()
    fetchMock.mockImplementation(async (_url, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      return Response.json({ id: rpc.id, result: rpc.method === 'initialize' ? { protocolVersion: MCP_PROTOCOL_VERSION } : { tools: [], nextCursor: 5 } })
    })
    await expect(httpClient().listTools()).rejects.toThrow(/non-string cursor/)
    expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('"cursor"'))).toHaveLength(0)
  })

  it('rejects the entire IPv6 link-local /10 but not adjacent ranges', () => {
    for (const host of ['fe80::1', 'fe90::1', 'fea0::1', 'febf:ffff::1']) {
      expect(() => assertOutboundUrl(`https://[${host}]/`)).toThrow(/prohibited/)
    }
    // fec0::/10 (deprecated site-local) directly above is prohibited too; the next block up is not.
    expect(() => assertOutboundUrl('https://[fec0::1]/')).toThrow(/prohibited/)
    for (const host of ['fe7f::1', 'fe7f:ffff::1']) expect(assertOutboundUrl(`https://[${host}]/`).protocol).toBe('https:')
  })

  it('does not treat NAT64 embedded loopback as direct loopback', () => {
    expect(() => assertOutboundUrl('https://[64:ff9b::7f00:1]/')).toThrow(/prohibited/)
    expect(() => assertOutboundUrl('http://[64:ff9b::7f00:1]/', { allowLoopbackHttp: true })).toThrow()
    expect(assertOutboundUrl('http://[::1]/', { allowLoopbackHttp: true }).protocol).toBe('http:')
  })

  it('consumes a rejected token promise when its source aborts synchronously', async () => {
    const fetch = mockHttp()
    const abort = new AbortController()
    let abortInSource = false
    const rejected = Promise.reject(new Error('token failed'))
    // Keep the RED run contained; observe whether the client attaches its own consumer.
    await rejected.catch(() => {})
    const consume = vi.spyOn(rejected, 'then')
    const client = httpClient(() => {
      if (!abortInSource) return Promise.resolve(undefined)
      abortInSource = false
      abort.abort()
      return rejected
    })
    await client.listTools()
    abortInSource = true
    fetch.mockClear()
    await expect(client.callTool('query', {}, 1_000, abort.signal)).rejects.toMatchObject({ receipt: { kind: 'not_dispatched' } })
    expect(consume).toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('aborts after entering token resolution without sending a cancellation or resolving another token', async () => {
    const fetch = mockHttp()
    const entered = barrier()
    const token = barrier<string | undefined>()
    let waiting = false
    const source = vi.fn(() => {
      if (!waiting) return Promise.resolve(undefined)
      entered.resolve()
      return token.promise
    })
    const client = httpClient(source)
    await client.listTools()
    waiting = true
    source.mockClear()
    fetch.mockClear()
    const abort = new AbortController()
    const call = client.callTool('query', {}, 1_000, abort.signal).catch((error: unknown) => error)
    await entered.promise
    abort.abort()
    expect(await call).toMatchObject({ receipt: { kind: 'not_dispatched' } })
    token.resolve('late-token')
    await Promise.resolve()
    expect(source).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a dispatched request with its original id and token without resolving tokens again', async () => {
    const fetch = mockHttp()
    const source = vi.fn(async () => 'original-token')
    const client = httpClient(source)
    await client.listTools()
    const entered = barrier()
    let requestId: number | undefined
    fetch.mockImplementation(async (_url, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (rpc.method !== 'tools/call') return new Response(null, { status: 202 })
      requestId = rpc.id
      entered.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    source.mockClear()
    fetch.mockClear()
    const abort = new AbortController()
    const call = client.callTool('query', {}, 1_000, abort.signal).catch((error: unknown) => error)
    await entered.promise
    abort.abort()
    expect(await call).toMatchObject({ receipt: { kind: 'possibly_dispatched' } })
    await expect.poll(() => fetch.mock.calls.length).toBe(2)
    const cancellation = fetch.mock.calls[1]![1]!
    expect(JSON.parse(String(cancellation.body))).toMatchObject({ method: 'notifications/cancelled', params: { requestId } })
    expect(new Headers(cancellation.headers).get('authorization')).toBe('Bearer original-token')
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('keeps a caller transport connected while recovery teardown is suspended', async () => {
    mockHttp()
    const client = httpClient(undefined, { breakerDurationMs: 10, reconnectJitterMs: 0 })
    await client.listTools()
    const old = internal(client).transport!
    internal(client).openBreaker(async () => {})
    // Model the transport still awaiting teardown when the recovery callback captures it.
    internal(client).transport = old
    const entered = barrier()
    const release = barrier()
    vi.spyOn(old, 'stop').mockImplementation(() => { entered.resolve(); return release.promise })
    await entered.promise
    const call = client.callTool('query', {}, 1_000)
    const outcome = await Promise.race([call.then(() => 'connected'), new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100))])
    const current = internal(client).transport
    const started = client.transportsStarted
    release.resolve()
    await call
    await expect.poll(() => internal(client).recoveryRunning).toBe(false)
    expect(outcome).toBe('connected')
    expect(current).not.toBe(old)
    expect(internal(client).transport).toBe(current)
    expect(client.transportsStarted).toBe(started)
  })

  it.each(['retired', 'noncurrent', 'dead'] as const)('late success on a %s transport does not close the breaker or revive state', async (mode) => {
    const fetch = mockHttp()
    const client = httpClient(undefined, { breakerDurationMs: 60_000 })
    await client.listTools()
    const entered = barrier()
    const response = barrier<Response>()
    fetch.mockImplementationOnce(async (_url, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id: number }
      entered.resolve()
      const result = await response.promise
      return new Response(JSON.stringify({ id: rpc.id, result: { content: [] } }), { headers: result.headers })
    })
    const call = client.callTool('query', {}, 1_000)
    await entered.promise
    if (mode === 'retired') await client.disconnect()
    else if (mode === 'noncurrent') internal(client).openBreaker()
    else {
      internal(client).transport!.state = 'failed'
      client.state = 'failed'
    }
    const state = client.state
    const until = client.breakerOpenUntil
    response.resolve(new Response(null, { headers: { 'content-type': 'application/json' } }))
    await call
    expect(client.state).toBe(state)
    expect(client.breakerOpenUntil).toBe(until)
  })
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
