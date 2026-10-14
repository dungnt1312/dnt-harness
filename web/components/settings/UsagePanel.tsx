import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { fetchUsage } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import type { UsageDailyResponse } from '../../lib/types.ts'
import {
  buildCacheStats,
  buildHeatmap,
  buildTrend,
  formatDuration,
  formatTokens,
  monotonePath,
  niceMax,
  shortDate,
  summarize,
  type CacheDayStats,
  type HeatmapMode,
  type TrendModel,
} from '../../lib/usage-stats.ts'
import { EmptyState, LoadFailed, PanelBody, PanelIntro, Section } from './settings-kit.tsx'

/** Series colours: distinct in both themes, assigned by rank within the range. */
export const SERIES_COLORS = ['#3b82f6', '#22c55e', '#8b5cf6', '#ef4444', '#f97316', '#14b8a6', '#ec4899', '#eab308'] as const

/** Heat levels 0–4: muted empty cell, then rising opacity of the link blue. */
const LEVEL_CLASS = ['fill-muted', 'fill-link/25', 'fill-link/45', 'fill-link/70', 'fill-link'] as const

const HEATMAP_MODES: readonly { readonly value: HeatmapMode; readonly label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cumulative', label: 'Cumulative' },
]

type RangeKey = '7' | '30'
const RANGES: readonly { readonly value: RangeKey; readonly label: string }[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
]

/**
 * Settings → Usage: token statistics across every workspace, read from the
 * host's durable usage log (`GET /api/usage`).
 */
