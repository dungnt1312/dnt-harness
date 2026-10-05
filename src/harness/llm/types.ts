/**
 * The message and stream vocabulary shared by every provider and consumer:
 * messages (including tool traffic), one model request, tool schemas, and
 * the stream events a provider yields.
 */

/**
 * A provider-side failure: transport, wire format, or model output the
 * harness cannot act on. Adapters throw it at their wire boundary so the
 * turn loop records the turn as `turn/error` kind `provider` instead of a
 * generic internal failure — or worse, a silently completed empty turn.
 */
export class ProviderError extends Error {
  /**
   * True only when the failure left no model output behind and asking again is
   * safe and plausible (a stream that closed empty). Anything else — an HTTP
   * error the adapter already retried, a rejected request, a failure after
   * output started — stays false and fails the turn at once.
   */
  readonly retryable: boolean
  get transient(): boolean { return this.retryable }
  /**
   * True when the provider rejected the request because it does not fit the
   * model's context window. Asking again with a smaller request is the cure,
   * so the loop re-assembles under a tighter budget instead of failing.
   */
  get contextExceeded(): boolean { return this.reason === 'context_exceeded' }

  readonly reason: ProviderErrorReason
  readonly phase: ProviderErrorPhase
  /** False fences retries when physical transport cleanup could not be confirmed. */
  transportSettled = true
  readonly retryAfterMs: number | undefined
  readonly status: number | undefined

  constructor(message: string, options?: { readonly retryAfterMs?: number; readonly status?: number; readonly transient?: boolean; readonly contextExceeded?: boolean; readonly reason?: ProviderErrorReason; readonly phase?: ProviderErrorPhase }) {
    super(message)
    this.name = 'ProviderError'
    this.retryAfterMs = typeof options?.retryAfterMs === 'number' && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0 ? Math.min(30_000, Math.ceil(options.retryAfterMs)) : undefined
    this.status = Number.isSafeInteger(options?.status) && options!.status! >= 100 && options!.status! <= 599 ? options?.status : undefined
    this.reason = options?.reason ?? (options?.contextExceeded ? 'context_exceeded' : 'unknown')
    this.phase = options?.phase ?? 'stream'
    this.retryable = options?.transient === true
  }
}

/** One model-invoked tool call: `id` correlates the request with its result. */
export interface ToolCall {
  readonly id: string
  readonly name: string
  /** JSON object arguments; validated at the model-JSON boundary. */
  readonly args: Record<string, unknown>
}

/**
 * One piece of a multimodal message. Text-only messages keep using a bare
 * string, so nothing that never carries an image has to change.
 */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      /** `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
      readonly mediaType: string
      /** Base64 image bytes; providers build their own wire encoding from it. */
      readonly base64: string
      /** Original file name, used when a message must be flattened to text. */
      readonly name?: string
    }

/** One message in model history. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  /** Plain text, or ordered parts when the message carries images. */
  readonly content: string | readonly ContentPart[]
  /** Tool calls the assistant requested; assistant messages only. */
  readonly toolCalls?: readonly ToolCall[]
  /** Which call this result answers; tool messages only. */
  readonly toolCallId?: string
}

/**
 * The readable text of any message content. Images become a short placeholder
 * so summaries, titles, logs and budgets stay honest about what was there
 * instead of silently dropping it.
 */
export function messageText(content: string | readonly ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : `[image: ${part.name ?? part.mediaType}]`))
    .filter((text) => text !== '')
    .join('\n')
}

/** A tool's model-facing schema, joined into request assembly. */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  /** JSON-Schema-ish parameters object: `{ properties, required }`. */
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
  }
}

