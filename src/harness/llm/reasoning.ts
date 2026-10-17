/**
 * Reasoning replay policy (phase 05, spec §10 PH-4): which wire field carries
 * an assistant's reasoning, whether the route requires it back, and which
 * assistant messages of a request carry it. Pure: no I/O.
 *
 * Evidence (plans/261017-runtime-provider-hardening/reports/phase-05-reasoning-round-trip.md):
 * native DeepSeek thinking mode returns `reasoning_content` beside `content`;
 * for a request carrying `tools`, the reasoning of ALL previous assistant
 * turns "should be passed back" and a missing one answers HTTP 400 ("The
 * `reasoning_content` in the thinking mode must be passed back to the API.");
 * a request without `tools` ignores the field. Third-party probes agree the
 * active tool loop is always enforced.
 */
import { createHash } from 'node:crypto'
import type { ModelMessage, ReasoningPayload } from './types.ts'

/**
 * Which assistant messages of a request carry their reasoning when this route
 * recorded it:
 * - `conversation`: every assistant message the request still contains
 *   (native DeepSeek default, per the documented "all previous turns");
 * - `tool-loop`: only the assistant messages after the latest `user` message.
 *
 * Whatever the window, the strict pre-network gate covers only the active tool
 * loop (after the latest user message): every source agrees it is mandatory
 * there, and a gap there can only be a route switch or a cut-off reply, never
 * legacy history. Outside it, missing reasoning is omitted, never fabricated.
 */
export type ReplayWindow = 'tool-loop' | 'conversation'

export interface ReasoningProfile {
  /** Wire field on assistant messages, e.g. `reasoning_content`. */
  readonly field: string
  /** The route requires reasoning back: record it, replay it, gate on it. */
  readonly required: boolean
  readonly replayWindow: ReplayWindow
}

/**
 * Keys a reasoning field may never be: message keys it would overwrite, wire
 * keys of the delta/choice it is read from, and prototype-polluting names.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'role', 'content', 'tool_calls', 'name', 'tool_call_id', 'function_call', 'refusal', 'audio',
  'prefix', 'type', 'id', 'index', 'function', 'finish_reason', 'delta',
  '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
])
/** Plain lower/upper-case identifier, no leading underscore (no dunder names). */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Delta keys gateways use for thinking text. A strict route that sees one of
 * these it does not parse cannot prove its recorded reasoning is whole.
 */
export const REASONING_LIKE_KEYS: readonly string[] = ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details', 'thinking', 'thought']

export const DEEPSEEK_REASONING_PROFILE: ReasoningProfile = Object.freeze({ field: 'reasoning_content', required: true, replayWindow: 'conversation' })

/**
 * Validate an override at a trust boundary (provider store, REST). Throws on
 * anything but the typed shape: unknown keys, a reserved or malformed field
 * name, an unknown window. Never an arbitrary body passthrough.
 */
export function normalizeReasoningProfile(input: unknown): ReasoningProfile {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('reasoning profile must be an object')
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'field' && key !== 'required' && key !== 'replayWindow') throw new Error(`reasoning profile: unknown key '${key}'`)
  }
  if (typeof record['required'] !== 'boolean') throw new Error("reasoning profile: 'required' must be a boolean")
  const field = record['field'] ?? DEEPSEEK_REASONING_PROFILE.field
  if (typeof field !== 'string') throw new Error("reasoning profile: 'field' must be a plain identifier")
  if (RESERVED_FIELDS.has(field)) throw new Error(`reasoning profile: '${field}' is a reserved message key`)
  if (!FIELD_NAME.test(field)) throw new Error("reasoning profile: 'field' must be a plain identifier")
  const window = record['replayWindow'] ?? DEEPSEEK_REASONING_PROFILE.replayWindow
  if (window !== 'tool-loop' && window !== 'conversation') throw new Error("reasoning profile: 'replayWindow' must be 'tool-loop' or 'conversation'")
  return { field, required: record['required'], replayWindow: window }
}

/** The native DeepSeek API, recognized by exact host. A model or provider NAME never qualifies. */
export function isNativeDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
  } catch {
    return false
  }
}

/**
 * Precedence: explicit override > detected native DeepSeek endpoint > generic
 * (no reasoning). Undefined means nothing is recorded, sent or gated; an
 * override with `required: false` opts a native endpoint out.
 */
export function resolveReasoningProfile(override: ReasoningProfile | undefined, baseUrl: string): ReasoningProfile | undefined {
  const profile = override ?? (isNativeDeepSeekEndpoint(baseUrl) ? DEEPSEEK_REASONING_PROFILE : undefined)
  return profile?.required === true ? profile : undefined
}

/** Index of the first message after the latest user message (the active tool loop). */
export function toolLoopStart(messages: readonly Pick<ModelMessage, 'role'>[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === 'user') return index + 1
  }
  return 0
}

function windowStart(messages: readonly Pick<ModelMessage, 'role'>[], window: ReplayWindow): number {
  return window === 'tool-loop' ? toolLoopStart(messages) : 0
}

/** Complete reasoning this exact route produced: the only kind ever replayed. */
export function replayable(message: ModelMessage, source: string): boolean {
  const reasoning = message.reasoning
  return message.role === 'assistant' && reasoning !== undefined && reasoning.complete === true && reasoning.source === source && typeof reasoning.text === 'string'
}

