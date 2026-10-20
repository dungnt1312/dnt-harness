// Type declarations for metrics.mjs (consumed by tests/scripts).
export type InputSemantics = 'inclusive' | 'non-cached'

export interface NormalizedMetrics {
  inputSemantics: InputSemantics | undefined
  steps: number | undefined
  toolCalls: number | undefined
  inputTokens: number | undefined
  outputTokens: number | undefined
  cachedTokens: number | undefined
  /** Inclusive semantics with cached > input: the cache figure is dropped. */
  cacheAnomaly: boolean
  inputInclusiveTokens: number | undefined
  totalTokens: number | undefined
  firstRequestInputTokens: number | undefined
}

export interface BenchRecord {
  rep: number
  wallMs: number
  verdict: { success: boolean }
  metrics?: Record<string, unknown> | null
  stderrTail?: string
}

export interface CellSummary {
  harness: string
  runs: number
  validRuns: number
  excluded: Array<{ rep: number; reason: string }>
  successRate: number | undefined
  inputSemantics: InputSemantics | 'mixed' | undefined
  stepsMedian: number | undefined
  toolCallsMedian: number | undefined
  wallSecondsMedian: number | undefined
  inputTokensMedian: number | undefined
  inputInclusiveTokensMedian: number | undefined
  outputTokensMedian: number | undefined
  cachedTokensMedian: number | undefined
  cachedTokensKnownRuns: number
  cacheAnomalyRuns: number
  totalTokensMedian: number | undefined
  firstRequestInputMedian: number | undefined
}

export const INPUT_SEMANTICS: readonly InputSemantics[]
export function measured(value: unknown): number | undefined
export function normalizeMetrics(raw: Record<string, unknown> | null | undefined, harness?: string): NormalizedMetrics
export function exclusionReason(record: { metrics?: Record<string, unknown> | null }): string | undefined
export function median(xs: ReadonlyArray<number | undefined>): number | undefined
export function summarizeCell(records: readonly BenchRecord[], harness: string): CellSummary
export function show(value: number | undefined, digits?: number): string
export function verifyReadAnswer(taskId: string, text: string): { ok: boolean; checks: Record<string, boolean> }
