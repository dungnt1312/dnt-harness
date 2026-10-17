/**
 * The transport for policy-owned outbound HTTP: MCP Streamable HTTP, managed
 * OAuth (discovery, registration, token, refresh, revoke) and foreign media.
 * Operator-configured LLM/image gateways do NOT use it; they may be private.
 *
 * Envelope, in order: validate the URL ({@link assertOutboundUrl}) → pick the
 * policy dispatcher for the mode → send with `redirect: 'manual'` and one
 * signal combining the caller's signal and the internal deadline → hand the
 * response to the caller, which owns status semantics and body consumption.
 * The combined signal stays attached to the body, so the deadline and the
 * caller's abort both bound reading it, not just the headers.
 *
 * DNS is checked at connection time: each dispatcher's `connect` resolves the
 * hostname, rejects any answer set containing a prohibited address
 * (`outbound-policy.ts`), and connects the socket to the vetted address only.
 *
 * Real Undici is loaded from its resolved package entry. Under Bun the bare
 * `undici` specifier (and `require.resolve('undici')`) is Bun's native shim:
 * native fetch that ignores `dispatcher`, so the connect-time check would be
 * silently skipped. A capability guard refuses that shape and every request
 * fails closed. There is no fallback to native fetch.
 *
 * Tests may inject a low-level `sender` UNDER the envelope: it only ever sees
 * an already-validated URL plus the policy dispatcher, and production code
 * never constructs an `OutboundHttp` with one (see the wiring test).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Undici from 'undici'
import { assertOutboundUrl, isLoopbackUrl, OutboundPolicyError, resolvePolicyAddresses, type AddressResolver } from './outbound-policy.ts'

/** `public`: public addresses only. `loopback`: the local fixture profile, loopback addresses only. */
export type OutboundMode = 'public' | 'loopback'

/** The real Undici transport could not be loaded or failed its capability check. Never retried, never bypassed. */
export class OutboundTransportUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'OutboundTransportUnavailableError'
  }
}

/** The Web Response subset callers use; both Undici's and the global Response satisfy it. */
export interface OutboundResponse {
  readonly status: number
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  readonly body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

/** What a low-level sender receives: a validated URL, the policy dispatcher, manual redirects. */
export interface OutboundSendInit {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string | URLSearchParams
  readonly signal: AbortSignal
  readonly redirect: 'manual'
  /** Opaque policy dispatcher; a sender that drops it skips the connect-time DNS check. */
  readonly dispatcher: unknown
}

export type OutboundSender = (url: URL, init: OutboundSendInit) => Promise<OutboundResponse>

export interface OutboundRequestInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | URLSearchParams
  /** The caller's signal; combined with `timeoutMs`, never replaced by it. */
  readonly signal?: AbortSignal
  /** Internal deadline covering connect, headers and body. */
  readonly timeoutMs?: number
  /** The configured local fixture profile: loopback (and plain HTTP to it) is allowed. */
  readonly allowLoopback?: boolean
  /** Called once a policy-approved socket is assigned and the request is about to be written; never after a refused/failed connect. */
  readonly onSend?: () => void
}

type UndiciModule = Pick<typeof Undici, 'fetch' | 'Agent' | 'Pool' | 'buildConnector'>
export type UndiciLoader = () => Promise<UndiciModule>

export interface OutboundHttpOptions {
  /** Test seam: replaces the real-entry loader (e.g. to present Bun's shim shape). */
  readonly loader?: UndiciLoader
  /** Test seam: a scoped resolver fixture; the policy still judges every answer. */
  readonly resolver?: AddressResolver
  /** Test seam: a low-level sender under the envelope. */
  readonly sender?: OutboundSender
  readonly connectTimeoutMs?: number
}

/**
 * Load the npm package's real entry by path. Bun intercepts both the bare
 * specifier and `require.resolve('undici')`, so resolve `package.json` and
 * join its `main`.
 */
export async function loadRealUndici(): Promise<UndiciModule> {
  const pkgPath = createRequire(import.meta.url).resolve('undici/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { readonly main?: string }
  const entry = path.join(path.dirname(pkgPath), pkg.main ?? 'index.js')
  const ns = await import(pathToFileURL(entry).href) as UndiciModule & { readonly default?: UndiciModule }
  return typeof ns.default?.fetch === 'function' ? ns.default : ns
}

function isNative(fn: unknown): boolean {
  return typeof fn === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn))
}

