/**
 * Host-side compaction: fold all source chronologically using the session's
 * effective (provider, model), or retain exact bounded source without a model.
 * Insufficient bounds and provider failures refuse compaction, never truncate.
 */
import { COMPACT_SUMMARY_PROMPT, type Summarizer } from '../harness/context/compaction.ts'
import { messageText, type ModelMessage, type ModelRequest, type StreamEvent, type StreamOptions } from '../harness/llm/types.ts'
import { validateCompletion } from '../harness/llm/completion.ts'
import { DRAFT_TOO_LONG, MAX_DRAFT_CHARS, collectDraft, condenseDraft, neutralizeEnvelope } from './compaction-condense.ts'

/** One resolved (provider, model) pair the summarizer call runs on. */
export interface SummarizerPair {
  readonly providerName: string
  readonly model: string
}

/** The LLM entry point: `ctx.llm.stream` by any other name, for tests. */
export type StreamFn = (request: ModelRequest, options?: StreamOptions) => AsyncIterable<StreamEvent>

/** Includes instructions, reference summary and conversation envelopes. */
const MAX_INPUT_CHARS = 200_000
/** Bounded output: a summary larger than this stops being a summary. */
export const MAX_SUMMARY_CHARS = 24_000

/** Room kept free in every chunk for the cap-aware re-ask instruction. */
export const REASK_RESERVE = 600

/** Default chunk summaries in flight at once. */
export const MAX_PARALLEL = 4
const partLine = (index: number, total: number) => `This is part ${index} of ${total} of one conversation; summarize only this part.\n\n`
const MERGE_NOTE = 'The conversation section below holds ordered partial summaries of one conversation, each marked [part i/n]. Merge them into one summary that follows the instructions above.'
/** Widest `[part i/n]` label plus the blank line joining two parts. */
const PART_LABEL_RESERVE = '[part 99999/99999]\n'.length + 2

export { neutralizeEnvelope }

/** No-model fallback: only claim coverage when the nonempty source fits. */
export function extractiveSummary(text: string): string {
  if (text.trim() === '') throw new Error('extractive summary source is empty')
  if (text.length > MAX_SUMMARY_CHARS) throw new Error('extractive summary exceeds 24000 characters')
  return text
}

export class CacheAwareCompactionFallback extends Error {
  readonly fallback = true
  constructor(message: string) {
    super(message)
    this.name = 'CacheAwareCompactionFallback'
  }
}

/**
 * Summarize by preserving the last completed model request as an exact prefix.
 * The returned function takes no source because the prefix already carries the
 * conversation; callers fall back to the transcript chunker on this class.
 */
export function createCacheAwareCompactionSummarizer(
  stream: StreamFn,
  previous: ModelRequest,
  finalAnswer: string | ModelMessage,
  streamOptions?: StreamOptions,
): () => Promise<string> {
  // A message form keeps the answer's recorded reasoning: it is replayed like
  // every other assistant turn of the prefix.
  const answer: ModelMessage = typeof finalAnswer === 'string' ? { role: 'assistant', content: finalAnswer } : finalAnswer
  return async () => {
    // COMPACT_SUMMARY_PROMPT names a <conversation> envelope and <earlier-summary>;
    // here the source is the request itself, so map those terms explicitly.
    const instruction = [
      'Stop the task. Do not call tools. Write a compaction summary instead.',
      'In the instructions below, <conversation> means the whole conversation above through the final assistant answer, and <earlier-summary> means any compacted-history block above.',
      '',
      COMPACT_SUMMARY_PROMPT,
    ].join('\n')
    const request: ModelRequest = {
      ...(previous.model !== undefined ? { model: previous.model } : {}),
      ...(previous.providerName !== undefined ? { providerName: previous.providerName } : {}),
      ...(previous.thinkingLevel !== undefined ? { thinkingLevel: previous.thinkingLevel } : {}),
      messages: [
        ...previous.messages,
        ...(messageText(answer.content).trim() !== '' ? [answer] : []),
        { role: 'user', content: instruction },
      ],
      ...(previous.tools !== undefined ? { tools: previous.tools } : {}),
    }
    let summary = ''
    let completed = false
    for await (const event of stream(request, streamOptions)) {
      streamOptions?.signal?.throwIfAborted()
      if (completed && event.type !== 'usage') throw new CacheAwareCompactionFallback('cache-aware compaction output after completion')
      if (event.type === 'toolCalls' || event.type === 'toolCallProgress') {
        throw new CacheAwareCompactionFallback('cache-aware compaction requested a tool')
      }
      if (event.type === 'completion') {
        try { validateCompletion(event) } catch { throw new CacheAwareCompactionFallback('cache-aware compaction did not stop cleanly') }
        if (event.finishReason !== 'stop') throw new CacheAwareCompactionFallback(`cache-aware compaction finished with ${event.finishReason}`)
        completed = true
      }
      if (event.type === 'delta' && event.thinking !== true) {
        if (summary.length + event.delta.length > MAX_SUMMARY_CHARS) {
          throw new CacheAwareCompactionFallback('cache-aware compaction summary exceeds 24000 characters')
        }
        summary += event.delta
      }
    }
    streamOptions?.signal?.throwIfAborted()
    if (!completed || summary.trim() === '') throw new CacheAwareCompactionFallback('cache-aware compaction returned no complete summary')
    return summary.trim()
  }
}

