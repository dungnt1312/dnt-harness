import { describe, expect, it } from 'vitest'
import { compactClientEvents } from './useSessionStream.ts'
import type { SseEvent } from '../lib/types.ts'

describe('client event compaction', () => {
  it('drops rendered content chunks once the step has a durable final message', () => {
    const events: SseEvent[] = [
      { seq: 1, type: 'turn/start', turnId: 't' },
      { seq: 2, type: 'assistant/chunk', stepId: 's', delta: 'hel' },
      { seq: 3, type: 'assistant/chunk', stepId: 's', delta: 'lo' },
      { seq: 4, type: 'assistant/message', stepId: 's', content: 'hello' },
      { seq: 5, type: 'turn/end', turnId: 't', reason: 'completed' },
    ]
    expect(compactClientEvents(events).map((event) => event.seq)).toEqual([1, 4, 5])
  })

  it('folds reasoning chunks but retains them after the final answer', () => {
    const compacted = compactClientEvents([
      { seq: 1, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'one ' },
      { seq: 2, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'two' },
      { seq: 3, type: 'assistant/message', stepId: 's', content: 'answer' },
    ])
    expect(compacted).toHaveLength(2)
    expect(compacted[0]).toMatchObject({ type: 'assistant/chunk', thinking: true, delta: 'one two', seq: 1 })
  })

  it('drops raw context bodies because the UI fetches them on demand by hash', () => {
    expect(compactClientEvents([
      { seq: 1, type: 'context/body', hash: 'a', body: 'large payload' },
      { seq: 2, type: 'context/manifest' },
    ]).map((event) => event.seq)).toEqual([2])
  })
})
