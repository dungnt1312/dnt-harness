import { createHash } from 'node:crypto'
import { classifyTransport } from './request-lifecycle.ts'
import { cancelReader, encodedBytes, normalizeFinishReason, protocolError, readBoundedError, readSse, validateCompletion, validateToolBatch, WIRE_LIMITS } from './completion.ts'
import {
  applyThinking, credentialGeneration, detectMaxTokensField, detectSupportsPromptCacheKey, detectSupportsStore,
  outputCeiling, outputPolicy, outputTokenCap, routeIdentity, routeKey,
  type CredentialHasher, type MaxTokensField, type OutputCapSource, type RouteIdentity,
} from './effective-model.ts'
import type { ModelCompletion, ModelFinishReason, ProviderErrorReason } from './types.ts'
import { messageText, ProviderError } from './types.ts'
import type { LlmProvider, ModelMessage, ModelRequest, StreamEvent, StreamOptions, TokenUsage } from './types.ts'

interface StreamChoice {
  finish_reason?: unknown
  delta?: {
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: StreamToolCall[] | null
  }
}

interface StreamToolCall {
  id?: string
  index?: number
  function?: { name?: string; arguments?: string }
}

/** One tool call accumulated across argument-fragment deltas. */
interface AccumulatedCall {
  id: string
  name: string
  argsString: string
}

/** The vision content array OpenAI-compatible servers accept on a user message. */
type WireContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]

/** One message in the OpenAI-style wire format every completions server accepts. */
interface WireMessage {
  role: string
  content: WireContent
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/**
 * Messages that carry images serialize as the documented content array, with
 * each image inlined as a `data:` URL. Text-only messages stay bare strings:
 * servers that predate vision keep receiving exactly what they always did.
 */
function toWireContent(content: ModelMessage['content']): WireContent {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: `data:${part.mediaType};base64,${part.base64}` } },
  )
}

/**
 * Translate the internal message vocabulary to the wire format at the wire
 * boundary: assistant `toolCalls` become `tool_calls` with JSON-string
 * `arguments`, and tool answers carry `tool_call_id` instead of
 * `toolCallId`. The inverse mapping happens on streamed `tool_calls` below,
 * so the internal vocabulary stays provider-neutral.
 */
function toWireMessages(messages: readonly ModelMessage[]): WireMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      return {
        role: 'assistant',
        content: toWireContent(message.content),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        // A tool answer is always text; flattening keeps the protocol's shape.
        content: messageText(message.content),
        tool_call_id: message.toolCallId ?? '',
      }
    }
    return { role: message.role, content: toWireContent(message.content) }
  })
}

/** Constructor options for any OpenAI chat-completions compatible endpoint. */
export interface OpenAiCompletionsOptions {
  /** Registry/UI name for this instance, e.g. `deepseek`, `cliproxy1`. */
  readonly name: string
  readonly apiKey: string
  /** Base URL without `/chat/completions`; e.g. `https://api.deepseek.com`. */
  readonly baseUrl: string
  /** Model names offered to selectors; the first is the fallback model. */
  readonly models?: readonly string[]
  /** Extra attempts for transient client statuses, non-deterministic 5xx, or a connection failure before streaming starts (default 3). */
  readonly maxRetries?: number
  /** First backoff delay; doubles per attempt with jitter (default 1000ms). */
  readonly retryBaseMs?: number
  /** Explicit gateway profile; default requires choice finish plus DONE. */
  readonly completionPolicy?: 'strict' | 'finish-eof'
  /** Operator per-model output-token caps; they win over the catalog value. */
  readonly maxOutputTokens?: Readonly<Record<string, number>>
  /**
   * Body field carrying the output cap. Unset means detect it from
   * `name`/`baseUrl`; unrecognized endpoints keep the historical `max_tokens`.
   */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * Whether this endpoint accepts `prompt_cache_key`. Unset means detect it
   * from the host (see {@link detectSupportsPromptCacheKey}); strict relays
   * reject unknown body fields, so an unrecognized endpoint never gets it.
   */
  readonly supportsPromptCacheKey?: boolean
  /** Whether this endpoint understands `store`. Only then is `store: false` sent. */
  readonly supportsStore?: boolean
  /**
   * Keyed hasher for the route identity's credential fingerprint, injected by
   * the host (persisted per-install secret). Unset: a process-local secret.
   */
  readonly credentialHasher?: CredentialHasher
}

// Wire-compatibility detection and the output-cap policy live in the shared
// resolver; re-exported here for existing importers.
export { detectMaxTokensField, detectSupportsPromptCacheKey, detectSupportsStore, outputTokenCap } from './effective-model.ts'

/** `prompt_cache_key` is documented at 64 characters. */
const OPENAI_PROMPT_CACHE_KEY_MAX = 64

/**
 * The cache key for a session: the id itself when it fits, else a SHA-256 of
 * it. A plain truncation would let two long ids sharing a prefix collide onto
 * one cache shard.
 */
