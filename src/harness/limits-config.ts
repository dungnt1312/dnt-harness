import { isValidLimit, type HarnessLimits } from './limits.ts'
import { MAX_TIMER_MS } from './processes/shutdown.ts'

/**
 * The numeric limits: the ones the global configuration edits. The boolean
 * rollout switches stay host/embedding options (`limitDefaults`, `limits`).
 */
export type LimitKey = { readonly [K in keyof HarnessLimits]: HarnessLimits[K] extends number ? K : never }[keyof HarnessLimits]

/** A sparse set of numeric limit overrides: what the app-config file holds. */
export type LimitOverrides = Partial<Record<LimitKey, number>>

export interface LimitField {
  readonly key: LimitKey; readonly label: string; readonly hint: string
  readonly group: 'requests' | 'tools' | 'context' | 'admission'
  readonly unit: 'ms' | 'bytes' | 'chars' | 'tokens' | 'count' | 'ratio'
  readonly integer: boolean; readonly minimum: number; readonly exclusiveMinimum: boolean; readonly maximum: number
  readonly applies: 'next-operation'
}

/**
 * Component-owned presentation + validation metadata for every harness limit.
 * All values stay in their native units; nothing here converts for the UI.
 * Acceptance ranges mirror `isValidLimit` exactly: minimum 0 for every field,
 * `exclusiveMinimum` false only for the zero-capable keys, maximum
 * MAX_TIMER_MS (1 for the precompute pressure fraction) — accepted legacy
 * fractions are not excluded by a minimum of 1.
 */
