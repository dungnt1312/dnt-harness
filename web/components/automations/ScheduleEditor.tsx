import Icon from '../common/Icon.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import {
  ADD_OPTIONS,
  ALL_DAYS,
  HOUR_STEPS,
  MINUTE_STEPS,
  WEEKDAYS,
  WEEKDAY_SHORT,
  describeRule,
  endOfLocalDay,
  formatTime,
  localDate,
  newRule,
  parseTime,
  type ClockTime,
  type HourWindow,
  type ScheduleRule,
} from '../../lib/automation-schedule.ts'

/** How a recurring plan ends: never, after N runs, or on a date. */
export type EndRule =
  | { readonly kind: 'never' }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'date'; readonly date: string }

export function endRuleOf(endsAt: number | null, maxRuns: number | null): EndRule {
  if (maxRuns !== null) return { kind: 'count', count: maxRuns }
  if (endsAt !== null) return { kind: 'date', date: localDate(endsAt) }
  return { kind: 'never' }
}

export function endFields(end: EndRule): { readonly endsAt: number | null; readonly maxRuns: number | null } {
  if (end.kind === 'count') return { endsAt: null, maxRuns: Math.max(1, Math.trunc(end.count) || 1) }
  if (end.kind === 'date') return { endsAt: endOfLocalDay(end.date), maxRuns: null }
  return { endsAt: null, maxRuns: null }
}

const fieldClass = 'h-8 rounded-lg border border-line bg-bg px-2 text-[13px] text-fg outline-none focus:border-fg-faint'
const chipClass = 'inline-flex h-7 min-w-9 items-center justify-center rounded-full border px-2 text-xs font-medium transition-colors'

/**
 * The Schedule section: one card per rule, each edited with plain controls
 * (dates, times, day chips, "every N"), an "+ Add schedule" menu, and the
 * end condition for recurring plans. No cron unless the user picks Custom.
 */
export function ScheduleEditor({ rules, onRules, end, onEnd }: {
  readonly rules: readonly ScheduleRule[]
  readonly onRules: (next: readonly ScheduleRule[]) => void
  readonly end: EndRule
  readonly onEnd: (next: EndRule) => void
}) {
  const recurring = rules.some((rule) => rule.kind !== 'once')
  const update = (index: number, next: ScheduleRule): void => onRules(rules.map((rule, i) => (i === index ? next : rule)))
  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, index) => (
        <RuleCard key={index} rule={rule} onChange={(next) => update(index, next)} onRemove={() => onRules(rules.filter((_, i) => i !== index))} />
      ))}
      <Menu
        label={rules.length === 0 ? 'Add schedule' : 'Add another time'}
        panelClassName="w-52"
        triggerClassName="flex h-10 w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        trigger={() => (<><Icon name="plus" size={15} />{rules.length === 0 ? 'Add schedule' : 'Add another time'}</>)}
      >
        {(close) => (
          <>
            {ADD_OPTIONS.map((option) => (
              <button key={option.id} type="button" role="menuitem" className={menuItemClass} onClick={() => { onRules([...rules, newRule(option.id)]); close() }}>
                {option.label}
              </button>
            ))}
          </>
        )}
      </Menu>
      {recurring ? <EndControl end={end} onEnd={onEnd} /> : null}
    </div>
  )
}

function RuleCard({ rule, onChange, onRemove }: {
  readonly rule: ScheduleRule
  readonly onChange: (next: ScheduleRule) => void
  readonly onRemove: () => void
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Icon name={rule.kind === 'once' ? 'calendarClock' : 'refresh'} size={15} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-sm">{describeRule(rule)}</span>
        <button type="button" className="shrink-0 text-fg-faint hover:text-bad" aria-label="Remove schedule" onClick={onRemove}><Icon name="close" size={15} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-fg-muted">
        <RuleFields rule={rule} onChange={onChange} />
      </div>
    </div>
  )
}

