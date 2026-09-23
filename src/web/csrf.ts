/**
 * Canonical-origin and CSRF checks for browser cookie sessions.
 *
 * The allowed origin is the one the server was configured with. Request
 * headers never widen it. `Sec-Fetch-*` is recorded by callers as defense in
 * depth; it is not an authorization decision.
 */
import { timingSafeEqual } from 'node:crypto'

export const CSRF_HEADER = 'x-mini-dsh-csrf'

/** Compare two CSRF tokens without leaking a prefix match through timing. */
export function csrfTokensMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type OriginVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403; readonly reason: string }

/**
 * Cookie mutations require exactly one canonical Origin. Missing, empty,
 * `null`, repeated, and foreign origins are refused. Bearer requests do not
 * use this check — they never fall back to a cookie.
 */
export function checkCanonicalOrigin(headers: { readonly origin?: string | string[] }, canonicalOrigin: string): OriginVerdict {
  const raw = headers.origin
  if (raw === undefined || raw === '') {
    return { ok: false, status: 403, reason: 'cookie mutation requires the canonical Origin' }
  }
  if (Array.isArray(raw)) {
    return { ok: false, status: 403, reason: 'multiple Origin headers are refused' }
  }
  if (raw === 'null') return { ok: false, status: 403, reason: 'opaque Origin is refused' }
  let presented: string
  try {
    presented = new URL(raw).origin
  } catch {
    return { ok: false, status: 403, reason: 'Origin is not a URL' }
  }
  if (presented !== canonicalOrigin) {
    return { ok: false, status: 403, reason: 'Origin does not match this server' }
  }
  return { ok: true }
}
