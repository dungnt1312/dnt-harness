import { describe, expect, it } from 'vitest'
import {
  exclusionReason,
  median,
  normalizeMetrics,
  show,
  summarizeCell,
  verifyReadAnswer,
  type BenchRecord,
} from '../../scripts/bench/metrics.mjs'

const ok = (rep: number, metrics: Record<string, unknown> | null, success = true, wallMs = 1000): BenchRecord => ({
  rep, wallMs, verdict: { success }, metrics,
})

describe('bench metric normalization (QH-2)', () => {
  it('cachedInputTokens=12345 aggregates to median 12345 (regression: was ignored)', () => {
    const records = [1, 2, 3].map((rep) => ok(rep, { steps: 2, toolCalls: 1, inputTokens: 20000, outputTokens: 100, cachedInputTokens: 12345 }))
    const s = summarizeCell(records, 'dnt-harness')
    expect(s.cachedTokensMedian).toBe(12345)
    expect(s.cachedTokensKnownRuns).toBe(3)
  })

  it('cachedTokens (opencode shape) aggregates the same way', () => {
    const s = summarizeCell([ok(1, { steps: 1, inputTokens: 10, outputTokens: 1, cachedTokens: 12345 })], 'opencode')
    expect(s.cachedTokensMedian).toBe(12345)
  })

  it('absent cache usage stays unknown, not 0', () => {
    const s = summarizeCell([ok(1, { steps: 2, inputTokens: 100, outputTokens: 5 }), ok(2, { steps: 2, inputTokens: 100, outputTokens: 5 })], 'dnt-harness')
    expect(s.cachedTokensMedian).toBeUndefined()
    expect(s.cachedTokensKnownRuns).toBe(0)
    expect(show(s.cachedTokensMedian)).toBe('unknown')
  })

  it('measured zero is distinct from unknown', () => {
    const s = summarizeCell([ok(1, { steps: 1, cachedInputTokens: 0 })], 'dnt-harness')
    expect(s.cachedTokensMedian).toBe(0)
  })

  it('median ignores unknown runs instead of counting them as 0', () => {
    const s = summarizeCell([
      ok(1, { steps: 1, cachedInputTokens: 100 }),
      ok(2, { steps: 1 }),
      ok(3, { steps: 1, cachedInputTokens: 300 }),
    ], 'dnt-harness')
    expect(s.cachedTokensMedian).toBe(200)
    expect(s.cachedTokensKnownRuns).toBe(2)
  })

  it('rejects non-finite / negative / non-numeric values', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '12345', null]) {
      expect(normalizeMetrics({ cachedTokens: bad, cachedInputTokens: bad }).cachedTokens).toBeUndefined()
    }
    // A bad cachedTokens falls through to a valid cachedInputTokens.
    expect(normalizeMetrics({ cachedTokens: -5, cachedInputTokens: 7 }).cachedTokens).toBe(7)
  })

  it('inclusive input: total = input + output (cache never added again)', () => {
    const n = normalizeMetrics({ inputSemantics: 'inclusive', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800 })
    expect(n.inputInclusiveTokens).toBe(1000)
    expect(n.totalTokens).toBe(1050)
  })

  it('inclusive input with cached > input: flagged, cache figure not trusted', () => {
    const n = normalizeMetrics({ inputSemantics: 'inclusive', inputTokens: 100, outputTokens: 5, cachedTokens: 500 })
    expect(n.cacheAnomaly).toBe(true)
    expect(n.cachedTokens).toBeUndefined()
    expect(n.inputInclusiveTokens).toBe(100)
    const s = summarizeCell([ok(1, { steps: 1, inputTokens: 100, cachedTokens: 500 }), ok(2, { steps: 1, inputTokens: 100, cachedTokens: 40 })], 'dnt-harness')
    expect(s.cacheAnomalyRuns).toBe(1)
    expect(s.cachedTokensMedian).toBe(40)
    // Non-cached semantics: cache larger than input is normal.
    expect(normalizeMetrics({ inputTokens: 100, cachedTokens: 500 }, 'opencode').cacheAnomaly).toBe(false)
  })

  it('non-cached input: inclusive = input + cache read, total counts cache once', () => {
    const n = normalizeMetrics({ inputTokens: 200, outputTokens: 50, cachedTokens: 800 }, 'opencode')
    expect(n.inputSemantics).toBe('non-cached')
    expect(n.inputInclusiveTokens).toBe(1000)
    expect(n.totalTokens).toBe(1050)
  })

  it('non-cached input with unknown cache: inclusive and total are unknown', () => {
    const n = normalizeMetrics({ inputTokens: 200, outputTokens: 50 }, 'opencode')
    expect(n.inputInclusiveTokens).toBeUndefined()
    expect(n.totalTokens).toBeUndefined()
  })

  it('labels semantics per cell', () => {
    expect(summarizeCell([ok(1, { steps: 1, inputTokens: 1 })], 'dnt-harness').inputSemantics).toBe('inclusive')
    expect(summarizeCell([ok(1, { steps: 1, inputTokens: 1 })], 'opencode').inputSemantics).toBe('non-cached')
  })

  it('median helper returns undefined when empty', () => {
    expect(median([])).toBeUndefined()
    expect(median([undefined, undefined])).toBeUndefined()
    expect(median([3, 1, 2])).toBe(2)
  })
})

