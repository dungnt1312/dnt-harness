import { describe, expect, it } from 'vitest'
import { projectItems, shareProjectedItems } from './project.ts'
import type { SseEvent } from './types.ts'

const history: SseEvent[] = [
  { seq: 1, type: 'user/message', content: 'hello' },
  { seq: 2, type: 'turn/start', turnId: 't1' },
  { seq: 3, type: 'assistant/chunk', delta: 'first' },
  { seq: 4, type: 'assistant/message', content: 'first' },
  { seq: 5, type: 'turn/end', turnId: 't1', reason: 'completed' },
  { seq: 6, type: 'turn/start', turnId: 't2' },
  { seq: 7, type: 'assistant/chunk', delta: 'live' },
]

describe('projected row identity', () => {
  it('reuses unchanged history while the live answer grows and updates the changed row', () => {
    const before = projectItems(history)
    const after = shareProjectedItems(before, projectItems([...history, { seq: 8, type: 'assistant/chunk', delta: ' next' }]))
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after.at(-1)).not.toBe(before.at(-1))
    expect(after.at(-1)).toMatchObject({ kind: 'assistant', content: 'live next' })
  })
  it('reuses a whole projection when nonvisual events arrive, but never stale rows across replacement', () => {
    const before = projectItems(history)
    expect(shareProjectedItems(before, projectItems([...history, { seq: 8, type: 'turn/usage' }]))).toBe(before)
    const other = shareProjectedItems(before, projectItems([{ seq: 1, type: 'user/message', content: 'different' }]))
    expect(other[0]).not.toBe(before[0])
  })
  it('does not mutate earlier projected rows when sharing later projections', () => {
    const before = projectItems(history)
    const original = before.at(-1)
    shareProjectedItems(before, projectItems([...history, { seq: 8, type: 'assistant/message', content: 'final' }, { seq: 9, type: 'turn/end', turnId: 't2', reason: 'completed' }]))
    expect(original).toMatchObject({ kind: 'assistant', content: 'live', live: true, turnOpen: true })
  })
  it('invalidates the affected tool result and turn footer without touching unrelated rows', () => {
    const log: SseEvent[] = [...history.slice(0, 5), { seq: 6, type: 'tool/call', call: { id: 'c', name: 'Bash', args: {} } }]
    const before = projectItems(log)
    const after = shareProjectedItems(before, projectItems([...log, { seq: 7, type: 'tool/result', callId: 'c', ok: true, output: 'ok' }]))
    expect(after[0]).toBe(before[0])
    expect(after.at(-1)).not.toBe(before.at(-1))
  })
})

const manifest = {
  modeId: 'default',
  modeRevision: 2,
  budget: { availableTokens: 994_880, usedTokens: 18_400, contextLimitTokens: 1_000_000, estimated: true },
  history: { setting: 'recent', includedTurns: 1, omittedTurns: 0 },
  sources: { skills: ['alpha@aa'.padEnd(10, '0')], memory: [], toolNames: ['Read', 'Glob'], toolSchemas: 6 },
  omissions: ['memory: dropped for budget'],
}

describe('context manifest projection', () => {
  it('a context/manifest event becomes a context row between the input and the answer', () => {
    const log: SseEvent[] = [
      { seq: 1, type: 'user/message', content: 'go' },
      { seq: 2, type: 'step/start', turnId: 't1', stepId: 's1' },
      { seq: 3, type: 'context/manifest', turnId: 't1', timestamp: 1234, manifest },
      { seq: 4, type: 'assistant/chunk', delta: 'hi' },
      { seq: 5, type: 'assistant/message', content: 'hi' },
    ]
    const items = projectItems(log)
    const at = items.findIndex((item) => item.kind === 'context')
    expect(at).toBe(1)
    expect(items[at]).toMatchObject({ kind: 'context', ts: 1234, manifest })
  })
  it('a context/manifest event without a manifest payload is skipped', () => {
    const items = projectItems([{ seq: 1, type: 'context/manifest', turnId: 't1' }])
    expect(items).toHaveLength(0)
  })
  it('context/body events project to nothing (raw text rides the body route, not the transcript)', () => {
    expect(projectItems([{ seq: 1, type: 'context/body', hash: 'a'.repeat(64), kind: 'system', chars: 3, body: 'abc' }])).toHaveLength(0)
  })
  it('requests within one turn fold into a single marker carrying the latest manifest', () => {
    const older = { ...manifest, budget: { ...manifest.budget, usedTokens: 10_000 } }
    const newer = { ...manifest, budget: { ...manifest.budget, usedTokens: 12_000 } }
    const items = projectItems([
      { seq: 1, type: 'user/message', content: 'go' },
      { seq: 2, type: 'step/start', turnId: 't1', stepId: 's1' },
      { seq: 3, type: 'context/manifest', turnId: 't1', manifest: older },
      { seq: 4, type: 'assistant/message', content: '', toolCalls: [{ id: 'c', name: 'Edit', args: {} }] },
      { seq: 5, type: 'step/start', turnId: 't1', stepId: 's2' },
      { seq: 6, type: 'context/manifest', turnId: 't1', manifest: newer },
      { seq: 7, type: 'assistant/message', content: 'done' },
    ])
    const contexts = items.filter((item) => item.kind === 'context')
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ kind: 'context', manifest: newer, requests: 2 })
  })
  it('a new turn starts its own marker', () => {
    const items = projectItems([
      { seq: 1, type: 'turn/start', turnId: 't1' },
      { seq: 2, type: 'context/manifest', turnId: 't1', manifest },
      { seq: 3, type: 'turn/end', turnId: 't1', reason: 'completed' },
      { seq: 4, type: 'turn/start', turnId: 't2' },
      { seq: 5, type: 'context/manifest', turnId: 't2', manifest },
    ])
    expect(items.filter((item) => item.kind === 'context')).toHaveLength(2)
  })
})