export function promptCacheKey(affinity: string): string {
  return affinity.length <= OPENAI_PROMPT_CACHE_KEY_MAX ? affinity : createHash('sha256').update(affinity).digest('hex')
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 1_000
/** A single wait never exceeds this, whatever `retry-after` asks for. */
const MAX_RETRY_DELAY_MS = 30_000
/** Error bodies are diagnostics: keep enough to explain, never an unbounded read. */
const boundedText = readBoundedError
/**
 * HTTP statuses that are transient without reading the body. Deterministic
 * client 4xx stay out; everything else with a 5xx body classifies as
 * `server_error` and is retried unless the body proves otherwise.
 */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504, 524, 529])
/** 5xx statuses whose semantics are deterministic: the same request will fail again. */
const DETERMINISTIC_SERVER_STATUS: ReadonlySet<number> = new Set([501, 505, 511])

/**
 * A status is retried when transient by code, or when the server reported a
 * 5xx-class failure (default-retryable) unless the body names a condition a
 * second identical request could not fix (auth at the upstream, quota,
 * context size). Client 4xx stays non-retryable; the caller re-reads nothing.
 */
function retryableStatus(status: number, detail: string): boolean {
  if (status < 500) return TRANSIENT_STATUS.has(status)
  if (DETERMINISTIC_SERVER_STATUS.has(status)) return false
  if (detail === '') return true
  return !/insufficient_quota|quota|billing|credit|balance|invalid api key|authentication/i.test(detail)
}

