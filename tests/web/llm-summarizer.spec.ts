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

  it('folds every character of a >1.1M transcript and carries latest state forward', async () => {
    const markers = ['START_STATE', 'MIDDLE_STATE', 'END_STATE', '44f6ada', '60 suites / 1.204 tests',
      'browser audio acceptance', 'media smoke automation', 'production secret rotation', 'flake monitoring']
    const text = `${markers[0]}\n${'synthetic exchange\n'.repeat(33_000)}${markers[1]}\n${'synthetic exchange\n'.repeat(33_000)}${markers.slice(2).join('\n')}`
    expect(text.length).toBeGreaterThan(1_100_000)
    const seen: ModelRequest[] = []
    const chunks: string[] = []
    const outputs: string[] = []
    const summarize = createCompactionSummarizer((request) => (async function* () {
      seen.push(request)
      const content = request.messages[0]!.content as string
      expect(content.length).toBeLessThanOrEqual(200_000)
      const source = content.slice(content.indexOf('<conversation>\n') + '<conversation>\n'.length, content.lastIndexOf('\n</conversation>'))
      chunks.push(source)
      if (outputs.length > 0) {
        expect(content).toContain('<earlier-summary>')
        expect(content).toContain(outputs.at(-1))
        expect(content.indexOf('<earlier-summary>\n')).toBeLessThan(content.indexOf('<conversation>\n'))
      }
      const output = markers.filter((marker) => source.includes(marker) || outputs.at(-1)?.includes(marker)).join('\n')
      outputs.push(output)
      yield { type: 'delta', delta: output }
    })(), PAIR)
    const summary = await summarize({ text })
    expect(chunks.join('')).toBe(text)
    expect(seen.length).toBeGreaterThan(5)
    for (const marker of markers) expect(summary).toContain(marker)
    // With many available newlines, chunks should end at a line boundary.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith('\n')).toBe(true)
  })

  it('chunks oversized single lines without splitting a UTF-16 surrogate pair', async () => {
    const overhead = `${COMPACT_SUMMARY_PROMPT}\n\n<conversation>\n\n</conversation>`.length
    const text = `${'x'.repeat(200_000 - overhead - 1)}😀${'y'.repeat(250_000)}`
    const chunks: string[] = []
    const summarize = createCompactionSummarizer((request) => (async function* () {
      const content = request.messages[0]!.content as string
      expect(content.length).toBeLessThanOrEqual(200_000)
      const chunk = content.slice(content.indexOf('<conversation>\n') + '<conversation>\n'.length, content.lastIndexOf('\n</conversation>'))
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
      chunks.push(chunk)
      yield { type: 'delta', delta: 'bounded summary' }
    })(), PAIR)
    await summarize({ text })
    expect(chunks.join('')).toBe(text)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it.each([[24_001], [12_000, 12_001]])('rejects overflowing deltas %j without consuming further output', async (...sizes: number[]) => {
    let consumed = 0
    let closed = false
    const summarize = createCompactionSummarizer(() => (async function* () {
      try {
        for (const size of sizes) {
          consumed++
          yield { type: 'delta', delta: 'x'.repeat(size) }
        }
        consumed++
        yield { type: 'delta', delta: 'must not be consumed' }
      } finally { closed = true }
    })(), PAIR)
    await expect(summarize({ text: 'user: hello' })).rejects.toThrow(/24,?000|24000/)
    expect(consumed).toBe(sizes.length)
    expect(closed).toBe(true)
  })

  it('rejects a second-chunk exception rather than returning partial coverage', async () => {
    let calls = 0
    const summarize = createCompactionSummarizer(() => (async function* () {
      if (++calls === 2) throw new Error('second chunk failed')
      yield { type: 'delta', delta: 'first summary' }
    })(), PAIR)
    await expect(summarize({ text: 'x'.repeat(300_000) })).rejects.toThrow('second chunk failed')
    expect(calls).toBe(2)
  })

  it('falls back to the extractive summary when no pair resolves', async () => {
    const seen: ModelRequest[] = []
    const summarize = createCompactionSummarizer(scriptedStream([{ type: 'delta', delta: 'should not run' }], seen), undefined)
    const summary = await summarize({ text: 'line one\n\nline two\nline three' })
    expect(summary).toBe('line one\n\nline two\nline three')
    expect(seen).toHaveLength(0)
  })

  it('the extractive summary retains exact bounded input and rejects insufficient bounds', async () => {
    const text = Array.from({ length: 150 }, (_, index) => `line ${index}`).join('\n')
    expect(extractiveSummary(text)).toBe(text)
    expect(extractiveSummary('\n\n  \nkept\n')).toBe('\n\n  \nkept\n')
    expect(extractiveSummary('x'.repeat(24_000))).toHaveLength(24_000)
    expect(() => extractiveSummary('x'.repeat(24_001))).toThrow(/24,?000|24000/)
    const seen: ModelRequest[] = []
    const summarize = createCompactionSummarizer(scriptedStream([], seen), undefined)
    await expect(summarize({ text: 'x'.repeat(24_001) })).rejects.toThrow(/24,?000|24000/)
    expect(seen).toHaveLength(0)
  })
})