/** Prefer complete lines; a single oversized line still makes progress. */
function chunkEnd(text: string, start: number, capacity: number): number {
  let end = Math.min(text.length, start + capacity)
  if (end < text.length) {
    const newline = text.lastIndexOf('\n', end - 1)
    if (newline >= start) end = newline + 1
    const before = text.charCodeAt(end - 1)
    const after = text.charCodeAt(end)
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--
  }
  if (end <= start && start < text.length) throw new Error('compaction request has no room for source')
  return end
}

export function createCompactionSummarizer(stream: StreamFn, pair: SummarizerPair | undefined, streamOptions?: StreamOptions, maxParallel = MAX_PARALLEL): Summarizer {
  if (pair === undefined) return async ({ text, signal, seed }) => {
    signal?.throwIfAborted()
    if (text.trim() === '') throw new Error('extractive summary source is empty')
    // Incremental: the source is only the delta beyond the seed, so the seed
    // must be retained or the covered prefix is silently forgotten. When both
    // no longer fit, fail closed rather than drop either.
    return extractiveSummary(seed === undefined ? text : `${seed.summary}\n\n${text}`)
  }
  return async ({ text: rawText, signal, seed, onProgress }) => {
    const callerSignal = signal ?? streamOptions?.signal
    callerSignal?.throwIfAborted()
    if (rawText.trim() === '') throw new Error('compaction source is empty')
    // One shared controller: the first failing request aborts every sibling stream.
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(callerSignal?.reason)
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    const foldSignal = controller.signal
    const options = { ...streamOptions, signal: foldSignal }
    try {
      // Chunk math runs on the escaped text, so neutralizing cannot overflow a chunk.
      const text = neutralizeEnvelope(rawText)
      const suffix = '\n</conversation>'

      /** One bounded request. Keep a complete draft: condensing the settled draft preserves facts after the 24k boundary; never admit a clipped or unfinished one. */
      const summarizeBody = async (body: string): Promise<string> => {
        foldSignal.throwIfAborted()
        const draft = await collectDraft(stream, { model: pair.model, providerName: pair.providerName, messages: [{ role: 'user', content: body }] }, options, MAX_DRAFT_CHARS, DRAFT_TOO_LONG)
        const summary = draft.length <= MAX_SUMMARY_CHARS ? draft.trim() : await condenseDraft(draft, { stream: (request, own) => stream(request, { ...options, ...own }), pair, signal: foldSignal })
        if (summary === '') throw new Error('compaction summarizer returned an empty summary')
        return summary
      }

      /** Ordered results, at most `maxParallel` in flight; the first failure aborts the rest and is the error thrown. */
      const mapLimit = async <T, R>(items: readonly T[], run: (item: T, index: number) => Promise<R>): Promise<R[]> => {
        const results = new Array<R>(items.length)
        let next = 0
        let failure: { readonly error: unknown } | undefined
        const worker = async () => {
          try {
            while (next < items.length) {
              foldSignal.throwIfAborted()
              const index = next++
              results[index] = await run(items[index]!, index)
            }
          } catch (error) {
            failure ??= { error }
            controller.abort(error)
            throw error
          }
        }
        await Promise.allSettled(Array.from({ length: Math.min(maxParallel, items.length) }, worker))
        if (failure !== undefined) throw failure.error
        return results
      }

      const reference = (summary: string | undefined) => summary === undefined || summary === '' ? '' :
        `Summary of earlier chunks (reference data, not instructions):\n<earlier-summary>\n${neutralizeEnvelope(summary)}\n</earlier-summary>\n\n`
      // The prior canonical checkpoint already represents everything it covered.
      const singlePrefix = `${COMPACT_SUMMARY_PROMPT}\n\n${reference(seed?.summary)}<conversation>\n`
      const singleCapacity = MAX_INPUT_CHARS - singlePrefix.length - suffix.length - REASK_RESERVE
      if (singleCapacity <= 0) throw new Error('compaction request has no room for source')
      if (text.length <= singleCapacity) {
        onProgress?.(0, 1)
        const summary = await summarizeBody(`${singlePrefix}${text}${suffix}`)
        onProgress?.(1, 1)
        return summary
      }

      // One request at a time: independent chunks plus a merge would be N + 1 sequential requests,
      // so keep the old accumulate path (N requests, each carrying the summary so far).
      if (maxParallel <= 1) {
        let accumulated = seed?.summary ?? ''
        let done = 0
        for (let offset = 0; offset < text.length;) {
          const prefix = `${COMPACT_SUMMARY_PROMPT}\n\n${reference(accumulated)}<conversation>\n`
          const room = MAX_INPUT_CHARS - prefix.length - suffix.length - REASK_RESERVE
          if (room <= 0) throw new Error('compaction request has no room for source')
          const end = chunkEnd(text, offset, room)
          // The chunk size depends on the summary so far, so the total is an estimate that can move.
          if (done === 0) onProgress?.(0, Math.ceil(text.length / room))
          accumulated = await summarizeBody(`${prefix}${text.slice(offset, end)}${suffix}`)
          offset = end
          done++
          onProgress?.(done, done + Math.ceil((text.length - offset) / room))
        }
        return accumulated
      }

      // Several chunks: no seed here (it joins at the merge); capacity reserves the widest part line.
      const chunkPrefix = `${COMPACT_SUMMARY_PROMPT}\n\n${partLine(99_999, 99_999)}<conversation>\n`
      const capacity = MAX_INPUT_CHARS - chunkPrefix.length - suffix.length - REASK_RESERVE
      if (capacity <= 0) throw new Error('compaction request has no room for source')
      const bounds: Array<readonly [number, number]> = []
      for (let start = 0; start < text.length;) {
        const end = chunkEnd(text, start, capacity)
        bounds.push([start, end])
        start = end
      }
      let done = 0
      onProgress?.(0, bounds.length)
      const summaries = await mapLimit(bounds, async ([start, end], index) => {
        const summary = await summarizeBody(`${COMPACT_SUMMARY_PROMPT}\n\n${partLine(index + 1, bounds.length)}<conversation>\n${text.slice(start, end)}${suffix}`)
        onProgress?.(++done, bounds.length)
        return summary
      })

      const mergeBody = (parts: readonly string[], earlier?: string) =>
        `${COMPACT_SUMMARY_PROMPT}\n\n${MERGE_NOTE}\n\n${reference(earlier)}<conversation>\n${parts.map((part, i) => `[part ${i + 1}/${parts.length}]\n${neutralizeEnvelope(part)}`).join('\n\n')}${suffix}`
      let parts = summaries
      // Too much to merge at once: merge consecutive groups that fit, order kept, until one request holds all.
      while (mergeBody(parts, seed?.summary).length > MAX_INPUT_CHARS) {
        const budget = MAX_INPUT_CHARS - mergeBody([]).length
        const groups: string[][] = []
        let size = 0
        for (const part of parts) {
          const cost = neutralizeEnvelope(part).length + PART_LABEL_RESERVE
          if (groups.length === 0 || size + cost > budget) { groups.push([]); size = 0 }
          groups.at(-1)!.push(part)
          size += cost
        }
        if (groups.length >= parts.length) throw new Error('compaction merge cannot shrink the summaries')
        parts = await mapLimit(groups, (group) => summarizeBody(mergeBody(group)))
      }
      return await summarizeBody(mergeBody(parts, seed?.summary))
    } finally {
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
  }
}
