import { applyThinkingOverride } from './model-catalog.ts'
import { messageText, ProviderError } from './types.ts'
import type { LlmProvider, ModelMessage, ModelRequest, StreamEvent, StreamOptions, TokenUsage } from './types.ts'

interface StreamChoice {
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
  /** Extra attempts for 408/409/425/429/5xx or a connection failure before streaming starts (default 3). */
  readonly maxRetries?: number
  /** First backoff delay; doubles per attempt with jitter (default 1000ms). */
  readonly retryBaseMs?: number
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 1_000
/** A single wait never exceeds this, whatever `retry-after` asks for. */
const MAX_RETRY_DELAY_MS = 30_000
/** Error bodies are diagnostics: keep enough to explain, never an unbounded read. */
const MAX_ERROR_BODY_CHARS = 4_000
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

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

async function boundedText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}… [truncated]` : text
  } catch {
    return '(unreadable body)'
  }
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
    const maxAttempts = 1 + Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES)
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
        // A connection-level failure (reset, DNS, refused) is transient; a stop is not.
        if (signal?.aborted === true || attempt >= maxAttempts) throw error
        await sleep(backoffMs(attempt, this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS), signal)
        continue
      }
      if (response.ok) break
      const detail = await boundedText(response)
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxAttempts) {
        throw new ProviderError(`${this.name}: HTTP ${response.status}: ${detail}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`)
      }
      wait = retryAfterMs(response.headers.get('retry-after'))
      await sleep(Math.min(MAX_RETRY_DELAY_MS, wait ?? backoffMs(attempt, this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)), signal)
    }
    if (response.body === null) {
      throw new ProviderError(`${this.name}: empty response body`)
    }

    const calls: AccumulatedCall[] = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Gateways that fail upstream mid-stream answer 200 and then close
    // cleanly; without this flag that reads as a successful empty turn.
    let sawModelOutput = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          yield* finishCalls(this.name, calls)
          if (!sawModelOutput) throw new ProviderError(`${this.name}: stream ended without any model output`)
          return
        }
        let parsed: { choices?: StreamChoice[]; usage?: WireUsage | null; error?: unknown }
        try {
          parsed = JSON.parse(data) as { choices?: StreamChoice[]; usage?: WireUsage | null; error?: unknown }
        } catch (error) {
          throw new ProviderError(`${this.name}: malformed stream chunk '${data}': ${String(error instanceof Error ? error.message : error)}`)
        }
        // One API-style relays report upstream failures as an error object in
        // a 200 stream; that payload is the only diagnosis the user ever sees.
        if (parsed.error !== undefined) {
          throw new ProviderError(`${this.name}: gateway error: ${gatewayErrorText(parsed.error)}`)
        }
        const usage = parseUsage(parsed.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
        const delta = parsed.choices?.[0]?.delta
        const content = delta?.content
        // Reasoning-capable models emit thinking separately from content:
        // the thinking text never joins the answered content and is marked
        // for the UI as a `thinking` delta.
        if (typeof content === 'string' && content !== '') {
          sawModelOutput = true
          yield { type: 'delta', delta: content }
        }
        const thinking = delta?.reasoning_content
        if (typeof thinking === 'string' && thinking !== '') {
          sawModelOutput = true
          yield { type: 'delta', delta: thinking, thinking: true }
        }
        if (delta?.tool_calls !== undefined) {
          sawModelOutput = true
          for (const fragment of delta.tool_calls) {
            const index = fragment.index ?? 0
            const slot = calls[index] ?? { id: '', name: '', argsString: '' }
            if (fragment.id !== undefined) slot.id = fragment.id
            if (fragment.function?.name !== undefined) slot.name = fragment.function.name
            slot.argsString += fragment.function?.arguments ?? ''
            calls[index] = slot
          }
        }
      }
    }
    yield* finishCalls(this.name, calls)
    if (!sawModelOutput) throw new ProviderError(`${this.name}: stream ended without any model output`)
  }
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
  yield {
    type: 'toolCalls',
    calls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      args: parseArgs(name, call.argsString),
    })),
  }
}

/** Parse streamed JSON arguments; an empty body means no arguments. */
function parseArgs(name: string, argsString: string): Record<string, unknown> {
  if (argsString === '') return {}
  try {
    const parsed: unknown = JSON.parse(argsString)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('tool arguments are not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new ProviderError(`${name}: invalid tool arguments JSON '${argsString}': ${String(error instanceof Error ? error.message : error)}`)
  }
}
