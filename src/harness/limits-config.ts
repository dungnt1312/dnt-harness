import { isValidLimit, type HarnessLimits } from './limits.ts'
import { MAX_TIMER_MS } from './processes/shutdown.ts'

export type LimitKey = keyof HarnessLimits

export interface LimitField {
  readonly key: LimitKey; readonly label: string; readonly hint: string
  readonly group: 'requests' | 'tools' | 'context' | 'admission'
  readonly unit: 'ms' | 'bytes' | 'chars' | 'count' | 'ratio'
  readonly integer: boolean; readonly minimum: number; readonly exclusiveMinimum: boolean; readonly maximum: number
  readonly applies: 'next-operation'
}

/**
 * Component-owned presentation + validation metadata for every harness limit.
 * All values stay in their native units; nothing here converts for the UI.
 * Acceptance ranges mirror `isValidLimit` exactly: minimum 0 for every field,
 * `exclusiveMinimum` false only for the two off-switch keys, maximum
 * MAX_TIMER_MS — accepted legacy fractions are not excluded by a minimum of 1.
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
  { key: 'approvalExpiryMs', label: 'Approval expiry', hint: 'Undecided approval requests expire and never approve implicitly.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'questionExpiryMs', label: 'Question expiry', hint: 'Unanswered AskUserQuestion prompts expire; the model is told the user did not answer.', group: 'tools', unit: 'ms', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'toolOutputLimit', label: 'Tool output limit', hint: 'Model-visible cap for one tool result, in characters; longer output is sliced today.', group: 'context', unit: 'chars', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'maxPendingInputs', label: 'Max pending inputs', hint: 'Bound on durably queued pending inputs per session; new inputs beyond it are rejected.', group: 'admission', unit: 'count', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'automaticCompactionPressure', label: 'Automatic compaction pressure', hint: 'Context pressure that triggers automatic compaction at a completed boundary; 0 disables.', group: 'context', unit: 'ratio', integer: false, minimum: 0, exclusiveMinimum: false, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'compactionTailTurns', label: 'Compaction tail turns', hint: 'Completed turns duplicated raw beside the compaction summary; 0 keeps none.', group: 'context', unit: 'count', integer: true, minimum: 0, exclusiveMinimum: false, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'maxAttachmentBytes', label: 'Max attachment bytes', hint: 'Largest single composer attachment accepted for storage.', group: 'admission', unit: 'bytes', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'maxAttachmentsPerMessage', label: 'Max attachments per message', hint: 'Attachments a single message may carry.', group: 'admission', unit: 'count', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
  { key: 'attachmentTextLimit', label: 'Attachment text limit', hint: 'Model-visible cap for one inlined text attachment; stored bytes are sliced by this byte count today.', group: 'context', unit: 'bytes', integer: false, minimum: 0, exclusiveMinimum: true, maximum: MAX_TIMER_MS, applies: 'next-operation' },
]

/** Web-host-only limit defaults: automatic compaction at 0.85 pressure; the library default stays 0 (disabled). */
export const WEB_LIMIT_DEFAULTS: Readonly<Partial<HarnessLimits>> = Object.freeze({ automaticCompactionPressure: 0.85 })

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
export function parseLimitOverrides(input: unknown): Partial<HarnessLimits> {
  if (!isPlainObject(input)) throw new Error('limits overrides must be a plain object')
  // HarnessLimits properties are readonly; the accumulator is a fresh detached
  // object the caller owns, so writes go through a mutable view of the same shape.
  const overrides = {} as { -readonly [K in LimitKey]?: number }
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey as LimitKey
    if (!LIMIT_FIELDS_BY_KEY.has(key)) throw new Error(`unknown limit key: ${rawKey}`)
    if (!isValidLimit(key, value)) throw new Error(`invalid value for limit ${rawKey}`)
    // `-0 === 0`: store a plain 0 so values, canonical bytes and hashes agree.
    overrides[key] = value === 0 ? 0 : value
  }
  return overrides as Partial<HarnessLimits>
}
