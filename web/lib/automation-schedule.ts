/**
 * Friendly schedule rules for the Automations editor. A user picks "Once",
 * "Every 10 minutes", "Every day at 07:00 and 19:00 on weekdays"…; each rule
 * becomes one or more host schedules (`{ at }` or a five-field cron) and the
 * saved schedules parse back into rules, so nobody has to read cron. Anything
 * the rules cannot express stays a `custom` cron rule.
 */

export type ApiSchedule = { readonly cron: string } | { readonly at: number }

/** Clock time, minutes past midnight-free: `{ hour, minute }`. */
export interface ClockTime { readonly hour: number; readonly minute: number }

/** Hours-of-day window: `from` inclusive, `to` exclusive (1-24). */
export interface HourWindow { readonly from: number; readonly to: number }

export type ScheduleRule =
  | { readonly kind: 'once'; readonly date: string; readonly time: ClockTime }
  | { readonly kind: 'minutes'; readonly every: number; readonly window: HourWindow | null; readonly days: readonly number[] }
  | { readonly kind: 'hours'; readonly every: number; readonly minute: number; readonly window: HourWindow | null; readonly days: readonly number[] }
  | { readonly kind: 'daily'; readonly times: readonly ClockTime[]; readonly days: readonly number[] }
  | { readonly kind: 'monthly'; readonly day: number | 'last'; readonly time: ClockTime }
  | { readonly kind: 'custom'; readonly cron: string }

export type RuleKind = ScheduleRule['kind']

/** "+ Add schedule" menu entries: daily/weekday/weekly are one rule with preset days. */
export const ADD_OPTIONS = [
  { id: 'once', label: 'Once' },
  { id: 'minutes', label: 'Every few minutes' },
  { id: 'hours', label: 'Every few hours' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Every weekday' },
  { id: 'weekly', label: 'Every week' },
  { id: 'monthly', label: 'Every month' },
  { id: 'custom', label: 'Custom (cron)' },
] as const

export type AddOption = (typeof ADD_OPTIONS)[number]['id']

export const MINUTE_STEPS = [5, 10, 15, 20, 30] as const
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const
export const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5]
export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const two = (n: number): string => String(n).padStart(2, '0')

export function formatTime(time: ClockTime): string {
  return `${two(time.hour)}:${two(time.minute)}`
}

/** `HH:MM` → ClockTime, or null. */
export function parseTime(value: string): ClockTime | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : null
}

/** Local `YYYY-MM-DD` of an instant. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** Local date + time → epoch ms (NaN on bad input). */
export function localInstant(date: string, time: ClockTime): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return Number.NaN
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), time.hour, time.minute, 0, 0).getTime()
}

/** A fresh rule for one "+ Add schedule" choice. `now` seeds Once with the next whole hour. */
export function newRule(option: AddOption, now = Date.now()): ScheduleRule {
  const nine: ClockTime = { hour: 9, minute: 0 }
  switch (option) {
    case 'once': {
      const next = new Date(now)
      next.setHours(next.getHours() + 1, 0, 0, 0)
      return { kind: 'once', date: localDate(next.getTime()), time: { hour: next.getHours(), minute: 0 } }
    }
    case 'minutes': return { kind: 'minutes', every: 10, window: null, days: ALL_DAYS }
    case 'hours': return { kind: 'hours', every: 2, minute: 0, window: null, days: ALL_DAYS }
    case 'daily': return { kind: 'daily', times: [nine], days: ALL_DAYS }
    case 'weekdays': return { kind: 'daily', times: [nine], days: WEEKDAYS }
    case 'weekly': return { kind: 'daily', times: [nine], days: [new Date(now).getDay()] }
    case 'monthly': return { kind: 'monthly', day: 1, time: nine }
    case 'custom': return { kind: 'custom', cron: '0 9 * * *' }
  }
}

// ── rule → host schedules ──────────────────────────────────────

function dowField(days: readonly number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
  if (set.length === 0 || set.length === 7) return '*'
  if (set.join(',') === '1,2,3,4,5') return '1-5'
  return set.join(',')
}

