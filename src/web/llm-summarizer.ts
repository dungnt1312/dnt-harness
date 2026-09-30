/**
 * The host-side compaction summarizer: an LLM call against the session's
 * effective (provider, model) pair with the structured compaction prompt.
 * When no pair resolves, compaction still works via the bounded extractive
 * fallback — a degraded summary beats refusing to compact.
 */
import { COMPACT_SUMMARY_PROMPT, type Summarizer } from '../harness/context/compaction.ts'
import type { ModelRequest, StreamEvent } from '../harness/llm/types.ts'

/** One resolved (provider, model) pair the summarizer call runs on. */
export interface SummarizerPair {
  readonly providerName: string
  readonly model: string
}

/** The LLM entry point: `ctx.llm.stream` by any other name, for tests. */
export type StreamFn = (request: ModelRequest) => AsyncIterable<StreamEvent>

/** Bounded source: the projected conversation never feeds more than this. */
const MAX_INPUT_CHARS = 200_000
/** Bounded output: a summary larger than this stops being a summary. */
const MAX_SUMMARY_CHARS = 24_000

/**
 * The no-model fallback: keep the first lines of every exchange. No model
 * call, no side effects — the pre-existing host default, kept as the floor.
 */
export function extractiveSummary(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.slice(0, 120).join('\n')
}

export function createCompactionSummarizer(stream: StreamFn, pair: SummarizerPair | undefined): Summarizer {
  if (pair === undefined) return async ({ text }) => extractiveSummary(text)
  return async ({ text }) => {
    const trimmed = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text
    const request: ModelRequest = {
      model: pair.model,
      providerName: pair.providerName,
      messages: [{ role: 'user', content: `${COMPACT_SUMMARY_PROMPT}\n\n<conversation>\n${trimmed}\n</conversation>` }],
    }
    let summary = ''
    for await (const event of stream(request)) {
      // Thinking deltas are the model's scratchpad, never the answer.
      if (event.type === 'delta' && event.thinking !== true) summary += event.delta
    }
    const cleaned = summary.trim()
    if (cleaned === '') throw new Error('compaction summarizer returned an empty summary')
    return cleaned.length > MAX_SUMMARY_CHARS ? cleaned.slice(0, MAX_SUMMARY_CHARS) : cleaned
  }
}