/** Error text that names a condition a second identical request cannot fix: the opt-OUT from default-retryable. */
const PERMANENT_GATEWAY_TEXT = /invalid api key|authenticat|unauthorized|forbidden|permission denied|not found|unsupported|invalid request|malformed|context[_ -]?(length|window)|too (long|large)|exceeds? (the )?(model'?s? )?(maximum|context)/i

function backoffMs(attempt: number, base: number): number {
  const exponential = base * 2 ** (attempt - 1)
  return Math.min(MAX_RETRY_DELAY_MS, exponential / 2 + Math.random() * (exponential / 2))
}

/** `retry-after` as seconds or an HTTP date; undefined when absent or unusable. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/** Wait, but wake with the abort reason as soon as the run is stopped. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * OpenAI chat-completions provider: POSTs `{baseUrl}/chat/completions` with
 * `stream: true`, yields `choices[0].delta.content` as SSE `data:` lines
 * arrive, and accumulates `delta.tool_calls` fragments (id/name arrive once,
 * arguments stream in pieces keyed by `index`) into one final `toolCalls`
 * stream event. Reasoning-style models may emit `delta.reasoning_content`,
 * surfaced as `thinking` deltas that never join answered content. Wire
 * format is validated here — the model-JSON boundary — and nowhere else.
 */
export class OpenAiCompletionsProvider implements LlmProvider {
  readonly name: string
  readonly models: readonly string[]
  /** Used only when a request names no model; never an operator preference. */
  private readonly fallbackModel: string
  /**
   * Output caps this endpoint taught us by rejecting the 32k fallback, keyed
   * by route identity (endpoint, wire model, profile, credential generation),
   * so a new key or endpoint never inherits them. Memory only and bounded.
   * Only the fallback is ever learned over: an operator or catalog cap that
   * is rejected stays a visible error.
   */
  private readonly learnedCaps = new LearnedCaps()
  private readonly credential: string

  constructor(private readonly options: OpenAiCompletionsOptions) {
    this.name = options.name
    this.models = options.models ?? []
    this.fallbackModel = options.models?.[0] ?? 'default'
    this.credential = credentialGeneration(options.apiKey, options.credentialHasher)
  }

  /**
   * Charge the one corrective cap resend to the request's attempt budget. Under
   * harness ownership it is a physical attempt of the logical request (so it
   * shrinks the squeeze/retry budget like any other); standalone it uses one of
   * this call's own attempts. No budget left = no resend; the error surfaces.
   */
  private async reserveCorrectiveResend(options: StreamOptions | undefined, attempt: number, maxAttempts: number, status: number): Promise<boolean> {
    const owner = options?.requestOwner
    if (owner === undefined) return attempt < maxAttempts
    if (owner.signal.aborted || owner.attempts >= owner.policy.maxAttempts) return false
    // The owner (runAttempt) closes the rejected physical attempt and opens a
    // new logged one, so attempt numbering in the log matches the charge.
    if (options?.correctiveAttempt !== undefined) {
      await options.correctiveAttempt({ status })
      return true
    }
    owner.consume()
    return true
  }

  private get maxTokensField(): MaxTokensField {
    return this.options.maxTokensField ?? detectMaxTokensField(this.name, this.options.baseUrl)
  }

  /** The versioned route identity a request for `model` travels on. Never contains the key. */
  routeIdentity(model?: string): RouteIdentity {
    return routeIdentity({ baseUrl: this.options.baseUrl, model: model ?? this.fallbackModel, maxTokensField: this.maxTokensField, credentialGeneration: this.credential })
  }

  /**
   * Secret-free output-cap facts for diagnostics: the policy source, and for a
   * guessed cap what this endpoint taught us (`omitted` = no cap is sent).
   */
  outputCapDiagnostics(model?: string): { readonly model: string; readonly source: OutputCapSource; readonly cap: number | 'omitted'; readonly learned: boolean } {
    const id = model ?? this.fallbackModel
    const policy = outputPolicy(id, this.options.maxOutputTokens?.[id])
    // Peek: a diagnostics read must not refresh the entry's LRU position.
    const learned = policy.guessed ? this.learnedCaps.peek(routeKey(this.routeIdentity(id))) : undefined
    const limit = learned?.limit
    return { model: id, source: policy.source, cap: limit === undefined ? policy.cap : limit === null ? 'omitted' : limit, learned: limit !== undefined }
  }

  async *stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<StreamEvent> {
    // The body is assembled as an object first so the documented per-model
    // thinking override can patch it; unsupported (model, level) pairs
    // leave it untouched rather than risking an undocumented field.
    const model = request.model ?? this.fallbackModel
    const tools = request.tools ?? []
    const hasTools = tools.length > 0
    const affinity = request.sessionAffinity
    // Every knob below resolves once, before the body is written: no magic
    // values scattered through the assembly, and `compatibility ?? detect`.
    const maxTokensField = this.maxTokensField
    const supportsStore = this.options.supportsStore ?? detectSupportsStore(this.name, this.options.baseUrl)
    const supportsPromptCacheKey = this.options.supportsPromptCacheKey ?? detectSupportsPromptCacheKey(this.options.baseUrl)
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(request.messages),
      ...(hasTools
        ? { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) }
        : {}),
      stream: true,
      // The final chunk then carries `usage` (real prompt/cached counts),
      // which the context meter shows instead of a raw estimate.
      stream_options: { include_usage: true },
      // Stateless by default where the flag exists; every other endpoint omits
      // the field entirely rather than risk rejecting an unknown one.
      ...(supportsStore ? { store: false } : {}),
    }
    // Only where the endpoint is known or declared to accept it: strict relays
    // reject unknown body fields. The affinity header below flows regardless.
    if (supportsPromptCacheKey && affinity !== undefined && affinity !== '') {
      body['prompt_cache_key'] = promptCacheKey(affinity)
    }
    // No room left for any reply: refuse before the network, as an overflow, so
    // the owner's bounded squeeze re-assembles smaller (or the turn fails).
    if (outputCeiling(request.outputCeilingTokens) === 'exhausted') {
      throw new ProviderError('provider request: no output room left in the context window', { reason: 'context_exceeded', phase: 'connect', classification: 'context_exceeded' })
    }
    // The cap is a guess only when nobody documented one: the operator's
    // override and the catalog are authoritative, the fallback is not.
    const guessed = outputPolicy(model, this.options.maxOutputTokens?.[model]).guessed
    const routeId = routeKey(this.routeIdentity(model))
    const capped = (learned: number | null | undefined): { readonly payload: string; readonly cap: number | undefined } => {
      const wire = { ...body }
      const maxTokens = outputTokenCap(model, this.options.maxOutputTokens, request.maxOutputTokens, request.outputCeilingTokens, learned)
      // Undefined cap means neither field is sent, never `null`/`undefined`.
      if (maxTokens !== undefined) wire[maxTokensField] = maxTokens
      // Thinking is computed against the FINAL cap, and Claude budget thinking
      // is dropped when no cap is sent at all.
      applyThinking(wire, model, request.thinkingLevel, maxTokens)
      return { payload: JSON.stringify(wire), cap: maxTokens }
    }
    let built = capped(guessed ? this.learnedCaps.get(routeId)?.limit : undefined)
    let payload = built.payload
    // One corrective resend per stream call, and only for a guessed cap.
    let capRelearned = !guessed
    const signal = options?.signal
    // Standalone use retains a bounded header-only retry policy; harness use never stacks it.
    const maxAttempts = options?.requestOwner ? 1 : Math.min(4, 1 + Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES))
    let response: Response
    // Retry only before the stream starts: nothing has been yielded, so a
    // second request cannot duplicate output. Rate limits and transient
    // gateway/server failures are retried with backoff; everything else
    // (auth, bad request, a mid-stream failure) surfaces at once.
    for (let attempt = 1; ; attempt++) {
      let wait: number | undefined
      try {
        response = await fetch(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          ...(signal !== undefined ? { signal } : {}),
          headers: {
            'content-type': 'application/json',
            // Local gateways often accept no credential at all; sending an empty
            // Bearer makes some of them reject the call outright.
            ...(this.options.apiKey === '' ? {} : { authorization: `Bearer ${this.options.apiKey}` }),
            // Provider-side prompt-cache affinity: every request of one session
            // reaches the same shard, so its prefix cache stays reusable. Only
            // sent when the host stamped an identity.
            ...(affinity !== undefined && affinity !== '' ? { 'x-session-affinity': affinity } : {}),
          },
          body: payload,
        })
      } catch (error) {
        const classified = signal?.aborted ? new ProviderError('provider request cancelled', { reason: 'cancelled', phase: 'connect' }) : classifyTransport(error, 'connect')
        if (!classified.retryable || attempt >= maxAttempts) throw classified
        await sleep(backoffMs(attempt, this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS), signal)
        continue
      }
      if (response.ok) break
      let cleanupSettled = true
      const detail = await boundedText(response, settled => { cleanupSettled = settled }, options?.onTransportSettled)
      const classification = classifyRequestError(response.status, detail)
      let guessRejected = false
      if (!capRelearned && cleanupSettled && built.cap !== undefined && capRejectionStatus(response.status) && OUTPUT_CAP_REJECTED.test(detail)) {
        // The endpoint refused the 32k guess and usually names its limit:
        // remember it (or "no cap") for this route so later requests start
        // right — even when this request has no attempt left to resend.
        capRelearned = true
        guessRejected = true
        const limit = outputLimitFromError(detail, built.cap)
        this.learnedCaps.set(routeId, limit ?? null)
        if (await this.reserveCorrectiveResend(options, attempt, maxAttempts, response.status)) {
          // Resend once with the corrected cap. Nothing was streamed yet. The
          // resend is a physical attempt like any other: charged and logged.
          built = capped(limit ?? null)
          payload = built.payload
          continue
        }
      }
      if (classification === 'missing_required_cap' && guessed && built.cap === undefined) {
        // A learned "send no cap" met an endpoint that requires one: forget it,
        // so the next request starts from the documented fallback again.
        this.learnedCaps.delete(routeId)
      }
      const quota = classification === 'quota'
      const reason: ProviderErrorReason = PUBLIC_REASON[classification]
      // Deterministic request rejections are never replayed, even when a relay
      // wrapped them in a transient-looking 502.
      const retryable = !DETERMINISTIC_CLASSES.has(classification) && !quota && retryableStatus(response.status, detail)
      if (!cleanupSettled || !retryable || attempt >= maxAttempts) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'))
        const excerpt = httpErrorExcerpt(detail, this.options.apiKey)
        const label = guessRejected
          // Nobody configured this cap: say so, and that the next request uses
          // what was just learned, instead of blaming an operator setting.
          ? `fallback output-cap guess (${built.cap}) rejected for '${model}'; the corrected cap applies to the next request (or set maxOutputTokens)`
          : classification === 'output_cap_rejected'
          ? `output cap rejected (${built.cap === undefined ? 'no cap sent' : `sent ${built.cap}`}; lower maxOutputTokens for '${model}')`
          : classification === 'missing_required_cap'
            ? `endpoint requires an output cap (set maxOutputTokens for '${model}')`
            : reason
        const error = new ProviderError(`provider HTTP ${response.status}: ${label}${excerpt === '' ? '' : `: ${excerpt}`}`, { reason, classification, phase: 'headers', transient: retryable, status: response.status, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) })
        error.transportSettled = cleanupSettled
        throw error
      }
      wait = retryAfterMs(response.headers.get('retry-after'))
      await sleep(Math.min(MAX_RETRY_DELAY_MS, wait ?? backoffMs(attempt, this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)), signal)
    }
    if (response.body === null) {
      throw new ProviderError(`${this.name}: empty response body`, { transient: true })
    }

    const calls: AccumulatedCall[] = []
    const reader = response.body.getReader()
    let finishReason: ModelFinishReason | undefined
    let boundary: 'done' | 'eof' = 'eof'
    let outputBytes = 0
    let argumentBytes = 0
    let settled = false
    let cleanupAttempted = false
    try {
      for await (const data of readSse(reader)) {
        if (data === '[DONE]') { boundary = 'done'; break }
        let parsed: { choices?: StreamChoice[]; usage?: WireUsage | null; error?: unknown }
        try {
          parsed = JSON.parse(data) as { choices?: StreamChoice[]; usage?: WireUsage | null; error?: unknown }
        } catch (error) {
          throw protocolError('malformed_protocol', `${this.name}: malformed stream JSON`)
        }
        if (parsed === null || typeof parsed !== 'object' || (parsed.choices !== undefined && !Array.isArray(parsed.choices))) throw protocolError('malformed_protocol', 'invalid stream record')
        // One API-style relays report upstream failures as an error object in
        // a 200 stream. That payload is the only diagnosis of the upstream
        // failure the user ever sees: classify on it, and carry it in the
        // message (bounded — this text lands in the durable session log).
        if (parsed.error !== undefined) {
          const text = redactSecrets(gatewayErrorText(parsed.error), this.options.apiKey).slice(0, WIRE_LIMITS.errorChars)
          const quota = /quota|billing|credit|balance/i.test(text)
          const classification = classifyRequestError(400, text)
          const contextExceeded = classification === 'context_exceeded' || classification === 'payload_too_large'
          // Default-retryable, but permanent diagnostics always win over a
          // transient gateway code. Context errors require squeezing, not
          // replay; a cap rejection is terminal for this payload.
          const deterministic = DETERMINISTIC_CLASSES.has(classification)
          const transient = !deterministic && !quota && !PERMANENT_GATEWAY_TEXT.test(text)
          const detail = text.slice(0, 300)
          throw new ProviderError(`provider gateway failure${detail === '' ? '' : `: ${detail}`}`, { reason: contextExceeded ? 'context_exceeded' : quota ? 'quota' : transient ? 'server_error' : 'unknown', transient, ...(deterministic ? { classification } : {}) })
        }
        const usage = parseUsage(parsed.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
        if (parsed === null || typeof parsed !== 'object') throw protocolError('malformed_protocol', 'invalid stream record')
        if ((parsed.choices?.length ?? 0) > 1) throw protocolError('malformed_protocol', 'multiple choices are unsupported')
        const choice = parsed.choices?.[0]
        const alreadyFinished = finishReason !== undefined
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          const next = normalizeFinishReason(choice.finish_reason)
          if (finishReason !== undefined && finishReason !== next) throw protocolError('malformed_protocol', 'conflicting finish reasons')
          finishReason = next
        }
        const delta = choice?.delta
        const content = delta?.content
        if ((content !== undefined && content !== null && typeof content !== 'string') || (delta?.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== 'string') || (delta?.tool_calls !== undefined && delta.tool_calls !== null && !Array.isArray(delta.tool_calls))) throw protocolError('malformed_protocol', 'invalid model delta')
        if (alreadyFinished && (delta?.content || delta?.reasoning_content || delta?.tool_calls?.length)) throw protocolError('malformed_protocol', 'output after semantic finish')
        outputBytes += encodedBytes(delta?.content ?? '') + encodedBytes(delta?.reasoning_content ?? '')
        if (outputBytes > WIRE_LIMITS.outputBytes) throw protocolError('output_limit', 'model output exceeds limit')
        // Reasoning-capable models emit thinking separately from content:
        // the thinking text never joins the answered content and is marked
        // for the UI as a `thinking` delta.
        if (typeof content === 'string' && content !== '') {
          yield { type: 'delta', delta: content }
        }
        const thinking = delta?.reasoning_content
        if (typeof thinking === 'string' && thinking !== '') {
          yield { type: 'delta', delta: thinking, thinking: true }
        }
        if (delta?.tool_calls != null && delta.tool_calls.length > 0) {
          for (const fragment of delta.tool_calls) {
            if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment) || (fragment.function !== undefined && (fragment.function === null || typeof fragment.function !== 'object' || Array.isArray(fragment.function)))) throw protocolError('malformed_protocol', 'invalid tool fragment shape')
            const index = fragment.index
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= WIRE_LIMITS.calls) throw protocolError('invalid_tool_input', 'invalid tool index')
            const slot = calls[index] ?? { id: '', name: '', argsString: '' }
            if (fragment.id !== undefined && fragment.id !== null) {
              const id = fragment.id
              // A continuation fragment may repeat the header with no usable
              // id (`null` / `""` — the live opencode-relayed DeepSeek stream
              // does). That is "no id in this fragment", not a new call, so the
              // slot keeps the id its header established; a call that never
              // gets one fails the batch at finish, where identity is checked.
              if (typeof id !== 'string') throw protocolError('invalid_tool_input', 'invalid tool ID')
              if (id.trim() !== '') {
                // A gateway may re-send the tool-call header with a fresh id at
                // the same index. While no arguments accumulated the slot still
                // describes one call, so the last header wins. Once arguments
                // exist the two ids would merge different calls into one
                // executable batch: a hard failure.
                if (slot.id && slot.id !== id && slot.argsString !== '') throw protocolError('invalid_tool_input', 'conflicting tool ID')
                slot.id = id
              }
            }
            if (fragment.function?.name !== undefined && fragment.function.name !== null) {
              const name = fragment.function.name
              // Same rule as the id: a repeated header may blank the name out.
              // Only a usable name participates, so `""` leaves the slot alone.
              if (typeof name !== 'string') throw protocolError('invalid_tool_input', 'invalid tool name')
              if (name.trim() !== '') {
                if (slot.name && slot.name !== name) throw protocolError('invalid_tool_input', 'conflicting tool name')
                slot.name = name
              }
            }
            const args = fragment.function?.arguments ?? ''
            if (typeof args !== 'string') throw protocolError('invalid_tool_input', 'invalid argument fragment')
            const bytes = encodedBytes(args)
            argumentBytes += bytes
            outputBytes += bytes + encodedBytes(fragment.id ?? '') + encodedBytes(fragment.function?.name ?? '')
            if (argumentBytes > WIRE_LIMITS.aggregateArgumentBytes || outputBytes > WIRE_LIMITS.outputBytes || encodedBytes(slot.argsString) + bytes > WIRE_LIMITS.argumentBytes) throw protocolError('output_limit', 'tool argument/output limit exceeded')
            slot.argsString += args
            calls[index] = slot
          }
          // Arguments may stream for minutes. Report model progress without
          // exposing or executing a call until its complete JSON is available.
          yield { type: 'toolCallProgress' }
        }
      }
      if (finishReason === undefined || (boundary === 'eof' && this.options.completionPolicy !== 'finish-eof')) throw protocolError('incomplete_completion', `${this.name}: stream ended without completion proof`)
      const completion: ModelCompletion = { type: 'completion', finishReason, transport: boundary, policy: boundary === 'done' ? 'strict' : 'finish-eof', transportSettled: true }
      // A `length` finish reaches the agent loop, which recovers in-turn. Tool
      // calls of a cut-off reply are incomplete by definition (their JSON may
      // even parse) and are never handed out for execution.
      validateCompletion(completion, { allowLength: true })
      const batch = finishReason === 'length' ? [] : [...finishCalls(this.name, calls)]
      cleanupAttempted = true
      settled = await cancelReader(reader, options?.onTransportSettled)
      if (!settled) throw new ProviderError('transport cleanup unresolved', { reason: 'incomplete_completion', phase: 'cleanup' })
      reader.releaseLock()
      yield* batch
      yield completion
    } catch (error) {
      const failure = signal?.aborted ? new ProviderError('provider request cancelled', { reason: 'cancelled', phase: 'stream' }) : error instanceof ProviderError ? error : classifyTransport(error, 'stream')
      if (!cleanupAttempted) {
        cleanupAttempted = true
        settled = await cancelReader(reader, options?.onTransportSettled)
      }
      failure.transportSettled = settled
      if (settled) reader.releaseLock()
      throw failure
    } finally {
      if (!settled) {
        const closing = !cleanupAttempted
        try {
          if (closing) settled = await cancelReader(reader, options?.onTransportSettled)
        } finally { reader.releaseLock() }
        // A consumer return must reject rather than report done while transport
        // cleanup is unresolved. Existing catch failures already carry this fact.
        if (closing && !settled) {
          const failure = new ProviderError('transport cleanup unresolved', { reason: 'incomplete_completion', phase: 'cleanup' })
          failure.transportSettled = false
          throw failure
        }
      }
    }
  }
}

