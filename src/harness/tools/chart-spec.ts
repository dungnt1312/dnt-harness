/**
 * The chart a `SendPreview` call carries. Dependency-free on purpose: the tool
 * validates the model's JSON with it and the web re-validates the logged
 * result with the same code before drawing.
 */

export interface ChartSpec {
  readonly type: 'bar' | 'line'
  readonly labels: readonly string[]
  readonly series: readonly { readonly name: string; readonly values: readonly number[] }[]
}

export const MAX_CHART_POINTS = 500
export const MAX_CHART_SERIES = 8

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
  return {
    type,
    labels: labels as string[],
    series: series.map((entry, index) => {
      const item = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const name = typeof item['name'] === 'string' ? item['name'].trim() : ''
      if (name === '') throw new Error(`series[${index}] needs a non-empty name`)
      const values = item['values']
      if (!Array.isArray(values) || values.length !== labels.length) throw new Error(`series '${name}' values must have one number per label (${labels.length})`)
      if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) throw new Error(`series '${name}' values must be finite numbers`)
      return { name, values: values as number[] }
    }),
  }
}
