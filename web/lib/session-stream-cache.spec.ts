import { expect, it } from 'vitest'
import { createSessionStreamCache } from './session-stream-cache.ts'

it('retains recent sessions within both entry and byte budgets', () => {
  const cache = createSessionStreamCache(2, 1000)
  const row = { events: [{ type: 'user/message', seq: 1, content: 'hello' }], cursor: 5 }
  cache.set('w/a', row); cache.set('w/b', row)
  expect(cache.get('w/a')).toBe(row)
  cache.set('w/c', row)
  expect(cache.get('w/b')).toBeUndefined()
  expect(cache.get('other/a')).toBeUndefined()
  cache.set('w/a', { events: [{ type: 'user/message', seq: 2, content: 'x'.repeat(1000) }], cursor: 6 })
  expect(cache.get('w/a')).toBeUndefined()
  expect(cache.get('w/c')).toBe(row)
})
