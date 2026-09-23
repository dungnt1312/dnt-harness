/**
 * One outbound policy for MCP HTTP and managed OAuth. Loopback HTTP is
 * allowed for the local fixture profile. Everything else must be HTTPS with
 * no userinfo, no fragment, and no address in a prohibited range.
 *
 * Redirects are not followed here. Callers use `redirect: 'manual'` and
 * re-check every hop with {@link assertOutboundUrl}.
 */
import { isIP } from 'node:net'

export class OutboundPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboundPolicyError'
  }
}

export interface OutboundPolicyOptions {
  /** Permit http:// to loopback. Tests and the local OAuth fixture need this. */
  readonly allowLoopbackHttp?: boolean
}

const PROHIBITED_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const

export function assertOutboundUrl(raw: string, options: OutboundPolicyOptions = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundPolicyError('outbound URL is not absolute')
  }
  if (url.username !== '' || url.password !== '') throw new OutboundPolicyError('outbound URL must not carry userinfo')
  if (url.hash !== '') throw new OutboundPolicyError('outbound URL must not carry a fragment')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundPolicyError('outbound URL scheme is not http(s)')
  const loopback = isLoopback(url.hostname)
  if (url.protocol === 'http:' && !(options.allowLoopbackHttp === true && loopback)) {
    throw new OutboundPolicyError('plain HTTP is limited to the loopback fixture profile')
  }
  if (!loopback && isProhibitedHost(url.hostname)) {
    throw new OutboundPolicyError('outbound URL targets a prohibited address')
  }
  return url
}

/** Headers the operator config must not replace. */
export const RESERVED_OUTBOUND_HEADERS = ['authorization', 'mcp-session-id', 'cookie', 'host', 'content-length'] as const

export function operatorHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (RESERVED_OUTBOUND_HEADERS.includes(key.toLowerCase() as typeof RESERVED_OUTBOUND_HEADERS[number])) continue
    out[key] = value
  }
  return out
}

function isLoopback(hostname: string): boolean {
  const host = unwrapIp(hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isProhibitedHost(hostname: string): boolean {
  const host = unwrapIp(hostname)
  if (host === 'localhost') return true
  const family = isIP(host)
  if (family === 4) return prohibitedV4(host)
  if (family === 6) return prohibitedV6(host)
  return false
}

function unwrapIp(hostname: string): string {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)
  return mapped?.[1] ?? bare.toLowerCase()
}

function prohibitedV4(ip: string): boolean {
  const value = ipv4Number(ip)
  if (value === undefined) return true
  return PROHIBITED_V4.some(([base, bits]) => {
    const network = ipv4Number(base)
    if (network === undefined) return false
    const mask = (~0 << (32 - bits)) >>> 0
    return (value & mask) === (network & mask)
  })
}

function prohibitedV6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true
  if (lower.startsWith('ff')) return true
  return false
}

function ipv4Number(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8) | octet
  }
  return value >>> 0
}