/**
 * Output caps one provider instance learned, keyed by route identity. Memory
 * only, a small LRU: a relay that answers with a new model id per request
 * cannot grow it without bound, and the route key carries the credential
 * generation, so a rotated key starts clean.
 */
class LearnedCaps {
  private readonly entries = new Map<string, { readonly limit: number | null }>()
  constructor(private readonly capacity = LEARNED_CAP_ROUTES) {}
  get(key: string): { readonly limit: number | null } | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }
  /** Read without touching recency. */
  peek(key: string): { readonly limit: number | null } | undefined {
    return this.entries.get(key)
  }
  set(key: string, limit: number | null): void {
    this.entries.delete(key)
    this.entries.set(key, { limit })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
  delete(key: string): void { this.entries.delete(key) }
}

/** Routes one provider instance remembers a learned cap for. */
const LEARNED_CAP_ROUTES = 16

/**
 * What an HTTP or gateway error says about the request, from bounded known
 * formats only. Internal: public `reason`s are mapped in {@link PUBLIC_REASON}.
 */
export type RequestErrorClass =
  | 'context_exceeded'
  | 'payload_too_large'
  | 'output_cap_rejected'
  | 'missing_required_cap'
  | 'quota'
  | 'auth'
  | 'rate_limit'
  | 'server_error'
  | 'request'

