/**
 * ZCode-style context counting (plans/261015-2000-zcode-context-counting/spec.md):
 * chars/3 estimator, provider-usage calibration, builder ratio, legacy fallback.
 */
import { describe, expect, it } from 'vitest'
import * as builder from '../../src/harness/context/builder.ts'
import type { BuildContextInput, ContextManifest } from '../../src/harness/context/builder.ts'
import { ContextBudgetError, DEFAULT_BUDGET, estimateTokens } from '../../src/harness/context/budget.ts'
import { MAX_CALIBRATION_RATIO, MIN_CALIBRATION_RATIO, TOKEN_ESTIMATOR, calibrationRatio, latestCalibration, pressureTokensOf, settledPressureTokens, type ContextCalibration } from '../../src/harness/context/calibration.ts'
import { BUNDLED_MODES, DEFAULT_MODE_ID } from '../../src/harness/modes/bundled.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import { attempt, manifest, row } from '../fixtures/context-accounting.ts'

describe('estimateTokens (AC-1)', () => {
  it('is ceil((len + cjk) / 3) with CJK ideographs counted twice', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('中文')).toBe(2)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('中a')).toBe(1)
  })
})

/** A manifest event as the host logs it; `estimator` defaults to the current one. */
function manifestRow(seq: number, contextId: string, over: { usedTokens?: number; estimator?: string | null; model?: string; provider?: string } = {}): SessionEvent {
  const base = manifest(contextId)
  const { estimator = TOKEN_ESTIMATOR, usedTokens = 100_000, model = 'scripted', provider = 'scripted' } = over
  return row(seq, { type: 'context/manifest', turnId: 't', manifest: { ...base, model, provider, budget: { ...base.budget, usedTokens, ...(estimator !== null ? { estimator } : {}) } } })
}
const usage = (inputTokens: number) => ({ inputTokens })
const target = { model: 'scripted', provider: 'scripted' }
const success = (seq: number, over: Record<string, unknown> = {}): SessionEvent => row(seq, { type: 'compaction/end', trigger: 'manual', coversSeq: 1, summaryChars: 5, durationMs: 1, summary: 'S', ...over })

describe('latestCalibration (AC-2)', () => {
  it('returns the newest valid attempt paired with its manifest estimate', () => {
    const events = [manifestRow(1, 'c1', { usedTokens: 10_000 }), attempt(2, 'c1', 'a1', usage(17_800)), manifestRow(3, 'c2', { usedTokens: 20_000 }), attempt(4, 'c2', 'a2', usage(35_600))]
    expect(latestCalibration(events, target)).toEqual({ contextId: 'c2', reportedInputTokens: 35_600, estimatedTokens: 20_000 })
  })

  it('accepts uncertain and reconciled attempts, not a start fact', () => {
    expect(latestCalibration([manifestRow(1, 'c1'), attempt(2, 'c1', 'a1', usage(500), 'uncertain')], target)?.reportedInputTokens).toBe(500)
    expect(latestCalibration([manifestRow(1, 'c1'), attempt(2, 'c1', 'a1', usage(600), 'reconciled')], target)?.reportedInputTokens).toBe(600)
    const start = row(2, { type: 'model/attempt', fact: { contextId: 'c1', state: 'start', usage: usage(700) } })
    expect(latestCalibration([manifestRow(1, 'c1'), start], target)).toBeUndefined()
  })

  it('skips attempts without usable usage, without a manifest, with a foreign estimator or a tiny base, and keeps scanning', () => {
    const good = [manifestRow(1, 'good', { usedTokens: 7_000 }), attempt(2, 'good', 'a0', usage(9_000))]
    const noUsage = row(4, { type: 'model/attempt', fact: { contextId: 'c-nousage', attemptId: 'a', state: 'end' } })
    const zero = attempt(6, 'c-zero', 'a', usage(0))
    const noManifest = attempt(7, 'c-orphan', 'a', usage(8_000))
    const legacy = [manifestRow(8, 'c-legacy', { estimator: null }), attempt(9, 'c-legacy', 'a', usage(8_000))]
    const otherEstimator = [manifestRow(10, 'c-est', { estimator: 'c4' }), attempt(11, 'c-est', 'a', usage(8_000))]
    const tiny = [manifestRow(12, 'c-tiny', { usedTokens: 999 }), attempt(13, 'c-tiny', 'a', usage(8_000))]
    const events = [...good, manifestRow(3, 'c-nousage'), noUsage, manifestRow(5, 'c-zero'), zero, noManifest, ...legacy, ...otherEstimator, ...tiny]
    expect(latestCalibration(events, target)).toEqual({ contextId: 'good', reportedInputTokens: 9_000, estimatedTokens: 7_000 })
  })

  it('stops at a measurement of another model or provider instead of reaching back to an older one', () => {
    const old = [manifestRow(1, 'mine', { usedTokens: 7_000 }), attempt(2, 'mine', 'a0', usage(9_000))]
    expect(latestCalibration([...old, manifestRow(3, 'c-model', { model: 'other' }), attempt(4, 'c-model', 'a', usage(8_000))], target)).toBeUndefined()
    expect(latestCalibration([...old, manifestRow(3, 'c-prov', { provider: 'other' }), attempt(4, 'c-prov', 'a', usage(8_000))], target)).toBeUndefined()
    // A foreign measurement stops the search even when it could not calibrate itself (legacy estimator).
    expect(latestCalibration([...old, manifestRow(3, 'c-legacy', { model: 'other', estimator: null }), attempt(4, 'c-legacy', 'a', usage(8_000))], target)).toBeUndefined()
    // Unknown target pair: any measurement calibrates.
    expect(latestCalibration([...old, manifestRow(3, 'c-model', { model: 'other' }), attempt(4, 'c-model', 'a', usage(8_000))], {})?.contextId).toBe('c-model')
  })

  it('calibrationRatio is reported/estimated, clamped', () => {
    expect(calibrationRatio(calibrationOf(178_000, 100_000))).toBeCloseTo(1.78)
    expect(calibrationRatio(calibrationOf(1, 100_000))).toBe(MIN_CALIBRATION_RATIO)
    expect(calibrationRatio(calibrationOf(900_000, 100_000))).toBe(MAX_CALIBRATION_RATIO)
  })

  it('returns undefined after a successful compaction, but not after a failed or unchanged one', () => {
    const measured = [manifestRow(1, 'c1'), attempt(2, 'c1', 'a1', usage(150_000))]
    expect(latestCalibration([...measured, success(3)], target)).toBeUndefined()
    expect(latestCalibration([...measured, success(3, { contextEffect: 'replaced' })], target)).toBeUndefined()
    expect(latestCalibration([...measured, success(3, { error: 'boom' })], target)?.contextId).toBe('c1')
    expect(latestCalibration([...measured, success(3, { summary: '  ' })], target)?.contextId).toBe('c1')
    expect(latestCalibration([...measured, success(3, { contextEffect: 'unchanged' })], target)?.contextId).toBe('c1')
    // A measurement taken after the compaction calibrates again.
    expect(latestCalibration([...measured, success(3), manifestRow(4, 'c2'), attempt(5, 'c2', 'a2', usage(40_000))], target)?.contextId).toBe('c2')
  })
})

