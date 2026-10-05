import { ProviderError } from './types.ts'
import type { LlmProvider, ModelCompletion, ModelFinishReason, StreamEvent, ToolCall } from './types.ts'

export const WIRE_LIMITS = Object.freeze({ frameBytes: 1024 * 1024, calls: 128, argumentBytes: 2 * 1024 * 1024, aggregateArgumentBytes: 8 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, errorBytes: 16 * 1024, errorChars: 4000 })
export const encodedBytes = (text: string): number => new TextEncoder().encode(text).byteLength
export function protocolError(reason: 'malformed_protocol' | 'invalid_tool_input' | 'output_limit' | 'incomplete_completion', message: string): ProviderError {
  return new ProviderError(message, { reason, phase: 'completion', transient: reason === 'incomplete_completion' })
}
export function normalizeFinishReason(raw: unknown): ModelFinishReason {
  return raw === 'stop' || raw === 'tool_calls' || raw === 'length' || raw === 'content_filter' || raw === 'error' ? raw : 'unknown'
}
export function validateCompletion(completion: ModelCompletion): void {
  if (!completion.transportSettled) throw new ProviderError('provider transport cleanup is unresolved', { reason: 'incomplete_completion', phase: 'cleanup' })
  if (completion.finishReason !== 'stop' && completion.finishReason !== 'tool_calls') {
    throw new ProviderError(`provider completion rejected: ${completion.finishReason}`, { reason: completion.finishReason === 'length' || completion.finishReason === 'content_filter' ? completion.finishReason : 'unknown', phase: 'completion' })
  }
  if (!((completion.transport === 'done' && completion.policy === 'strict') || (completion.transport === 'eof' && completion.policy === 'finish-eof') || (completion.transport === 'legacy' && completion.policy === 'legacy-iterable'))) {
    throw protocolError('malformed_protocol', 'inconsistent completion policy and transport')
  }
}
export function validateToolBatch(calls: readonly ToolCall[]): void {
  if (calls.length > WIRE_LIMITS.calls) throw protocolError('output_limit', 'too many tool calls')
  const ids = new Set<string>()
  let aggregate = 0
  for (const call of calls) {
    if (!call || typeof call.id !== 'string' || !call.id.trim() || typeof call.name !== 'string' || !call.name.trim() || ids.has(call.id)) throw protocolError('invalid_tool_input', 'invalid or duplicate tool identity')
    ids.add(call.id)
    if (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) throw protocolError('invalid_tool_input', 'tool arguments must be a JSON object')
    const size = encodedBytes(JSON.stringify(call.args))
    aggregate += size
    if (size > WIRE_LIMITS.argumentBytes || aggregate > WIRE_LIMITS.aggregateArgumentBytes) throw protocolError('output_limit', 'tool arguments exceed limit')
  }
}
/** Opt-in adapter for known legacy integrations. Never applied implicitly. */
export function withLegacyCompletion(provider: LlmProvider): LlmProvider {
  return {
    name: provider.name,
    ...(provider.models ? { models: provider.models } : {}),
    async *stream(request, options): AsyncIterable<StreamEvent> {
      let calls = false
      for await (const event of provider.stream(request, options)) {
        if (event.type === 'completion') throw protocolError('malformed_protocol', 'legacy provider already emits completion')
        if (event.type === 'toolCalls') { validateToolBatch(event.calls); calls = event.calls.length > 0 }
        yield event
      }
      yield { type: 'completion', finishReason: calls ? 'tool_calls' : 'stop', transport: 'legacy', policy: 'legacy-iterable', transportSettled: true }
    },
  }
}

/** Await transport cancellation for at most the spec cleanup grace. */
export async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, onSettled?: () => void): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Capture terminal stream failure BEFORE cancellation. cancel() on an
  // already-errored fetch body rejects with its stored AbortError; that is
  // different from an underlying source whose cancellation itself fails.
  let alreadyErrored = false
  const closed = reader.closed.then(() => {}, () => { alreadyErrored = true })
  await Promise.resolve()
  const confirm = (): boolean => { try { onSettled?.() } catch { /* notification only */ }; return true }
  try {
    return await Promise.race([
      alreadyErrored ? closed.then(confirm) : reader.cancel().then(confirm, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10_000); timer.unref?.() }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Byte-bounded diagnostic reader. Cancels at cap, releases the lock on every exit. */
export async function readBoundedError(response: Response, cleanup?: (settled: boolean) => void, onSettled?: () => void): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let count = 0
  let text = ''
  try {
    while (count < WIRE_LIMITS.errorBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const slice = value.subarray(0, WIRE_LIMITS.errorBytes - count)
      count += slice.length
      text += decoder.decode(slice, { stream: true })
    }
    text += decoder.decode()
    return text.slice(0, WIRE_LIMITS.errorChars)
  } catch { return '(unreadable body)' }
  finally { const settled = await cancelReader(reader, onSettled); cleanup?.(settled); reader.releaseLock() }
}

/** Complete SSE records only; multi-line data joins with newline, comments ignored. */
export async function* readSse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let line = ''
  let data: string[] = []
  let frameBytes = 0
  let pendingCR = false
  const countByte = (): void => {
    if (++frameBytes > WIRE_LIMITS.frameBytes) throw protocolError('output_limit', 'SSE frame exceeds byte limit')
  }
  const endLine = function* (): Generator<string> {
    if (line === '') {
      const record = data.length ? data.join('\n') : undefined
      data = []; frameBytes = 0
      if (record !== undefined) yield record
    } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    line = ''
  }
  const decode = (bytes?: Uint8Array): string => {
    try { return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }) }
    catch { throw protocolError('malformed_protocol', 'invalid SSE UTF-8') }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (pendingCR) { pendingCR = false; yield* endLine() }
      line += decode()
      break
    }
    let start = 0
    for (let index = 0; index < value.length; index++) {
      const byte = value[index]
      if (pendingCR) {
        pendingCR = false
        if (byte === 10) countByte()
        yield* endLine()
        if (byte === 10) { start = index + 1; continue }
      }
      countByte()
      if (byte === 10 || byte === 13) {
        // Decode only through this line: post-DONE bytes remain outside the response.
        line += decode(value.subarray(start, index)) + decode()
        start = index + 1
        if (byte === 13) pendingCR = true
        else yield* endLine()
      }
    }
    line += decode(value.subarray(start))
  }
  if (line !== '' || data.length) throw protocolError('malformed_protocol', 'incomplete SSE terminal tail')
}
