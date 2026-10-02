/**
 * MCP client (G5): JSON-RPC over stdio subprocess (primary) or Streamable
 * HTTP. Lifecycle pins MCP spec `2025-06-18`: initialize → tools/list →
 * tools/call → notifications/cancelled. Production hardening: per-call
 * timeout, one tools/call dispatch (no automatic replay), circuit breaker
 * (5 fails → 5 min disabled → auto-reconnect with jitter), 30s health
 * checks, verified subprocess cleanup on disconnect.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { McpDispatchError, receiptForTransportFailure, boundToolMetadata } from './boundaries.ts'
import type { McpServerConfig } from './config.ts'
import { MCP_LIMITS } from './limits.ts'
import { assertOutboundUrl, operatorHeaders } from './outbound-policy.ts'
import { assertHardContainmentAvailable, minimalStdioEnv, resolveCanonicalExecutable } from './process-controller.ts'
import { assertInitializeResult, assertCursor, assertSessionId } from './protocol.ts'
import { SseParser } from './sse-parser.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpToolDescriptor {
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
  readonly requiresUserInteraction?: boolean
  readonly readOnlyHint?: boolean
}

export interface McpCallResult {
  readonly isError: boolean
  readonly content: unknown
}

export type TransportState = 'connecting' | 'ready' | 'failed' | 'disabled'

export class McpTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpTransportError'
  }
}

/** JSON-RPC framing over a request/response channel. */
interface Transport {
  start(): Promise<void>
  stop(): Promise<void>
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): Promise<void>
  readonly state: TransportState
}

interface ProcessSample { readonly memoryMb: number; readonly cpuSeconds: number }

/**
 * Kill the server and every helper it started. POSIX children are spawned
 * as process-group leaders (`detached`), so the negative pid reaches the
 * whole group; Windows walks the tree with `taskkill /T`, asynchronously so
 * the event loop never blocks on it.
 */
function killOwnedProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => { child.kill() })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

/** Watchdog sampling period. */
const WATCHDOG_INTERVAL_MS = 1_000
/** Consecutive over-limit CPU samples that make a breach sustained (~3 s). */
const WATCHDOG_CPU_BREACHES = 3

