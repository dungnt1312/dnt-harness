/**
 * The restoration a compaction wrote into the log is model-visible state, so
 * the builder must read it back from the log alone: only when the successful
 * end that follows it is the checkpoint in use. A failed or foreign attempt
 * that left an event behind must never leak into context.
 */
import { describe, expect, it } from 'vitest'
import { buildContext, DEFAULT_BUDGET, messageText } from 'dnt-harness'
import type { SessionEvent, ModeDefinition } from 'dnt-harness'
import { estimateConversationTokens, restoredStateOf } from '../../src/harness/context/builder.ts'

const mode: ModeDefinition = {
  id: 'restore', name: 'Restore', instructions: '',
  sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false },
  toolExposure: [], permissionDefaults: {},
}
const log = (rows: Record<string, unknown>[]): SessionEvent[] => rows.map((row, i) => ({ ...row, seq: i + 1, timestamp: i + 1 }) as SessionEvent)
const restoration = (coversSeq: number, body: string): Record<string, unknown> =>
  ({ type: 'compaction/restoration', coversSeq, body, sections: [{ kind: 'todo', name: 'todo', status: 'included', tokens: 3 }] })
const end = (coversSeq: number, summary: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ type: 'compaction/end', trigger: 'manual', coversSeq, summary, summaryChars: summary.length, durationMs: 1, ...extra })

const covered = [
  { type: 'turn/start', turnId: 't1' },
  { type: 'user/message', turnId: 't1', content: 'COVERED REQUEST' },
  { type: 'assistant/message', stepId: 's1', content: 'covered answer' },
  { type: 'turn/end', turnId: 't1', reason: 'completed' },
]
const tail = [
  { type: 'turn/start', turnId: 't2' },
  { type: 'user/message', turnId: 't2', content: 'NEXT TASK' },
]

const build = (events: SessionEvent[], summary = 'SUMMARY') => buildContext({
  events, mode: { definition: mode, source: 'workspace' }, modeRevision: 1, model: 'test', providerName: 'test',
  schemas: [], activeSkills: [], pinnedMemory: [], budget: DEFAULT_BUDGET,
  compaction: { summary, coversSeq: 4 },
})
const text = (result: ReturnType<typeof build>): string => result.messages.map((m) => messageText(m.content)).join('\n')

describe('restored state in the request', () => {
  it('carries the restoration of the transaction that produced the checkpoint, as lower-trust state after the summary', () => {
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'RESTORED: ship the fix'), end(4, 'SUMMARY'), ...tail])
    const result = build(events)
    const system = result.messages.filter((m) => m.role === 'system').map((m) => messageText(m.content))
    const summaryAt = system.findIndex((t) => t.includes('SUMMARY') && t.includes('compacted-history'))
    const restoredAt = system.findIndex((t) => t.includes('RESTORED: ship the fix'))
    expect(summaryAt).toBeGreaterThanOrEqual(0)
    expect(restoredAt).toBeGreaterThan(summaryAt)
    expect(system[restoredAt]).toMatch(/untrusted/i)
  })

  it('a restoration left by a FAILED attempt never reaches the model', () => {
    const events = log([
      ...covered,
      { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'ORPHAN FROM FAILED ATTEMPT'),
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summaryChars: 0, durationMs: 1, error: 'model changed' },
      { type: 'compaction/start', trigger: 'manual' }, end(4, 'SUMMARY'),
      ...tail,
    ])
    expect(text(build(events))).not.toContain('ORPHAN FROM FAILED ATTEMPT')
  })

  it('a checkpoint written without restoration gets none, even if an older attempt at the same cutoff had one', () => {
    const events = log([
      ...covered,
      { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'STALE RESTORATION'),
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summaryChars: 0, durationMs: 1, error: 'cancelled' },
      { type: 'compaction/start', trigger: 'manual' }, end(4, 'SUMMARY'),
      ...tail,
    ])
    expect(restoredStateOf(events, { summary: 'SUMMARY', coversSeq: 4 })).toBeUndefined()
  })

  it('an end that carries an error never makes its restoration count, even if it names the same cutoff and summary', () => {
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'FROM A FAILED END'), end(4, 'SUMMARY', { error: 'late failure' }), ...tail])
    expect(restoredStateOf(events, { summary: 'SUMMARY', coversSeq: 4 })).toBeUndefined()
  })

  it('only the transaction whose summary is the checkpoint in use counts: same cutoff, different summary gets nothing', () => {
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'FOR THE OTHER SUMMARY'), end(4, 'OTHER SUMMARY'), ...tail])
    expect(restoredStateOf(events, { summary: 'THE SUMMARY IN USE', coversSeq: 4 })).toBeUndefined()
    expect(restoredStateOf(events, { summary: 'OTHER SUMMARY', coversSeq: 4 })?.body).toBe('FOR THE OTHER SUMMARY')
  })

  it('a restoration written for a different cutoff than its end claims is not trusted', () => {
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, restoration(3, 'WRONG CUTOFF'), end(4, 'SUMMARY'), ...tail])
    expect(restoredStateOf(events, { summary: 'SUMMARY', coversSeq: 4 })).toBeUndefined()
  })

  it('belongs to the checkpoint it was written for: a newer checkpoint replaces it', () => {
    const events = log([
      ...covered,
      { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'FIRST RESTORATION'), end(4, 'SUMMARY'),
      { type: 'turn/start', turnId: 't2' }, { type: 'user/message', turnId: 't2', content: 'more' }, { type: 'assistant/message', stepId: 's2', content: 'x' }, { type: 'turn/end', turnId: 't2', reason: 'completed' },
      { type: 'compaction/start', trigger: 'manual' }, end(10, 'SECOND SUMMARY'),
      ...tail,
    ])
    expect(restoredStateOf(events, { summary: 'SECOND SUMMARY', coversSeq: 10 })).toBeUndefined()
    expect(restoredStateOf(events, { summary: 'SUMMARY', coversSeq: 4 })?.body).toBe('FIRST RESTORATION')
  })

  it('counts toward the context the request carries', () => {
    const body = 'r'.repeat(4_000)
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, restoration(4, body), end(4, 'SUMMARY'), ...tail])
    const plain = log([...covered, { type: 'compaction/start', trigger: 'manual' }, end(4, 'SUMMARY'), ...tail])
    const withRestoration = build(events).manifest.budget.usedTokens
    const without = build(plain).manifest.budget.usedTokens
    expect(withRestoration - without).toBeGreaterThanOrEqual(1_000)
  })

  it('does not change the size estimate of the conversation itself', () => {
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, restoration(4, 'r'.repeat(4_000)), end(4, 'SUMMARY'), ...tail])
    const plain = log([...covered, { type: 'compaction/start', trigger: 'manual' }, end(4, 'SUMMARY'), ...tail])
    const input = (e: SessionEvent[]) => ({ events: e, compaction: { summary: 'SUMMARY', coversSeq: 4 } })
    expect(estimateConversationTokens(input(events))).toBe(estimateConversationTokens(input(plain)))
  })

  it('ignores a malformed restoration instead of throwing', () => {
    const events = log([...covered, { type: 'compaction/start', trigger: 'manual' }, { type: 'compaction/restoration', coversSeq: 4, body: 42 }, end(4, 'SUMMARY'), ...tail])
    expect(restoredStateOf(events, { summary: 'SUMMARY', coversSeq: 4 })).toBeUndefined()
    expect(() => build(events)).not.toThrow()
  })
})
