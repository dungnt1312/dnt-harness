/**
 * Reasoning round-trip policy, provider-agnostic. Modelled on opencode's
 * OpenAI-chat lowering (packages/ai/src/protocols/openai-chat.ts): record the
 * reasoning any provider streams together with the wire field it arrived
 * under, and send it back on later assistant messages under that same field.
 * Configuration only overrides what the stream already tells us. Pure: no I/O.
 *
 * Interleaved-thinking endpoints (DeepSeek, Kimi, GLM, MiniMax, Groq,
 * OpenRouter, …) want the reasoning of earlier assistant turns back. A
 * session that only ever talked to an endpoint without reasoning sends no
 * reasoning field; after a model switch the readable text crosses over under
 * `reasoning_content` (as in opencode). `replayReasoning: false` opts out.
 */
import { createHash } from 'node:crypto'
import type { ModelMessage, ReasoningPayload } from './types.ts'

/** Scalar delta keys providers stream thinking under, in lookup order (after a configured field). */
export const REASONING_FIELDS: readonly string[] = ['reasoning_content', 'reasoning', 'reasoning_text']

/** Field a replayed message uses when neither configuration nor the stream named one. */
const DEFAULT_REASONING_FIELD = 'reasoning_content'

/**
 * Operator overrides (opencode `compatibility`). Both optional: the stream
 * decides the field, and {@link defaultRequireReasoning} decides whether a
 * message without reasoning still carries an empty one.
 */
export interface ReasoningCompatibility {
  /** Wire field reasoning is read from first and written to on every assistant message. */
  readonly reasoningField?: string
  /** Send the field on every assistant message, `""` when none was recorded. */
  readonly requireReasoning?: boolean
  /**
   * dnt escape hatch (default true): `false` never sends recorded reasoning
   * back, for endpoints that stream it but refuse it as input.
   */
  readonly replayReasoning?: boolean
}

/**
 * Keys a reasoning field may never be: message keys it would overwrite, wire
 * keys of the delta/choice it is read from, and prototype-polluting names.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'role', 'content', 'tool_calls', 'name', 'tool_call_id', 'function_call', 'refusal', 'audio',
  'prefix', 'type', 'id', 'index', 'function', 'finish_reason', 'delta', 'cache_control',
  // Structured (array) reasoning, not a text field; not supported as one.
  'reasoning_details',
  '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
])
/** Plain identifier, no leading underscore (no dunder names). */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** A field name safe to read from a delta and write onto a wire message. */
export function isReasoningField(value: unknown): value is string {
  return typeof value === 'string' && FIELD_NAME.test(value) && !RESERVED_FIELDS.has(value)
}

/**
 * Validate overrides at a trust boundary (provider store, constructor). Known
 * keys must be well typed (throws otherwise); unknown keys are ignored, so a
 * config shared with opencode (`maxTokensField`, …) does not break the entry.
 */
export function normalizeReasoningCompatibility(input: unknown): ReasoningCompatibility {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('compatibility must be an object')
  const record = input as Record<string, unknown>
  const field = record['reasoningField']
  const required = record['requireReasoning']
  const replay = record['replayReasoning']
  if (field !== undefined && !isReasoningField(field)) throw new Error("compatibility: 'reasoningField' must be a plain identifier that is not a reserved message key")
  if (required !== undefined && typeof required !== 'boolean') throw new Error("compatibility: 'requireReasoning' must be a boolean")
  if (replay !== undefined && typeof replay !== 'boolean') throw new Error("compatibility: 'replayReasoning' must be a boolean")
  return {
    ...(field !== undefined ? { reasoningField: field } : {}),
    ...(required !== undefined ? { requireReasoning: required } : {}),
    ...(replay !== undefined ? { replayReasoning: replay } : {}),
  }
}

/**
 * The phase-05 `reasoning: { field?, required, replayWindow? }` entry, read
 * and rewritten as compatibility. `required: true` replayed under `field` and
 * sent it on every turn; `required: false` turned replay off entirely, so it
 * maps to `replayReasoning: false` (its field is moot). The window has no
 * equivalent.
 */
