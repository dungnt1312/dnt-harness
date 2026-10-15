import { expect, it } from 'vitest'
import { compactionTokenChange } from './format.ts'
import { manifestRefreshKey } from './manifest-refresh.ts'

it('ignores streaming chunks but changes on request, step and turn boundaries or compaction', () => {
  const running = [{ seq: 1, type: 'turn/start' }, { seq: 2, type: 'step/start' }, { seq: 3, type: 'assistant/chunk' }, { seq: 4, type: 'assistant/chunk' }] as const
  expect(manifestRefreshKey(running.slice(0, 3), 0)).toBe(manifestRefreshKey(running, 0))
  // The manifest lands when the request is assembled, before any answer text.
  expect(manifestRefreshKey([...running, { seq: 5, type: 'context/manifest' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 5, type: 'step/end' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 5, type: 'step/abandoned' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 5, type: 'turn/end' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  // Automatic compaction shrinks the window with no request or turn boundary.
  expect(manifestRefreshKey([...running, { seq: 5, type: 'compaction/end' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey(running, 1)).not.toBe(manifestRefreshKey(running, 0))
})

it('advances on a terminal measured attempt but not on start, usage-less attempts or chunks', () => {
  const fact = { requestId: 'r', attemptId: 'a', attempt: 1, committed: false, transportSettled: true, contextId: 'ctx-1' } as const
  const usage = { inputTokens: 10, cachedInputTokens: 4 }
  const manifestEvent = { seq: 1, type: 'context/manifest' }
  const terminalWithUsage = { seq: 3, type: 'model/attempt', fact: { ...fact, state: 'end', usage } } as const
  const attemptStart = { seq: 2, type: 'model/attempt', fact: { ...fact, state: 'start' } } as const
  const assistantChunk = { seq: 4, type: 'assistant/chunk' }
  expect(manifestRefreshKey([manifestEvent, terminalWithUsage], 0)).toBe(`${terminalWithUsage.seq}:0`)
  expect(manifestRefreshKey([manifestEvent, attemptStart, assistantChunk], 0)).toBe(`${manifestEvent.seq}:0`)
  expect(manifestRefreshKey([manifestEvent, { seq: 5, type: 'model/attempt', fact: { ...fact, state: 'end' } }], 0)).toBe(`1:0`)
  for (const [type, state] of [['execution/uncertain', 'uncertain'], ['execution/reconciled', 'reconciled']] as const) {
    expect(manifestRefreshKey([manifestEvent, { seq: 6, type, fact: { ...fact, state, usage } }], 0)).toBe('6:0')
  }
  expect(manifestRefreshKey([manifestEvent, { seq: 7, type: 'model/attempt', fact: { ...fact, state: 'end', usage: { inputTokens: -1 } } }], 0)).toBe('1:0')
})

it('formats the before/after token change only when it was measured', () => {
  expect(compactionTokenChange({ tokensBefore: 139_200, tokensAfter: 42_000 })).toBe('139k → 42k tokens')
  expect(compactionTokenChange({ tokensBefore: 900, tokensAfter: 12_300 })).toBe('900 → 12.3k tokens')
  expect(compactionTokenChange({})).toBeUndefined()
  expect(compactionTokenChange({ tokensBefore: 10 })).toBeUndefined()
})

it('labels both figures when the compaction compares a reported count with an estimate', () => {
  const change = { tokensBefore: 120_000, tokensAfter: 30_000 }
  expect(compactionTokenChange({ ...change, measurement: { before: { tokens: 120_000, basis: 'reported' }, after: { tokens: 30_000, basis: 'estimated' } } }))
    .toBe('120k reported → 30k estimated tokens')
  expect(compactionTokenChange({ ...change, measurement: { before: { tokens: 120_000, basis: 'estimated' }, after: { tokens: 30_000, basis: 'estimated' } } }))
    .toBe('120k → 30k tokens')
  // A scalar-only (older) event is an estimate on both sides, never "reported".
  expect(compactionTokenChange(change)).not.toContain('reported')
})
