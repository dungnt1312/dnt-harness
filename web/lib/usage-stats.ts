/**
 * Pure statistics behind Settings → Usage. The server sends daily rows per
 * model (`GET /api/usage`); everything shown is derived here so it stays
 * testable without a DOM.
 */
import type { UsageDailyResponse, UsageDayRow } from './types.ts'

export type HeatmapMode = 'daily' | 'weekly' | 'cumulative'

const DAY_MS = 86_400_000
export const HEATMAP_WEEKS = 53
export const MAX_SERIES = 8
export const OTHER_SERIES = 'Other'

/** Tokens a row stands for: prompt (cached included) plus completion. */
export const rowTokens = (row: Pick<UsageDayRow, 'input' | 'output'>): number => row.input + row.output

/** `YYYY-MM-DD` → local-midnight Date (never parsed as UTC). */
export function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Shift a `YYYY-MM-DD` by whole calendar days (DST-safe). */
export function addDays(date: string, days: number): string {
  const d = parseDate(date)
  d.setDate(d.getDate() + days)
  return formatDate(d)
}

/** Total tokens per date, all models summed. */
export function totalsByDate(days: readonly UsageDayRow[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of days) totals.set(row.date, (totals.get(row.date) ?? 0) + rowTokens(row))
  return totals
}

export interface UsageSummary {
  readonly totalTokens: number
  readonly peakTokens: number
  readonly longestSessionMs: number
  readonly currentStreak: number
  readonly longestStreak: number
}

export function summarize(data: UsageDailyResponse): UsageSummary {
  const totals = totalsByDate(data.days)
  let totalTokens = 0
  let peakTokens = 0
  for (const value of totals.values()) {
    totalTokens += value
    peakTokens = Math.max(peakTokens, value)
  }
  const active = (date: string): boolean => (totals.get(date) ?? 0) > 0
  // An empty today does not break the streak yet (GitHub's convention).
  let cursor = active(data.today) ? data.today : addDays(data.today, -1)
  let currentStreak = 0
  while (active(cursor)) {
    currentStreak += 1
    cursor = addDays(cursor, -1)
  }
  let longestStreak = 0
  let run = 0
  let previous: string | undefined
  for (const date of [...totals.keys()].filter(active).sort()) {
    run = previous !== undefined && addDays(previous, 1) === date ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    previous = date
  }
  return { totalTokens, peakTokens, longestSessionMs: data.longestSessionMs, currentStreak, longestStreak }
}

/** Compact count: 812 · 12.4K · 306.2M · 1.9B. */
export function formatTokens(value: number): string {
  const units: readonly [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  // Round first, so 999_960 reads 1M rather than 1000K.
  for (const [size, suffix] of units) {
    if (Number((value / size).toFixed(1)) >= 1) return `${Number((value / size).toFixed(1))}${suffix}`
  }
  return String(Math.round(value))
}

/** `6 h 57 m`, `42 m`, `—` when nothing was recorded. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '< 1 m'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} h ${minutes % 60} m` : `${minutes} m`
}

export interface HeatmapCell {
  readonly date: string
  /** Value the colour encodes in the chosen mode. */
  readonly value: number
  /** That day's own tokens, for the tooltip. */
  readonly dayTokens: number
  /** 0 = empty, 1–4 = intensity. */
  readonly level: 0 | 1 | 2 | 3 | 4
  readonly future: boolean
}

export interface HeatmapModel {
  /** `weeks[col][row]`, row 0 = Sunday. */
  readonly weeks: readonly (readonly HeatmapCell[])[]
  /** Column index where each month first appears, with its short name. */
  readonly months: readonly { readonly col: number; readonly label: string }[]
}

/** Quantile thresholds over the non-zero values; one huge day cannot wash out the rest. */
export function levelFor(value: number, thresholds: readonly number[]): HeatmapCell['level'] {
  if (value <= 0) return 0
  let level = 1
  for (const t of thresholds) if (value > t) level += 1
  return Math.min(4, level) as HeatmapCell['level']
}

