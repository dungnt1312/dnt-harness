/**
 * The trusted environment block every request carries: date, platform, and —
 * for root sessions with a project bound — the workspace path and git branch.
 * Pure rendering from injected facts: the builder and its tests stay
 * deterministic, and the web server owns the I/O (a cached git lookup).
 *
 * Prefix stability matters more than freshness: the block sits in the first
 * system message, ahead of every cached token, so anything that changes here
 * invalidates the provider's prompt cache for the whole request. It therefore
 * carries the DAY, never the time of day; the time travels with each message
 * the user typed (see {@link formatSentStamp}), where it never changes again.
 * A stale git branch is the documented trade-off (the Git view remains the
 * source of truth); the block never blocks or fails a request.
 */

/** Host-supplied facts; every field is optional and omitted when unknown. */
export interface EnvironmentFacts {
  /** Host clock at assembly time; only its local date and zone are rendered. */
  readonly now?: Date
  /** `process.platform` + `process.arch`, e.g. `darwin arm64`. */
  readonly platform?: string
  readonly arch?: string
  /** Node version, e.g. `v22.9.0`. */
  readonly nodeVersion?: string
  /** The project folder absolute path (root sessions with a project bound). */
  readonly workspacePath?: string
  /** Current branch when the workspace is a git checkout; omitted otherwise. */
  readonly gitBranch?: string
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

const pad = (value: number): string => String(value).padStart(2, '0')

/** `2026-10-06` in the runtime's local zone. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `14:30` in the runtime's local zone. */
function localTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * `2026-10-06 Monday · 14:30 +07:00` — minute granularity, local zone, `·`
 * separators. Kept for callers that display a full reading; the request
 * environment block uses {@link formatEnvironmentDay}.
 */
export function formatEnvironmentDate(now: Date): string {
  return `${localDate(now)} ${WEEKDAYS[now.getDay()] ?? ''} · ${localTime(now)} ${localOffset(now)}`
}

/** `2026-10-06 Monday (timezone +07:00)` — the request block's stable day line. */
export function formatEnvironmentDay(now: Date): string {
  return `${localDate(now)} ${WEEKDAYS[now.getDay()] ?? ''} (timezone ${localOffset(now)})`
}

/**
 * `[sent 2026-10-06 14:30 +07:00]` — when a typed user message was sent,
 * from its durable event timestamp. Rendered from an immutable log fact, so a
 * message renders identically in every later request and stays cacheable.
 */
export function formatSentStamp(timestampMs: number): string {
  const at = new Date(timestampMs)
  return `[sent ${localDate(at)} ${localTime(at)} ${localOffset(at)}]`
}

/** Matches the `[sent …]` line {@link formatSentStamp} puts before a typed message. */
export const SENT_STAMP_LINE = /^\[sent \d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:[+-]\d{2}:\d{2}|Z)\]\n/

/** A typed message's text without the host's `[sent …]` line. */
export function withoutSentStamp(text: string): string {
  return text.replace(SENT_STAMP_LINE, '')
}

/** `+07:00` / `-05:30` / `Z` from the runtime zone, matching ISO-8601 style. */
function localOffset(now: Date): string {
  const total = -now.getTimezoneOffset()
  if (total === 0) return 'Z'
  const sign = total < 0 ? '-' : '+'
  const abs = Math.abs(total)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = String(abs % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/**
 * The rendered `<environment_context>` block, or undefined when no fact is
 * known. Callers embed the block in the trusted system message; it is never
 * wrapped (host-owned facts) and never droppable.
 */
export function renderEnvironmentContext(facts: EnvironmentFacts): string | undefined {
  const lines: string[] = []
  if (facts.now !== undefined) lines.push(`Today: ${formatEnvironmentDay(facts.now)}`)
  if (facts.platform !== undefined) {
    lines.push(`Platform: ${facts.platform}${facts.arch !== undefined ? ` ${facts.arch}` : ''}${facts.nodeVersion !== undefined ? ` · Node ${facts.nodeVersion}` : ''}`)
  }
  if (facts.workspacePath !== undefined && facts.workspacePath !== '') {
    // Repository-controlled refs must not forge markup in the trusted block.
    const branch = facts.gitBranch?.replace(/[^A-Za-z0-9._/-]/g, '')
    lines.push(`Workspace: ${facts.workspacePath}${branch !== undefined && branch !== '' ? ` (git branch: ${branch})` : ''}`)
  }
  if (lines.length === 0) return undefined
  return `<environment_context>\n${lines.join('\n')}\n</environment_context>`
}