/** Fail closed unless fetch is Undici's own JS fetch and the module can build connect-hooked agents. */
function assertCapable(mod: UndiciModule): void {
  if (typeof mod.fetch !== 'function') throw new OutboundTransportUnavailableError('outbound transport: Undici fetch is missing')
  if (mod.fetch === globalThis.fetch || isNative(mod.fetch)) {
    throw new OutboundTransportUnavailableError('outbound transport: fetch is the runtime native fetch, which ignores the policy dispatcher')
  }
  if (typeof mod.Agent !== 'function' || typeof mod.Pool !== 'function' || typeof mod.buildConnector !== 'function') {
    throw new OutboundTransportUnavailableError('outbound transport: Undici Agent/Pool/buildConnector are unavailable')
  }
}

interface LoadedTransport {
  readonly send: OutboundSender
  readonly dispatchers: Readonly<Record<OutboundMode, Undici.Agent>>
  /** Every per-origin pool the agents created; `Agent.close()` forgets them, a forced close must not. */
  readonly pools: Set<Undici.Dispatcher>
}

function policyAgent(mod: UndiciModule, mode: OutboundMode, resolver: AddressResolver | undefined, timeout: number | undefined, pools: Set<Undici.Dispatcher>): Undici.Agent {
  // TLS verification stays on: the base connector gets no TLS overrides, and
  // `host` (hence SNI and certificate identity) keeps the original name.
  const base = mod.buildConnector(timeout !== undefined ? { timeout } : {})
  const agent = new mod.Agent({
    factory(origin, options) {
      const pool = new mod.Pool(origin, options)
      pools.add(pool)
      // The Agent closes an idle pool in its own (later) disconnect listener; check after it ran.
      pool.on('disconnect', () => { setImmediate(() => { if (pool.closed || pool.destroyed) pools.delete(pool) }) })
      return pool
    },
    connect(options, callback) {
      resolvePolicyAddresses(options.hostname, mode === 'loopback', resolver).then(
        (addresses) => {
          // Every address already passed the policy; fall back across them on
          // connect errors only (`localhost` ? [::1, 127.0.0.1] with an
          // IPv4-only listener). A TLS or protocol error is final.
          let index = 0
          const attempt = (): void => {
            base({ ...options, hostname: addresses[index]!.address }, (error, socket) => {
              if (error !== null && index < addresses.length - 1 && isConnectError(error)) {
                index += 1
                attempt()
                return
              }
              if (error !== null) callback(error, null)
              else callback(null, socket!)
            })
          }
          attempt()
        },
        // A policy refusal is deterministic: never retried, never dialled.
        (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error)), null) },
      )
    },
  })
  if (typeof (agent as { dispatch?: unknown }).dispatch !== 'function') {
    throw new OutboundTransportUnavailableError('outbound transport: dispatcher has no callable dispatch')
  }
  return agent
}

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])

function isConnectError(error: Error): boolean {
  return !(error instanceof OutboundPolicyError) && CONNECT_ERRORS.has(String((error as { code?: unknown }).code))
}

/**
 * The policy dispatcher for one request, reporting when bytes may leave:
 * Undici calls `onConnect` only once a socket (that passed the connect-time
 * policy) is assigned and the request is about to be written. A refused or
 * failed connect never fires it.
 */
function reportingDispatcher(agent: Undici.Agent, onSend: () => void): Pick<Undici.Agent, 'dispatch'> {
  return {
    dispatch(options, handler) {
      let fired = false
      const wrapped = Object.create(handler) as typeof handler & { onConnect?: (...args: unknown[]) => unknown; onRequestStart?: (...args: unknown[]) => unknown }
      const fire = (): void => { if (!fired) { fired = true; onSend() } }
      const legacy = (handler as { onConnect?: (...args: unknown[]) => unknown }).onConnect
      const modern = (handler as { onRequestStart?: (...args: unknown[]) => unknown }).onRequestStart
      if (typeof legacy === 'function') wrapped.onConnect = function (this: unknown, ...args: unknown[]) { fire(); return legacy.apply(this, args) }
      if (typeof modern === 'function') wrapped.onRequestStart = function (this: unknown, ...args: unknown[]) { fire(); return modern.apply(this, args) }
      return agent.dispatch(options, wrapped)
    },
  }
}

const CLOSE_GRACE_MS = 2_000

