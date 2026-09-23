/**
 * The message and stream vocabulary shared by every provider and consumer:
 * messages (including tool traffic), one model request, tool schemas, and
 * the stream events a provider yields.
 */

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
}

/** What a provider yields while streaming one completion. */
export type StreamEvent =
  | { readonly type: 'delta'; readonly delta: string; readonly thinking?: true }
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
  /** Fires when the owning turn stops or its provider stream becomes inactive. */
  readonly signal?: AbortSignal
}
