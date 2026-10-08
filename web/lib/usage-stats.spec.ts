import { describe, expect, it } from 'vitest'
import type { UsageDailyResponse, UsageDayRow } from './types.ts'
import {
  addDays, buildHeatmap, buildTrend, formatDuration, formatTokens, levelFor, monotonePath, niceMax, quantileThresholds, summarize, OTHER_SERIES,
} from './usage-stats.ts'

const row = (date: string, model: string, input: number, output = 0): UsageDayRow => ({ date, model, input, cached: 0, output, requests: 1 })
const data = (days: UsageDayRow[], today = '2026-10-08', longestSessionMs = 0): UsageDailyResponse => ({ days, today, longestSessionMs })

describe('summarize', () => {
  it('sums input + output, finds the peak day across models', () => {
    const s = summarize(data([row('2026-10-01', 'a', 100, 10), row('2026-10-01', 'b', 50), row('2026-10-03', 'a', 120)]))
    expect(s.totalTokens).toBe(280)
    expect(s.peakTokens).toBe(160)
  })

  it('keeps the current streak alive when today is still empty', () => {
    const s = summarize(data([row('2026-10-05', 'a', 1), row('2026-10-06', 'a', 1), row('2026-10-07', 'a', 1)]))
    expect(s.currentStreak).toBe(3)
    expect(summarize(data([row('2026-10-05', 'a', 1)])).currentStreak).toBe(0)
    expect(summarize(data([row('2026-10-07', 'a', 1), row('2026-10-08', 'a', 1)])).currentStreak).toBe(2)
  })

  it('finds the longest run of consecutive active days, across month ends', () => {
    const days = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-10', '2026-09-11'].map((d) => row(d, 'a', 5))
    const s = summarize(data(days))
    expect(s.longestStreak).toBe(4)
    expect(s.currentStreak).toBe(0)
  })

  it('zero-token rows are not activity', () => {
    expect(summarize(data([row('2026-10-08', 'a', 0)])).currentStreak).toBe(0)
  })
})

describe('formatting', () => {
  it('compacts token counts like the reference', () => {
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(12_400)).toBe('12.4K')
    expect(formatTokens(306_200_000)).toBe('306.2M')
    expect(formatTokens(1_900_000_000)).toBe('1.9B')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(250_000)).toBe('250K')
    expect(formatTokens(999_960)).toBe('1M')
  })

  it('formats session length', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration((6 * 60 + 57) * 60_000)).toBe('6 h 57 m')
    expect(formatDuration(42 * 60_000)).toBe('42 m')
  })
})

describe('heatmap', () => {
  it('ends with today in the last column, Sunday-first rows', () => {
    // 2026-10-08 is a Thursday.
    const map = buildHeatmap(data([row('2026-10-08', 'a', 10)]), 'daily')
    expect(map.weeks).toHaveLength(53)
    const last = map.weeks[52]!
    expect(last[0]!.date).toBe('2026-10-04')
    expect(last[4]!.date).toBe('2026-10-08')
    expect(last[4]!.level).toBeGreaterThan(0)
    expect(last[5]!.future).toBe(true)
    expect(map.weeks[0]![0]!.date).toBe(addDays('2026-10-04', -52 * 7))
    // Oct 1 (a Thursday) falls in the column starting Sun Sep 27.
    expect(map.months.at(-1)).toEqual({ col: 51, label: 'Oct' })
  })

  it('weekly mode paints a whole column with its week total', () => {
    const map = buildHeatmap(data([row('2026-10-05', 'a', 10), row('2026-10-06', 'a', 30)]), 'weekly')
    const values = map.weeks[52]!.filter((c) => !c.future).map((c) => c.value)
    expect(new Set(values)).toEqual(new Set([40]))
    expect(map.weeks[52]![1]!.dayTokens).toBe(10)
  })

  it('cumulative mode never decreases and includes history before the window', () => {
    const map = buildHeatmap(data([row('2025-01-01', 'a', 7), row('2026-10-01', 'a', 3), row('2026-10-07', 'a', 5)]), 'cumulative')
    const values = map.weeks.flat().filter((c) => !c.future).map((c) => c.value)
    expect(values[0]).toBe(7)
    expect(values.at(-1)).toBe(15)
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
  })

  it('quantile levels keep one outlier from washing out the rest', () => {
    const t = quantileThresholds([1, 2, 3, 4, 1000])
    expect(levelFor(0, t)).toBe(0)
    expect(levelFor(1, t)).toBe(1)
    expect(levelFor(3, t)).toBe(2)
    expect(levelFor(4, t)).toBe(3)
    expect(levelFor(1000, t)).toBe(4)
  })
})

describe('trend', () => {
  it('produces one point per day in range, ranked by volume', () => {
    const trend = buildTrend(data([row('2026-10-02', 'small', 5), row('2026-10-08', 'big', 100), row('2026-09-01', 'old', 999)]), 7)
    expect(trend.dates).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'])
    expect(trend.series.map((s) => s.model)).toEqual(['big', 'small'])
    expect(trend.series[1]!.values[0]).toBe(5)
    expect(trend.max).toBe(100)
    expect(buildTrend(data([]), 30).dates).toHaveLength(30)
  })

  it('folds models beyond the eighth series into Other', () => {
    const days = Array.from({ length: 10 }, (_, i) => row('2026-10-08', `m${i}`, 100 - i))
    const trend = buildTrend(data(days), 7)
    expect(trend.series).toHaveLength(8)
    expect(trend.series.at(-1)).toMatchObject({ model: OTHER_SERIES, total: 93 + 92 + 91 })
  })
})

describe('niceMax', () => {
  it('rounds the axis up to a clean value', () => {
    expect(niceMax(0)).toBe(4)
    expect(niceMax(1)).toBe(4)
    expect(niceMax(1_300_000_000)).toBe(2_000_000_000)
    expect(niceMax(4_500)).toBe(5_000)
    expect(niceMax(100)).toBe(100)
  })
})

describe('monotonePath', () => {
  it('never overshoots below the baseline next to a spike', () => {
    const path = monotonePath([{ x: 0, y: 100 }, { x: 10, y: 100 }, { x: 20, y: 0 }, { x: 30, y: 100 }])
    const ys = [...path.matchAll(/-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    expect(Math.max(...ys)).toBeLessThanOrEqual(100)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(monotonePath([])).toBe('')
  })
})
