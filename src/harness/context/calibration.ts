/**
 * Provider-calibrated context counting (ZCode parity). The provider's reported
 * input count for the latest request calibrates the chars/3 estimate as a
 * ratio, so budget decisions follow the provider's count. Browser-safe: no
 * Node imports.
 */
import type { TokenUsage } from '../llm/types.ts'
import { isValidContextId, isValidTokenUsage } from './context-metrics.ts'

/** Names the estimator a manifest's token counts came from; a ratio only pairs within one. */
export const TOKEN_ESTIMATOR = 'c3'

/** Estimate one string's token cost: chars/3 rounded up, CJK ideographs (U+4E00–U+9FFF) counted twice (ZCode's estimator, `c3`). */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0x4e00 && code <= 0x9fff) cjk++
  }
  return Math.ceil((text.length + cjk) / 3)
}

/** The latest request the provider measured, with the estimate the builder made for it. */
export interface ContextCalibration {
  readonly contextId: string
  readonly reportedInputTokens: number
  readonly estimatedTokens: number
}

/** Below this estimate a request's report says too little about the estimator's error to scale by. */
export const MIN_CALIBRATION_BASE_TOKENS = 1_000
/**
 * Bounds on the reported/estimated ratio. Calibration only ever tightens the
 * budget: a report below the estimate comes from a measurement that does not
 * transfer (flat image estimates, a gateway that leaves cached tokens out of
 * the prompt count), and loosening on it would send requests the provider
 * refuses. The upper bound keeps one wild report from swinging it further.
 */
export const MIN_CALIBRATION_RATIO = 1
export const MAX_CALIBRATION_RATIO = 3

/**
 * The estimator's error on the measured request, as a ratio. The error of a
 * chars/N estimate scales with the content, so a ratio — unlike an absolute
 * offset — stays right when the next request trims, drops or squeezes
 * differently from the measured one.
 */
export function calibrationRatio(calibration: ContextCalibration): number {
  const raw = calibration.reportedInputTokens / calibration.estimatedTokens
  return Math.min(Math.max(raw, MIN_CALIBRATION_RATIO), MAX_CALIBRATION_RATIO)
}

/** `tokens` of estimate, calibrated by `ratio`. */
export function calibrated(tokens: number, ratio: number): number {
  return ratio === 1 ? tokens : Math.ceil(tokens * ratio)
}

/** The slice of the session log calibration reads (structural, so the browser can share it). */
interface CalibrationEvent {
  readonly type: string
  readonly manifest?: { readonly contextId?: string; readonly model?: string; readonly provider?: string; readonly budget: { readonly usedTokens: number; readonly estimator?: string } }
  readonly fact?: { readonly state: string; readonly contextId?: string; readonly usage?: TokenUsage }
  readonly error?: string
  readonly summary?: string
  readonly contextEffect?: 'replaced' | 'unchanged'
}

const ATTEMPT_TYPES = new Set(['model/attempt', 'execution/uncertain', 'execution/reconciled'])

/**
 * The newest provider-measured request the next assembly may calibrate
 * against. A successful compaction after it replaces the history that report
 * measured, so nothing calibrates across one: the estimate stands until the
 * provider reports again. The same holds across a model or provider switch:
 * the newest measurement belongs to another tokenizer, and an older one of
 * this pair describes a context that has since moved on.
 */
export function latestCalibration(events: readonly CalibrationEvent[], target: { readonly model?: string | null | undefined; readonly provider?: string | null | undefined }): ContextCalibration | undefined {
  let manifests: Map<string, NonNullable<CalibrationEvent['manifest']>> | undefined
  const manifestOf = (contextId: string): CalibrationEvent['manifest'] => {
    if (manifests === undefined) {
      manifests = new Map()
      for (const event of events) {
        const id = event.type === 'context/manifest' ? event.manifest?.contextId : undefined
        if (id !== undefined && event.manifest !== undefined && !manifests.has(id)) manifests.set(id, event.manifest)
      }
    }
    return manifests.get(contextId)
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'compaction/end') {
      if (event.error === undefined && typeof event.summary === 'string' && event.summary.trim() !== '' && event.contextEffect !== 'unchanged') return undefined
      continue
    }
    if (!ATTEMPT_TYPES.has(event.type)) continue
    const fact = event.fact
    if (fact === undefined || fact.state === 'start' || !isValidContextId(fact.contextId) || !isValidTokenUsage(fact.usage) || fact.usage.inputTokens <= 0) continue
    const manifest = manifestOf(fact.contextId)
    if (manifest === undefined) continue
    if (target.model != null && manifest.model !== undefined && manifest.model !== target.model) return undefined
    if (target.provider != null && manifest.provider !== undefined && manifest.provider !== target.provider) return undefined
    if (manifest.budget.estimator !== TOKEN_ESTIMATOR || manifest.budget.usedTokens < MIN_CALIBRATION_BASE_TOKENS) continue
    return { contextId: fact.contextId, reportedInputTokens: fact.usage.inputTokens, estimatedTokens: manifest.budget.usedTokens }
  }
  return undefined
}

/** The budget fields pressure reads; legacy manifests lack `measured`. */
export interface PressureBudget {
  readonly usedTokens: number
  readonly preTrimTokens?: number
  readonly measured?: { readonly preTrimTokens: number }
}

/** Tokens the auto-compact and precompute policies compare with the input budget. */
export function pressureTokensOf(budget: PressureBudget): number {
  return budget.measured?.preTrimTokens ?? budget.preTrimTokens ?? budget.usedTokens
}

/**
 * Pressure after a turn settled. When the provider already measured this very
 * request, its own ratio replaces the one it was assembled under (which came
 * from the request before it).
 */
export function settledPressureTokens(
  manifest: { readonly contextId?: string; readonly budget: PressureBudget },
  latest: ContextCalibration | undefined,
): number {
  if (latest === undefined || manifest.contextId === undefined || latest.contextId !== manifest.contextId) return pressureTokensOf(manifest.budget)
  return calibrated(manifest.budget.preTrimTokens ?? manifest.budget.usedTokens, calibrationRatio(latest))
}