/**
 * No new public reason: output-cap and missing-cap rejections keep `unknown`
 * (terminal, not `output_limit`, which is the local output-byte bound), and a
 * payload too large keeps `context_exceeded` because a smaller assembly is its
 * cure. The finer class rides on `ProviderError.classification`.
 */
const PUBLIC_REASON: Readonly<Record<RequestErrorClass, ProviderErrorReason>> = {
  context_exceeded: 'context_exceeded',
  payload_too_large: 'context_exceeded',
  output_cap_rejected: 'unknown',
  missing_required_cap: 'unknown',
  quota: 'quota',
  auth: 'auth_configuration',
  rate_limit: 'rate_limit',
  server_error: 'server_error',
  request: 'unknown',
}

/** Classes a second identical payload cannot fix, whatever the status says. */
const DETERMINISTIC_CLASSES: ReadonlySet<RequestErrorClass> = new Set(['context_exceeded', 'payload_too_large', 'output_cap_rejected', 'missing_required_cap'])

/**
 * An independent statement of the model's maximum OUTPUT (not this request's
 * remaining room): OpenAI, Anthropic, Groq, DashScope, Gemini, Cohere forms.
 * `max_tokens is too large` alone is deliberately not here: vLLM uses it for
 * input + cap > window.
 */
const OUTPUT_CAP_INDEPENDENT = /supports at most \d+ completion tokens|max_tokens: \d+ > \d+, which is the maximum allowed|'max_(?:completion_)?tokens'[^.;]{0,80}above maximum value|`?max_(?:completion_)?tokens`?[^.;,]{0,40}?must be (?:less than or equal to|smaller than|less than|at most) `?\d+|range of max_tokens should be \[\d+,\s*\d+\]|max_output_tokens[^.;]{0,80}(?:range|exceed)/i

/** Genuine shared-window arithmetic: input + completion > window, in known forms. */
const SHARED_WINDOW_EVIDENCE = /maximum context length is \d+ tokens[^]{0,300}?(?:\(\d+ > \d+ - \d+\)|\d+ in the messages, \d+ in the completion|requested \d+ tokens)/i

/** The endpoint requires an output cap and none was sent (bounded forms). */
const MISSING_REQUIRED_CAP = /`?max_(?:completion_)?tokens`?(?: field)? (?:is required|is a required (?:field|parameter|property))|missing (?:the )?required (?:field|parameter|property)[^.]{0,20}`?max_(?:completion_)?tokens|`?max_(?:completion_)?tokens`?:? (?:field required|must be (?:provided|specified|set))/i

