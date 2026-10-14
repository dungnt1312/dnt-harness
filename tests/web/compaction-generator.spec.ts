/**
 * Structured summary generation: the request is the snapshot's exact prefix
 * plus one appended instruction; the answer must be one settled stop with
 * bounded text. Failures never fall back to folding the raw transcript.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError, type ModelCompletion, type ModelRequest, type StreamEvent, type TokenUsage } from '../../src/harness/llm/types.ts'
import type { EffectiveCompactionSnapshot } from '../../src/harness/context/compaction-snapshot.ts'
import {
  COMPACTION_HANDOFF_MARKER,
  assertFitsWindow,
  estimateSnapshotTokens,
  generateCompaction,
  type GenerateOptions,
} from '../../src/web/compaction-generator.ts'

const STOP: ModelCompletion = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }

const snapshot: EffectiveCompactionSnapshot = {
  id: 'snap-1',
  v: 1,
  policyVersion: 1,
  sessionId: 'session-a',
  cutoff: 42,
  turnId: 't9',
  request: {
    model: 'm1',
    providerName: 'p1',
    thinkingLevel: 'high',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'a.ts' } }] },
      { role: 'tool', content: '[cleared]', toolCallId: 'c1' },
    ],
    tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }],
  },
  finalAnswer: { role: 'assistant', content: 'finished' },
  projection: { v: 1, policyVersion: 1, history: 'compact', sources: [], losses: [] },
  sourceDigest: 'digest-1',
  identity: { provider: 'p1', model: 'm1', thinkingLevel: 'high', modeHash: 'mode', grantsHash: 'grants', providerGeneration: 1, policyVersion: 1, prefixHash: 'prefix' },
}

type Attempt = StreamEvent[] | ((request: ModelRequest, signal: AbortSignal | undefined) => AsyncIterable<StreamEvent>)

/** A stream function that plays one scripted attempt per call and records what it was sent. */
function scripted(attempts: Attempt[]): { stream: GenerateOptions['stream']; requests: ModelRequest[]; signals: (AbortSignal | undefined)[] } {
  const requests: ModelRequest[] = []
  const signals: (AbortSignal | undefined)[] = []
  let call = 0
  const stream: GenerateOptions['stream'] = (request, options) => {
    requests.push(request)
    signals.push(options?.signal)
    const attempt = attempts[call++] ?? attempts.at(-1)!
    if (typeof attempt === 'function') return attempt(request, options?.signal)
    return (async function* (): AsyncIterable<StreamEvent> { for (const event of attempt) yield event })()
  }
  return { stream, requests, signals }
}

const answer = (text: string, usage?: TokenUsage): StreamEvent[] => [
  { type: 'delta', delta: text },
  ...(usage !== undefined ? [{ type: 'usage', usage } as StreamEvent] : []),
  STOP,
]

