import { afterEach, expect, it, vi } from 'vitest'
import { subscribeEventsIn } from './api.ts'

afterEach(() => vi.unstubAllGlobals())
it('requests a cached cursor and exposes SSE frame ids including empty resume frames', () => {
  let source: { onmessage?: (message: { data: string; lastEventId: string }) => void; close: ReturnType<typeof vi.fn> } | undefined
  const urls: string[] = []
  vi.stubGlobal('EventSource', class {
    close = vi.fn()
    constructor(url: string) { urls.push(url); source = this }
  })
  const receive = vi.fn()
  const dispose = subscribeEventsIn('w', 's', receive, undefined, 42)
  expect(urls).toEqual(['/api/workspaces/w/sessions/s/events?cursor=42'])
  source!.onmessage!({ data: JSON.stringify({ kind: 'resume', events: [] }), lastEventId: '99' })
  expect(receive).toHaveBeenCalledWith({ kind: 'resume', events: [] }, 99)
  dispose()
  expect(source!.close).toHaveBeenCalledOnce()
  subscribeEventsIn('w', 's', receive, undefined, -1)
  expect(urls.at(-1)).toBe('/api/workspaces/w/sessions/s/events')
})
