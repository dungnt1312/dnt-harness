import { expect, it } from 'vitest'
import * as projection from './project.ts'
import type { SseEvent } from './types.ts'

it('applies only new events while preserving immutable row identities', () => {
  expect(projection).toHaveProperty('createProjector')
  const projector = projection.createProjector()
  const initial: SseEvent[] = [
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'user/message', content: 'hello' },
    { seq: 3, type: 'assistant/chunk', delta: 'one', stepId: 's' },
  ]
  const first = projector.apply(initial)
  const next = projector.apply([{ seq: 4, type: 'assistant/chunk', delta: ' two', stepId: 's' }])
  expect(first[1]).toMatchObject({ content: 'one' })
  expect(next[0]).toBe(first[0])
  expect(next[1]).not.toBe(first[1])
  expect(next).toEqual(projection.projectItems([...initial, { seq: 4, type: 'assistant/chunk', delta: ' two', stepId: 's' }]))
  expect(projector.apply([{ seq: 5, type: 'step/end' }])).toBe(next)
})

it('matches full replay for every boundary and never mutates published thinking or tool rows', () => {
  expect(projection).toHaveProperty('createProjector')
  const projector = projection.createProjector()
  const events: SseEvent[] = [
    { seq: 1, type: 'input/queued', inputId: 'i', content: 'hello' },
    { seq: 2, type: 'turn/start', turnId: 't' },
    { seq: 3, type: 'user/message', inputId: 'i', content: 'hello' },
    { seq: 4, type: 'assistant/chunk', thinking: true, delta: 'think' },
    { seq: 5, type: 'assistant/chunk', thinking: true, delta: ' more' },
    { seq: 6, type: 'assistant/message', content: '', toolCalls: [{ id: 'c', name: 'Read', args: {} }] },
    { seq: 7, type: 'tool/call', call: { id: 'c', name: 'Read', args: {} } },
    { seq: 8, type: 'tool/result', callId: 'c', ok: true, output: 'ok' },
    { seq: 9, type: 'assistant/message', content: 'done' },
    { seq: 10, type: 'turn/end', turnId: 't', reason: 'completed' },
  ]
  for (let i = 0; i < events.length; i++) {
    const before = projector.apply([])
    const frozen = JSON.stringify(before)
    expect(projector.apply([events[i]!])).toEqual(projection.projectItems(events.slice(0, i + 1)))
    expect(JSON.stringify(before)).toBe(frozen)
  }
})