/** Sample cumulative process CPU seconds + memory; caller computes deltas. */
async function readProcessSample(pid: number): Promise<ProcessSample | undefined> {
  if (process.platform === 'win32') {
    const stdout = await new Promise<string | undefined>((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} | Select-Object @{n='m';e={$_.WorkingSet64/1MB}},@{n='c';e={$_.CPU}} | ConvertTo-Json -Compress)`,
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true }, (error, out) => resolve(error === null ? out : undefined))
    })
    if (stdout === undefined) return undefined
    try {
      const parsed = JSON.parse(stdout.trim()) as { m?: number; c?: number }
      return { memoryMb: parsed.m ?? 0, cpuSeconds: parsed.c ?? 0 }
    } catch { return undefined }
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(/\s+/)
    const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0)
    // Linux clock ticks are commonly 100 Hz; this is explicit and can be
    // made platform-configurable if a target differs.
    const ticks = Number(stat[13] ?? 0) + Number(stat[14] ?? 0)
    return { memoryMb: kb / 1024, cpuSeconds: ticks / 100 }
  } catch { return undefined }
}

/** stdio: one subprocess per (workspace, server), newline-delimited JSON-RPC. */
class StdioTransport implements Transport {
  private child: ChildProcess | undefined
  /** Set by stop() even when spawn has not assigned `child` yet. */
  private stopped = false
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private buffer = ''
  private resourceTimer: ReturnType<typeof setInterval> | undefined
  private previousSample: { readonly at: number; readonly cpuSeconds: number } | undefined
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  state: TransportState = 'connecting'

  constructor(
    private readonly config: McpServerConfig,
    private readonly resolvedEnv: Record<string, string>,
    private readonly onNotification?: (method: string) => void,
  ) {}

  async start(): Promise<void> {
    const command = this.config.command
    if (command === undefined) throw new McpTransportError('stdio transport requires a command')
    if (this.stopped) throw new McpTransportError('transport stopped before spawn')
    if (this.config.resourceLimits?.enforcement === 'hard') await assertHardContainmentAvailable()
    if (this.stopped) throw new McpTransportError('transport stopped before spawn')
    const canonical = await resolveCanonicalExecutable(command)
    const pin = this.config.executable
    if (pin !== undefined && (canonical.path !== pin.path || canonical.sha256 !== pin.sha256)) {
      // The file the operator authorized is not the file that would run now:
      // an edited command, a PATH change, or replaced bytes. Enabling again
      // is what authorizes the new file.
      throw new McpTransportError(`executable_changed: '${command}' now resolves to ${canonical.path === pin.path ? 'different bytes at the authorized path' : canonical.path}; enable the server again to trust it`)
    }
    if (this.stopped) throw new McpTransportError('transport stopped before spawn')
    const child = spawn(canonical.path, this.config.args ?? [], {
      env: minimalStdioEnv(this.resolvedEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // Own process group on POSIX so stop() can kill the server's helpers too.
      // (On Windows `detached` would open a new console; taskkill /T covers it.)
      detached: process.platform !== 'win32',
    })
    this.child = child
    if (this.stopped) {
      killOwnedProcessTree(child)
      this.child = undefined
      throw new McpTransportError('transport stopped before spawn')
    }
    this.startResourceWatchdog(child)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(this.buffer) + chunk.length > MCP_LIMITS.maxFrameBytes) {
        this.failPending(new McpTransportError('stdio frame exceeded the byte limit'))
        return
      }
      this.buffer += chunk.toString('utf8')
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        newline = this.buffer.indexOf('\n')
        if (line === '') continue
        this.handleLine(line)
      }
    })
    // A write after the server died (e.g. the watchdog killed it) emits EPIPE
    // on stdin; unhandled, that event would crash the host process.
    child.stdin?.on('error', (error: Error) => {
      this.failPending(new McpTransportError(`stdin write failed: ${error.message}`))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // stderr = server logs; surfaced via diagnostics, never parsed.
      void chunk
    })
    child.on('close', () => {
      this.state = 'failed'
      for (const pending of this.pending.values()) {
        pending.reject(new McpTransportError('server closed the connection'))
      }
      this.pending.clear()
    })
    child.on('error', (error: Error) => {
      this.state = 'failed'
      for (const pending of this.pending.values()) {
        pending.reject(new McpTransportError(`spawn error: ${error.message}`))
      }
      this.pending.clear()
    })
    // MCP initialize handshake. A bad version never receives notifications/initialized.
    const initialized = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mini-dsh', version: '0.1.0' },
    }, 10_000)
    assertInitializeResult(initialized)
    await this.notify('notifications/initialized', {})
    this.state = 'ready'
  }

  private failPending(error: Error): void {
    this.state = 'failed'
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (this.child !== undefined) killOwnedProcessTree(this.child)
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return // non-JSON line = server log noise
    }
    const record = parsed as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
    if (typeof record.method === 'string') {
      this.onNotification?.(record.method)
      return
    }
    if (typeof record.id !== 'number') return
    const pending = this.pending.get(record.id)
    if (pending === undefined) return
    this.pending.delete(record.id)
    if (record.error !== undefined) {
      pending.reject(new McpTransportError('MCP JSON-RPC request failed'))
    } else {
      pending.resolve(record.result)
    }
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.child?.stdin?.write(`${message}\n`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'client abort' } })}\n`)
      rejectPending(new McpTransportError(`${method} cancelled`))
    }
    const rejectPending = (error: Error): void => {
      const waiting = this.pending.get(id)
      if (waiting === undefined) return
      this.pending.delete(id)
      waiting.reject(error)
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpTransportError(`${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.pending.delete(id)
    }
  }

  /** Watchdog kills of this process: at most one, however long the breach lasts. */
  watchdogKills = 0

  private startResourceWatchdog(child: ChildProcess): void {
    const limits = this.config.resourceLimits
    if (limits === undefined || child.pid === undefined) return
    if (limits.maxLifetimeMs !== undefined) {
      this.lifetimeTimer = setTimeout(() => killOwnedProcessTree(child), limits.maxLifetimeMs)
      this.lifetimeTimer.unref?.()
    }
    if (limits.memoryMb === undefined && limits.cpuPercent === undefined) return
    const pid = child.pid
    // One kill per breach, however many samples keep reporting it.
    const act = (): void => {
      if (this.watchdogKills > 0) return
      this.watchdogKills += 1
      killOwnedProcessTree(child)
    }
    let cpuBreaches = 0
    let sampling = false
    const sampleOnce = async (): Promise<void> => {
      // Sampling is asynchronous so a slow probe (PowerShell on Windows)
      // never blocks the host's event loop; overlapping ticks are skipped.
      if (sampling || this.watchdogKills > 0) return
      sampling = true
      try {
        const sample = await readProcessSample(pid)
        if (sample === undefined) {
          // A configured limit this host cannot monitor fails closed.
          act()
          return
        }
        if (limits.memoryMb !== undefined && sample.memoryMb > limits.memoryMb) act()
        if (limits.cpuPercent !== undefined) {
          const now = Date.now()
          const previous = this.previousSample
          this.previousSample = { at: now, cpuSeconds: sample.cpuSeconds }
          if (previous !== undefined) {
            const wallSeconds = Math.max((now - previous.at) / 1_000, 0.001)
            const cpuPercent = ((sample.cpuSeconds - previous.cpuSeconds) / wallSeconds / Math.max(cpus().length, 1)) * 100
            // A short burst is not a breach: only CPU over the limit for
            // WATCHDOG_CPU_BREACHES consecutive samples is sustained load.
            cpuBreaches = cpuPercent > limits.cpuPercent ? cpuBreaches + 1 : 0
            if (cpuBreaches >= WATCHDOG_CPU_BREACHES) act()
          }
        }
      } finally {
        sampling = false
      }
    }
    void sampleOnce()
    this.resourceTimer = setInterval(() => { void sampleOnce() }, WATCHDOG_INTERVAL_MS)
    this.resourceTimer.unref?.()
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}
`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.resourceTimer !== undefined) clearInterval(this.resourceTimer)
    if (this.lifetimeTimer !== undefined) clearTimeout(this.lifetimeTimer)
    // Verified cleanup: close stdin, kill the tree, wait for exit. Windows
    // orphan prevention mirrors the G1 Bash gate (taskkill on timeout paths
    // — here a direct SIGKILL/kill suffices since we own the direct child).
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    await new Promise<void>((resolve) => {
      const done = (): void => resolve()
      child.once('close', done)
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      try {
        child.stdin?.end()
        // One OS process per (workspace, server), but MCP servers may spawn
        // helpers: kill the whole tree so Stop/restart leaves no orphans.
        killOwnedProcessTree(child)
      } catch {
        done()
      }
      setTimeout(done, 2_000).unref?.()
    })
  }
}