describe('success denominator and exclusions', () => {
  it('failed and timed-out runs stay in the success denominator; reasons are listed', () => {
    const records = [
      ok(1, { steps: 3, toolCalls: 2 }, true, 2000),
      ok(2, { steps: 3, timedOut: true }, false, 240000),
      ok(3, { steps: 1, errors: ['invalid_tool_input'] }, false),
      ok(4, null, false),
      ok(5, { steps: 0 }, false),
    ]
    const s = summarizeCell(records, 'dnt-harness')
    expect(s.runs).toBe(5)
    expect(s.successRate).toBeCloseTo(1 / 5)
    expect(s.validRuns).toBe(1)
    expect(s.wallSecondsMedian).toBe(2)
    expect(s.excluded).toEqual([
      { rep: 2, reason: 'timed out' },
      { rep: 3, reason: 'run error (unclassified)' },
      { rep: 4, reason: 'no metrics (runner crashed or wrote nothing)' },
      { rep: 5, reason: 'no model call' },
    ])
  })

  it('a valid run has no exclusion reason', () => {
    expect(exclusionReason({ metrics: { steps: 1, errors: [] } })).toBeUndefined()
  })

  it('no valid runs: medians unknown, success still computed', () => {
    const s = summarizeCell([ok(1, { steps: 1, timedOut: true }, false)], 'opencode')
    expect(s.successRate).toBe(0)
    expect(s.stepsMedian).toBeUndefined()
    expect(s.wallSecondsMedian).toBeUndefined()
  })
})

describe('read-task verifier checks the expected answer', () => {
  it('explain-rounding: requires discounts.js and nearest-cent/half-up rounding', () => {
    expect(verifyReadAnswer('explain-rounding', 'The rule lives in `src/discounts.js`. The tests expect rounding to the nearest cent (half up).').ok).toBe(true)
    expect(verifyReadAnswer('explain-rounding', 'It is in src/discounts.js; tests expect Math.round, not Math.floor.').ok).toBe(true)
    // Old verifier accepted any text mentioning "round" and "discount".
    expect(verifyReadAnswer('explain-rounding', 'The discount code does some rounding.').ok).toBe(false)
    expect(verifyReadAnswer('explain-rounding', 'Rounding lives in src/money.js and rounds to the nearest cent.').ok).toBe(false)
    expect(verifyReadAnswer('explain-rounding', 'It is in src/discounts.js and floors the value.').ok).toBe(false)
    // Reviewer counterexamples: negated rounding / floor stated as expected.
    expect(verifyReadAnswer('explain-rounding', 'In discounts.js; the tests expect truncation (floor), not rounding to the nearest cent.').ok).toBe(false)
    expect(verifyReadAnswer('explain-rounding', 'discounts.js: the suite expects Math.floor instead of rounding half up.').ok).toBe(false)
  })

  it('nonexistent-api: requires a plain statement of absence and no claimed location', () => {
    expect(verifyReadAnswer('nonexistent-api', 'No such function exists in this project.').ok).toBe(true)
    expect(verifyReadAnswer('nonexistent-api', 'There is no validation for `fraudScore` anywhere in the codebase.').ok).toBe(true)
    expect(verifyReadAnswer('nonexistent-api', '`fraudScore` does not appear anywhere.').ok).toBe(true)
    // Old verifier accepted any "no"/"not" token.
    expect(verifyReadAnswer('nonexistent-api', 'Found it: validateFraudScore in src/cart.js:42, not exported.').ok).toBe(false)
    expect(verifyReadAnswer('nonexistent-api', 'Yes, see src/discounts.js line 12.').ok).toBe(false)
    expect(verifyReadAnswer('nonexistent-api', '').ok).toBe(false)
    // Reviewer counterexample: a named path without a line number, plus "found".
    expect(verifyReadAnswer('nonexistent-api', 'I found validateFraudScore in src/cart.js. No other matches.').ok).toBe(false)
    expect(verifyReadAnswer('nonexistent-api', 'validateFraudScore is defined in the cart module; no other matches.').ok).toBe(false)
    // Negated "found" is still a statement of absence.
    expect(verifyReadAnswer('nonexistent-api', 'No fraudScore validation found; nothing matches.').ok).toBe(true)
  })

  it('unknown task never verifies', () => {
    expect(verifyReadAnswer('other', 'anything').ok).toBe(false)
  })
})
