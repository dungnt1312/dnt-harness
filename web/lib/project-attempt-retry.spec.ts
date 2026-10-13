import { expect, it } from 'vitest'
import { createProjector, projectItems } from './project.ts'
import type { SseEvent } from './types.ts'

const attempt = (seq: number, state: 'start' | 'end', extra: Record<string, unknown> = {}): SseEvent =>
  ({ seq, type: 'model/attempt', fact: { requestId: 'r1', attemptId: `a${seq}`, attempt: 1, state, committed: false, transportSettled: false, ...extra } })

/** A turn whose transport keeps resetting before any output; the host retries each attempt. */
const retryingTurn: readonly SseEvent[] = [
  { seq: 1, type: 'turn/start', turnId: 't' },
  { seq: 2, type: 'user/message', turnId: 't', content: 'hello' },
  { seq: 3, type: 'step/start', turnId: 't', stepId: 's1' },
  attempt(4, 'start', { startedAt: 1_000 }),
  attempt(5, 'end', { reason: 'reset' }),
  attempt(6, 'start', { startedAt: 2_000, attempt: 2 }),
  attempt(7, 'end', { reason: 'reset', attempt: 2 }),
  attempt(8, 'start', { startedAt: 3_000, attempt: 3 }),
  { seq: 9, type: 'assistant/chunk', stepId: 's1', delta: 'answer' },
  { seq: 10, type: 'assistant/message', stepId: 's1', content: 'answer' },
  { seq: 11, type: 'turn/end', turnId: 't', reason: 'completed' },
]

it('shows one live retry notice while a turn retries, updated in place and cleared on success', () => {
  const projector = createProjector()
  let latest = projector.apply(retryingTurn.slice(0, 6))
  let notices = latest.filter((item) => item.kind === 'retry')
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ kind: 'retry', attempt: 1, reason: 'reset', live: true })
  // The second failure updates the same row, not a new one.
  latest = projector.apply(retryingTurn.slice(6, 8))
  notices = latest.filter((item) => item.kind === 'retry')
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ kind: 'retry', attempt: 2, reason: 'reset', live: true })
  // The retry attempt starting again, streaming and completing settles it:
  // it stays as a quiet historical line, no longer live.
  latest = projector.apply(retryingTurn.slice(8))
  const settled = latest.filter((item) => item.kind === 'retry')
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({ kind: 'retry', attempt: 2, live: false })
})

it('keeps the last retry notice, settled, after the turn failed for good', () => {
  const events: readonly SseEvent[] = [
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'user/message', turnId: 't', content: 'hello' },
    { seq: 3, type: 'step/start', turnId: 't', stepId: 's1' },
    attempt(4, 'start', { startedAt: 1_000 }),
    attempt(5, 'end', { reason: 'reset' }),
    attempt(6, 'start', { startedAt: 2_000, attempt: 2 }),
    attempt(7, 'end', { reason: 'reset', attempt: 2 }),
    { seq: 8, type: 'turn/error', turnId: 't', kind: 'provider', message: 'provider transport interrupted' },
    { seq: 9, type: 'turn/end', turnId: 't', reason: 'failed' },
  ]
  const items = projectItems(events)
  const notices = items.filter((item) => item.kind === 'retry')
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ kind: 'retry', attempt: 2, live: false })
})

it('a turn without failed attempts stays quiet', () => {
  const items = projectItems([
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'user/message', turnId: 't', content: 'hello' },
    { seq: 3, type: 'step/start', turnId: 't', stepId: 's1' },
    attempt(4, 'start', { startedAt: 1_000 }),
    attempt(5, 'end', { finish: 'stop' }),
    { seq: 6, type: 'assistant/message', stepId: 's1', content: 'answer' },
    { seq: 7, type: 'turn/end', turnId: 't', reason: 'completed' },
  ])
  expect(items.some((item) => item.kind === 'retry')).toBe(false)
})

it('whole-replay projection matches the incremental one', () => {
  const projector = createProjector()
  let latest = projector.apply([])
  for (const event of retryingTurn) latest = projector.apply([event])
  expect(latest).toEqual(projectItems(retryingTurn))
})