export interface ReplayPlan {
  /** Indexes of assistant messages whose reasoning is serialized. */
  readonly eligible: ReadonlySet<number>
  /** Tool-loop assistant messages without complete reasoning of this route (the strict gate). */
  readonly missing: number
}

/**
 * Which assistant messages carry reasoning, and how many in the active tool
 * loop cannot. Another route's (model, endpoint, credential), a partial
 * (`length`) or an absent record is never replaced by an empty string.
 */
export function planReasoningReplay(messages: readonly ModelMessage[], source: string, window: ReplayWindow): ReplayPlan {
  const eligible = new Set<number>()
  const start = windowStart(messages, window)
  const loop = toolLoopStart(messages)
  let missing = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const ok = replayable(message, source)
    if (ok && index >= start) eligible.add(index)
    if (!ok && index >= loop) missing += 1
  }
  return { eligible, missing }
}

/**
 * Projection for one target route: keep reasoning only where it would be
 * replayed (same route, complete, inside the window), drop it everywhere else
 * so it is neither counted nor sent. `replay` undefined drops every record.
 */
export function selectReasoning<T extends { readonly message: ModelMessage }>(entries: readonly T[], replay: { readonly source: string; readonly window: ReplayWindow } | undefined): T[] {
  const plan = replay === undefined ? undefined : planReasoningReplay(entries.map((entry) => entry.message), replay.source, replay.window)
  return entries.map((entry, index) => {
    if (entry.message.reasoning === undefined || plan?.eligible.has(index) === true) return entry
    return { ...entry, message: withoutReasoning(entry.message) }
  })
}

export function withoutReasoning(message: ModelMessage): ModelMessage {
  if (message.reasoning === undefined) return message
  const { reasoning: _dropped, ...rest } = message
  void _dropped
  return rest
}

/**
 * Whether a snapshot's / summary request's final answer keeps its reasoning.
 * One rule for every handoff path (capture, reconstruction, cache-aware
 * summary): the answer is placed exactly as it will be sent — after the
 * request's messages and before the appended summary instruction (a `user`
 * message) — and keeps its reasoning only if the route's replay plan would
 * serialize it there. Requests without tools never carry reasoning.
 */
export function handoffAnswerReasoning(
  messages: readonly ModelMessage[],
  answer: ModelMessage,
  replay: { readonly source: string; readonly window: ReplayWindow } | undefined,
  hasTools: boolean,
): ReasoningPayload | undefined {
  if (replay === undefined || !hasTools || answer.reasoning === undefined) return undefined
  const placed: ModelMessage[] = [...messages, answer, { role: 'user', content: '' }]
  return planReasoningReplay(placed, replay.source, replay.window).eligible.has(messages.length) ? answer.reasoning : undefined
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

/** The stored-record limit `isReasoningPayload` enforces on `source`. */
export const REASONING_SOURCE_MAX = 1_024

/**
 * The `source` a reasoning record is filed under. A route key longer than the
 * stored limit is replaced by its SHA-256 (`h:` + hex), on the adapter side
 * (replay planning) and at capture alike, so a record never fails the reader
 * and the comparison still holds. Idempotent.
 */
export function reasoningSourceKey(routeKey: string): string {
  return routeKey.length <= REASONING_SOURCE_MAX ? routeKey : `h:${createHash('sha256').update(routeKey, 'utf8').digest('hex')}`
}

/**
 * The durable reasoning record of one attempt. Secret-shaped text (and the
 * route's own key, when known) is masked before persistence; a masked record
 * says so (`redacted`: not byte-faithful). The record always satisfies
 * {@link isReasoningPayload}: an empty source yields no record at all, an
 * over-long one is hashed. A session can never become unreadable because of it.
 */
export function capturedReasoning(text: string, complete: boolean, source: string, options: { readonly apiKey?: string; readonly redacted?: boolean } = {}): ReasoningPayload | undefined {
  if (typeof source !== 'string' || source === '') return undefined
  const masked = redactSecrets(text, options.apiKey)
  const record: ReasoningPayload = { text: masked, complete, source: reasoningSourceKey(source), ...(masked !== text || options.redacted === true ? { redacted: true as const } : {}) }
  return isReasoningPayload(record) ? record : undefined
}

/** Strict shape check for a stored record (new vocabulary only). */
export function isReasoningPayload(value: unknown): value is ReasoningPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'text' && key !== 'complete' && key !== 'source' && key !== 'redacted')) return false
  return typeof record['text'] === 'string' && typeof record['complete'] === 'boolean'
    && typeof record['source'] === 'string' && record['source'] !== '' && record['source'].length <= REASONING_SOURCE_MAX
    && (record['redacted'] === undefined || record['redacted'] === true)
}

/** The endpoint's own refusal of a replay without reasoning (DeepSeek wording). */
export const REASONING_REPLAY_REJECTED = /reasoning_content[`'"]?[^.]{0,60}must be passed back/i

export const REASONING_RESET_HINT = 'start a new session, or explicitly reset this conversation\'s context; the harness will not invent missing reasoning'
