import { applyThinkingOverride, resolveOutputLimit } from './model-catalog.ts'
import { classifyTransport } from './request-lifecycle.ts'
import { cancelReader, encodedBytes, normalizeFinishReason, protocolError, readBoundedError, readSse, validateCompletion, validateToolBatch, WIRE_LIMITS } from './completion.ts'
import type { ModelCompletion, ModelFinishReason } from './types.ts'
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
   * Whether this endpoint accepts `prompt_cache_key`. Off unless declared:
   * strict relays reject unknown body fields. The affinity headers still flow
   * whenever a request stamps `sessionAffinity`.
   */
  readonly supportsPromptCacheKey?: boolean
  /** Whether this endpoint understands `store`. Only then is `store: false` sent. */
  readonly supportsStore?: boolean
  /** Whether the final stream chunk carries `usage` (default true). */
  readonly supportsUsageInStreaming?: boolean
  /**
   * Wait for response headers before giving up on one physical attempt.
   * Unset means no separate deadline: the existing stream timers apply.
   */
  readonly headerTimeoutMs?: number
  /**
   * Wire-contract expectations. `'expect'` reads a repeated tool-call index
   * that arrives with a fresh id as a re-sent header (see the adapter's
   * tool-call assembly); `'tolerate'` is the default.
   */
  readonly wire?: {
    readonly toolCallIdReuse?: 'tolerate' | 'expect'
  }
}

/**
 * OpenAI itself, recognized by host only. A provider merely *named* "openai"
 * is often a relay (LiteLLM, Azure, vLLM, llama.cpp) that would reject `store`
 * or ignore `max_completion_tokens`, so the name never opts an endpoint in.
 */
const isOpenAiNative = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

/**
 * Providers documented to take the legacy `max_tokens` field even though
 * their endpoint is not OpenAI's; mirrors opencode's `openai-chat` list.
 */
const LEGACY_MAX_TOKENS_PROVIDERS: ReadonlySet<string> = new Set([
  'deepseek', 'moonshotai', 'togetherai', 'together', 'zai', 'zai-coding-plan',
  'zhipuai', 'zhipuai-coding-plan', 'nvidia', 'cerebras', 'chutes',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai',
])
const LEGACY_MAX_TOKENS_HOSTS: readonly string[] = [
  'deepseek.com', 'api.moonshot.', 'api.together.', 'api.z.ai', 'open.bigmodel.cn',
  'integrate.api.nvidia.com', 'cerebras.ai', 'llm.chutes.ai',
  'gateway.ai.cloudflare.com', 'api.cloudflare.com',
]

/**
 * Which body field carries the output cap. OpenAI-native endpoints take
 * `max_completion_tokens` — the field their newer models require — while the
 * documented compatible families above keep `max_tokens`. An endpoint that
 * cannot be recognized keeps `max_tokens` too: an arbitrarily named gateway is
 * far more likely to be a compatible relay than OpenAI itself, so shipping
 * SR-0 must not change what existing deployments receive.
 */
export function detectMaxTokensField(name: string, baseUrl: string): 'max_tokens' | 'max_completion_tokens' {
  if (LEGACY_MAX_TOKENS_PROVIDERS.has(name.toLowerCase())) return 'max_tokens'
  const url = baseUrl.toLowerCase()
  if (LEGACY_MAX_TOKENS_HOSTS.some((host) => url.includes(host))) return 'max_tokens'
  return isOpenAiNative(baseUrl) ? 'max_completion_tokens' : 'max_tokens'
}

/** Only OpenAI-native endpoints are known to accept an explicit `store`. */
export function detectSupportsStore(_name: string, baseUrl: string): boolean {
  return isOpenAiNative(baseUrl)
}

/** `prompt_cache_key` is documented at 64 characters. */
const OPENAI_PROMPT_CACHE_KEY_MAX = 64