function hourField(window: HourWindow | null): string | null {
  if (window === null) return null
  const from = Math.max(0, Math.min(23, window.from))
  const last = Math.max(from, Math.min(23, window.to - 1))
  return from === last ? String(from) : `${from}-${last}`
}

export function ruleToSchedules(rule: ScheduleRule): ApiSchedule[] {
  switch (rule.kind) {
    case 'once': return [{ at: localInstant(rule.date, rule.time) }]
    case 'minutes': {
      const minute = rule.every <= 1 ? '*' : `*/${rule.every}`
      return [{ cron: `${minute} ${hourField(rule.window) ?? '*'} * * ${dowField(rule.days)}` }]
    }
    case 'hours': {
      const range = hourField(rule.window)
      const hour = rule.every <= 1 ? (range ?? '*') : `${range ?? '*'}/${rule.every}`
      return [{ cron: `${rule.minute} ${hour} * * ${dowField(rule.days)}` }]
    }
    case 'daily': {
      const unique = [...new Map(rule.times.map((t) => [formatTime(t), t])).values()]
      return unique.map((t) => ({ cron: `${t.minute} ${t.hour} * * ${dowField(rule.days)}` }))
    }
    case 'monthly': return [{ cron: `${rule.time.minute} ${rule.time.hour} ${rule.day === 'last' ? 'L' : rule.day} * *` }]
    case 'custom': return [{ cron: rule.cron.trim().replace(/\s+/g, ' ') }]
  }
}

export function rulesToSchedules(rules: readonly ScheduleRule[]): ApiSchedule[] {
  return rules.flatMap(ruleToSchedules)
}

// ── host schedules → rules ─────────────────────────────────────

const NUM = /^\d{1,2}$/

function parseDays(field: string): number[] | null {
  if (field === '*') return [...ALL_DAYS]
  if (field === '1-5') return [...WEEKDAYS]
  const parts = field.split(',')
  if (!parts.every((p) => /^[0-6]$/.test(p))) return null
  return [...new Set(parts.map(Number))].sort((a, b) => a - b)
}

function parseWindow(field: string): HourWindow | null | undefined {
  if (field === '*') return null
  if (NUM.test(field) && Number(field) <= 23) return { from: Number(field), to: Number(field) + 1 }
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(field)
  if (match === null) return undefined
  const from = Number(match[1])
  const last = Number(match[2])
  return from <= last && last <= 23 ? { from, to: last + 1 } : undefined
}

/** One host schedule → one rule (daily rules carry a single time here). */
export function scheduleToRule(schedule: ApiSchedule): ScheduleRule {
  if ('at' in schedule) {
    const d = new Date(schedule.at)
    return { kind: 'once', date: localDate(schedule.at), time: { hour: d.getHours(), minute: d.getMinutes() } }
  }
  const cron = schedule.cron.trim().replace(/\s+/g, ' ')
  const custom: ScheduleRule = { kind: 'custom', cron }
  const parts = cron.split(' ')
  if (parts.length !== 5) return custom
  const [mi, ho, dom, mon, dow] = parts as [string, string, string, string, string]
  if (mon !== '*') return custom
  const days = parseDays(dow)
  // Every N minutes, optionally within an hour window.
  const minuteStep = mi === '*' ? 1 : /^\*\/(\d{1,2})$/.exec(mi)?.[1]
  if (minuteStep !== undefined && dom === '*' && days !== null) {
    const window = parseWindow(ho)
    if (window !== undefined) return { kind: 'minutes', every: Number(minuteStep), window, days }
  }
  if (!NUM.test(mi) || Number(mi) > 59) return custom
  const minute = Number(mi)
  // Every N hours at minute M, optionally within a window.
  const hourStep = /^(\*|\d{1,2}-\d{1,2})\/(\d{1,2})$/.exec(ho)
  if (dom === '*' && days !== null && (hourStep !== null || ho === '*' || /^\d{1,2}-\d{1,2}$/.test(ho))) {
    const rangeField = hourStep !== null ? hourStep[1]! : ho
    const window = parseWindow(rangeField)
    if (window !== undefined) return { kind: 'hours', every: hourStep !== null ? Number(hourStep[2]) : 1, minute, window, days }
  }
  if (!NUM.test(ho) || Number(ho) > 23) return custom
  const time: ClockTime = { hour: Number(ho), minute }
  if (dom === '*' && days !== null) return { kind: 'daily', times: [time], days }
  if (dow === '*' && (dom === 'L' || (NUM.test(dom) && Number(dom) >= 1 && Number(dom) <= 31))) {
    return { kind: 'monthly', day: dom === 'L' ? 'last' : Number(dom), time }
  }
  return custom
}

