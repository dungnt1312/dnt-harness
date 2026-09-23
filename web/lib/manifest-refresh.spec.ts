import { expect, it } from 'vitest'
import { manifestRefreshKey } from './manifest-refresh.ts'

it('changes manifest refresh key only after a turn settles or an explicit compaction', () => {
  const running = [{ seq: 1, type: 'turn/start' }, { seq: 2, type: 'assistant/chunk' }, { seq: 3, type: 'assistant/chunk' }] as const
  expect(manifestRefreshKey(running.slice(0, 2), 0)).toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 4, type: 'turn/end' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey(running, 1)).not.toBe(manifestRefreshKey(running, 0))
})
