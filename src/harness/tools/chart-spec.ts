/**
 * The chart a `SendPreview` call carries. Dependency-free on purpose: the tool
 * validates the model's JSON with it and the web re-validates the logged
 * result with the same code before drawing.
 */

export interface ChartSpec {
  readonly type: 'bar' | 'line'
  readonly labels: readonly string[]
  /** `color` is `#rgb` or `#rrggbb`; without it the series takes the palette colour for its position. */
  readonly series: readonly { readonly name: string; readonly values: readonly number[]; readonly color?: string }[]
  /** Axis titles. */
  readonly xLabel?: string
  readonly yLabel?: string
  /** Print each value on its bar or point. */
  readonly showValues?: boolean
}

export const MAX_CHART_POINTS = 500
export const MAX_CHART_SERIES = 8
export const MAX_AXIS_LABEL = 60
// Only hex ever reaches the SVG `fill`/`stroke`, so model text cannot inject CSS or markup.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function axisLabel(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`chart '${key}' must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_AXIS_LABEL) throw new Error(`chart '${key}' is longer than ${MAX_AXIS_LABEL} characters`)
  return trimmed === '' ? undefined : trimmed
}

/** Throws a message the model can act on. */
export function parseChart(raw: unknown): ChartSpec {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  if (record === undefined) throw new Error("argument 'chart' must be an object")
  const type = record['type']
  if (type !== 'bar' && type !== 'line') throw new Error("chart 'type' must be 'bar' or 'line'")
  const labels = record['labels']
  if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => typeof label === 'string')) throw new Error("chart 'labels' must be a non-empty array of strings")
  if (labels.length > MAX_CHART_POINTS) throw new Error(`chart has ${labels.length} points; the limit is ${MAX_CHART_POINTS}`)
  const series = record['series']
  if (!Array.isArray(series) || series.length === 0 || series.length > MAX_CHART_SERIES) throw new Error(`chart 'series' must have 1 to ${MAX_CHART_SERIES} entries`)
  const xLabel = axisLabel(record['xLabel'], 'xLabel')
  const yLabel = axisLabel(record['yLabel'], 'yLabel')
  const showValues = record['showValues']
  if (showValues !== undefined && typeof showValues !== 'boolean') throw new Error("chart 'showValues' must be a boolean")
  return {
    type,
    labels: labels as string[],
    ...(xLabel !== undefined ? { xLabel } : {}),
    ...(yLabel !== undefined ? { yLabel } : {}),
    ...(showValues === true ? { showValues } : {}),
    series: series.map((entry, index) => {
      const item = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const name = typeof item['name'] === 'string' ? item['name'].trim() : ''
      if (name === '') throw new Error(`series[${index}] needs a non-empty name`)
      const values = item['values']
      if (!Array.isArray(values) || values.length !== labels.length) throw new Error(`series '${name}' values must have one number per label (${labels.length})`)
      if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new Error(`series '${name}' values must be finite numbers`)
      const color = item['color']
      if (color !== undefined && (typeof color !== 'string' || !HEX_COLOR.test(color))) throw new Error(`series '${name}' color must be a hex colour like #3b82f6 or #38f`)
      return { name, values: values as number[], ...(color !== undefined ? { color: color as string } : {}) }
    }),
  }
}