const MODE = { definition: BUNDLED_MODES.find((mode) => mode.id === DEFAULT_MODE_ID)!, source: 'bundled' as const }
const inputOf = (events: readonly SessionEvent[], over: Partial<BuildContextInput> = {}): BuildContextInput => ({
  events, mode: MODE, modeRevision: 1, model: 'scripted', providerName: 'scripted', schemas: [], activeSkills: [], pinnedMemory: [], budget: DEFAULT_BUDGET, ...over,
})
const calibrationOf = (reportedInputTokens: number, estimatedTokens: number): ContextCalibration => ({ contextId: 'base', reportedInputTokens, estimatedTokens })

/** `count` completed turns of `size` chars each, then an open turn. */
function turns(count: number, size: number): SessionEvent[] {
  const payloads: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    payloads.push({ type: 'turn/start', turnId: `t${i}` }, { type: 'user/message', turnId: `t${i}`, content: `q${i}` })
    payloads.push({ type: 'assistant/message', stepId: `s${i}`, content: 'x'.repeat(size) }, { type: 'turn/end', turnId: `t${i}`, reason: 'completed' })
  }
  payloads.push({ type: 'turn/start', turnId: 'open' }, { type: 'user/message', turnId: 'open', content: 'now' })
  return payloads.map((payload, index) => row(index + 1, payload))
}

/** One open turn: a brief, then `count` Read steps of `size` chars each. */
function longRun(count: number, size: number): SessionEvent[] {
  const rows: SessionEvent[] = [row(1, { type: 'turn/start', turnId: 't' }), row(2, { type: 'user/message', turnId: 't', content: 'brief' })]
  for (let i = 0; i < count; i++) {
    rows.push(row(rows.length + 1, { type: 'assistant/message', stepId: `s${i}`, content: '', toolCalls: [{ id: `c${i}`, name: 'Read', args: { path: `f${i}` } }] }))
    rows.push(row(rows.length + 1, { type: 'tool/result', stepId: `s${i}`, callId: `c${i}`, ok: true, output: `${i}:`.padEnd(size, 'x') }))
  }
  rows.push(row(rows.length + 1, { type: 'assistant/message', stepId: 'last', content: 'thinking' }))
  return rows
}