/** Streamable HTTP: JSON-RPC over POST with bearer auth. */
class HttpTransport implements Transport {
  private sessionId: string | undefined
  private nextId = 1
  private stopped = false
  private readonly abort = new AbortController()
  state: TransportState = 'connecting'

  constructor(
    private readonly config: McpServerConfig,
    private readonly bearerToken: string | undefined,
    private readonly onNotification?: (method: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.stopped) throw new McpTransportError('transport stopped before spawn')
    const initialized = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mini-dsh', version: '0.1.0' },
    }, 10_000)
    if (this.stopped) throw new McpTransportError('transport stopped before spawn')
    assertInitializeResult(initialized)
    await this.notify('notifications/initialized', {})
    this.state = 'ready'
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const onAbort = (): void => {
      void this.notify('notifications/cancelled', { requestId: id, reason: 'client abort' }).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Removed on every path: a failed request must not leave its listener on
    // a signal that outlives it (a turn's signal spans many calls).
    try {
      const response = await this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, timeoutMs, signal)
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) return await this.readSseResult(response, id)
      let body: { id?: unknown; result?: unknown; error?: unknown }
      try {
        body = JSON.parse(await readBoundedText(response, MCP_LIMITS.maxFrameBytes)) as typeof body
      } catch (error) {
        if (error instanceof McpTransportError) throw error
        throw new McpTransportError('MCP response is not valid JSON')
      }
      if (body.id !== id) throw new McpTransportError(`MCP response id mismatch: expected ${id}`)
      if (body.error !== undefined) throw new McpTransportError('MCP JSON-RPC request failed')
      return body.result
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, 5_000)
    // Notifications may return 202/204 or a JSON ack; status was checked.
    await response.body?.cancel().catch(() => {})
  }

  private async post(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    if (this.config.url === undefined) throw new McpTransportError('http transport requires a url')
    const target = assertOutboundUrl(this.config.url, { allowLoopbackHttp: true })
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...operatorHeaders(this.config.headers),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: target.origin,
        ...(this.bearerToken !== undefined ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        ...(this.sessionId !== undefined ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal, ...(signal !== undefined ? [signal] : [])]),
    })
    if (response.status >= 300 && response.status < 400) {
      throw new McpDispatchError('HTTP redirect was not followed', receiptForTransportFailure(true, 'redirect_followed'))
    }
    const sessionHeader = response.headers.get('mcp-session-id')
    if (sessionHeader !== null) {
      assertSessionId(sessionHeader)
      this.sessionId = sessionHeader
    }
    if (!response.ok) throw new McpTransportError(`HTTP ${response.status}`)
    return response
  }

  /** Incremental SSE event parser: no full-response buffering; matches request id. */
  private async readSseResult(response: Response, requestId: number): Promise<unknown> {
    if (response.body === null) throw new McpTransportError('SSE response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const events = parser.push(decoder.decode(value, { stream: true }))
        for (const event of events) {
          let parsed: { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
          try { parsed = JSON.parse(event.data) as typeof parsed } catch { continue }
          if (typeof parsed.method === 'string') {
            this.onNotification?.(parsed.method)
            continue
          }
          if (parsed.id !== requestId) continue
          if (parsed.error !== undefined) throw new McpTransportError('MCP JSON-RPC request failed')
          return parsed.result
        }
      }
    } finally {
      reader.releaseLock()
    }
    throw new McpTransportError('SSE response carried no matching JSON-RPC result')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    // Terminate the server-side Streamable HTTP session when one exists.
    if (this.config.url !== undefined && this.sessionId !== undefined) {
      await fetch(assertOutboundUrl(this.config.url, { allowLoopbackHttp: true }), {
        method: 'DELETE',
        redirect: 'manual',
        headers: {
          origin: new URL(this.config.url).origin,
          'mcp-session-id': this.sessionId,
          ...(this.bearerToken !== undefined ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        },
      }).catch(() => undefined)
    }
    this.sessionId = undefined
  }
}


