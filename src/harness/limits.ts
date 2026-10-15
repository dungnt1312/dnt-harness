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
  /**
   * Undecided approval requests expire (never approve implicitly); 0 waits
   * forever — the ask stays open until answered, denied, or the turn stops.
   */
  readonly approvalExpiryMs: number
  /** Unanswered AskUserQuestion prompts expire (the model is told the user did not answer). */
  readonly questionExpiryMs: number
  /** Model-visible cap for one tool result. */
  readonly toolOutputLimit: number
  /** Most read-only tool calls (Read/Grep/Glob) of one batch running at once. */
  readonly readOnlyToolConcurrency: number
  /** Bound on durably queued pending inputs per session. */
  readonly maxPendingInputs: number
  /**
   * Estimated pre-trim context pressure (preTrimTokens/availableTokens from
   * the settled turn's fresh context manifest) that triggers automatic
   * compaction at a completed boundary; 0 disables.
   */
  readonly automaticCompactionPressure: number
  /**
   * Estimated-token cap on covered messages kept verbatim beside the summary
   * (typed user messages plus the latest covered final answer, newest first);
   * 0 keeps none. Uncovered history remains eligible for budget trimming.
   */
  readonly compactionRetainTokens: number
  /** Largest single composer attachment accepted for storage. */
  readonly maxAttachmentBytes: number
  /** Attachments one message may carry. */
  readonly maxAttachmentsPerMessage: number
  /** Model-visible cap for one inlined text attachment. */
  readonly attachmentTextLimit: number
  /**
   * Rollout switch: compact the effective context (one structured summary)
   * instead of folding the raw transcript. Off keeps the legacy path.
   */
  readonly compactionEffectiveEnabled: boolean
  /** Rollout switch: summarize in the background and adopt the result later. Needs the effective path. */
  readonly compactionPrecomputeEnabled: boolean
  /** Fraction of the USABLE request budget at which background compaction starts (0 < x ≤ 1). */
  readonly compactionPrecomputePressure: number
  /** One deadline for a whole compaction summary operation: queue, transport, backoff, re-ask. */
  readonly compactionDeadlineMs: number
  /** Output-token budget asked for a compaction summary; the 24k-character cap stays authoritative. */
  readonly compactionOutputTokens: number
  /** How long an explicit compaction waits for a pending background summary before taking over; 0 never waits. */
  readonly compactionCandidateWaitMs: number
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
  questionExpiryMs: 30 * 60_000,
  toolOutputLimit: 60_000,
  readOnlyToolConcurrency: 10,
  maxPendingInputs: 100,
  automaticCompactionPressure: 0,
  compactionRetainTokens: 20_000,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentsPerMessage: 10,
  attachmentTextLimit: 60_000,
  compactionEffectiveEnabled: false,
  compactionPrecomputeEnabled: false,
  compactionPrecomputePressure: 0.65,
  compactionDeadlineMs: 180_000,
  compactionOutputTokens: 8_000,
  compactionCandidateWaitMs: 15_000,
}

const BOOLEAN_LIMITS: ReadonlySet<keyof HarnessLimits> = new Set(['compactionEffectiveEnabled', 'compactionPrecomputeEnabled'])
const INTEGER_LIMITS: ReadonlySet<string> = new Set([
  'streamFirstEventMs', 'streamIdleMs', 'logicalRequestMs', 'stepRetries', 'stepRetryBaseMs', 'compactionRetainTokens', 'readOnlyToolConcurrency',
  'compactionDeadlineMs', 'compactionOutputTokens', 'compactionCandidateWaitMs',
])
const ZERO_CAPABLE_LIMITS: ReadonlySet<string> = new Set(['compactionRetainTokens', 'automaticCompactionPressure', 'compactionCandidateWaitMs', 'approvalExpiryMs'])

/** Merge overrides; invalid request durations/counts (including fractions) use defaults. */
export function resolveLimits(partial?: Partial<HarnessLimits>): HarnessLimits {
  if (partial === undefined) return DEFAULT_LIMITS
  const merged: Record<string, number | boolean> = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof HarnessLimits)[]) {
    const value = partial[key]
    if (BOOLEAN_LIMITS.has(key)) {
      if (typeof value === 'boolean') merged[key] = value
      continue
    }
    if (key === 'compactionPrecomputePressure') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1) merged[key] = value
      continue
    }
    const zeroCapable = ZERO_CAPABLE_LIMITS.has(key)
    if (typeof value === 'number' && Number.isFinite(value) && (!INTEGER_LIMITS.has(key) || Number.isSafeInteger(value)) && (zeroCapable ? value >= 0 : value > 0) && value <= MAX_TIMER_MS) {
      merged[key] = value
    }
  }
  return merged as unknown as HarnessLimits
}