const PAYLOAD_TOO_LARGE = /payload too large|request entity too large|request too large|body (?:is )?too large/i
const QUOTA = /insufficient_quota|quota|billing|credit|balance/i

/** Statuses at which a request-shaped rejection (cap, missing cap) may arrive. */
function capRejectionStatus(status: number): boolean {
  return (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) || RELAY_STATUSES.has(status)
}

/**
 * Classify an HTTP (or gateway) error. Order matters:
 * 1. an independent output maximum wins — trimming history cannot fix it, even
 *    when the same text also reports a window overflow;
 * 2. a missing required cap;
 * 3. shared-window / payload evidence (status-gated: auth, quota and origin
 *    500 are never turned into an overflow; relays need explicit evidence);
 * 4. quota, auth, rate limit, server error, other request error.
 */
export function classifyRequestError(status: number, detail: string): RequestErrorClass {
  const text = detail.slice(0, WIRE_LIMITS.errorChars)
  if (capRejectionStatus(status) && OUTPUT_CAP_INDEPENDENT.test(text)) return 'output_cap_rejected'
  if (capRejectionStatus(status) && MISSING_REQUIRED_CAP.test(text)) return 'missing_required_cap'
  const requestStatus = status === 400 || status === 413 || status === 422
  if (requestStatus || RELAY_STATUSES.has(status)) {
    const shared = SHARED_WINDOW_EVIDENCE.test(text)
    // Cap wording without window arithmetic (`max_tokens is too large: N`) is
    // neither an overflow nor provably output-only: a plain request error.
    const capWordingOnly = OUTPUT_CAP_REJECTED.test(text) && !shared
    if (!capWordingOnly) {
      if (requestStatus && (status === 413 || PAYLOAD_TOO_LARGE.test(text)) && !shared) return 'payload_too_large'
      if (shared || (requestStatus ? CONTEXT_EXCEEDED.test(text) : EXPLICIT_CONTEXT_EXCEEDED.test(text))) return 'context_exceeded'
    }
  }
  if (QUOTA.test(text)) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server_error'
  return 'request'
}

