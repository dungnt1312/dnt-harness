import { expect, it } from 'vitest'
import { manifestRefreshKey } from './manifest-refresh.ts'

it('ignores streaming chunks but changes on request, step and turn boundaries or compaction', () => {
  const running = [{ seq: 1, type: 'turn/start' }, { seq: 2, type: 'step/start' }, { seq: 3, type: 'assistant/chunk' }, { seq: 4, type: 'assistant/chunk' }] as const
  expect(manifestRefreshKey(running.slice(0, 3), 0)).toBe(manifestRefreshKey(running, 0))
  // The manifest lands when the request is assembled, before any answer text.
  expect(manifestRefreshKey([...running, { seq: 5, type: 'context/manifest' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 5, type: 'step/end' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 5, type: 'step/abandoned' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey([...running, { seq: 5, type: 'turn/end' }], 0)).not.toBe(manifestRefreshKey(running, 0))
  expect(manifestRefreshKey(running, 1)).not.toBe(manifestRefreshKey(running, 0))
})
