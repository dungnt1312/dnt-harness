/**
 * The host compaction summarizer: structured prompt + stream collection
 * (thinking deltas excluded), bounded input and output, an empty-summary
 * refusal, and the extractive fallback when no (provider, model) pair
 * resolves.
 */
import { describe, expect, it } from 'vitest'
import { COMPACT_SUMMARY_PROMPT } from '../../src/harness/context/compaction.ts'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import { createCompactionSummarizer, extractiveSummary } from '../../src/web/llm-summarizer.ts'

function scriptedStream(events: readonly StreamEvent[], seen: ModelRequest[]): (request: ModelRequest) => AsyncIterable<StreamEvent> {
  return (request) => {
    seen.push(request)
    return (async function* () {
      yield* events
    })()
  }
}

const PAIR = { providerName: 'prov', model: 'model-1' }

describe('llm compaction summarizer', () => {
  it('collects text deltas, skips thinking, and sends the structured prompt', async () => {
    const seen: ModelRequest[] = []
    const summarize = createCompactionSummarizer(scriptedStream([
      { type: 'delta', delta: 'scratch ', thinking: true },
      { type: 'delta', delta: 'Primary ' },
      { type: 'delta', delta: 'Request summary' },
    ], seen), PAIR)
    const summary = await summarize({ text: 'user: hello\nassistant: hi' })
    expect(summary).toBe('Primary Request summary')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.providerName).toBe('prov')
    expect(seen[0]!.model).toBe('model-1')
    const content = seen[0]!.messages[0]!.content
    expect(typeof content).toBe('string')
    expect(content as string).toContain('Primary Request and Intent')
    expect(content as string).toContain('<conversation>\nuser: hello\nassistant: hi\n</conversation>')
  })

  it('refuses an empty summary instead of storing it', async () => {
    const summarize = createCompactionSummarizer(scriptedStream([
      { type: 'delta', delta: 'chain of thought only', thinking: true },
    ], []), PAIR)
    await expect(summarize({ text: 'user: hello' })).rejects.toThrow(/empty summary/)
  })

  it('bounds the source conversation and the returned summary', async () => {
    const seen: ModelRequest[] = []
    const summarize = createCompactionSummarizer(scriptedStream([
      { type: 'delta', delta: 'x'.repeat(30_000) },
    ], seen), PAIR)
    const summary = await summarize({ text: 'y'.repeat(300_000) })
    expect(summary).toHaveLength(24_000)
    const content = seen[0]!.messages[0]!.content as string
    // prompt + '<conversation>' wrapper + at most 200k source chars
    expect(content.length).toBeLessThanOrEqual(COMPACT_SUMMARY_PROMPT.length + 200_000 + 40)
  })

  it('falls back to the extractive summary when no pair resolves', async () => {
    const seen: ModelRequest[] = []
    const summarize = createCompactionSummarizer(scriptedStream([{ type: 'delta', delta: 'should not run' }], seen), undefined)
    const summary = await summarize({ text: 'line one\n\nline two\nline three' })
    expect(summary).toBe('line one\nline two\nline three')
    expect(seen).toHaveLength(0)
  })

  it('the extractive summary keeps at most 120 non-empty lines', () => {
    const lines = Array.from({ length: 150 }, (_, index) => `line ${index}`)
    expect(extractiveSummary(lines.join('\n')).split('\n')).toHaveLength(120)
    expect(extractiveSummary('\n\n  \nkept\n')).toBe('kept')
  })
})