export function quantileThresholds(values: readonly number[]): readonly number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!
  return [at(0.25), at(0.5), at(0.75)]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function buildHeatmap(data: UsageDailyResponse, mode: HeatmapMode, weeks = HEATMAP_WEEKS): HeatmapModel {
  const totals = totalsByDate(data.days)
  const today = parseDate(data.today)
  // The last column holds today; columns start on Sunday.
  const start = addDays(data.today, -(today.getDay() + (weeks - 1) * 7))
  const dates: string[][] = []
  for (let col = 0; col < weeks; col += 1) {
    const week: string[] = []
    for (let row = 0; row < 7; row += 1) week.push(addDays(start, col * 7 + row))
    dates.push(week)
  }
  const isFuture = (date: string): boolean => date > data.today
  const day = (date: string): number => (isFuture(date) ? 0 : totals.get(date) ?? 0)

  let values: number[][]
  if (mode === 'weekly') {
    values = dates.map((week) => {
      const sum = week.reduce((acc, date) => acc + day(date), 0)
      return week.map(() => sum)
    })
  } else if (mode === 'cumulative') {
    // Running total includes history before the visible window.
    let running = 0
    for (const [date, value] of totals) if (date < start) running += value
    values = dates.map((week) => week.map((date) => {
      running += day(date)
      return isFuture(date) ? 0 : running
    }))
  } else {
    values = dates.map((week) => week.map(day))
  }
  const thresholds = quantileThresholds(mode === 'weekly' ? values.map((w) => w[0]!) : values.flat())
  const grid = dates.map((week, col) => week.map((date, row): HeatmapCell => {
    const value = values[col]![row]!
    return { date, value, dayTokens: day(date), level: isFuture(date) ? 0 : levelFor(value, thresholds), future: isFuture(date) }
  }))
  const months: { col: number; label: string }[] = []
  let lastMonth = -1
  dates.forEach((week, col) => {
    // A month is labelled at the first column containing its 1st day
    // (or the first column, for the month already in progress).
    const firstOfMonth = week.find((date) => date.endsWith('-01'))
    const month = parseDate(firstOfMonth ?? week[0]!).getMonth()
    if (month !== lastMonth && (firstOfMonth !== undefined || col === 0)) {
      months.push({ col, label: MONTHS[month]! })
      lastMonth = month
    }
  })
  // Drop a leading partial-month label that would collide with the next one.
  if (months.length > 1 && months[1]!.col - months[0]!.col < 3) months.shift()
  return { weeks: grid, months }
}

export interface TrendSeries {
  readonly model: string
  /** One value per date in `dates`. */
  readonly values: readonly number[]
  readonly total: number
}

export interface TrendModel {
  readonly dates: readonly string[]
  readonly series: readonly TrendSeries[]
  readonly max: number
}

/**
 * One series per model over the last `rangeDays` days ending today, ranked
 * by volume; models beyond `MAX_SERIES - 1` fold into "Other".
 */
export function buildTrend(data: UsageDailyResponse, rangeDays: number): TrendModel {
  const dates = Array.from({ length: rangeDays }, (_, i) => addDays(data.today, i - rangeDays + 1))
  const index = new Map(dates.map((date, i) => [date, i]))
  const perModel = new Map<string, number[]>()
  for (const row of data.days) {
    const i = index.get(row.date)
    if (i === undefined) continue
    let values = perModel.get(row.model)
    if (values === undefined) perModel.set(row.model, (values = new Array<number>(rangeDays).fill(0)))
    values[i]! += rowTokens(row)
  }
  let series: TrendSeries[] = [...perModel].map(([model, values]) => ({ model, values, total: values.reduce((a, b) => a + b, 0) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model))
  if (series.length > MAX_SERIES) {
    const kept = series.slice(0, MAX_SERIES - 1)
    const rest = series.slice(MAX_SERIES - 1)
    const values = dates.map((_, i) => rest.reduce((acc, s) => acc + s.values[i]!, 0))
    series = [...kept, { model: OTHER_SERIES, values, total: values.reduce((a, b) => a + b, 0) }]
  }
  const max = series.reduce((acc, s) => Math.max(acc, ...s.values), 0)
  return { dates, series, max }
}

/** Smallest 1/2/4/5/10 * 10^n at or above `value`, so 4 gridlines read cleanly; 4 when empty. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 4
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 4, 5, 10]) if (step * magnitude >= value) return Math.max(4, step * magnitude)
  return Math.max(4, 10 * magnitude)
}

export interface Point { readonly x: number; readonly y: number }

/**
 * Monotone cubic (Fritsch–Carlson) path through `points`: smooth like the
 * reference chart, yet never overshoots below zero or above a peak.
 */
export function monotonePath(points: readonly Point[]): string {
  const n = points.length
  if (n === 0) return ''
  const f = (v: number): string => String(Math.round(v * 100) / 100)
  if (n === 1) return `M${f(points[0]!.x)},${f(points[0]!.y)}`
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1]!.x - points[i]!.x)
    slope.push((points[i + 1]!.y - points[i]!.y) / dx[i]!)
  }
  const tangent: number[] = [slope[0]!]
  for (let i = 1; i < n - 1; i += 1) {
    tangent.push(slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2)
  }
  tangent.push(slope[n - 2]!)
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i]! / slope[i]!
    const b = tangent[i + 1]! / slope[i]!
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      tangent[i] = t * a * slope[i]!
      tangent[i + 1] = t * b * slope[i]!
    }
  }
  let d = `M${f(points[0]!.x)},${f(points[0]!.y)}`
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[i]!
    const p1 = points[i + 1]!
    const h = dx[i]! / 3
    d += `C${f(p0.x + h)},${f(p0.y + tangent[i]! * h)},${f(p1.x - h)},${f(p1.y - tangent[i + 1]! * h)},${f(p1.x)},${f(p1.y)}`
  }
  return d
}

/** `Oct 6` for axis ticks; `Oct 6, 2026` for tooltips. */
export function shortDate(date: string, withYear = false): string {
  const d = parseDate(date)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`
}