function RuleFields({ rule, onChange }: { readonly rule: ScheduleRule; readonly onChange: (next: ScheduleRule) => void }) {
  switch (rule.kind) {
    case 'once':
      return (
        <>
          <label className="flex items-center gap-1.5">On
            <input type="date" aria-label="Date" className={fieldClass} min={localDate(Date.now())} value={rule.date} onChange={(event) => event.target.value !== '' && onChange({ ...rule, date: event.target.value })} />
          </label>
          <TimeField label="Time" value={rule.time} onChange={(time) => onChange({ ...rule, time })} />
        </>
      )
    case 'minutes':
      return (
        <>
          <StepField label="Every" unit="minutes" steps={MINUTE_STEPS} max={59} value={rule.every} onChange={(every) => onChange({ ...rule, every })} />
          <WindowField window={rule.window} onChange={(window) => onChange({ ...rule, window })} />
          <DayChips days={rule.days} onChange={(days) => onChange({ ...rule, days })} />
        </>
      )
    case 'hours':
      return (
        <>
          <StepField label="Every" unit="hours" steps={HOUR_STEPS} max={23} value={rule.every} onChange={(every) => onChange({ ...rule, every })} />
          <label className="flex items-center gap-1.5">at minute
            <input type="number" min={0} max={59} aria-label="Minute past the hour" className={cn(fieldClass, 'w-16')} value={rule.minute} onChange={(event) => onChange({ ...rule, minute: clamp(Number(event.target.value), 0, 59) })} />
          </label>
          <WindowField window={rule.window} onChange={(window) => onChange({ ...rule, window })} />
          <DayChips days={rule.days} onChange={(days) => onChange({ ...rule, days })} />
        </>
      )
    case 'daily':
      return (
        <>
          <DayChips days={rule.days} onChange={(days) => onChange({ ...rule, days })} />
          <div className="flex flex-wrap items-center gap-1.5">
            at
            {rule.times.map((time, index) => (
              <span key={index} className="flex items-center gap-0.5">
                <TimeField label={`Time ${index + 1}`} value={time} onChange={(next) => onChange({ ...rule, times: rule.times.map((t, i) => (i === index ? next : t)) })} />
                {rule.times.length > 1 ? (
                  <button type="button" className="text-fg-faint hover:text-bad" aria-label={`Remove ${formatTime(time)}`} onClick={() => onChange({ ...rule, times: rule.times.filter((_, i) => i !== index) })}><Icon name="close" size={13} /></button>
                ) : null}
              </span>
            ))}
            {rule.times.length < 12 ? (
              <button type="button" className="flex h-8 items-center gap-1 rounded-lg px-2 text-fg-muted hover:bg-hover hover:text-fg" onClick={() => onChange({ ...rule, times: [...rule.times, nextTime(rule.times)] })}>
                <Icon name="plus" size={13} />time
              </button>
            ) : null}
          </div>
        </>
      )
    case 'monthly':
      return (
        <>
          <label className="flex items-center gap-1.5">On day
            <select aria-label="Day of month" className={fieldClass} value={String(rule.day)} onChange={(event) => onChange({ ...rule, day: event.target.value === 'last' ? 'last' : Number(event.target.value) })}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => <option key={day} value={day}>{day}</option>)}
              <option value="last">Last day</option>
            </select>
          </label>
          <TimeField label="Time" value={rule.time} onChange={(time) => onChange({ ...rule, time })} />
          {rule.day !== 'last' && rule.day > 28 ? <span className="text-fg-faint">Months without day {rule.day} are skipped.</span> : null}
        </>
      )
    case 'custom':
      return (
        <label className="flex min-w-0 flex-1 items-center gap-1.5">Cron
          <input
            aria-label="Cron expression"
            className={cn(fieldClass, 'min-w-40 flex-1 font-mono')}
            placeholder="minute hour day month weekday"
            spellCheck={false}
            value={rule.cron}
            onChange={(event) => onChange({ ...rule, cron: event.target.value })}
          />
        </label>
      )
  }
}

function TimeField({ label, value, onChange }: { readonly label: string; readonly value: ClockTime; readonly onChange: (next: ClockTime) => void }) {
  return (
    <input
      type="time"
      aria-label={label}
      className={fieldClass}
      value={formatTime(value)}
      onChange={(event) => { const parsed = parseTime(event.target.value); if (parsed !== null) onChange(parsed) }}
    />
  )
}

/** "Every [10 ▾] minutes": common steps, plus any custom number already saved. */
function StepField({ label, unit, steps, max, value, onChange }: {
  readonly label: string
  readonly unit: string
  readonly steps: readonly number[]
  readonly max: number
  readonly value: number
  readonly onChange: (next: number) => void
}) {
  const options = [...new Set([...steps, value])].filter((n) => n >= 1 && n <= max).sort((a, b) => a - b)
  return (
    <label className="flex items-center gap-1.5">{label}
      <select aria-label={`${label} ${unit}`} className={fieldClass} value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      {unit}
    </label>
  )
}