describe('buildContext calibration (AC-3, AC-4)', () => {
  it('without calibration the manifest is a pure estimate (AC-3 baseline)', () => {
    const { budget } = builder.buildContext(inputOf(turns(1, 300))).manifest
    expect(budget.estimator).toBe(TOKEN_ESTIMATOR)
    expect(budget.measured).toEqual({ source: 'estimate', tokens: budget.usedTokens, preTrimTokens: budget.preTrimTokens })
  })

  it('a 1.78 provider ratio scales the next request by that ratio', () => {
    const events = turns(1, 300)
    const pure = builder.buildContext(inputOf(events)).manifest.budget
    const calibrated = builder.buildContext(inputOf(events, { calibration: calibrationOf(178_000, 100_000) })).manifest.budget
    expect(calibrated.measured).toEqual({ source: 'provider_usage', tokens: Math.ceil(pure.usedTokens * 1.78), preTrimTokens: Math.ceil(pure.preTrimTokens! * 1.78), baseContextId: 'base', ratio: 1.78 })
    // usedTokens and the breakdown stay pure estimates.
    expect(calibrated.usedTokens).toBe(pure.usedTokens)
    expect(calibrated.preTrimTokens).toBe(pure.preTrimTokens)
  })

  it('never loosens below the estimate: a ratio under 1 clamps to 1', () => {
    const { budget } = builder.buildContext(inputOf(turns(1, 300), { calibration: calibrationOf(1, 1_000_000) })).manifest
    expect(budget.measured).toMatchObject({ source: 'provider_usage', tokens: Math.ceil(budget.usedTokens * MIN_CALIBRATION_RATIO), ratio: MIN_CALIBRATION_RATIO })
  })

  it('a ratio that pushes the request over the microcompact line clears old tool results the pure estimate would keep', () => {
    const events = longRun(7, 4_000)
    const limit = { ...DEFAULT_BUDGET, contextLimitTokens: 30_000, outputReserveTokens: 512, marginTokens: 256 }
    const pure = builder.buildContext(inputOf(events, { budget: limit }))
    expect(pure.manifest.budget.usedTokens).toBeLessThan(pure.manifest.budget.availableTokens * builder.MICROCOMPACT_PRESSURE)
    expect(pure.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(false)
    const calibrated = builder.buildContext(inputOf(events, { budget: limit, calibration: calibrationOf(25_000, 10_000) }))
    expect(calibrated.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(true)
    expect(calibrated.messages.filter((message) => message.content === builder.CLEARED_TOOL_RESULT)).toHaveLength(7 - builder.MICROCOMPACT_KEEP_RECENT)
  })

  // Review C1: an absolute offset taken from a microcompacted request shrank, so the next step
  // skipped microcompaction and sent everything, alternating every step. A ratio does not.
  it('microcompaction holds from step to step once the ratio calls for it', () => {
    const limit = { ...DEFAULT_BUDGET, contextLimitTokens: 30_000, outputReserveTokens: 512, marginTokens: 256 }
    const first = builder.buildContext(inputOf(longRun(7, 4_000), { budget: limit, calibration: calibrationOf(25_000, 10_000) }))
    expect(first.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(true)
    // The provider measures the trimmed request at the same 2.5× ratio; the next step adds one result.
    const measured = calibrationOf(Math.ceil(first.manifest.budget.usedTokens * 2.5), first.manifest.budget.usedTokens)
    const next = builder.buildContext(inputOf(longRun(8, 4_000), { budget: limit, calibration: measured }))
    expect(next.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(true)
  })

  it('microcompact weighs its savings at the calibrated size, like the pressure that triggered it', () => {
    const events = longRun(builder.MICROCOMPACT_KEEP_RECENT + 1, 600) // one clearable result, ~170 estimated tokens
    const used = builder.buildContext(inputOf(events)).manifest.budget.usedTokens
    const limitFor = (available: number) => ({ ...DEFAULT_BUDGET, contextLimitTokens: Math.ceil(available) + DEFAULT_BUDGET.outputReserveTokens + DEFAULT_BUDGET.marginTokens })
    const cleared = (built: ReturnType<typeof builder.buildContext>) => built.manifest.omissions.some((line) => line.startsWith('tool-results:'))
    // Under pressure (used ≈ 0.9 × available) but the pure saving is below the minimum: kept.
    expect(cleared(builder.buildContext(inputOf(events, { budget: limitFor(used / 0.9) })))).toBe(false)
    // The same request at a 2.5× ratio: the same clear frees 2.5× the tokens, over the minimum.
    expect(cleared(builder.buildContext(inputOf(events, { budget: limitFor(used * 2.5 / 0.9), calibration: calibrationOf(25_000, 10_000) })))).toBe(true)
  })

  // Review I1: squeeze shrinks the window; a ratio shrinks with it, an absolute offset could exceed it outright.
  it('a squeezed retry still assembles under a large ratio', () => {
    const events = turns(4, 3_000)
    const built = builder.buildContext(inputOf(events, { squeeze: 3, calibration: calibrationOf(285_000, 160_000) }))
    expect(built.manifest.budget.measured?.source).toBe('provider_usage')
  })

  it('a ratio that pushes the request over budget drops the oldest completed turn', () => {
    const events = turns(3, 3_000)
    const pure = builder.buildContext(inputOf(events)).manifest.budget
    const budget = { ...DEFAULT_BUDGET, contextLimitTokens: pure.usedTokens + 500 + 4_096 + 1_024 }
    const fits = builder.buildContext(inputOf(events, { budget }))
    expect(fits.manifest.omissions.some((line) => line.startsWith('history:'))).toBe(false)
    const trimmed = builder.buildContext(inputOf(events, { budget, calibration: calibrationOf(pure.usedTokens * 2, pure.usedTokens) }))
    expect(trimmed.manifest.omissions.some((line) => line.startsWith('history: dropped oldest'))).toBe(true)
    expect(trimmed.manifest.history.omittedTurns).toBeGreaterThan(0)
  })

  it('ContextBudgetError reports the calibrated count', () => {
    // An open turn alone (nothing droppable) that only overflows once calibrated.
    const events = [row(1, { type: 'turn/start', turnId: 'open' }), row(2, { type: 'user/message', turnId: 'open', content: 'x'.repeat(30_000) })]
    const budget = { ...DEFAULT_BUDGET, contextLimitTokens: 20_000 }
    const used = builder.buildContext(inputOf(events, { budget })).manifest.budget.usedTokens
    const available = budget.contextLimitTokens - budget.outputReserveTokens - budget.marginTokens
    expect(used).toBeLessThan(available)
    let error: unknown
    try { builder.buildContext(inputOf(events, { budget, calibration: calibrationOf(200_000, 100_000) })) } catch (thrown) { error = thrown }
    expect(error).toBeInstanceOf(ContextBudgetError)
    expect((error as ContextBudgetError).neededTokens).toBe(used * 2)
    expect((error as ContextBudgetError).availableTokens).toBe(available)
  })
})

describe('buildContextPreview ignores calibration (AC-6)', () => {
  const closed = turns(2, 300).slice(0, -2) // two completed turns, no open one
  it('stays an estimate and identical to the uncalibrated preview', () => {
    const preview = { checkpoint: { summary: 'SUMMARY', coversSeq: 4 } }
    const plain = builder.buildContextPreview(inputOf(closed), preview).manifest.budget
    const calibrated = builder.buildContextPreview(inputOf(closed, { calibration: calibrationOf(900_000, 1_000) }), preview).manifest.budget
    expect(calibrated.measured?.source).toBe('estimate')
    expect(calibrated).toEqual(plain)
  })
})

describe('legacy manifests (AC-8)', () => {
  it('pressureTokensOf falls back from measured to preTrimTokens to usedTokens', () => {
    expect(pressureTokensOf({ usedTokens: 5 })).toBe(5)
    expect(pressureTokensOf({ usedTokens: 5, preTrimTokens: 9 })).toBe(9)
    expect(pressureTokensOf({ usedTokens: 5, preTrimTokens: 9, measured: { preTrimTokens: 40 } })).toBe(40)
    const legacy: ContextManifest = manifest('c')
    expect(pressureTokensOf(legacy.budget)).toBe(legacy.budget.usedTokens)
  })

  it('a manifest with no estimator/measured never calibrates', () => {
    expect(latestCalibration([manifestRow(1, 'c1', { estimator: null }), attempt(2, 'c1', 'a1', usage(9_000))], target)).toBeUndefined()
  })
})

describe('settledPressureTokens', () => {
  const budget = { usedTokens: 90_000, preTrimTokens: 100_000, measured: { preTrimTokens: 150_000 } }
  it("uses the request's own report when the provider already measured it", () => {
    const own = { contextId: 'last', reportedInputTokens: 178_000, estimatedTokens: 90_000 }
    expect(settledPressureTokens({ contextId: 'last', budget }, own)).toBe(Math.ceil(100_000 * (178_000 / 90_000)))
  })
  it('falls back to the assembled calibration otherwise', () => {
    expect(settledPressureTokens({ contextId: 'last', budget }, calibrationOf(178_000, 90_000))).toBe(150_000)
    expect(settledPressureTokens({ contextId: 'last', budget }, undefined)).toBe(150_000)
    expect(settledPressureTokens({ budget }, { contextId: 'last', reportedInputTokens: 178_000, estimatedTokens: 90_000 })).toBe(150_000)
  })
})
