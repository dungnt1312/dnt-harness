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
