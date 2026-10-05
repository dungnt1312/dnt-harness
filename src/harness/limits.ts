import { MAX_TIMER_MS } from './processes/shutdown.ts'
/**
 * Centralized bounded-execution defaults. Every limit the harness enforces
 * lives here so operators (and tests) override one shape; nothing scatters
 * magic numbers through the loop.
 */
export interface HarnessLimits {
  /**
   * Kill a provider stream that never delivers its first event within this
   * window. Generous by design: extended thinking can run minutes before the
   * first visible event when a gateway does not stream reasoning deltas, and
   * upstream providers cap streamed requests near ten minutes.
   */
  readonly streamFirstEventMs: number
  readonly streamIdleMs: number
  readonly logicalRequestMs: number
  /**
   * Extra attempts for one model request that failed transiently before any
   * output was produced (see `ProviderError.transient`). A run of dozens of
   * requests — a subagent — otherwise dies on the first hiccup.
   */
  readonly stepRetries: number
  /** Base delay of the exponential backoff between those attempts. */
  readonly stepRetryBaseMs: number
  /**
   * Longest a root turn waits, after the model stops calling tools, for the
   * children it delegated and left running. Past it they are cancelled and
   * report what they got done. A user stop ends the wait at once.
   */
  readonly delegationJoinMs: number
  /** Default foreground wait before eligible Bash commands auto-background. */
  readonly toolTimeoutMs: number
  readonly bashMaxWaitMs: number
  readonly subagentBackgroundBashMaxMs: number
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
  streamIdleMs: 300_000,
  logicalRequestMs: 1_800_000,
  stepRetries: 3,
  stepRetryBaseMs: 1_000,
  delegationJoinMs: 30 * 60_000,
  toolTimeoutMs: 120_000,
  bashMaxWaitMs: 600_000,
  subagentBackgroundBashMaxMs: 3_600_000,
  approvalExpiryMs: 5 * 60_000,
  toolOutputLimit: 60_000,
  maxPendingInputs: 100,
  automaticCompactionPressure: 0,
  compactionTailTurns: 4,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentsPerMessage: 10,
  attachmentTextLimit: 60_000,
}

/** Merge overrides; invalid request durations/counts (including fractions) use defaults. */
export function resolveLimits(partial?: Partial<HarnessLimits>): HarnessLimits {
  if (partial === undefined) return DEFAULT_LIMITS
  const merged = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(merged) as (keyof HarnessLimits)[]) {
    const value = partial[key]
    const integerRequestLimit = ['streamFirstEventMs', 'streamIdleMs', 'logicalRequestMs', 'stepRetries', 'stepRetryBaseMs'].includes(key)
    if (typeof value === 'number' && Number.isFinite(value) && (!integerRequestLimit || Number.isSafeInteger(value)) && value > 0 && value <= MAX_TIMER_MS) {
      merged[key] = value
    }
  }
  return merged
}