/**
 * Diagnostics: how many times a re-sent tool-call header (a fresh id at an
 * index that already carried this call's id) was tolerated instead of failing
 * the turn. Non-zero means the endpoint's wire contract is looser than the
 * standard one.
 */
let toolCallIdReissues = 0

/** Read the process-wide count of tolerated tool-call id re-sends. */
export function toolCallIdReissueCount(): number {
  return toolCallIdReissues
}

/**
 * Lower the host-approved subset of `providerOptions` onto the body. Only
 * fields with a documented chat-completions meaning are serialized; anything
 * else is dropped rather than forwarded, because one unknown field makes a
 * strict gateway reject the whole request.
 */
export function applyProviderOptions(body: Record<string, unknown>, options: Readonly<Record<string, unknown>> | undefined, hasTools: boolean): void {
  if (options === undefined) return
  // A tool choice without tools is meaningless; sending it would be rejected.
  const choice = options['toolChoice']
  if (hasTools) {
    if (choice === 'auto' || choice === 'none' || choice === 'required') body['tool_choice'] = choice
    else if (choice !== null && typeof choice === 'object' && !Array.isArray(choice) && typeof (choice as { name?: unknown }).name === 'string') {
      body['tool_choice'] = { type: 'function', function: { name: (choice as { name: string }).name } }
    }
  }
  const parallel = options['parallelToolCalls']
  if (typeof parallel === 'boolean') body['parallel_tool_calls'] = parallel
  const format = options['responseFormat']
  if (format === 'text' || format === 'json_object') body['response_format'] = { type: format }
  else if (format !== null && typeof format === 'object' && !Array.isArray(format)) body['response_format'] = format
  const stop = options['stop']
  if (Array.isArray(stop)) {
    const sequences = stop.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    if (sequences.length > 0) body['stop'] = sequences
  }
}

/** Sent when neither the operator nor the catalog knows the model's output limit. */
const OUTPUT_TOKEN_FALLBACK = 32_000
/** Upper bound on any cap: a larger request only risks a rejection. */
const OUTPUT_TOKEN_MAX = 256_000
/**
 * The window ceiling never squeezes the cap below this: a near-full window
 * still leaves room for a usable reply, and an over-tight estimate surfaces as
 * a context overflow (which compacts) instead of a uselessly short answer.
 */
const OUTPUT_TOKEN_MIN = 1_024

/**
 * The output-token cap sent as `max_tokens`: an operator override, else the
 * catalog's documented maximum, else a 32,000-token fallback (the same
 * numbers opencode uses). The fallback avoids gateway defaults that can cut
 * long replies off with finish `length`.
 */
