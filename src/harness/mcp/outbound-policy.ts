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

/**
 * The address a host names, with an IPv4 address embedded in IPv6 brought
 * out as dotted IPv4 so the IPv4 ranges apply to it. URL parsing writes
 * `[::ffff:10.0.0.1]` as `[::ffff:a00:1]`, so the hex form matters most.
 */
function unwrapIp(hostname: string): string {
  const bare = (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname).toLowerCase()
  if (isIP(bare) !== 6) return bare
  return embeddedIpv4(bare) ?? bare
}

/** IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`) or NAT64 (`64:ff9b::/96`). */
function embeddedIpv4(ip: string): string | undefined {
  const words = ipv6Words(ip)
  if (words === undefined) return undefined
  const high = words.slice(0, 6)
  const zeroHigh = high.slice(0, 5).every((word) => word === 0)
  const mapped = zeroHigh && high[5] === 0xffff
  const compatible = zeroHigh && high[5] === 0 && !(words[6] === 0 && (words[7] ?? 0) <= 1)
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && high.slice(2).every((word) => word === 0)
  if (!mapped && !compatible && !nat64) return undefined
  const [a = 0, b = 0] = [words[6], words[7]]
  return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`
}

/** Eight 16-bit words of a valid IPv6 literal (a dotted IPv4 tail is folded in). */
function ipv6Words(ip: string): number[] | undefined {
  let text = ip
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted?.[1] !== undefined) {
    const value = ipv4Number(dotted[1])
    if (value === undefined) return undefined
    text = `${text.slice(0, -dotted[1].length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string | undefined): number[] => part === undefined || part === '' ? [] : part.split(':').map((word) => parseInt(word, 16))
  const head = parse(halves[0])
  const tail = parse(halves[1])
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const words = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail]
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined
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
