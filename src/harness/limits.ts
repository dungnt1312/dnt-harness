/**
 * Centralized bounded-execution defaults. Every limit the harness enforces
 * lives here so operators (and tests) override one shape; nothing scatters
 * magic numbers through the loop.
 */
export interface HarnessLimits {
  /** @deprecated Ignored. Turns no longer have a model-step budget. */
  readonly maxSteps?: number
  /** @deprecated Ignored. Turns no longer have a wall-clock deadline. */
  readonly turnDeadlineMs?: number
  /**
   * Kill a provider stream that never delivers its first event within this
   * window. Generous by design: extended thinking can run minutes before the
   * first visible event when a gateway does not stream reasoning deltas, and
   * upstream providers cap streamed requests near ten minutes.
   */
  readonly streamFirstEventMs: number
  /** Kill a provider stream silent this long between events, once output started. */
  readonly streamInactivityMs: number
  /** Default wall-clock kill for one bash command. */
  readonly toolTimeoutMs: number
  /** Undecided approval requests expire (never approve implicitly). */
  readonly approvalExpiryMs: number
  /** Model-visible cap for one tool result. */
  readonly toolOutputLimit: number
  /** Bound on durably queued pending inputs per session. */
  readonly maxPendingInputs: number
  /**
   * Context pressure (usedTokens/availableTokens from the session's newest
   * context manifest) that triggers automatic compaction at a completed
   * boundary; 0 disables. Token-accurate: it reads the same budget numbers
   * the manifest inspector shows, not a character projection.
   */
  readonly automaticCompactionPressure: number
  /** Completed turns kept in context after the newest compaction checkpoint. */
  readonly compactionTailTurns: number
  /** Largest single composer attachment accepted for storage. */
  readonly maxAttachmentBytes: number
  /** Attachments one message may carry. */
  readonly maxAttachmentsPerMessage: number
  /** Model-visible cap for one inlined text attachment. */
  readonly attachmentTextLimit: number
}

export const DEFAULT_LIMITS: HarnessLimits = {
  streamFirstEventMs: 600_000,
  streamInactivityMs: 120_000,
  toolTimeoutMs: 30_000,
  approvalExpiryMs: 5 * 60_000,
  toolOutputLimit: 60_000,
  maxPendingInputs: 100,
  automaticCompactionPressure: 0,
  compactionTailTurns: 4,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentsPerMessage: 10,
  attachmentTextLimit: 60_000,
}

/** Merge a partial override over the defaults; non-positive values are ignored. */
export function resolveLimits(partial?: Partial<HarnessLimits>): HarnessLimits {
  if (partial === undefined) return DEFAULT_LIMITS
  const merged = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(merged) as (keyof HarnessLimits)[]) {
    const value = partial[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      merged[key] = value
    }
  }
  return merged
}
