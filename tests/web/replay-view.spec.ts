import { expect, it } from 'vitest'
import { replayView } from '../../src/web/replay-view.ts'

it('keeps only delegation facts for the lightweight parent view', () => {
  const events = [{ type: 'user/message', seq: 1 }, { type: 'agent/child-spawn', seq: 2 }, { type: 'tool/result', seq: 3 }, { type: 'agent/child-result', seq: 4 }]
  expect(replayView(events, true)).toEqual([events[1], events[3]])
  expect(replayView(events, false)).toBe(events)
})
