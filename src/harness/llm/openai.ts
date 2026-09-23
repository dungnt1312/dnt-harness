import { applyThinkingOverride } from './model-catalog.ts'
import { messageText } from './types.ts'
import type { LlmProvider, ModelMessage, ModelRequest, StreamEvent, StreamOptions } from './types.ts'

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
    }
    applyThinkingOverride(body, model, request.thinkingLevel)
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      headers: {
        'content-type': 'application/json',
        // Local gateways often accept no credential at all; sending an empty
        // Bearer makes some of them reject the call outright.
        ...(this.options.apiKey === '' ? {} : { authorization: `Bearer ${this.options.apiKey}` }),
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`${this.name}: HTTP ${response.status}: ${await response.text()}`)
    }
    if (response.body === null) {
      throw new Error(`${this.name}: empty response body`)
    }

    const calls: AccumulatedCall[] = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
          return
        }
        const parsed = JSON.parse(data) as { choices?: StreamChoice[] }
        const delta = parsed.choices?.[0]?.delta
        const content = delta?.content
        // Reasoning-capable models emit thinking separately from content:
        // the thinking text never joins the answered content and is marked
        // for the UI as a `thinking` delta.
        if (typeof content === 'string' && content !== '') yield { type: 'delta', delta: content }
        const thinking = delta?.reasoning_content
        if (typeof thinking === 'string' && thinking !== '') yield { type: 'delta', delta: thinking, thinking: true }
        if (delta?.tool_calls !== undefined) {
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
    throw new Error(`${name}: invalid tool arguments JSON '${argsString}': ${String(error)}`)
  }
}