export function outputTokenCap(model: string, overrides?: Readonly<Record<string, number>>, requested?: number, ceiling?: number): number {
  const override = overrides?.[model]
  const known = Math.min(
    override !== undefined && Number.isSafeInteger(override) && override > 0 ? override : resolveOutputLimit(model) ?? OUTPUT_TOKEN_FALLBACK,
    OUTPUT_TOKEN_MAX,
  )
  // A request may only lower the catalog, operator or fallback cap.
  const cap = requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(known, requested)
    : known
  return ceiling !== undefined && Number.isSafeInteger(ceiling) && ceiling > 0 ? Math.min(cap, Math.max(OUTPUT_TOKEN_MIN, ceiling)) : cap
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

  constructor(private readonly options: OpenAiCompletionsOptions) {
    this.name = options.name
    this.models = options.models ?? []
    this.fallbackModel = options.models?.[0] ?? 'default'
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
    const maxTokensField = this.options.maxTokensField ?? detectMaxTokensField(this.name, this.options.baseUrl)
    const supportsStore = this.options.supportsStore ?? detectSupportsStore(this.name, this.options.baseUrl)
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(request.messages),
      ...(hasTools
        ? { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) }
        : {}),
      stream: true,
      // The final chunk then carries `usage` (real prompt/cached counts),
      // which the context meter shows instead of a raw estimate.
      ...(this.options.supportsUsageInStreaming !== false ? { stream_options: { include_usage: true } } : {}),
      // Stateless by default where the flag exists; every other endpoint omits
      // the field entirely rather than risk rejecting an unknown one.
      ...(supportsStore ? { store: false } : {}),
    }
    const maxTokens = outputTokenCap(model, this.options.maxOutputTokens, request.maxOutputTokens, request.outputCeilingTokens)
    if (maxTokens !== undefined) body[maxTokensField] = maxTokens
    applyThinkingOverride(body, model, request.thinkingLevel, maxTokens)
    applyProviderOptions(body, request.providerOptions, hasTools)
    // Off unless the endpoint declares support: strict relays reject unknown
    // body fields. The affinity headers below flow regardless.
    if (this.options.supportsPromptCacheKey === true && affinity !== undefined && affinity !== '') {
      body['prompt_cache_key'] = affinity.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX)
    }
    const payload = JSON.stringify(body)
    const signal = options?.signal
    // Standalone use retains a bounded header-only retry policy; harness use never stacks it.
    const maxAttempts = options?.requestOwner ? 1 : Math.min(4, 1 + Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES))
    let response: Response
    // The caller's abort is forwarded to the attempt controller for as long as
    // that attempt's body may still be read, not just until headers arrive:
    // the response body is bound to the attempt signal, so dropping the
    // forwarder early would leave a cancelled run blocked in `read()`.
    let detachAbort = (): void => {}
    // Retry only before the stream starts: nothing has been yielded, so a
    // second request cannot duplicate output. Rate limits and transient
    // gateway/server failures are retried with backoff; everything else
    // (auth, bad request, a mid-stream failure) surfaces at once.
    for (let attempt = 1; ; attempt++) {
      let wait: number | undefined
      // A header deadline is opt-in: without one this loop behaves exactly as
      // before. Each physical attempt gets its own timer and controller.
      const headerTimeout = this.options.headerTimeoutMs
      const attemptController = headerTimeout === undefined ? undefined : new AbortController()
      const forwardAbort = (): void => attemptController?.abort(signal?.reason)
      const headerTimer = attemptController === undefined || headerTimeout === undefined
        ? undefined
        : setTimeout(() => attemptController.abort(new ProviderError(`provider sent no response headers within ${headerTimeout}ms`, { reason: 'first_progress_timeout', phase: 'headers', transient: true })), headerTimeout)
      if (attemptController !== undefined) {
        if (signal?.aborted === true) attemptController.abort(signal.reason)
        else signal?.addEventListener('abort', forwardAbort, { once: true })
      }
      detachAbort = () => signal?.removeEventListener('abort', forwardAbort)
      const wireSignal = attemptController?.signal ?? signal
      try {
        response = await fetch(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          ...(wireSignal !== undefined ? { signal: wireSignal } : {}),
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
        const deadline = attemptController?.signal.reason instanceof ProviderError ? attemptController.signal.reason : undefined
        const classified = signal?.aborted
          ? new ProviderError('provider request cancelled', { reason: 'cancelled', phase: 'connect' })
          : deadline ?? classifyTransport(error, 'connect')
        detachAbort()
        if (!classified.retryable || attempt >= maxAttempts) throw classified
        await sleep(backoffMs(attempt, this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS), signal)
        continue
      } finally {
        if (headerTimer !== undefined) clearTimeout(headerTimer)
      }
      if (response.ok) break
      let cleanupSettled = true
      const detail = await boundedText(response, settled => { cleanupSettled = settled }, options?.onTransportSettled)
      detachAbort()
      const quota = /insufficient_quota|quota|billing|credit|balance/i.test(detail)
      const reason = isContextExceeded(response.status, detail) ? 'context_exceeded' : quota ? 'quota' : response.status === 401 || response.status === 403 ? 'auth_configuration' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server_error' : 'unknown'
      const retryable = reason !== 'context_exceeded' && !quota && retryableStatus(response.status, detail)
      if (!cleanupSettled || !retryable || attempt >= maxAttempts) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'))
        const excerpt = httpErrorExcerpt(detail, this.options.apiKey)
        const error = new ProviderError(`provider HTTP ${response.status}: ${reason}${excerpt === '' ? '' : `: ${excerpt}`}`, { reason, phase: 'headers', transient: retryable, status: response.status, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) })
        error.transportSettled = cleanupSettled
        throw error
      }
      wait = retryAfterMs(response.headers.get('retry-after'))
      await sleep(Math.min(MAX_RETRY_DELAY_MS, wait ?? backoffMs(attempt, this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)), signal)
    }
    if (response.body === null) {
      detachAbort()
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
          const contextExceeded = isContextExceeded(400, text)
          // Default-retryable, but permanent diagnostics always win over a
          // transient gateway code. Context errors require squeezing, not replay.
          const transient = !contextExceeded && !quota && !PERMANENT_GATEWAY_TEXT.test(text)
          const detail = text.slice(0, 300)
          throw new ProviderError(`provider gateway failure${detail === '' ? '' : `: ${detail}`}`, { reason: contextExceeded ? 'context_exceeded' : quota ? 'quota' : transient ? 'server_error' : 'unknown', transient })
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
                if (slot.id && slot.id !== id) {
                  // A gateway may re-send the tool-call header with a fresh id at
                  // the same index. While no arguments accumulated the slot still
                  // describes one call, so the last header wins. Once arguments
                  // exist the two ids would merge different calls into one
                  // executable batch: a hard failure, unless the endpoint is
                  // declared to re-send headers (`wire.toolCallIdReuse: 'expect'`,
                  // where the accumulated arguments and name are kept).
                  if (slot.argsString !== '' && this.options.wire?.toolCallIdReuse !== 'expect') throw protocolError('invalid_tool_input', 'conflicting tool ID')
                  toolCallIdReissues += 1
                }
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
      detachAbort()
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

const CONTEXT_EXCEEDED = /context[_ -]?(length|window)|maximum context|too (long|large|many tokens)|exceeds? (the )?(model'?s? )?(maximum|max|limit|context)|reduce the (length|size)|prompt is too long|input (is )?too long|tokens? (limit|exceeded)/i

/** Explicit model-window diagnostics survive relays that rewrite the HTTP status. */
const EXPLICIT_CONTEXT_EXCEEDED = /context[_ -]?(length|window)|maximum context|prompt is too long|input (is )?too long|too many tokens|tokens? (limit|exceeded)/i

/** Gateway statuses a relay substitutes for the upstream request error. */
const RELAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * The endpoint rejected the requested output cap itself (OpenAI, vLLM,
 * Anthropic, Cohere wordings). Shrinking the prompt cannot fix that, so it is
 * never a context overflow; the operator lowers the model's output cap.
 */
const OUTPUT_CAP_REJECTED = /\bmax_(?:completion_)?tokens'?(?: or '?max_completion_tokens'?)? is too large|supports at most \d+ completion tokens|'max_(?:completion_)?tokens'[^.]*above maximum value|max_tokens must be (?:less|smaller|at most)|max_tokens: \d+ > \d+, which is the maximum allowed/i

/**
 * Whether an HTTP error says the request did not fit the model's window.
 * Request errors (400/413/422) match the broad wording; a relay's gateway
 * status matches only explicit window diagnostics. Auth failures and origin
 * 500s never count: the request may fit, and squeezing would hide the fault.
 * A rejected output cap never counts either: squeezing would only throw away
 * history and resend the same cap.
 */
export function isContextExceeded(status: number, detail: string): boolean {
  if (OUTPUT_CAP_REJECTED.test(detail)) return false
  if (status === 400 || status === 413 || status === 422) return CONTEXT_EXCEEDED.test(detail)
  return RELAY_STATUSES.has(status) && EXPLICIT_CONTEXT_EXCEEDED.test(detail)
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
