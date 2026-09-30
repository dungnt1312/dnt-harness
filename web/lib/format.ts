/** Display helpers: times, durations, and compact argument summaries. */

import type { ContextManifestView } from './api.ts'

/** Fill of the model's whole context window, shared by the meter and the panel. */
export interface ContextFill {
  /** Prompt tokens: provider-reported when present, otherwise the chars/4 estimate. */
  readonly used: number
  /** The model's context window (`availableTokens` only when the window was not recorded). */
  readonly limit: number
  /** `used / limit`, clamped to 1. */
  readonly ratio: number
  /** True when `used` is the builder's estimate rather than a provider count. */
  readonly estimated: boolean
  /** Session cache hit rate, only when some request reported a cached share. */
  readonly cacheHitRate: number | undefined
}

export function formatTime(ts?: number): string {
  if (ts === undefined) return ''
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

/** Compact sidebar age: now, 5m, 3h, 2d, 1w — coarser buckets only. */
export function formatAge(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return ''
  const diff = Math.max(0, now - ts)
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`
  return `${Math.floor(diff / 604_800_000)}w`
}

export function formatDuration(start?: number, end?: number): string {
  if (start === undefined || end === undefined) return ''
  const ms = end - start
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

/** Time left before a deadline: `4:32`, `0:07`, or `now` once it is reached. */
export function formatCountdown(expiresAt: number, now = Date.now()): string {
  const remaining = expiresAt - now
  if (remaining <= 0) return 'now'
  const seconds = Math.ceil(remaining / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Short one-line summary of tool arguments: `{ path: 'src/x.ts', … }`. */
export function argsSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return '{}'
  const head = entries[0]
  if (head === undefined) return '{}'
  const [key, value] = head
  const shown = `${key}: ${summarize(value)}`
  return entries.length > 1 ? `{ ${shown}, … }` : `{ ${shown} }`
}

function summarize(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 48 ? `'${value.slice(0, 48)}…'` : `'${value}'`
  }
  return JSON.stringify(value)
}

/** Last segment of a filesystem path, honoring both separators. */
export function pathBasename(path: string): string {
  if (path === '') return ''
  const parts = path.split(/[\\/]/)
  return parts.at(-1) ?? path
}

/** First non-empty string argument — the human target of most tool calls. */
export function toolTarget(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * A path narrow enough for one activity row: it keeps its last segments,
 * because deep paths share a prefix and differ at the end. The full value
 * stays in the row's title. Only paths may be shortened this way — splitting
 * a shell command on `/` would drop the verb and keep an argument.
 */
export function shortPath(target: string, segments = 2): string {
  const parts = target.split(/[\\/]/).filter((part) => part !== '')
  if (parts.length <= segments) return target
  return `…/${parts.slice(-segments).join('/')}`
}

/**
 * A command or pattern narrow enough for one activity row: newlines collapse
 * to spaces and the middle is elided, because the verb at the front and the
 * argument at the end are both what the row is read for.
 */
export function shortCommand(command: string, max = 64): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const head = Math.ceil((max - 1) * 0.65)
  return `${flat.slice(0, head).trimEnd()}…${flat.slice(flat.length - (max - 1 - head)).trimStart()}`
}

/** Human-readable size for an attachment chip or a recorded payload. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Compact token count for chips: 940, 18.4k, 65k, 256k, 1M, 1.5M. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 100_000) {
    const k = (tokens / 1000).toFixed(1)
    return `${k.endsWith('.0') ? k.slice(0, -2) : k}k`
  }
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Budget fill tone by usage ratio: state color thresholds (≥80 warn, ≥95 bad). */
export function budgetTone(usedTokens: number, availableTokens: number): 'ok' | 'warn' | 'bad' {
  if (availableTokens <= 0) return 'bad'
  const ratio = usedTokens / availableTokens
  if (ratio >= 0.95) return 'bad'
  if (ratio >= 0.8) return 'warn'
  return 'ok'
}

/**
 * How full the model's context window was on the last request.
 * Denominator is the whole window, never the input budget left after the
 * output reserve and safety margin. Numerator is the provider's prompt
 * count when it reported one; otherwise the builder's chars/4 estimate.
 */
export function contextFill(manifest: ContextManifestView): ContextFill {
  const limit = manifest.budget.contextLimitTokens ?? manifest.budget.availableTokens
  const reported = manifest.usage?.last?.inputTokens
  const used = reported ?? manifest.budget.usedTokens
  const cacheable = manifest.usage?.cacheableInputTokens ?? 0
  return {
    used,
    limit,
    ratio: limit > 0 ? Math.min(used / limit, 1) : 0,
    estimated: reported === undefined,
    cacheHitRate: cacheable > 0 ? (manifest.usage?.cachedInputTokens ?? 0) / cacheable : undefined,
  }
}
