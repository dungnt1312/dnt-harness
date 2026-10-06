/**
 * The trusted environment block every request carries: date/time, platform,
 * and — for root sessions with a project bound — the workspace path and git
 * branch. Pure rendering from injected facts: the builder and its tests stay
 * deterministic, and the web server owns the I/O (a cached git lookup).
 *
 * Format stability matters more than freshness: the timestamp is minute
 * granularity and the block sits at a fixed position in the system message,
 * so a provider's prompt-cache prefix stays valid across steps within a
 * session. A stale git branch is the documented trade-off (the Git view
 * remains the source of truth); the block never blocks or fails a request.
 */

/** Host-supplied facts; every field is optional and omitted when unknown. */
export interface EnvironmentFacts {
  /** Rendered from the host clock at assembly time (UTC ISO or offset form). */
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

/**
 * `2026-10-06 Monday · 14:30 +07:00` — minute granularity, local zone, `·`
 * separators. Padding keeps the rendered width stable within a day.
 */
export function formatEnvironmentDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const weekday = WEEKDAYS[now.getDay()] ?? ''
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const zone = localOffset(now)
  return `${date} ${weekday} · ${time} ${zone}`
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
  if (facts.now !== undefined) lines.push(`Today: ${formatEnvironmentDate(facts.now)}`)
  if (facts.platform !== undefined) {
    lines.push(`Platform: ${facts.platform}${facts.arch !== undefined ? ` ${facts.arch}` : ''}${facts.nodeVersion !== undefined ? ` · Node ${facts.nodeVersion}` : ''}`)
  }
  if (facts.workspacePath !== undefined && facts.workspacePath !== '') {
    lines.push(`Workspace: ${facts.workspacePath}${facts.gitBranch !== undefined && facts.gitBranch !== '' ? ` (git branch: ${facts.gitBranch})` : ''}`)
  }
  if (lines.length === 0) return undefined
  return `<environment_context>\n${lines.join('\n')}\n</environment_context>`
}