/** "All day" or "only between [08:00] and [22:00]". */
function WindowField({ window, onChange }: { readonly window: HourWindow | null; readonly onChange: (next: HourWindow | null) => void }) {
  const hours = Array.from({ length: 24 }, (_, h) => h)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <select aria-label="Hours of the day" className={fieldClass} value={window === null ? 'all' : 'between'} onChange={(event) => onChange(event.target.value === 'all' ? null : { from: 8, to: 22 })}>
        <option value="all">all day</option>
        <option value="between">only between</option>
      </select>
      {window !== null ? (
        <>
          <select aria-label="From hour" className={fieldClass} value={window.from} onChange={(event) => { const from = Number(event.target.value); onChange({ from, to: Math.max(window.to, from + 1) }) }}>
            {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
          and
          <select aria-label="Until hour" className={fieldClass} value={window.to} onChange={(event) => { const to = Number(event.target.value); onChange({ from: Math.min(window.from, to - 1), to }) }}>
            {hours.map((h) => h + 1).map((h) => <option key={h} value={h}>{String(h % 24).padStart(2, '0')}:00</option>)}
          </select>
        </>
      ) : null}
    </span>
  )
}

/** Weekday toggles with Every day / Weekdays shortcuts; at least one day stays on. */
function DayChips({ days, onChange }: { readonly days: readonly number[]; readonly onChange: (next: readonly number[]) => void }) {
  const set = new Set(days)
  const same = (other: readonly number[]): boolean => other.length === set.size && other.every((d) => set.has(d))
  const toggle = (day: number): void => {
    const next = set.has(day) ? days.filter((d) => d !== day) : [...days, day]
    if (next.length > 0) onChange([...next].sort((a, b) => a - b))
  }
  const shortcut = (label: string, value: readonly number[]) => (
    <button type="button" aria-pressed={same(value)} className={cn(chipClass, same(value) ? 'border-fg-faint bg-hover text-fg' : 'border-line text-fg-muted hover:text-fg')} onClick={() => onChange(value)}>{label}</button>
  )
  return (
    <span role="group" aria-label="Days" className="flex flex-wrap items-center gap-1">
      {shortcut('Every day', ALL_DAYS)}
      {shortcut('Weekdays', WEEKDAYS)}
      <span className="mx-0.5 h-4 w-px bg-line" />
      {[1, 2, 3, 4, 5, 6, 0].map((day) => (
        <button
          key={day}
          type="button"
          aria-pressed={set.has(day)}
          aria-label={WEEKDAY_SHORT[day]}
          className={cn(chipClass, set.has(day) ? 'border-primary bg-primary text-primary-fg' : 'border-line text-fg-muted hover:text-fg')}
          onClick={() => toggle(day)}
        >
          {WEEKDAY_SHORT[day]!.slice(0, 2)}
        </button>
      ))}
    </span>
  )
}

function EndControl({ end, onEnd }: { readonly end: EndRule; readonly onEnd: (next: EndRule) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 text-[13px] text-fg-muted">
      <span>Ends</span>
      <select
        aria-label="Ends"
        className={fieldClass}
        value={end.kind}
        onChange={(event) => {
          const kind = event.target.value
          onEnd(kind === 'count' ? { kind: 'count', count: 5 } : kind === 'date' ? { kind: 'date', date: localDate(Date.now() + 7 * 86_400_000) } : { kind: 'never' })
        }}
      >
        <option value="never">Never</option>
        <option value="count">After a number of runs</option>
        <option value="date">On a date</option>
      </select>
      {end.kind === 'count' ? (
        <label className="flex items-center gap-1.5">
          <input type="number" min={1} max={100000} aria-label="Number of runs" className={cn(fieldClass, 'w-20')} value={end.count} onChange={(event) => onEnd({ kind: 'count', count: clamp(Number(event.target.value), 1, 100_000) })} />
          {end.count === 1 ? 'run' : 'runs'}
        </label>
      ) : null}
      {end.kind === 'date' ? (
        <input type="date" aria-label="End date" className={fieldClass} min={localDate(Date.now())} value={end.date} onChange={(event) => event.target.value !== '' && onEnd({ kind: 'date', date: event.target.value })} />
      ) : null}
    </div>
  )
}

function nextTime(times: readonly ClockTime[]): ClockTime {
  const last = times[times.length - 1] ?? { hour: 9, minute: 0 }
  return { hour: (last.hour + 1) % 24, minute: last.minute }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min
}