/** One model request, projected from the session log by `deriveMessages()`. */
export interface ModelRequest {
  /** Host-only assembly scope; hooks must check after awaits before side effects. Never serialized. */
  readonly assemblySignal?: AbortSignal
  /** Provider-specific model name; providers apply their own default. */
  readonly model?: string
  readonly messages: readonly ModelMessage[]
  /** Tool schemas the model may call this step; omitted when none. */
  readonly tools?: readonly ToolSchema[]
  /**
   * Host-stamped execution metadata: the registered provider that must
   * serve this request (e.g. the owning workspace's selection). It is
   * resolved by `LlmService.streamVia` at the dispatch boundary and never
   * reaches the wire — providers serialize known fields only.
   */
  readonly providerName?: string
  /**
   * Host-stamped thinking/reasoning level ('off' | 'minimal' | … | 'max').
   * Providers translate it into the model's DOCUMENTED request fields
   * (see model-catalog's `applyThinkingOverride`); it never serializes
   * directly onto the wire.
   */
  readonly thinkingLevel?: string
  /**
   * Host-only assembly hint, never serialized: how many times this request was
   * already rejected as too large. The context builder shrinks its budget by
   * level (see `squeezeBudget`) so a retry actually sends less.
   */
  readonly squeeze?: number
}

export type ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'unknown'
export type CompletionPolicy = 'strict' | 'finish-eof' | 'legacy-iterable'
export type ProviderErrorReason = 'cancelled' | 'connect' | 'read' | 'reset' | 'first_progress_timeout' | 'idle_timeout' | 'total_timeout' | 'rate_limit' | 'server_error' | 'auth_configuration' | 'quota' | 'context_exceeded' | 'malformed_protocol' | 'invalid_tool_input' | 'incomplete_completion' | 'output_limit' | 'length' | 'content_filter' | 'unknown'
export type ProviderErrorPhase = 'connect' | 'headers' | 'stream' | 'completion' | 'cleanup'
export interface ModelCompletion {
  readonly type: 'completion'
  readonly finishReason: ModelFinishReason
  readonly transport: 'done' | 'eof' | 'legacy'
  readonly policy: CompletionPolicy
  readonly transportSettled: boolean
}

/** What a provider yields while streaming one completion. */
export type StreamEvent =
  | ModelCompletion
  | { readonly type: 'delta'; readonly delta: string; readonly thinking?: true }
  // Model progress only: no partial arguments, execution or transcript entry.
  | { readonly type: 'toolCallProgress' }
  | { readonly type: 'toolCalls'; readonly calls: readonly ToolCall[] }
  | { readonly type: 'usage'; readonly usage: TokenUsage }

/** Provider-reported token accounting for one completion (not an estimate). */
export interface TokenUsage {
  /** Prompt tokens the provider billed, cached ones included. */
  readonly inputTokens: number
  /** The part of `inputTokens` served from the provider's prompt cache. */
  readonly cachedInputTokens?: number
  readonly outputTokens?: number
}

/**
 * A model provider: consumes a request, yields stream events — content
 * deltas as they arrive, then the accumulated tool calls. Providers never
 * touch sessions or the loop; the seam is the whole contract.
 */
export interface LlmProvider {
  /** Provider name used for `ctx.llm.use()` selection. */
  readonly name: string
  /** Model names this provider offers, for UI selection. */
  readonly models?: readonly string[]
  stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<StreamEvent>
}

/** Per-request stream options. */
export interface StreamOptions {
  readonly attribution?: import('./request-lifecycle.ts').AttemptAttribution
  /** Mandatory canonical sink, distinct from contained optional telemetry. */
  readonly recordAttempt?: (fact: import('./request-lifecycle.ts').AttemptFact) => Promise<void>
  /** Fires when the owning turn stops or its provider stream becomes inactive. */
  readonly signal?: AbortSignal
  /** Present under harness ownership: built-in adapters perform exactly one physical attempt. */
  readonly requestOwner?: import('./request-lifecycle.ts').LogicalRequest
  /** Adapter calls only after verified local transport settlement, including late cleanup. */
  readonly onTransportSettled?: () => void
}