export function legacyReasoningCompatibility(input: unknown): ReasoningCompatibility {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('legacy `reasoning` entry must be an object')
  const record = input as Record<string, unknown>
  if (typeof record['required'] !== 'boolean') throw new Error("legacy `reasoning` entry: 'required' must be a boolean")
  if (record['required'] === false) return { replayReasoning: false }
  return normalizeReasoningCompatibility({ ...(record['field'] !== undefined ? { reasoningField: record['field'] } : {}), requireReasoning: true })
}

/**
 * opencode's default for `requireReasoning`: on for DeepSeek (by provider
 * name, endpoint host or model id) and whenever a field is configured.
 */
export function defaultRequireReasoning(input: { readonly provider: string; readonly baseUrl: string; readonly model: string; readonly configuredField?: string }): boolean {
  return input.configuredField !== undefined
    || input.provider.toLowerCase() === 'deepseek'
    || input.baseUrl.toLowerCase().includes('deepseek.com')
    || input.model.toLowerCase().includes('deepseek')
}

/** The stored-record limit `isReasoningPayload` enforces on `source`. */
export const REASONING_SOURCE_MAX = 1_024

/**
 * The `source` a reasoning record is filed under. A key longer than the stored
 * limit is replaced by its SHA-256 (`h:` + hex) so a record never fails the
 * reader and comparisons still hold. Idempotent.
 */
export function reasoningSourceKey(key: string): string {
  return key.length <= REASONING_SOURCE_MAX ? key : `h:${createHash('sha256').update(key, 'utf8').digest('hex')}`
}

/**
 * Who produced a reasoning record: provider and model, like opencode's
 * same-model check. The credential is not part of it, so a key rotation keeps
 * replaying; a model or provider switch keeps only the readable text.
 */
export function reasoningSourceFor(provider: string, model: string): string {
  return reasoningSourceKey(JSON.stringify([provider, model]))
}

/** Reasoning a request may carry: complete records only. A `length` cutoff is never replayed. */
export function replayableReasoning(message: ModelMessage): ReasoningPayload | undefined {
  const reasoning = message.reasoning
  return message.role === 'assistant' && reasoning !== undefined && reasoning.complete === true && typeof reasoning.text === 'string' ? reasoning : undefined
}

export function withoutReasoning(message: ModelMessage): ModelMessage {
  if (message.reasoning === undefined) return message
  const { reasoning: _dropped, ...rest } = message
  void _dropped
  return rest
}

/** Drop every record a request will not carry, so it is neither counted nor sent. */
export function keepReplayableReasoning<T extends { readonly message: ModelMessage }>(entries: readonly T[]): T[] {
  return entries.map((entry) => entry.message.reasoning === undefined || replayableReasoning(entry.message) !== undefined ? entry : { ...entry, message: withoutReasoning(entry.message) })
}

export interface WireReasoningPolicy {
  readonly configuredField?: string
  readonly requireReasoning: boolean
  /** `false`: recorded reasoning is never sent (only a required `""`). */
  readonly replay?: boolean
  /** {@link reasoningSourceFor} of the target route: the recorded field is reused only for its own records. */
  readonly source: string
}

/**
 * The reasoning field and text one assistant message carries on the wire, or
 * undefined for none. Same precedence as opencode `lowerAssistantMessage`:
 * configured field → field observed on this route's own stream →
 * `reasoning_content`; an empty string only when reasoning is required.
 */
export function wireReasoning(message: ModelMessage, policy: WireReasoningPolicy): { readonly field: string; readonly text: string } | undefined {
  const reasoning = policy.replay === false ? undefined : replayableReasoning(message)
  if (policy.configuredField !== undefined && (policy.requireReasoning || reasoning !== undefined)) return { field: policy.configuredField, text: reasoning?.text ?? '' }
  if (reasoning === undefined) return policy.requireReasoning ? { field: DEFAULT_REASONING_FIELD, text: '' } : undefined
  // After a model or provider switch only the readable text crosses over; the
  // destination route picks its own field.
  const observed = reasoning.source === policy.source && isReasoningField(reasoning.field) ? reasoning.field : undefined
  return { field: observed ?? DEFAULT_REASONING_FIELD, text: reasoning.text }
}

