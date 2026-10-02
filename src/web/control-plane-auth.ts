/**
 * Local control-plane authentication.
 *
 * Browser sessions are opaque server-side records reached by an HttpOnly
 * cookie. CLI and headless clients use a separate scoped bearer. Presenting
 * both at once is rejected. A pairing code is single-use, stored only as a
 * keyed verifier, and never logged by this module.
 *
 * This does not protect against same-user malware or same-origin XSS.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { CSRF_HEADER, checkCanonicalOrigin, csrfTokensMatch } from './csrf.ts'

export const SESSION_COOKIE = 'dnt-harness-session'
/** Expires the browser's session cookie (logout, or a stale session found on load). */
export const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
export const PAIRING_BODY_FIELD = 'code'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_PAIRING_FAILURES = 8
const PAIRING_LOCK_MS = 60_000

export type BearerScope = 'sessions' | 'providers' | 'mcp' | 'admin'

export interface ControlPlanePrincipal {
  readonly kind: 'browser' | 'bearer'
  readonly id: string
  readonly generation: number
  readonly scopes: readonly BearerScope[]
}

interface BrowserSession {
  readonly id: string
  readonly csrf: string
  readonly generation: number
  expiresAt: number
}

interface PairingChallenge {
  readonly verifier: Buffer
  readonly expiresAt: number
  consumed: boolean
}

interface BearerCredential {
  readonly id: string
  readonly verifier: Buffer
  readonly scopes: readonly BearerScope[]
  readonly generation: number
  revoked: boolean
}

export interface ControlPlaneAuthOptions {
  /** Origin the browser must present on cookie mutations, e.g. `http://127.0.0.1:3082`. */
  readonly canonicalOrigin: string
  /** When false, every request is anonymous. Production sets true. */
  readonly enabled: boolean
  readonly now?: () => number
}

export type AuthDecision =
  | { readonly ok: true; readonly principal: ControlPlanePrincipal; readonly csrf?: string }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string }

export class ControlPlaneAuthService {
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly bearers = new Map<string, BearerCredential>()
  private pairing: PairingChallenge | undefined
  private operatorVerifier: Buffer | undefined
  private pairingFailures = 0
  private pairingLockedUntil = 0
  private generation = 1
  private readonly hmacKey = randomBytes(32)

  private origin: string

  constructor(private readonly options: ControlPlaneAuthOptions) {
    this.origin = options.canonicalOrigin
  }

  get enabled(): boolean {
    return this.options.enabled
  }

  get canonicalOrigin(): string {
    return this.origin
  }

  /** Set once the server knows the address it actually bound. */
  bindOrigin(origin: string): void {
    this.origin = origin
  }

  /** Current session generation. Logout and revocation increment it. */
  currentGeneration(): number {
    return this.generation
  }

  /**
   * Issue a single-use pairing code. The caller shows it once; only the
   * verifier is retained. A new code replaces any unconsumed previous one.
   */
  issuePairingCode(): { readonly code: string; readonly expiresAt: number } {
    const code = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pairing = { verifier: this.mac(code), expiresAt, consumed: false }
    return { code, expiresAt }
  }

  /**
   * Arm the operator channel: whoever can read the data home's operator file
   * (the same OS user that runs the host) may mint a fresh pairing code. That
   * is the recovery path when the startup code expired or a browser was lost.
   */
  armOperatorKey(): string {
    const key = randomBytes(32).toString('base64url')
    this.operatorVerifier = this.mac(key)
    return key
  }

  /** Constant-time check of a presented operator key. */
  operatorKeyMatches(presented: string): boolean {
    const verifier = this.operatorVerifier
    return verifier !== undefined && presented !== '' && safeEqual(this.mac(presented), verifier)
  }

  /** True when a pairing code is waiting. The code itself is not returned. */
  get pairingPending(): boolean {
    const pending = this.pairing
    return pending !== undefined && !pending.consumed && pending.expiresAt > this.now()
  }

  /**
   * Consume a pairing code and open a browser session. Failure is uniform:
   * wrong, reused, and expired codes all return the same 401, and the lockout
   * does not reveal which.
   */
  redeemPairingCode(code: string): { readonly ok: true; readonly sessionId: string; readonly csrf: string } | { readonly ok: false; readonly status: 401 | 429; readonly reason: string } {
    if (this.pairingLockedUntil > this.now()) {
      return { ok: false, status: 429, reason: 'pairing is temporarily locked' }
    }
    const pending = this.pairing
    const presented = this.mac(code)
    const matches = pending !== undefined && !pending.consumed && pending.expiresAt > this.now() && safeEqual(presented, pending.verifier)
    if (!matches || pending === undefined) {
      this.pairingFailures += 1
      if (this.pairingFailures >= MAX_PAIRING_FAILURES) {
        this.pairingLockedUntil = this.now() + PAIRING_LOCK_MS
        this.pairingFailures = 0
      }
      return { ok: false, status: 401, reason: 'pairing code rejected' }
    }
    pending.consumed = true
    this.pairing = undefined
    this.pairingFailures = 0
    this.generation += 1
    const opened = this.openBrowserSession()
    return { ok: true, sessionId: opened.id, csrf: opened.csrf }
  }

