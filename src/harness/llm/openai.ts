import { applyThinkingOverride } from './model-catalog.ts'
import { classifyTransport } from './request-lifecycle.ts'
import { cancelReader, encodedBytes, normalizeFinishReason, protocolError, readBoundedError, readSse, validateCompletion, validateToolBatch, WIRE_LIMITS } from './completion.ts'
import type { ModelCompletion, ModelFinishReason } from './types.ts'
import { messageText, ProviderError } from './types.ts'
import type { LlmProvider, ModelMessage, ModelRequest, StreamEvent, StreamOptions, TokenUsage } from './types.ts'

interface StreamChoice {
  finish_reason?: unknown
  delta?: {
    content?: string
    reasoning_content?: string
    tool_calls?: StreamToolCall[]
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

/** Gateway error `code` strings that unambiguously name a transient condition. */
const TRANSIENT_GATEWAY_CODES: ReadonlySet<string> = new Set(['server_error', 'rate_limit_exceeded', 'service_unavailable', 'overloaded_error'])

/** A gateway `code` is transient for 5xx-class numbers and known transient strings; text decides the rest. */
function gatewayCodeRetryable(code: unknown): boolean {
  if (typeof code === 'number') return code >= 500 || TRANSIENT_STATUS.has(code)
  return typeof code === 'string' && TRANSIENT_GATEWAY_CODES.has(code)
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
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(request.messages),
      ...(request.tools !== undefined && request.tools.length > 0
        ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) }
        : {}),
      stream: true,
      // The final chunk then carries `usage` (real prompt/cached counts),
      // which the context meter shows instead of a chars/4 estimate.
      stream_options: { include_usage: true },
    }
    applyThinkingOverride(body, model, request.thinkingLevel)
    const payload = JSON.stringify(body)
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
      const quota = /insufficient_quota|quota|billing|credit|balance/i.test(detail)
      const reason = isContextExceeded(response.status, detail) ? 'context_exceeded' : quota ? 'quota' : response.status === 401 || response.status === 403 ? 'auth_configuration' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server_error' : 'unknown'
      const retryable = !quota && retryableStatus(response.status, detail)
      if (!cleanupSettled || !retryable || attempt >= maxAttempts) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'))
        const error = new ProviderError(`provider HTTP ${response.status}: ${reason}`, { reason, phase: 'headers', transient: retryable, status: response.status, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) })
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
          const text = gatewayErrorText(parsed.error).slice(0, WIRE_LIMITS.errorChars)
          const quota = /quota|billing|credit|balance/i.test(text)
          const code = parsed.error !== null && typeof parsed.error === 'object' ? (parsed.error as { code?: unknown }).code : undefined
          // Default-retryable: a gateway error naming no recognizable permanent
          // condition gets the benefit of the doubt; only a permanent-looking
          // body opts out.
          const transient = !quota && (gatewayCodeRetryable(code) || !PERMANENT_GATEWAY_TEXT.test(text))
          const detail = text.slice(0, 300)
          throw new ProviderError(`provider gateway failure${detail === '' ? '' : `: ${detail}`}`, { reason: isContextExceeded(400, text) ? 'context_exceeded' : quota ? 'quota' : transient ? 'server_error' : 'unknown', transient })
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
        if ((content !== undefined && content !== null && typeof content !== 'string') || (delta?.reasoning_content !== undefined && typeof delta.reasoning_content !== 'string') || (delta?.tool_calls !== undefined && !Array.isArray(delta.tool_calls))) throw protocolError('malformed_protocol', 'invalid model delta')
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
        if (delta?.tool_calls !== undefined && delta.tool_calls.length > 0) {
          for (const fragment of delta.tool_calls) {
            if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment) || (fragment.function !== undefined && (fragment.function === null || typeof fragment.function !== 'object' || Array.isArray(fragment.function)))) throw protocolError('malformed_protocol', 'invalid tool fragment shape')
            const index = fragment.index
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= WIRE_LIMITS.calls) throw protocolError('invalid_tool_input', 'invalid tool index')
            const slot = calls[index] ?? { id: '', name: '', argsString: '' }
            if (fragment.id !== undefined) {
              if (typeof fragment.id !== 'string' || !fragment.id.trim() || (slot.id && slot.id !== fragment.id)) throw protocolError('invalid_tool_input', 'conflicting tool ID')
              slot.id = fragment.id
            }
            if (fragment.function?.name !== undefined) {
              const name = fragment.function.name
              if (typeof name !== 'string' || !name.trim() || (slot.name && slot.name !== name)) throw protocolError('invalid_tool_input', 'conflicting tool name')
              slot.name = name
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
      validateCompletion(completion)
      const batch = [...finishCalls(this.name, calls)]
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
        if (!cleanupAttempted) await cancelReader(reader, options?.onTransportSettled)
        reader.releaseLock()
      }
    }
  }
}

const CONTEXT_EXCEEDED = /context[_ -]?(length|window)|maximum context|too (long|large|many tokens)|exceeds? (the )?(model'?s? )?(maximum|max|limit|context)|reduce the (length|size)|prompt is too long|input (is )?too long|tokens? (limit|exceeded)/i

/** Whether an HTTP error says the request did not fit the model's window. */
export function isContextExceeded(status: number, detail: string): boolean {
  return (status === 400 || status === 413 || status === 422) && CONTEXT_EXCEEDED.test(detail)
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