/** Token-shaped substrings: `sk-…`, `pk_…`, `key-…`, and `Bearer <token>`. */
export const SECRET_SHAPES = /\b(?:sk|pk|rk|key|api[-_]?key)[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Mask secret-shaped substrings (and an exact known key, when given). */
export function redactSecrets(text: string, apiKey = ''): string {
  let out = text
  if (apiKey.length >= 4) out = out.split(apiKey).join('[redacted]')
  return out.replace(SECRET_SHAPES, '[redacted]')
}

/** Longest token-like run held back while streaming; past it the run is redacted as is. */
const STREAM_CARRY_MAX = 512
const TOKEN_CHAR = /[A-Za-z0-9._~+/=-]/
/** The trailing run that may still grow into a secret (with a preceding `Bearer `). Linear scan. */
function trailingToken(text: string): string {
  let start = text.length
  while (start > 0 && TOKEN_CHAR.test(text[start - 1]!)) start--
  // `Bearer <token>`: keep the scheme with its token so the pair is matched whole.
  let ws = start
  while (ws > 0 && /\s/.test(text[ws - 1]!)) ws--
  if (ws < start && ws >= 6 && /bearer$/i.test(text.slice(ws - 6, ws))) start = ws - 6
  return text.slice(start)
}

/**
 * Secret-shape redaction for text that arrives in pieces. A secret split
 * across deltas (`sk-ab` | `cdefgh…`) is still caught: the trailing run of
 * token characters is carried over until a delimiter ends it (or the stream
 * flushes). Emitted text is therefore slightly behind the wire. A token-like
 * run longer than {@link STREAM_CARRY_MAX} is redacted and emitted on its own;
 * a key longer than that split exactly at the cap is the documented limit.
 */
export class StreamRedactor {
  private carry = ''
  /** True once any emitted text differed from the input. */
  changed = false
  constructor(private readonly apiKey = '') {}

  push(delta: string): string {
    const text = this.carry + delta
    const tail = trailingToken(text)
    if (tail.length > STREAM_CARRY_MAX) {
      this.carry = ''
      return this.mask(text)
    }
    this.carry = tail
    return this.mask(text.slice(0, text.length - tail.length))
  }

  flush(): string {
    const text = this.carry
    this.carry = ''
    return this.mask(text)
  }

  private mask(text: string): string {
    if (text === '') return ''
    const masked = redactSecrets(text, this.apiKey)
    if (masked !== text) this.changed = true
    return masked
  }
}

/**
 * The durable reasoning record of one attempt. Secret-shaped text (and the
 * route's own key, when known) is masked before persistence; a masked record
 * says so (`redacted`: not byte-faithful). The record always satisfies
 * {@link isReasoningPayload}: an empty source yields no record at all, an
 * over-long one is hashed, an unusable field is left out.
 */
export function capturedReasoning(text: string, complete: boolean, source: string, options: { readonly apiKey?: string; readonly redacted?: boolean; readonly field?: string } = {}): ReasoningPayload | undefined {
  if (typeof source !== 'string' || source === '') return undefined
  const masked = redactSecrets(text, options.apiKey)
  const record: ReasoningPayload = {
    text: masked,
    ...(isReasoningField(options.field) ? { field: options.field } : {}),
    complete,
    source: reasoningSourceKey(source),
    ...(masked !== text || options.redacted === true ? { redacted: true as const } : {}),
  }
  return isReasoningPayload(record) ? record : undefined
}

/** Strict shape check for a stored record. Records written before `field` existed stay valid. */
export function isReasoningPayload(value: unknown): value is ReasoningPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'text' && key !== 'field' && key !== 'complete' && key !== 'source' && key !== 'redacted')) return false
  return typeof record['text'] === 'string' && typeof record['complete'] === 'boolean'
    && typeof record['source'] === 'string' && record['source'] !== '' && record['source'].length <= REASONING_SOURCE_MAX
    && (record['field'] === undefined || isReasoningField(record['field']))
    && (record['redacted'] === undefined || record['redacted'] === true)
}

/** An endpoint's refusal of history without reasoning (DeepSeek wording, and close variants). */
export const REASONING_REPLAY_REJECTED = /reasoning(?:_content|_details)?[`'"]?[^.]{0,60}must be (?:passed|sent) back/i

export const REASONING_RESET_HINT = 'this endpoint requires reasoning that this history does not have (for example after switching models); start a new session, or set the provider\'s compatibility (reasoningField / requireReasoning / replayReasoning)'