/**
 * Read a response body up to `maxBytes` of DECODED bytes. The runtime
 * decompresses gzip/deflate/br transparently, so counting after decoding is
 * what bounds a small compressed body that inflates to gigabytes.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new McpTransportError(`MCP response exceeds the ${maxBytes}-byte decoded limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function descriptorsFromList(raw: unknown, serverName: string): readonly McpToolDescriptor[] {
  const result = raw as { tools?: { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; requiresUserInteraction?: boolean } }[] } | undefined
  const seen = new Set<string>()
  const descriptors: McpToolDescriptor[] = []
  for (const tool of result?.tools ?? []) {
    if (typeof tool.name !== 'string' || tool.name.trim() === '' || seen.has(tool.name)) {
      throw new McpTransportError(`MCP tools/list contains duplicate or empty tool name`)
    }
    seen.add(tool.name)
    const bounded = boundToolMetadata({
      server: serverName,
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    })
    if (bounded === undefined) throw new McpTransportError('MCP tools/list contains an unusable tool name')
    descriptors.push({
      name: bounded.name,
      ...(bounded.description !== '' ? { description: bounded.description } : {}),
      inputSchema: bounded.inputSchema,
      ...(tool.annotations?.readOnlyHint === true ? { readOnlyHint: true } : {}),
      ...(tool.annotations?.requiresUserInteraction === true ? { requiresUserInteraction: true } : {}),
    })
  }
  return descriptors
}

/** Retry + circuit breaker + health-check wrapper around one transport. */
export class McpServerClient {
  private transport: Transport | undefined
  state: TransportState = 'disabled'
  private consecutiveFailures = 0
  private breakerUntil = 0
  private breakerState: 'closed' | 'open' | 'half-open' = 'closed'
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryRunning = false
  private healthTimer: ReturnType<typeof setInterval> | undefined
  private onReconnected: (() => Promise<void>) | undefined
  private toolsCache: readonly McpToolDescriptor[] = []

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly resolved: { readonly env?: Record<string, string> | undefined; readonly bearerToken?: string | undefined; readonly headers?: Record<string, string> | undefined },
    private readonly onAudit: (event: { readonly kind: 'call' | 'breaker' | 'reconnect'; readonly detail: string; readonly durationMs: number; readonly isError: boolean }) => void,
    private readonly runtime: { readonly breakerDurationMs?: number; readonly healthIntervalMs?: number; readonly reconnectJitterMs?: number } = {},
  ) {}

  /** Whether the breaker currently allows a call. */
  get available(): boolean {
    return this.state === 'ready' && Date.now() >= this.breakerUntil
  }

  get breakerOpenUntil(): number {
    return this.breakerUntil
  }

  /** Discover tools: connect if needed, snapshot tools/list. */
  async listTools(): Promise<readonly McpToolDescriptor[]> {
    if (Date.now() < this.breakerUntil) {
      throw new McpTransportError(`server '${this.serverName}' is disabled by the circuit breaker`)
    }
    await this.ensureConnected()
    const tools = await this.withRetry(() => this.fetchAllTools(this.config.timeoutMs ?? 15_000))
    this.toolsCache = tools
    return tools
  }

  /**
   * The one discovery walk — initial list, health check, breaker recovery,
   * and `tools/list_changed` all use it, so each sees every page under the
   * same cursor and tool caps rather than a first page only.
   */
  private async fetchAllTools(timeoutMs: number): Promise<readonly McpToolDescriptor[]> {
    const transport = this.transport
    if (transport === undefined) throw new McpTransportError('tools/list needs a connected transport')
    const pages: McpToolDescriptor[] = []
    const names = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let page = 0
    do {
      page += 1
      assertCursor(cursor, seenCursors, page)
      if (cursor !== undefined && cursor !== '') seenCursors.add(cursor)
      const raw = await transport.request('tools/list', cursor !== undefined ? { cursor } : {}, timeoutMs)
      for (const descriptor of descriptorsFromList(raw, this.serverName)) {
        if (names.has(descriptor.name)) throw new McpTransportError(`tools/list repeats '${descriptor.name}' across pages`)
        names.add(descriptor.name)
        pages.push(descriptor)
      }
      if (pages.length > MCP_LIMITS.maxTools) throw new McpTransportError('tools/list exceeded the tool cap')
      cursor = (raw as { nextCursor?: unknown } | undefined)?.nextCursor as string | undefined
    } while (cursor !== undefined && cursor !== '')
    return pages
  }

  cachedTools(): readonly McpToolDescriptor[] {
    return this.toolsCache
  }

  /**
   * One tools/call. A transport failure after the write is attempted is
   * `possibly_dispatched` and is not sent again.
   */
  async callTool(tool: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult> {
    const started = Date.now()
    let sent = false
    try {
      if (Date.now() < this.breakerUntil) {
        throw new McpDispatchError(
          `server '${this.serverName}' is disabled by the circuit breaker`,
          receiptForTransportFailure(false, 'not_connected'),
        )
      }
      await this.ensureConnected()
      if (this.retired) {
        throw new McpDispatchError('runtime generation was fenced', receiptForTransportFailure(false, 'not_connected'))
      }
      // A turn already stopping sends nothing; this is provably not dispatched.
      if (signal?.aborted === true) {
        throw new McpDispatchError('cancelled before the call was sent', receiptForTransportFailure(false, 'cancelled_before_send'))
      }
      sent = true
      const raw = await this.transport?.request('tools/call', { name: tool, arguments: args }, timeoutMs, signal)
      this.recordSuccess()
      const result = (raw ?? {}) as { isError?: boolean; content?: unknown }
      this.onAudit({ kind: 'call', detail: `${this.serverName}.${tool}`, durationMs: Date.now() - started, isError: result.isError === true })
      return { isError: result.isError === true, content: result.content ?? null }
    } catch (error) {
      const dispatch = error instanceof McpDispatchError
        ? error
        : new McpDispatchError(
          error instanceof Error ? error.message : String(error),
          receiptForTransportFailure(sent, sent ? (signal?.aborted === true ? 'cancelled_after_send' : 'response_lost') : 'not_connected'),
        )
      this.recordFailure(dispatch)
      throw dispatch
    }
  }

  /**
   * The generation that built this client is dead. Further connects throw
   * instead of spawning another process from the old config.
   */
  private retired = false

  retire(): void {
    this.retired = true
  }

  /** Disconnect with verified subprocess cleanup. */
  async disconnect(): Promise<void> {
    this.retired = true
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    if (this.recoveryTimer !== undefined) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = undefined
    }
    await this.transport?.stop()
    this.transport = undefined
    this.state = 'disabled'
  }

  /** 30s health checks; breaker recovery is timer-driven and single-flight. */
  startHealthChecks(onReconnected: () => Promise<void>): void {
    this.onReconnected = onReconnected
    if (this.breakerState === 'open') this.scheduleRecovery(onReconnected)
    if (this.healthTimer !== undefined) return
    this.healthTimer = setInterval(() => {
      if (this.breakerState === 'open') return
      void (async () => {
        try {
          await this.ensureConnected()
          this.toolsCache = await this.fetchAllTools(5_000)
          this.recordSuccess()
        } catch {
          this.recordFailure(new McpTransportError('health check failed'), onReconnected)
        }
      })()
    }, this.runtime.healthIntervalMs ?? 30_000)
    this.healthTimer.unref?.()
  }

  private scheduleRecovery(onReconnected: () => Promise<void>): void {
    if (this.recoveryTimer !== undefined) return
    const delay = Math.max(0, this.breakerUntil - Date.now()) +
      (this.runtime.reconnectJitterMs ?? Math.floor(Math.random() * 2_000))
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      if (this.recoveryRunning) return
      this.recoveryRunning = true
      void (async () => {
        try {
          this.breakerState = 'half-open'
          await this.transport?.stop().catch(() => {})
          this.transport = undefined
          await this.ensureConnected(true)
          this.toolsCache = await this.fetchAllTools(5_000)
          this.recordSuccess()
          await onReconnected()
          this.onAudit({ kind: 'reconnect', detail: this.serverName, durationMs: 0, isError: false })
        } catch {
          this.openBreaker(onReconnected)
        } finally {
          this.recoveryRunning = false
        }
      })()
    }, delay)
    this.recoveryTimer.unref?.()
  }

  private async ensureConnected(halfOpen = false): Promise<void> {
    if (this.retired) {
      throw new McpDispatchError('runtime generation was fenced', receiptForTransportFailure(false, 'not_connected'))
    }
    if (this.breakerState === 'open') {
      if (!halfOpen && Date.now() < this.breakerUntil) {
        throw new McpTransportError(`server '${this.serverName}' is disabled by the circuit breaker`)
      }
      // Recovery window elapsed: this caller becomes the half-open probe.
      this.breakerState = 'half-open'
    }
    if (this.transport !== undefined && this.state === 'ready') return
    // Single flight: concurrent callers share one connect. Two unshared
    // connects would each build a transport, and the one overwritten would
    // leak its process or session.
    if (this.connecting === undefined) {
      this.connecting = this.connect().finally(() => { this.connecting = undefined })
    }
    await this.connecting
  }

  private connecting: Promise<void> | undefined

  private async connect(): Promise<void> {
    this.state = 'connecting'
    const onNotification = (method: string): void => {
      if (method === 'notifications/tools/list_changed') this.refreshToolsFromNotification()
    }
    const transport =
      this.config.transport === 'stdio'
        ? new StdioTransport(this.config, this.resolved.env ?? {}, onNotification)
        : new HttpTransport({
            ...this.config,
            ...((this.resolved.headers ?? this.config.headers) !== undefined
              ? { headers: this.resolved.headers ?? this.config.headers }
              : {}),
          }, this.resolved.bearerToken, onNotification)
    // A failed or dead transport is replaced, never abandoned: its process
    // (and watchdog timers) would otherwise outlive the reference to it.
    const previous = this.transport
    this.transport = transport
    if (previous !== undefined) await previous.stop().catch(() => {})
    this.transportsStarted += 1
    try {
      await transport.start()
    } catch (error) {
      // Handshake timeout, frame overrun, bad version: tear the child down now.
      await transport.stop().catch(() => {})
      if (this.transport === transport) this.transport = undefined
      this.state = 'failed'
      throw error
    }
    this.state = transport.state
  }

  /** Transports this client has built; a reconnect storm must not grow it past one per connect. */
  transportsStarted = 0

  /** Resource-watchdog kills of the current stdio process (0 or 1). */
  get watchdogKills(): number {
    return this.transport instanceof StdioTransport ? this.transport.watchdogKills : 0
  }

  private refreshing: Promise<void> | undefined
  private refreshAgain = false
  /** Refreshes actually run, for observing notification coalescing. */
  toolRefreshes = 0

  /**
   * A `tools/list_changed` storm collapses to one refresh in flight plus one
   * follow-up: notifications that arrive during a refresh only ask for
   * another pass, which then sees everything they announced.
   */
  private refreshToolsFromNotification(): void {
    if (this.refreshing !== undefined) {
      this.refreshAgain = true
      return
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false
        this.toolRefreshes += 1
        try {
          this.toolsCache = await this.fetchAllTools(this.config.timeoutMs ?? 15_000)
          await this.onReconnected?.()
          this.onAudit({ kind: 'reconnect', detail: `${this.serverName}: tools/list_changed`, durationMs: 0, isError: false })
        } catch {
          this.recordFailure(new McpTransportError('tools/list_changed refresh failed'))
          return
        }
      } while (this.refreshAgain && !this.retired)
    })().finally(() => { this.refreshing = undefined })
  }

  private async withRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted === true) throw new McpTransportError('cancelled')
      try {
        return await operation()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt))
      }
    }
    throw lastError ?? new McpTransportError('operation failed')
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0
    this.breakerUntil = 0
    this.breakerState = 'closed'
    this.state = 'ready'
  }

  private recordFailure(error: Error, onReconnected?: () => Promise<void>): void {
    this.consecutiveFailures += 1
    // Redacted diagnostic detail: never store/log the raw server error.
    this.onAudit({ kind: 'call', detail: `${this.serverName}: operation failed`, durationMs: 0, isError: true })
    if (this.consecutiveFailures >= 5) this.openBreaker(onReconnected ?? this.onReconnected)
  }

  private openBreaker(onReconnected?: () => Promise<void>): void {
    this.breakerUntil = Date.now() + (this.runtime.breakerDurationMs ?? 5 * 60_000)
    this.breakerState = 'open'
    this.state = 'failed'
    this.consecutiveFailures = 0
    this.onAudit({ kind: 'breaker', detail: `${this.serverName} breaker open`, durationMs: 0, isError: true })
    void this.transport?.stop().catch(() => {})
    this.transport = undefined
    const recover = onReconnected ?? this.onReconnected
    if (recover !== undefined) this.scheduleRecovery(recover)
  }
}