const CONTEXT_EXCEEDED = /context[_ -]?(length|window)|maximum context|too (long|large|many tokens)|exceeds? (the )?(model'?s? )?(maximum|max|limit|context)|reduce the (length|size)|prompt is too long|input (is )?too long|tokens? (limit|exceeded)/i

/** Explicit model-window diagnostics survive relays that rewrite the HTTP status. */
const EXPLICIT_CONTEXT_EXCEEDED = /context[_ -]?(length|window)|maximum context|prompt is too long|input (is )?too long|too many tokens|tokens? (limit|exceeded)/i

/** Gateway statuses a relay substitutes for the upstream request error. */
const RELAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * The endpoint rejected the requested output cap itself (OpenAI, vLLM,
 * Anthropic, Groq, DashScope, Gemini, Cohere wordings). Shrinking the prompt
 * cannot fix that, so it is never a context overflow: the adapter relearns a
 * guessed cap, and an authoritative one surfaces for the operator to lower.
 */
const OUTPUT_CAP_REJECTED = /\bmax_(?:completion_)?tokens'?(?: or '?max_completion_tokens'?)? is too large|supports at most \d+ completion tokens|'max_(?:completion_)?tokens'[^.;]{0,80}above maximum value|`?max_(?:completion_)?tokens`?[^.;,]{0,40}?must be (?:less|smaller|at most)|max_tokens: \d+ > \d+, which is the maximum allowed|range of max_tokens should be|max_output_tokens[^.;]{0,80}(?:range|exceed)/i

/** Largest output limit ever accepted from an error text (the product output budget). */
const LEARNED_CAP_MAX = 256_000
/**
 * Smallest output limit ever accepted from an error text. A smaller "limit" is
 * far likelier a misread neighbouring field than a model's real maximum, and
 * learning it would cripple every later reply on the route: send no cap instead.
 */
const LEARNED_CAP_MIN = 256

/**
 * The model's maximum output when an endpoint's rejection names it, from
 * known formats only. `undefined` when no number can be read, for vLLM's
 * window form (`N > X - M`: that is this request's remaining room, never a
 * model limit — vLLM fills the window by itself when no cap is sent), for
 * anything but a safe integer in 1..256,000, and for a "limit" at or above
 * what was sent (`sent`), which cannot explain the rejection.
 */
export function outputLimitFromError(detail: string, sent?: number): number | undefined {
  const text = detail.slice(0, WIRE_LIMITS.errorChars)
  // Every number is anchored to the output-token field in the same clause, so
  // a neighbouring field (`temperature must be at most 2`) is never read as a
  // cap. vLLM's window form (`N > X - M`) matches none of these on purpose.
  const patterns = [
    /supports at most (\d{1,7}) completion tokens/i,
    /max_tokens: \d{1,9} > (\d{1,7}), which is the maximum allowed/i,
    /`?max_(?:completion_)?tokens`?[^.;,]{0,40}?must be (?:less than or equal to|at most|<=) `?(\d{1,7})`?/i,
    /'max_(?:completion_)?tokens': integer above maximum value\. Expected a value <= (\d{1,7})/i,
    /range of max_tokens should be \[\d{1,7},\s*(\d{1,7})\]/i,
    /max_output_tokens[^.;]{0,80}range[^0-9;]{0,40}\d{1,7}[^0-9;]{1,10}(\d{1,7})\s*\(exclusive\)/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    let value = Number(match[1])
    if (/\(exclusive\)/i.test(match[0])) value -= 1
    if (!Number.isSafeInteger(value) || value < LEARNED_CAP_MIN || value > LEARNED_CAP_MAX) return undefined
    if (sent !== undefined && value >= sent) return undefined
    return value
  }
  return undefined
}

/**
 * Whether an HTTP error says the request did not fit (shared window or
 * payload size), so a smaller assembly is the cure. Request errors
 * (400/413/422) match the broad wording; a relay's gateway status matches
 * only explicit window diagnostics. Auth failures, quota and origin 500s
 * never count. An independent output-cap rejection never counts either:
 * squeezing would only throw away history and resend the same cap.
 */
export function isContextExceeded(status: number, detail: string): boolean {
  const classification = classifyRequestError(status, detail)
  return classification === 'context_exceeded' || classification === 'payload_too_large'
}

/** A relay's error payload: OpenAI object shape, bare string, or anything else. */
function gatewayErrorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return JSON.stringify(error)
}