/** Saved schedules → editor rules; daily schedules sharing their days merge into one rule. */
export function schedulesToRules(schedules: readonly ApiSchedule[]): ScheduleRule[] {
  const rules: ScheduleRule[] = []
  for (const schedule of schedules) {
    const rule = scheduleToRule(schedule)
    if (rule.kind === 'daily') {
      const key = dowField(rule.days)
      const index = rules.findIndex((r) => r.kind === 'daily' && dowField(r.days) === key)
      const existing = rules[index]
      if (existing !== undefined && existing.kind === 'daily') {
        rules[index] = { ...existing, times: [...existing.times, ...rule.times].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)) }
        continue
      }
    }
    rules.push(rule)
  }
  return rules
}

// ── words ──────────────────────────────────────────────────────

export function describeDays(days: readonly number[]): string {
  const field = dowField(days)
  if (field === '*') return 'every day'
  if (field === '1-5') return 'on weekdays'
  if (field === '0,6') return 'on weekends'
  const set = field.split(',').map(Number)
  return set.length === 1 ? `every ${WEEKDAY_LABELS[set[0]!]}` : `on ${set.map((d) => WEEKDAY_SHORT[d]).join(', ')}`
}

function describeWindow(window: HourWindow | null): string {
  return window === null ? '' : ` between ${two(window.from)}:00 and ${two(window.to % 24)}:00`
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/** Plain-language summary of one rule, e.g. "Every 10 minutes between 08:00 and 22:00". */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.kind) {
    case 'once': return `Once on ${rule.date} at ${formatTime(rule.time)}`
    case 'minutes': {
      const days = describeDays(rule.days)
      return `Every ${rule.every === 1 ? 'minute' : `${rule.every} minutes`}${describeWindow(rule.window)}${days === 'every day' ? '' : `, ${days}`}`
    }
    case 'hours': {
      const days = describeDays(rule.days)
      return `Every ${rule.every === 1 ? 'hour' : `${rule.every} hours`} at :${two(rule.minute)}${describeWindow(rule.window)}${days === 'every day' ? '' : `, ${days}`}`
    }
    case 'daily': {
      const days = describeDays(rule.days)
      const times = rule.times.map(formatTime).join(', ')
      return `${days.charAt(0).toUpperCase()}${days.slice(1)} at ${times}`
    }
    case 'monthly': return `Every month on the ${rule.day === 'last' ? 'last day' : ordinal(rule.day)} at ${formatTime(rule.time)}`
    case 'custom': return `Cron ${rule.cron}`
  }
}

/** Summary of a saved plan for list rows, end condition included. */
export function describePlan(schedules: readonly ApiSchedule[], endsAt: number | null, maxRuns: number | null): string {
  const parts = schedulesToRules(schedules).map(describeRule)
  const recurring = schedules.some((s) => 'cron' in s)
  if (recurring && maxRuns !== null) parts.push(`${maxRuns} time${maxRuns === 1 ? '' : 's'} total`)
  if (recurring && endsAt !== null) parts.push(`until ${localDate(endsAt)}`)
  return parts.join(' · ')
}

/** Short local date-time, e.g. "Fri 10/10 07:00". */
export function formatRunTime(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAY_SHORT[d.getDay()]} ${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** End of a local calendar day (inclusive end date). */
export function endOfLocalDay(date: string): number {
  return localInstant(date, { hour: 23, minute: 59 }) + 59_000
}