/** Graceful close, then destroy every pool still open after the grace period. */
async function closeAgents(agents: readonly Undici.Agent[], pools: Set<Undici.Dispatcher>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const graceful = Promise.all(agents.map((agent) => agent.close())).then(() => true, () => false)
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs) })
  const closed = await Promise.race([graceful, expired])
  clearTimeout(timer)
  if (!closed) {
    await Promise.allSettled([...pools].map((pool) => pool.destroy()))
    await Promise.allSettled(agents.map((agent) => agent.destroy()))
  }
  pools.clear()
}

function policyCause(error: unknown): OutboundPolicyError | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
    if (current instanceof OutboundPolicyError) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/** One long-lived dispatcher pool per policy mode, with an explicit owner and close. */
export class OutboundHttp {
  private transport: Promise<LoadedTransport> | undefined
  private closed = false

  constructor(private readonly options: OutboundHttpOptions = {}) {}

  /** Resolve once the real transport passed its capability check; rejects (permanently) otherwise. */
  ready(): Promise<void> {
    return this.load().then(() => undefined)
  }

  private load(): Promise<LoadedTransport> {
    this.transport ??= (async (): Promise<LoadedTransport> => {
      let mod: UndiciModule
      try {
        mod = await (this.options.loader ?? loadRealUndici)()
      } catch (error) {
        throw new OutboundTransportUnavailableError('outbound transport: Undici could not be loaded', { cause: error })
      }
      assertCapable(mod)
      const pools = new Set<Undici.Dispatcher>()
      const dispatchers = {
        public: policyAgent(mod, 'public', this.options.resolver, this.options.connectTimeoutMs, pools),
        loopback: policyAgent(mod, 'loopback', this.options.resolver, this.options.connectTimeoutMs, pools),
      }
      // Undici's Response/RequestInit types differ from the lib ones only nominally.
      const send: OutboundSender = (url, init) => mod.fetch(url, init as unknown as Undici.RequestInit) as unknown as Promise<OutboundResponse>
      return { send, dispatchers, pools }
    })()
    return this.transport
  }

  async request(raw: string | URL, init: OutboundRequestInit = {}): Promise<OutboundResponse> {
    if (this.closed) throw new OutboundTransportUnavailableError('outbound transport is closed')
    const allowLoopback = init.allowLoopback === true
    // Prohibited literals and schemes never reach the network.
    const url = assertOutboundUrl(String(raw), { allowLoopbackHttp: allowLoopback })
    const mode: OutboundMode = allowLoopback && isLoopbackUrl(url) ? 'loopback' : 'public'
    const signals = [
      ...(init.signal !== undefined ? [init.signal] : []),
      ...(init.timeoutMs !== undefined ? [AbortSignal.timeout(init.timeoutMs)] : []),
    ]
    const signal = signals.length === 1 ? signals[0]! : signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals)
    if (signal.aborted) throw abortReason(signal)
    const transport = await this.load()
    if (this.closed) throw new OutboundTransportUnavailableError('outbound transport is closed')
    if (signal.aborted) throw abortReason(signal)
    const agent = transport.dispatchers[mode]
    let dispatcher: unknown = agent
    if (this.options.sender !== undefined) {
      // A test sender has no socket lifecycle; treat handing over as sending.
      init.onSend?.()
    } else if (init.onSend !== undefined) {
      dispatcher = reportingDispatcher(agent, init.onSend)
    }
    const send = this.options.sender ?? transport.send
    try {
      return await send(url, {
        method: init.method ?? 'GET',
        headers: { ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal,
        redirect: 'manual',
        dispatcher,
      })
    } catch (error) {
      // A connect-time policy refusal is deterministic: surface it as such.
      throw policyCause(error) ?? error
    }
  }

  /** Close both pools (destroying sockets still busy after `graceMs`). Requests after this fail closed. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.closed = true
    const loaded = await this.transport?.catch(() => undefined)
    if (loaded === undefined) return
    await closeAgents([loaded.dispatchers.public, loaded.dispatchers.loopback], loaded.pools, graceMs)
  }
}

let shared: OutboundHttp | undefined

/** The process-wide policy transport. Hosts share it; none closes it on its own shutdown. */
export function defaultOutboundHttp(): OutboundHttp {
  shared ??= new OutboundHttp()
  return shared
}

/** A body exceeded its byte cap; the stream was cancelled. */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds the ${limit}-byte limit`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a body as decoded bytes, cancelling the stream as soon as it exceeds
 * `maxBytes` (chunked bodies have no trustworthy length) or on any read error.
 */
export async function readBoundedBytes(response: { readonly body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Cancel a response body, ignoring a body that is already closed or errored. */
export async function discardBody(response: { readonly body: ReadableStream<Uint8Array> | null }): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}