  /** Open a browser session directly. Production uses pairing; tests may call this. */
  openBrowserSession(): { readonly id: string; readonly csrf: string } {
    const id = randomBytes(32).toString('base64url')
    const csrf = randomBytes(32).toString('base64url')
    this.sessions.set(id, { id, csrf, generation: this.generation, expiresAt: this.now() + SESSION_TTL_MS })
    return { id, csrf }
  }

  revokeBrowserSession(id: string): void {
    if (!this.sessions.delete(id)) return
    this.generation += 1
  }

  /** Drop every browser session and fence live streams. */
  logoutAll(): void {
    this.sessions.clear()
    this.generation += 1
  }

  issueBearer(scopes: readonly BearerScope[]): { readonly token: string; readonly id: string } {
    const id = randomBytes(16).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    this.bearers.set(id, { id, verifier: this.mac(secret), scopes, generation: this.generation, revoked: false })
    return { token: `${id}.${secret}`, id }
  }

  revokeBearer(id: string): void {
    const credential = this.bearers.get(id)
    if (credential === undefined) return
    credential.revoked = true
    this.generation += 1
  }

  /**
   * Authenticate one request. Cookie and bearer together are refused so a
   * browser session cannot widen a CLI token, or the reverse.
   */
  authenticate(headers: IncomingMessage['headers'], method: string): AuthDecision {
    if (!this.options.enabled) {
      return { ok: true, principal: { kind: 'browser', id: 'disabled', generation: this.generation, scopes: ['admin'] } }
    }
    const bearer = bearerToken(headers.authorization)
    const cookie = readCookie(headers.cookie, SESSION_COOKIE)
    if (bearer !== undefined && cookie !== undefined) {
      return { ok: false, status: 403, reason: 'cookie and bearer credentials cannot be combined' }
    }
    if (bearer !== undefined) return this.authenticateBearer(bearer)
    if (cookie !== undefined) return this.authenticateCookie(cookie, headers, method)
    return { ok: false, status: 401, reason: 'authentication required' }
  }

  cookieHeader(sessionId: string): string {
    const secure = this.options.canonicalOrigin.startsWith('https://') ? '; Secure' : ''
    return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/${secure}`
  }

  private authenticateBearer(token: string): AuthDecision {
    const split = token.indexOf('.')
    if (split <= 0) return { ok: false, status: 401, reason: 'authentication required' }
    const id = token.slice(0, split)
    const secret = token.slice(split + 1)
    const credential = this.bearers.get(id)
    if (credential === undefined || credential.revoked || !safeEqual(this.mac(secret), credential.verifier)) {
      return { ok: false, status: 401, reason: 'authentication required' }
    }
    return {
      ok: true,
      principal: { kind: 'bearer', id, generation: this.generation, scopes: credential.scopes },
    }
  }

  private authenticateCookie(sessionId: string, headers: IncomingMessage['headers'], method: string): AuthDecision {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      return { ok: false, status: 401, reason: 'authentication required' }
    }
    if (session.generation !== this.generation) {
      return { ok: false, status: 401, reason: 'session generation was revoked' }
    }
    const unsafe = method !== 'GET' && method !== 'HEAD'
    if (unsafe) {
      const originHeader = headers.origin
      const origin = checkCanonicalOrigin(
        originHeader === undefined ? {} : { origin: originHeader },
        this.origin,
      )
      if (!origin.ok) return origin
      const presented = headerOne(headers[CSRF_HEADER])
      if (presented === undefined || !csrfTokensMatch(presented, session.csrf)) {
        return { ok: false, status: 403, reason: 'CSRF token rejected' }
      }
    }
    session.expiresAt = this.now() + SESSION_TTL_MS
    return {
      ok: true,
      csrf: session.csrf,
      principal: { kind: 'browser', id: session.id, generation: session.generation, scopes: ['admin'] },
    }
  }

  private mac(value: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(value).digest()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/** Routes that answer without a local session. Pairing and the OAuth code deposit are two of them. */
export function isPublicPath(pathname: string, method: string): boolean {
  if (method === 'GET' && (pathname === '/api/health' || pathname === '/api/meta' || pathname === '/api/auth/state')) return true
  if (method === 'POST' && pathname === '/api/auth/pair') return true
  if ((method === 'GET' || method === 'POST') && pathname === '/api/mcp/oauth/callback') return true
  return false
}

/**
 * Bearer scopes are explicit. `sessions` can manage workspaces and sessions
 * because the CLI uses that credential for the memory-mode routes. `admin`
 * covers the browser session. A scope that does not match the path is 403.
 */
export function bearerAllows(pathname: string, scopes: readonly BearerScope[]): boolean {
  if (scopes.includes('admin')) return true
  if (pathname.includes('/mcp')) return scopes.includes('mcp')
  if ((pathname.startsWith('/api/workspaces') || pathname.startsWith('/api/sessions')) && scopes.includes('sessions')) return true
  if (pathname.startsWith('/api/providers') && scopes.includes('providers')) return true
  return false
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = headerOne(header)
  if (value === undefined) return undefined
  const match = /^Bearer (.+)$/.exec(value)
  return match?.[1]
}

function headerOne(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return undefined
  return header
}

/** The session cookie's value from a raw `Cookie` header, valid or not. */
export function readSessionCookie(header: string | undefined): string | undefined {
  return readCookie(header, SESSION_COOKIE)
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
