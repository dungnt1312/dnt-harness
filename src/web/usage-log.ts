import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Durable, cross-workspace token accounting: one JSONL line per completed
 * model request at `<home>/usage.jsonl`. The in-memory index is rebuilt by
 * streaming the file at boot, so the Settings → Usage tab survives restarts.
 */

export type UsageKind = 'turn' | 'child' | 'compaction'

export interface UsageRecord {
  readonly v: 1
  /** When the stream reported usage (ms epoch). */
  readonly at: number
  /** When the request started (ms epoch). */
  readonly startedAt: number
  readonly workspaceId?: string
  readonly sessionId: string
  /** Root execution domain; children fold into their root's session time. */
  readonly rootSessionId: string
  readonly kind: UsageKind
  readonly provider?: string
  readonly model: string
  /** Prompt tokens, cached ones included. */
  readonly input: number
  readonly cached: number
  readonly output: number
}

export interface UsageDayRow {
  /** Host-local calendar date, `YYYY-MM-DD`. */
  readonly date: string
  readonly model: string
  readonly input: number
  readonly cached: number
  readonly output: number
  readonly requests: number
}

export interface UsageDailyResponse {
  readonly days: readonly UsageDayRow[]
  readonly longestSessionMs: number
  readonly firstRecordAt?: number
  /** Host-local date of "now", so the client never guesses the timezone. */
  readonly today: string
}

export interface UsageLog {
  /** Fire-and-forget; appends are serialized so lines never interleave. */
  record(record: Omit<UsageRecord, 'v'>): void
  daily(): UsageDailyResponse
  /** Resolves once every queued append has settled (tests, shutdown). */
  flush(): Promise<void>
}

/** Days of history the API returns: 53 heatmap weeks plus padding. */
export const USAGE_WINDOW_DAYS = 371
/** Activity gaps up to this long still count as one working session. */
export const SESSION_GAP_MS = 30 * 60_000

/** Host-local `YYYY-MM-DD` of an epoch-ms instant. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Longest merged block of `[start, end]` intervals whose gaps are ≤ `gapMs`. */
export function longestMergedSpan(intervals: readonly (readonly [number, number])[], gapMs = SESSION_GAP_MS): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let [start, end] = sorted[0]!
  let best = end - start
  for (const [s, e] of sorted.slice(1)) {
    if (s - end <= gapMs) {
      end = Math.max(end, e)
    } else {
      start = s
      end = e
    }
    best = Math.max(best, end - start)
  }
  return Math.max(0, best)
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

/** Parse one stored line; malformed, truncated or foreign-version lines yield undefined. */
export function parseUsageLine(line: string): UsageRecord | undefined {
  if (line.trim() === '') return undefined
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || typeof r.at !== 'number' || typeof r.sessionId !== 'string' || typeof r.model !== 'string') return undefined
  const kind: UsageKind = r.kind === 'child' || r.kind === 'compaction' ? r.kind : 'turn'
  return {
    v: 1,
    at: r.at,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : r.at,
    ...(typeof r.workspaceId === 'string' ? { workspaceId: r.workspaceId } : {}),
    sessionId: r.sessionId,
    rootSessionId: typeof r.rootSessionId === 'string' ? r.rootSessionId : r.sessionId,
    kind,
    ...(typeof r.provider === 'string' ? { provider: r.provider } : {}),
    model: r.model,
    input: count(r.input),
    cached: count(r.cached),
    output: count(r.output),
  }
}

interface Bucket { input: number; cached: number; output: number; requests: number }

class UsageIndex {
  readonly byDay = new Map<string, Map<string, Bucket>>()
  readonly sessions = new Map<string, [number, number][]>()
  firstRecordAt: number | undefined

  add(record: UsageRecord): void {
    const date = localDate(record.at)
    let models = this.byDay.get(date)
    if (models === undefined) this.byDay.set(date, (models = new Map()))
    const bucket = models.get(record.model) ?? { input: 0, cached: 0, output: 0, requests: 0 }
    bucket.input += record.input
    bucket.cached += record.cached
    bucket.output += record.output
    bucket.requests += 1
    models.set(record.model, bucket)
    const spans = this.sessions.get(record.rootSessionId) ?? []
    spans.push([Math.min(record.startedAt, record.at), record.at])
    this.sessions.set(record.rootSessionId, spans)
    if (this.firstRecordAt === undefined || record.at < this.firstRecordAt) this.firstRecordAt = record.at
  }

  daily(now: number): UsageDailyResponse {
    const today = localDate(now)
    const from = new Date(now)
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - (USAGE_WINDOW_DAYS - 1))
    const cutoff = localDate(from.getTime())
    const days: UsageDayRow[] = []
    for (const date of [...this.byDay.keys()].sort()) {
      if (date < cutoff || date > today) continue
      for (const [model, b] of this.byDay.get(date)!) days.push({ date, model, ...b })
    }
    let longestSessionMs = 0
    for (const spans of this.sessions.values()) longestSessionMs = Math.max(longestSessionMs, longestMergedSpan(spans))
    return { days, longestSessionMs, today, ...(this.firstRecordAt !== undefined ? { firstRecordAt: this.firstRecordAt } : {}) }
  }
}

async function loadIndex(file: string, index: UsageIndex): Promise<void> {
  let stream
  try {
    await fs.access(file)
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    const record = parseUsageLine(line)
    if (record !== undefined) index.add(record)
  }
}

/**
 * Open (or create on first append) the usage log. A file that cannot be read
 * degrades to an empty index; a failing append warns once and never throws
 * into the request path.
 */
export async function openUsageLog(file: string, options: { readonly now?: () => number; readonly warn?: (message: string) => void } = {}): Promise<UsageLog> {
  const now = options.now ?? Date.now
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const index = new UsageIndex()
  try {
    await loadIndex(file, index)
  } catch (error) {
    warn(`usage log: could not read ${file}: ${String(error)}`)
  }
  let queue: Promise<void> = Promise.resolve()
  let warned = false
  let dirReady = false
  return {
    record(input) {
      const record: UsageRecord = { v: 1, ...input }
      index.add(record)
      const line = `${JSON.stringify(record)}\n`
      queue = queue.then(async () => {
        if (!dirReady) {
          await fs.mkdir(path.dirname(file), { recursive: true })
          dirReady = true
        }
        await fs.appendFile(file, line, 'utf8')
      }).catch((error: unknown) => {
        if (!warned) {
          warned = true
          warn(`usage log: append to ${file} failed: ${String(error)}`)
        }
      })
    },
    daily: () => index.daily(now()),
    flush: () => queue,
  }
}

/** Memory-only log for hosts without a data home (tests). */
export function memoryUsageLog(now: () => number = Date.now): UsageLog {
  const index = new UsageIndex()
  return {
    record: (input) => index.add({ v: 1, ...input }),
    daily: () => index.daily(now()),
    flush: () => Promise.resolve(),
  }
}
