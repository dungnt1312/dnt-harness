import { expect, it } from 'vitest'
import { projectItems } from './project.ts'
import type { SseEvent } from './types.ts'

const continuation = (seq: number, content: string): SseEvent => ({
  seq,
  type: 'user/message',
  turnId: 't',
  content,
  origin: 'continuation',
  timestamp: 1791187353885,
})

it('projects a continuation user/message as its own system row, never a user bubble', () => {
  const items = projectItems([
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'user/message', inputId: 'i', content: 'review it' },
    { seq: 3, type: 'assistant/message', content: 'done' },
    continuation(4, 'Delegated agents you left running have finished.\n\n### reviewer (session-c) — cancelled\nno result'),
  ])
  expect(items).toHaveLength(3)
  expect(items[0]).toMatchObject({ kind: 'user', content: 'review it' })
  expect(items[1]).toMatchObject({ kind: 'assistant', content: 'done' })
  expect(items[2]).toMatchObject({ kind: 'continuation', content: expect.stringContaining('### reviewer (session-c)') })
})

it('legacy logs without the origin stamp are recognized by the exact header', () => {
  const items = projectItems([
    { seq: 1, type: 'turn/start', turnId: 't' },
    { seq: 2, type: 'user/message', turnId: 't', content: 'Delegated agents you left running have finished. Their reports follow; use them to complete the task.\n\n### explorer (session-c) — completed\ndone' },
  ])
  expect(items).toEqual([expect.objectContaining({ kind: 'continuation' })])
})

it('a continuation never joins the turn retry inputs', () => {
  const items = projectItems([
    { seq: 1, type: 'input/queued', inputId: 'i', content: 'review it' },
    { seq: 2, type: 'turn/start', turnId: 't' },
    { seq: 3, type: 'user/message', inputId: 'i', content: 'review it' },
    continuation(4, 'Delegated agents you left running have finished.'),
    { seq: 5, type: 'turn/error', turnId: 't', kind: 'provider', message: 'boom' },
    { seq: 6, type: 'turn/end', turnId: 't', reason: 'failed' },
  ])
  const failed = items.find((item) => item.kind === 'status' && item.reason === 'provider: boom')
  expect(failed).toBeDefined()
  expect(failed && failed.kind === 'status' && failed.retry !== undefined ? failed.retry.inputs : []).toEqual([
    { content: 'review it' },
  ])
})

it('a user/message without the marker still projects as a user bubble (legacy logs)', () => {
  const items = projectItems([{ seq: 1, type: 'user/message', content: 'plain' }])
  expect(items).toEqual([{ kind: 'user', content: 'plain', ts: undefined }])
})