export const LIMIT_FIELDS: readonly LimitField[] = [
  { key: 'streamFirstEventMs', label: 'Stream first event', hint: 'Kill a provider stream that delivers no first event within this window.', group: 'requests', unit: 'ms', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'streamIdleMs', label: 'Stream idle timeout', hint: 'Kill a provider stream that stays silent for this long mid-response.', group: 'requests', unit: 'ms', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'logicalRequestMs', label: 'Logical request deadline', hint: 'Whole request budget spanning reassembly, retries and all physical attempts.', group: 'requests', unit: 'ms', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'stepRetries', label: 'Step retries', hint: 'Extra attempts for one transiently failed request; current consumer clamps total attempts to 4 (at most 3 extra).', group: 'requests', unit: 'count', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'stepRetryBaseMs', label: 'Step retry base delay', hint: 'Base delay of the exponential backoff between retry attempts.', group: 'requests', unit: 'ms', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'delegationJoinMs', label: 'Delegation join wait', hint: 'Longest a root turn waits for delegated children after the model stops calling tools.', group: 'requests', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'toolTimeoutMs', label: 'Tool timeout', hint: 'Default foreground wait before eligible Bash commands auto-background.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'bashMaxWaitMs', label: 'Bash max wait', hint: 'Upper bound clamping an explicit Bash timeoutMs argument.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'subagentBackgroundBashMaxMs', label: 'Subagent background Bash max', hint: 'Runtime ceiling for Bash processes a subagent commits to background.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'approvalExpiryMs', label: 'Approval expiry', hint: 'Undecided approval requests expire and never approve implicitly; 0 waits until answered, denied or the turn stops.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: false, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'questionExpiryMs', label: 'Question expiry', hint: 'Unanswered AskUserQuestion prompts expire; the model is told the user did not answer.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'readOnlyToolConcurrency', label: 'Read-only tool concurrency', hint: 'Most read-only tool calls (Read/Grep/Glob) of one batch running at once.', group: 'tools', unit: 'count', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'toolOutputLimit', label: 'Tool output limit', hint: 'Model-visible cap for one tool result, in characters; longer output is sliced today.', group: 'context', unit: 'chars', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'maxPendingInputs', label: 'Max pending inputs', hint: 'Bound on durably queued pending inputs per session; new inputs beyond it are rejected.', group: 'admission', unit: 'count', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'automaticCompactionPressure', label: 'Automatic compaction pressure', hint: 'Context pressure that triggers automatic compaction at a completed boundary; 0 disables.', group: 'context', unit: 'ratio', integer: false, minimum: 0, exclusiveMinimum: false, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'compactionRetainTokens', label: 'Compaction retained tokens', hint: 'Estimated-token cap on covered messages kept verbatim beside the compaction summary; 0 keeps none.', group: 'context', unit: 'tokens', integer: true, minimum: 0, exclusiveMinimum: false, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'compactionPrecomputePressure', label: 'Background compaction pressure', hint: 'Fraction of the usable request budget at which a background compaction summary starts (when precompute is enabled by the host).', group: 'context', unit: 'ratio', integer: false, minimum: 0, exclusiveMinimum: true, maximum: 1, applies: 'next-operation' },
  { key: 'compactionDeadlineMs', label: 'Compaction deadline', hint: 'One deadline for a whole compaction summary: queue, transport, backoff and re-ask.', group: 'context', unit: 'ms', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'compactionOutputTokens', label: 'Compaction output tokens', hint: 'Output-token budget asked for a compaction summary; the summary character cap stays authoritative.', group: 'context', unit: 'tokens', integer: true, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'compactionCandidateWaitMs', label: 'Compaction candidate wait', hint: 'How long an explicit compaction waits for a pending background summary before taking over; 0 never waits.', group: 'context', unit: 'ms', integer: true, minimum: 0, exclusiveMinimum: false, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'maxAttachmentBytes', label: 'Max attachment bytes', hint: 'Largest single composer attachment accepted for storage.', group: 'admission', unit: 'bytes', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'maxAttachmentsPerMessage', label: 'Max attachments per message', hint: 'Attachments a single message may carry.', group: 'admission', unit: 'count', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'attachmentTextLimit', label: 'Attachment text limit', hint: 'Model-visible cap for one inlined text attachment; stored bytes are sliced by this byte count today.', group: 'context', unit: 'bytes', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
]

/**
 * Host profile defaults the shipped web bin boots with, layered under the
 * app-config file (the file overrides them, nothing is locked). Embedded hosts
 * keep the library defaults.
 * - Automatic compaction runs at 85% of the usable budget (library default 0, disabled).
 * - Compaction asks the model once over the request it last saw instead of folding the whole transcript
 *   in many sequential calls. Background precompute stays off until it has a live measurement.
 * - An approval request waits until it is answered, denied or the turn stops; it never expires on its own.
 */
export const WEB_LIMIT_DEFAULTS: Readonly<Partial<HarnessLimits>> = Object.freeze({
  automaticCompactionPressure: 0.85,
  compactionEffectiveEnabled: true,
  approvalExpiryMs: 0,
})

/** True for JSON-style plain objects (Object or null prototype), never arrays. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

const LIMIT_FIELDS_BY_KEY = new Map(LIMIT_FIELDS.map(f => [f.key, f]))

/**
 * Strict parser for durable/operator-supplied override objects: accepts only
 * plain objects holding known limit keys with `isValidLimit`-valid numbers,
 * and rejects the whole object otherwise. Returns a detached sparse
 * `Partial<HarnessLimits>` — missing keys mean "inherit", never a default fill.
 */
export function parseLimitOverrides(input: unknown): LimitOverrides {
  if (!isPlainObject(input)) throw new Error('limits overrides must be a plain object')
  // HarnessLimits properties are readonly; the accumulator is a fresh detached
  // object the caller owns, so writes go through a mutable view of the same shape.
  const overrides: { -readonly [K in LimitKey]?: number } = {}
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey as LimitKey
    if (!LIMIT_FIELDS_BY_KEY.has(key)) throw new Error(`unknown limit key: ${rawKey}`)
    if (!isValidLimit(key, value)) throw new Error(`invalid value for limit ${rawKey}`)
    // `-0 === 0`: store a plain 0 so values, canonical bytes and hashes agree.
    overrides[key] = value === 0 ? 0 : value
  }
  return overrides
}
