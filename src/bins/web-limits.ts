import type { HarnessLimits } from '../harness/limits.ts'

/**
 * Limits the shipped web bin boots with. Embedded hosts keep the library defaults; only this bin opts in.
 * - Automatic compaction runs at 85% of the usable budget.
 * - Compaction asks the model once over the request it last saw instead of folding the whole transcript
 *   in many sequential calls. Background precompute stays off until it has a live measurement.
 * - An approval request waits until it is answered, denied or the turn stops; it never expires on its own.
 */
export const WEB_BIN_LIMITS: Partial<HarnessLimits> = {
  automaticCompactionPressure: 0.85,
  compactionEffectiveEnabled: true,
  approvalExpiryMs: 0,
}
