import { expect, it } from 'vitest'
import { createProjector, projectItems } from './project.ts'
import type { SseEvent } from './types.ts'

/** One turn whose first step is abandoned mid-stream and re-asked under a new id. */
const abandonedTurn: readonly SseEvent[] = [
  { seq: 1, type: 'turn/start', turnId: 't' },
  { seq: 2, type: 'user/message', turnId: 't', content: 'hello' },
  { seq: 3, type: 'step/start', turnId: 't', stepId: 's1' },
  { seq: 4, type: 'assistant/chunk', stepId: 's1', delta: 'partial ' },
  { seq: 5, type: 'assistant/chunk', stepId: 's1', delta: 'answer' },
  { seq: 6, type: 'step/abandoned', turnId: 't', stepId: 's1', reason: 'stream ended without completion proof' },
  { seq: 7, type: 'step/start', turnId: 't', stepId: 's2' },
  { seq: 8, type: 'assistant/chunk', stepId: 's2', delta: 'recovered' },
  { seq: 9, type: 'assistant/message', stepId: 's2', content: 'recovered' },
  { seq: 10, type: 'turn/end', turnId: 't', reason: 'completed' },
]

it('folds the abandoned step\'s draft behind a discarded marker and keeps the fresh answer live-closed', () => {
  const items = projectItems(abandonedTurn)
  const answers = items.filter((item) => item.kind === 'assistant')
  expect(answers).toHaveLength(2)
  expect(answers[0]).toMatchObject({ content: 'partial answer', discarded: true, live: false })
  expect(answers[1]).toMatchObject({ content: 'recovered', live: false })
  expect(answers[1]?.discarded).toBeUndefined()
  expect(items.some((item) => item.kind === 'status' && item.reason.includes('abandoned'))).toBe(false)
})

it('a step/abandoned that does not match the open draft leaves the draft streaming', () => {
  const projector = createProjector()
  projector.apply([
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'assistant/chunk', stepId: 's1', delta: 'still going' },
  ])
  const items = projector.apply([
    { seq: 3, type: 'step/abandoned', turnId: 't', stepId: 'other', reason: 'unrelated' },
  ])
  expect(items[items.length - 1]).toMatchObject({ kind: 'assistant', content: 'still going', live: true })
})

it('matches whole-replay projection when the abandonment arrives incrementally', () => {
  const projector = createProjector()
  let latest = projector.apply([])
  for (const event of abandonedTurn) latest = projector.apply([event])
  expect(latest).toEqual(projectItems(abandonedTurn))
})