function options(over: Partial<GenerateOptions> & Pick<GenerateOptions, 'stream'>): GenerateOptions {
  return {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    maxOutputTokens: 8_000,
    recordUsage: () => {},
    path: 'exact',
    ...over,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('generateCompaction: request shape', () => {
  it('sends the snapshot prefix verbatim plus the final answer and one appended instruction', async () => {
    const { stream, requests } = scripted([answer('SUMMARY')])
    await generateCompaction(snapshot, options({ stream }))
    expect(requests).toHaveLength(1)
    const sent = requests[0]!
    expect(sent.messages.slice(0, -1)).toEqual([...snapshot.request.messages, snapshot.finalAnswer])
    const last = sent.messages.at(-1)!
    expect(last.role).toBe('user')
    expect(String(last.content)).toContain(COMPACTION_HANDOFF_MARKER)
    expect(sent.tools).toEqual(snapshot.request.tools)
    expect(sent.thinkingLevel).toBe('high')
    expect(sent.model).toBe('m1')
    expect(sent.providerName).toBe('p1')
    expect(sent.maxOutputTokens).toBe(8_000)
  })

  it('asks for a handoff, not the nine-heading archive, and forbids tools', async () => {
    const { stream, requests } = scripted([answer('SUMMARY')])
    await generateCompaction(snapshot, options({ stream }))
    const instruction = String(requests[0]!.messages.at(-1)!.content)
    expect(instruction).not.toContain('Primary Request and Intent')
    expect(instruction).toMatch(/do not call (any )?tools/i)
    // The five things the spec requires a handoff to keep.
    for (const topic of [/constraint|permission/i, /decision|ruled out|tried/i, /current work|where .* stand/i, /pending|next step/i, /exact|verbatim/i]) {
      expect(instruction).toMatch(topic)
    }
  })

  it('returns a prepared summary carrying the snapshot identity, digest and path', async () => {
    const { stream } = scripted([answer('  THE SUMMARY  ', { inputTokens: 100, outputTokens: 7 })])
    const prepared = await generateCompaction(snapshot, options({ stream, path: 'reconstructed' }))
    expect(prepared).toMatchObject({
      snapshotId: 'snap-1',
      cutoff: 42,
      summary: 'THE SUMMARY',
      sourceDigest: 'digest-1',
      identity: snapshot.identity,
      path: 'reconstructed',
      usage: { inputTokens: 100, outputTokens: 7 },
    })
    expect(prepared.generationMs).toBeGreaterThanOrEqual(0)
  })

  it('carries the seed hash when the snapshot had one', async () => {
    const { stream } = scripted([answer('S')])
    const prepared = await generateCompaction({ ...snapshot, seedHash: 'seed-hash' }, options({ stream }))
    expect(prepared.seedHash).toBe('seed-hash')
  })
})

describe('generateCompaction: strict answers', () => {
  const rejects: [string, StreamEvent[]][] = [
    ['a tool call', [{ type: 'toolCalls', calls: [{ id: 'x', name: 'Read', args: {} }] }, { ...STOP, finishReason: 'tool_calls' }]],
    ['tool progress', [{ type: 'toolCallProgress' }, ...answer('S')]],
    ['a length finish', [{ type: 'delta', delta: 'cut' }, { ...STOP, finishReason: 'length' }]],
    ['no completion', [{ type: 'delta', delta: 'S' }]],
    ['a duplicate completion', [{ type: 'delta', delta: 'S' }, STOP, STOP]],
    ['output after completion', [{ type: 'delta', delta: 'S' }, STOP, { type: 'delta', delta: 'more' }]],
    ['an unsettled transport', [{ type: 'delta', delta: 'S' }, { ...STOP, transportSettled: false }]],
    ['an empty answer', [{ type: 'delta', delta: '   ' }, STOP]],
    ['thinking only', [{ type: 'delta', delta: 'hmm', thinking: true }, STOP]],
  ]
  it.each(rejects)('rejects %s', async (_name, events) => {
    const { stream } = scripted([events])
    await expect(generateCompaction(snapshot, options({ stream }))).rejects.toThrow()
  })

  it('rejects a tool_calls finish even when no tool call event was seen (validateCompletion alone accepts it)', async () => {
    const { stream } = scripted([[{ type: 'delta', delta: 'S' }, { ...STOP, finishReason: 'tool_calls' }]])
    await expect(generateCompaction(snapshot, options({ stream }))).rejects.toThrow(/stop completion/)
  })

  it('ignores thinking deltas when building the summary', async () => {
    const { stream } = scripted([[{ type: 'delta', delta: 'private reasoning', thinking: true }, { type: 'delta', delta: 'REAL' }, STOP]])
    expect((await generateCompaction(snapshot, options({ stream }))).summary).toBe('REAL')
  })
})

describe('generateCompaction: size cap and re-ask', () => {
  const OVER = 'x'.repeat(24_001)

  it('re-asks exactly once with a hard length constraint, then accepts a compliant answer', async () => {
    const { stream, requests } = scripted([answer(OVER), answer('SHORT')])
    const prepared = await generateCompaction(snapshot, options({ stream }))
    expect(prepared.summary).toBe('SHORT')
    expect(requests).toHaveLength(2)
    const retry = String(requests[1]!.messages.at(-1)!.content)
    expect(retry).toContain(COMPACTION_HANDOFF_MARKER)
    expect(retry).toMatch(/HARD CONSTRAINT/)
    expect(retry).toContain('24000')
    // The retried request keeps the same prefix.
    expect(requests[1]!.messages.slice(0, -1)).toEqual(requests[0]!.messages.slice(0, -1))
  })

  it('refuses a second overflow and never loops or folds raw source', async () => {
    const { stream, requests } = scripted([answer(OVER)])
    await expect(generateCompaction(snapshot, options({ stream }))).rejects.toThrow(/24000/)
    expect(requests).toHaveLength(2)
  })

  it('accepts a summary of exactly the cap', async () => {
    const { stream } = scripted([answer('y'.repeat(24_000))])
    expect((await generateCompaction(snapshot, options({ stream }))).summary).toHaveLength(24_000)
  })
})

describe('generateCompaction: provider failures', () => {
  it('never resends the same input after a context overflow', async () => {
    const overflow = new ProviderError('too long', { contextExceeded: true })
    const { stream, requests } = scripted([() => (async function* (): AsyncIterable<StreamEvent> { throw overflow })()])
    await expect(generateCompaction(snapshot, options({ stream }))).rejects.toBe(overflow)
    expect(requests).toHaveLength(1)
  })

  it('propagates other provider errors unchanged', async () => {
    const failure = new ProviderError('boom', { reason: 'server_error' })
    const { stream } = scripted([() => (async function* (): AsyncIterable<StreamEvent> { throw failure })()])
    await expect(generateCompaction(snapshot, options({ stream }))).rejects.toBe(failure)
  })
})

describe('generateCompaction: usage', () => {
  it('records usage of every attempt, including the one whose answer was rejected', async () => {
    const recorded: TokenUsage[] = []
    const { stream } = scripted([
      answer('x'.repeat(24_001), { inputTokens: 1_000, outputTokens: 900 }),
      answer('OK', { inputTokens: 1_010, outputTokens: 40 }),
    ])
    await generateCompaction(snapshot, options({ stream, recordUsage: (usage) => recorded.push(usage) }))
    expect(recorded).toEqual([{ inputTokens: 1_000, outputTokens: 900 }, { inputTokens: 1_010, outputTokens: 40 }])
  })

  it('records usage even when the attempt then fails', async () => {
    const recorded: TokenUsage[] = []
    const { stream } = scripted([[{ type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }, { type: 'delta', delta: 'S' }]]) // no completion
    await expect(generateCompaction(snapshot, options({ stream, recordUsage: (usage) => recorded.push(usage) }))).rejects.toThrow()
    expect(recorded).toEqual([{ inputTokens: 5, outputTokens: 1 }])
  })

  it('never records usage that the provider did not report', async () => {
    const recorded: TokenUsage[] = []
    const { stream } = scripted([answer('S')])
    const prepared = await generateCompaction(snapshot, options({ stream, recordUsage: (usage) => recorded.push(usage) }))
    expect(recorded).toEqual([])
    expect(prepared.usage).toBeUndefined()
  })
})

describe('generateCompaction: cancellation and deadline', () => {
  const hang = (): Attempt => (_request, signal) =>
    (async function* (): AsyncIterable<StreamEvent> {
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => reject(signal?.reason ?? new Error('aborted'))
        if (signal?.aborted === true) fail()
        else signal?.addEventListener('abort', fail, { once: true })
      })
    })()

  it('aborts the stream and rejects when the shared deadline passes', async () => {
    vi.useFakeTimers()
    const { stream, signals } = scripted([hang()])
    const run = generateCompaction(snapshot, options({ stream, deadlineAt: Date.now() + 100 }))
    const settled = run.then(() => 'resolved', (error: unknown) => String(error))
    await vi.advanceTimersByTimeAsync(101)
    expect(await settled).toMatch(/deadline/i)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('shares ONE deadline across the re-ask: time spent on the first answer is not refunded', async () => {
    vi.useFakeTimers()
    const slowOverflow: Attempt = () => (async function* (): AsyncIterable<StreamEvent> {
      await new Promise((resolve) => setTimeout(resolve, 60))
      yield { type: 'delta', delta: 'x'.repeat(24_001) }
      yield STOP
    })()
    const { stream } = scripted([slowOverflow, hang()])
    const started = Date.now()
    const run = generateCompaction(snapshot, options({ stream, deadlineAt: started + 100 }))
    const settled = run.then(() => 'resolved', (error: unknown) => String(error))
    await vi.advanceTimersByTimeAsync(101) // 60ms + the re-ask hanging for 41ms hits the deadline, not 160ms
    expect(await settled).toMatch(/deadline/i)
  })

  it('refuses to start when the deadline has already passed', async () => {
    const { stream, requests } = scripted([answer('S')])
    await expect(generateCompaction(snapshot, options({ stream, deadlineAt: Date.now() - 1 }))).rejects.toThrow(/deadline/i)
    expect(requests).toHaveLength(0)
  })

  it('propagates a parent abort and does not start the re-ask', async () => {
    const parent = new AbortController()
    const { stream, requests } = scripted([() => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: 'delta', delta: 'x'.repeat(24_001) }
      parent.abort(new Error('stopped by user'))
      yield STOP
    })(), answer('late')])
    await expect(generateCompaction(snapshot, options({ stream, signal: parent.signal }))).rejects.toThrow(/stopped by user/)
    expect(requests).toHaveLength(1)
  })

  it('clears its deadline timer on success so nothing keeps the process alive', async () => {
    vi.useFakeTimers()
    const { stream } = scripted([answer('S')])
    await generateCompaction(snapshot, options({ stream }))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('input fit', () => {
  const big = (chars: number): EffectiveCompactionSnapshot => ({
    ...snapshot,
    request: { ...snapshot.request, messages: [{ role: 'user', content: 'a'.repeat(chars) }] },
  })

  it('uses the provider-reported input as the baseline and says so', () => {
    const measured = { ...big(400), inputEvidence: { inputTokens: 50_000 } }
    const estimate = estimateSnapshotTokens(measured)
    expect(estimate.basis).toBe('reported')
    // reported baseline + the final answer + the instruction, with the 20% margin on the unmeasured increment only
    expect(estimate.tokens).toBeGreaterThanOrEqual(50_000)
    expect(estimate.tokens).toBeLessThan(55_000)
  })

  it('falls back to a conservative chars/4 estimate when nothing was reported', () => {
    const estimate = estimateSnapshotTokens(big(40_000))
    expect(estimate.basis).toBe('estimated')
    expect(estimate.tokens).toBeGreaterThanOrEqual(10_000)
  })

  it('refuses a summary request that cannot leave room for the output', () => {
    const near = { ...big(400), inputEvidence: { inputTokens: 195_000 } }
    expect(() => assertFitsWindow(near, { contextWindowTokens: 200_000, outputTokens: 8_000 })).toThrow(/compaction-input-too-large/)
    expect(() => assertFitsWindow({ ...big(400), inputEvidence: { inputTokens: 100_000 } }, { contextWindowTokens: 200_000, outputTokens: 8_000 })).not.toThrow()
  })

  it('cannot judge an unknown window and leaves it to the provider', () => {
    expect(() => assertFitsWindow(big(4_000_000), { outputTokens: 8_000 })).not.toThrow()
  })

  it('is never fooled into treating a character count as the window', () => {
    // 200k CHARACTERS is only ~50k tokens: it fits a 200k-token window.
    expect(() => assertFitsWindow(big(200_000), { contextWindowTokens: 200_000, outputTokens: 8_000 })).not.toThrow()
  })
})