export function UsagePanel() {
  const [data, setData] = useState<UsageDailyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<HeatmapMode>('daily')
  const [range, setRange] = useState<RangeKey>('7')

  const load = useCallback(() => {
    setLoading(true)
    fetchUsage()
      .then((next) => { setData(next); setError(null) })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  if (data === null) {
    if (error !== null) return <LoadFailed what="usage" error={error} busy={loading} onRetry={load} />
    return <p role="status" className="m-0 text-[13px] text-fg-muted">Loading usage…</p>
  }

  const empty = data.days.length === 0
  return (
    <PanelBody>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <PanelIntro>Tokens reported by providers across every workspace (prompt, cached prompt included, plus completion). Days follow this host's local time.</PanelIntro>
        <IconButton label="Refresh usage" disabled={loading} onClick={load}><Icon name="refresh" size={15} /></IconButton>
      </div>
      {error !== null ? <LoadFailed what="the latest usage" error={error} busy={loading} onRetry={load} /> : null}
      {empty ? <EmptyState>Usage is recorded from now on — earlier requests were not tracked.</EmptyState> : null}
      <StatStrip data={data} />
      <Section title="Token activity" actions={<Segmented label="Activity aggregation" value={mode} options={HEATMAP_MODES} onChange={setMode} />}>
        <Heatmap data={data} mode={mode} />
      </Section>
      <Section title="Time range" actions={<Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />}>
        <TrendChart data={data} rangeDays={Number(range)} />
      </Section>
      <Section title="Prompt cache">
        <CacheSection data={data} rangeDays={Number(range)} />
      </Section>
    </PanelBody>
  )
}

function StatStrip({ data }: { readonly data: UsageDailyResponse }) {
  const summary = useMemo(() => summarize(data), [data])
  const stats = [
    { label: 'Total tokens', value: formatTokens(summary.totalTokens) },
    { label: 'Peak tokens', value: formatTokens(summary.peakTokens), title: 'Most tokens in a single day' },
    { label: 'Longest session', value: formatDuration(summary.longestSessionMs), title: 'Longest stretch of activity in one conversation (idle gaps over 30 minutes split it)' },
    { label: 'Current streak', value: `${summary.currentStreak} d` },
    { label: 'Longest streak', value: `${summary.longestStreak} d` },
  ]
  return (
    <dl className="m-0 grid min-w-0 grid-cols-2 gap-y-3 rounded-xl border border-line bg-surface px-2 py-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Usage summary">
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          title={stat.title}
          className={cn('flex min-w-0 flex-col-reverse items-center gap-0.5 px-2 text-center', index > 0 && 'lg:border-l lg:border-line')}
        >
          <dt className="m-0 truncate text-xs text-fg-muted">{stat.label}</dt>
          <dd className="m-0 text-lg font-semibold tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  )
}

const percent = (hit: number | undefined): string => (hit === undefined ? 'No data' : `${(hit * 100).toFixed(1)}%`)

/** Cache hit over the range chosen for the trend chart above it. */
function CacheSection({ data, rangeDays }: { readonly data: UsageDailyResponse; readonly rangeDays: number }) {
  const stats = useMemo(() => buildCacheStats(data, rangeDays), [data, rangeDays])
  const { total } = stats
  const summary = [
    { label: 'Cache hit', value: total.hit === undefined ? '—' : percent(total.hit), title: 'Cached prompt tokens divided by the prompt tokens of requests whose provider reported a cache share' },
    { label: 'Cached tokens', value: formatTokens(total.cached) },
    { label: 'Fresh tokens', value: formatTokens(total.freshInput), title: 'Prompt tokens that were not served from the cache' },
    { label: 'No cache data', value: `${total.unreportedRequests} ${total.unreportedRequests === 1 ? 'request' : 'requests'}`, title: 'Requests whose provider sent no cache information; they are left out of the hit rate' },
  ]
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="m-0 grid min-w-0 grid-cols-2 gap-y-3 rounded-xl border border-line bg-surface px-2 py-3 lg:grid-cols-4" aria-label="Cache summary">
        {summary.map((stat, index) => (
          <div key={stat.label} title={stat.title} className={cn('flex min-w-0 flex-col-reverse items-center gap-0.5 px-2 text-center', index > 0 && 'lg:border-l lg:border-line')}>
            <dt className="m-0 truncate text-xs text-fg-muted">{stat.label}</dt>
            <dd className="m-0 text-lg font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <CacheDailyChart days={stats.days} rangeDays={rangeDays} />
      {stats.models.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-muted">No requests in the last {rangeDays} days.</p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[420px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs text-fg-muted">
                <th scope="col" className="px-3 py-2 font-medium">Model</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Requests</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Cache hit</th>
                <th scope="col" className="px-3 py-2 text-right font-medium" title="Average prompt tokens per request that were not cached">Fresh per request</th>
              </tr>
            </thead>
            <tbody>
              {stats.models.map((row) => (
                <tr key={row.model} data-testid="cache-model-row" className="border-b border-line last:border-b-0">
                  <th scope="row" className="max-w-[16rem] truncate px-3 py-2 font-normal">{row.model}</th>
                  <td className="px-3 py-2 text-right tabular-nums">{row.requests}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', row.hit === undefined && 'text-fg-faint')}>{percent(row.hit)}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', row.freshPerRequest === undefined && 'text-fg-faint')}>
                    {row.freshPerRequest === undefined ? '—' : formatTokens(row.freshPerRequest)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const CACHE_W = 720
const CACHE_H = 120
const CACHE_PAD = { top: 8, right: 16, bottom: 24, left: 40 }

/** One bar per day: height is that day's hit rate; a day with no cache data is a faint stub. */
function CacheDailyChart({ days, rangeDays }: { readonly days: readonly CacheDayStats[]; readonly rangeDays: number }) {
  const innerW = CACHE_W - CACHE_PAD.left - CACHE_PAD.right
  const innerH = CACHE_H - CACHE_PAD.top - CACHE_PAD.bottom
  const slot = innerW / days.length
  const barW = Math.max(2, slot * 0.7)
  const tickEvery = rangeDays <= 7 ? 1 : 5
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <h4 className="m-0 mb-2 text-[13px] font-semibold">Daily cache hit</h4>
      <svg viewBox={`0 0 ${CACHE_W} ${CACHE_H}`} className="block h-auto w-full" role="img" aria-label={`Daily cache hit rate, last ${rangeDays} days`}>
        {[0, 0.5, 1].map((f) => {
          const y = CACHE_PAD.top + innerH - f * innerH
          return (
            <g key={f}>
              <line x1={CACHE_PAD.left} x2={CACHE_W - CACHE_PAD.right} y1={y} y2={y} className="stroke-line" strokeDasharray={f === 0 ? undefined : '3 4'} />
              <text x={CACHE_PAD.left - 8} y={y + 3} textAnchor="end" className="fill-fg-faint text-[10px]">{`${f * 100}%`}</text>
            </g>
          )
        })}
        {days.map((day, i) => {
          const x = CACHE_PAD.left + i * slot + (slot - barW) / 2
          const height = day.hit === undefined ? 2 : Math.max(2, day.hit * innerH)
          return (
            <g key={day.date}>
              <rect
                data-testid="cache-bar"
                x={x}
                y={CACHE_PAD.top + innerH - height}
                width={barW}
                height={height}
                rx={1.5}
                className={day.hit === undefined ? 'fill-muted' : 'fill-link'}
              >
                <title>{`${shortDate(day.date, true)} · ${day.hit === undefined ? 'no cache data' : `${percent(day.hit)} cache hit`}`}</title>
              </rect>
              {(days.length - 1 - i) % tickEvery === 0 ? (
                <text x={x + barW / 2} y={CACHE_H - 6} textAnchor="middle" className="fill-fg-faint text-[10px]">{shortDate(day.date)}</text>
              ) : null}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

const CELL = 11
const GAP = 3
const STEP = CELL + GAP

function Heatmap({ data, mode }: { readonly data: UsageDailyResponse; readonly mode: HeatmapMode }) {
  const map = useMemo(() => buildHeatmap(data, mode), [data, mode])
  const width = map.weeks.length * STEP - GAP
  const height = 7 * STEP - GAP + 18
  const unit = mode === 'weekly' ? 'tokens that week' : mode === 'cumulative' ? 'tokens so far' : 'tokens'
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`Token activity heatmap, ${mode}, last ${map.weeks.length} weeks`}
      >
        {map.weeks.map((week, col) => week.map((cell, row) => cell.future ? null : (
          <rect
            key={cell.date}
            data-testid="heat-cell"
            data-level={cell.level}
            x={col * STEP}
            y={row * STEP}
            width={CELL}
            height={CELL}
            rx={2.5}
            className={LEVEL_CLASS[cell.level]}
          >
            <title>{`${shortDate(cell.date, true)} · ${formatTokens(cell.value)} ${unit}${mode !== 'daily' ? ` (${formatTokens(cell.dayTokens)} that day)` : ''}`}</title>
          </rect>
        )))}
        {map.months.map((month) => (
          <text key={`${month.col}-${month.label}`} x={month.col * STEP} y={height - 4} className="fill-fg-faint text-[10px]">{month.label}</text>
        ))}
      </svg>
      <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-fg-faint" aria-hidden="true">
        Less
        {LEVEL_CLASS.map((cls) => <svg key={cls} width={CELL} height={CELL}><rect width={CELL} height={CELL} rx={2.5} className={cls} /></svg>)}
        More
      </div>
    </div>
  )
}

const CHART_W = 720
const CHART_H = 240
const PAD = { top: 12, right: 16, bottom: 28, left: 48 }

function TrendChart({ data, rangeDays }: { readonly data: UsageDailyResponse; readonly rangeDays: number }) {
  const trend = useMemo<TrendModel>(() => buildTrend(data, rangeDays), [data, rangeDays])
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const visible = trend.series.filter((s) => !hidden.has(s.model))
  const max = niceMax(Math.max(0, ...visible.flatMap((s) => s.values)))
  const innerW = CHART_W - PAD.left - PAD.right
  const innerH = CHART_H - PAD.top - PAD.bottom
  const x = (i: number): number => PAD.left + (trend.dates.length <= 1 ? innerW / 2 : (i / (trend.dates.length - 1)) * innerW)
  const y = (v: number): number => PAD.top + innerH - (v / max) * innerH
  const tickEvery = rangeDays <= 7 ? 1 : 5
  const ticks = trend.dates.flatMap((date, i) => ((trend.dates.length - 1 - i) % tickEvery === 0 ? [{ i, date }] : []))
  const toggle = (model: string): void => setHidden((current) => {
    const next = new Set(current)
    if (next.has(model)) next.delete(model)
    else next.add(model)
    return next
  })

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <h4 className="m-0 text-[13px] font-semibold">Daily token trend chart</h4>
      {trend.series.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-muted">No tokens in the last {rangeDays} days.</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0" aria-label="Models">
          {trend.series.map((series, index) => (
            <li key={series.model}>
              <button
                type="button"
                aria-pressed={!hidden.has(series.model)}
                onClick={() => toggle(series.model)}
                title={`${formatTokens(series.total)} tokens`}
                className={cn('inline-flex items-center gap-1.5 rounded px-1 text-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-link', hidden.has(series.model) && 'opacity-40 line-through')}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }} />
                {series.model}
              </button>
            </li>
          ))}
        </ul>
      )}
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="block h-auto w-full" role="img" aria-label={`Daily tokens per model, last ${rangeDays} days`}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(max * f)} y2={y(max * f)} className="stroke-line" strokeDasharray={f === 0 ? undefined : '3 4'} />
            <text x={PAD.left - 8} y={y(max * f) + 3} textAnchor="end" className="fill-fg-faint text-[10px]">{formatTokens(max * f)}</text>
          </g>
        ))}
        {ticks.map(({ i, date }) => (
          <text key={date} x={x(i)} y={CHART_H - 8} textAnchor="middle" className="fill-fg-faint text-[10px]" data-testid="trend-tick">{shortDate(date)}</text>
        ))}
        {trend.series.map((series, index) => hidden.has(series.model) ? null : (
          <g key={series.model} data-testid="trend-series">
            <path
              d={monotonePath(series.values.map((v, i) => ({ x: x(i), y: y(v) })))}
              fill="none"
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {series.values.map((v, i) => (
              <circle key={trend.dates[i]} cx={x(i)} cy={y(v)} r={6} fill="transparent">
                <title>{`${series.model} · ${shortDate(trend.dates[i]!, true)} · ${formatTokens(v)} tokens`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </div>
  )
}
