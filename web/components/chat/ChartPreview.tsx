import type { ChartSpec } from '../../../src/harness/tools/chart-spec.ts'
import { SERIES_COLORS } from '../settings/UsagePanel.tsx'

const W = 520
const H = 220
const PAD = { top: 12, right: 12, bottom: 28, left: 44 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom
const MAX_X_TICKS = 8

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })
const color = (index: number): string => SERIES_COLORS[index % SERIES_COLORS.length]!

/**
 * A bar or line chart drawn as plain SVG from a validated spec. Model text only
 * ever reaches the DOM as React text nodes, never as markup. Beyond ~500 points
 * the labels thin out but nothing is aggregated; upgrade to a chart library
 * if richer charts (tooltips, zoom, pie) are needed.
 */
export function ChartPreview({ chart, title }: { readonly chart: ChartSpec; readonly title: string }) {
  const all = chart.series.flatMap((series) => series.values)
  // Bars start at zero; a line may float, but both include zero when the data allows.
  const min = Math.min(0, ...all)
  const max = Math.max(0, ...all)
  const span = max - min === 0 ? 1 : max - min
  const y = (value: number): number => PAD.top + PLOT_H - ((value - min) / span) * PLOT_H
  const count = chart.labels.length
  const slot = PLOT_W / count
  const xCenter = (i: number): number => PAD.left + slot * (i + 0.5)
  const stride = Math.ceil(count / MAX_X_TICKS)
  const barW = Math.max(1, (slot * 0.8) / chart.series.length)
  const ticks = [0, 0.5, 1].map((f) => min + span * f)

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5 rounded-2xl bg-muted p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${title}: ${chart.type} chart of ${chart.series.map((s) => s.name).join(', ')} over ${count} points`}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-line" strokeDasharray={tick === min ? undefined : '3 4'} />
            <text x={PAD.left - 6} y={y(tick) + 3} textAnchor="end" className="fill-fg-faint text-[10px]">{compact.format(tick)}</text>
          </g>
        ))}
        {chart.labels.map((label, i) => (i % stride === 0
          ? <text key={i} x={xCenter(i)} y={H - 8} textAnchor="middle" className="fill-fg-faint text-[10px]">{label.length > 10 ? `${label.slice(0, 9)}…` : label}</text>
          : null))}
        {chart.type === 'bar'
          ? chart.series.map((series, s) => series.values.map((value, i) => (
            <rect
              key={`${s}-${i}`}
              data-bar=""
              x={xCenter(i) - (barW * chart.series.length) / 2 + barW * s}
              y={Math.min(y(value), y(0))}
              width={barW}
              height={Math.abs(y(value) - y(0))}
              fill={color(s)}
            />
          )))
          : chart.series.map((series, s) => (
            <polyline
              key={s}
              fill="none"
              stroke={color(s)}
              strokeWidth={2}
              strokeLinejoin="round"
              points={series.values.map((value, i) => `${xCenter(i)},${y(value)}`).join(' ')}
            />
          ))}
      </svg>
      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[12px] text-fg-muted">
        {chart.series.map((series, s) => (
          <li key={series.name} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ backgroundColor: color(s) }} />{series.name}</li>
        ))}
      </ul>
      <details className="text-[12px] text-fg-muted">
        <summary className="cursor-pointer">Data</summary>
        <div className="max-h-60 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead><tr><th className="pr-3 font-medium" />{chart.series.map((series) => <th key={series.name} className="pr-3 font-medium">{series.name}</th>)}</tr></thead>
            <tbody>
              {chart.labels.map((label, i) => (
                <tr key={i}><th className="pr-3 font-normal">{label}</th>{chart.series.map((series) => <td key={series.name} className="pr-3 tabular-nums">{series.values[i]}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