/**
 * A compact excerpt of an HTTP error body for the surfaced message. Only
 * structured JSON error payloads qualify (OpenAI `error` shape or a top-level
 * `message` string), whitespace-collapsed and capped: a proxy's HTML page or a
 * bare blob must never be pasted into the visible error, and an opaque status
 * like `400: unknown` must still tell the operator what the relay complained
 * about. The excerpt lands in the durable session log, so credentials are
 * redacted: the configured key verbatim, and anything shaped like a token
 * (an auth error commonly echoes the key it rejected).
 */
function httpErrorExcerpt(detail: string, apiKey: string): string {
  const trimmed = detail.trim()
  if (trimmed === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return ''
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const record = parsed as Record<string, unknown>
  let text: string | undefined
  if (record['error'] !== undefined && record['error'] !== null) text = gatewayErrorText(record['error'])
  else if (typeof record['message'] === 'string' && record['message'] !== '') text = record['message']
  if (text === undefined) return ''
  const flat = redactSecrets(text, apiKey).replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/** Token-shaped substrings: `sk-…`, `pk_…`, `key-…`, and `Bearer <token>`. */
const SECRET_SHAPES = /\b(?:sk|pk|rk|key|api[-_]?key)[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

function redactSecrets(text: string, apiKey: string): string {
  let out = text
  if (apiKey.length >= 4) out = out.split(apiKey).join('[redacted]')
  return out.replace(SECRET_SHAPES, '[redacted]')
}

/** The `usage` object of a completions chunk; cache fields vary by server. */
interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** OpenAI and most compatible gateways. */
  prompt_tokens_details?: { cached_tokens?: number } | null
  /** DeepSeek's spelling of the cached share. */
  prompt_cache_hit_tokens?: number
}

/** Validate a chunk's usage at the wire boundary; absent or malformed → undefined. */
function parseUsage(usage: WireUsage | null | undefined): TokenUsage | undefined {
  if (usage === null || usage === undefined || typeof usage.prompt_tokens !== 'number') return undefined
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  return {
    inputTokens: usage.prompt_tokens,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
    ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
  }
}

/** Emit accumulated calls once, with arguments parsed at the boundary. */
function* finishCalls(name: string, calls: readonly AccumulatedCall[]): Generator<StreamEvent> {
  if (calls.length === 0) return
  const batch = []
  for (const call of calls) {
    if (!call) throw protocolError('invalid_tool_input', 'sparse tool indices')
    batch.push({ id: call.id, name: call.name, args: parseArgs(name, call.argsString) })
  }
  validateToolBatch(batch)
  yield { type: 'toolCalls', calls: batch }
}

/** Parse strictly: missing/empty arguments are not repaired into an object. */
function parseArgs(name: string, argsString: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsString)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('tool arguments are not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw protocolError('invalid_tool_input', `${name}: invalid tool arguments JSON`)
  }
}
