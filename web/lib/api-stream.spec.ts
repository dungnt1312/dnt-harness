import { afterEach, expect, it, vi } from 'vitest'
import { subscribeEventsIn, subscribeTerminals } from './api.ts'

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
  subscribeEventsIn('w', 's', receive, undefined, 7, { delegationsOnly: true })
  expect(urls.at(-1)).toBe('/api/workspaces/w/sessions/s/events?view=delegations&cursor=7')
})

it('resumes from the last frame id with a fresh source after a long hide or a network return', () => {
  vi.useFakeTimers()
  const docListeners = new Map<string, () => void>()
  const winListeners = new Map<string, () => void>()
  const doc = { visibilityState: 'visible', addEventListener: (k: string, f: () => void) => docListeners.set(k, f), removeEventListener: (k: string) => docListeners.delete(k) }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { addEventListener: (k: string, f: () => void) => winListeners.set(k, f), removeEventListener: (k: string) => winListeners.delete(k) })
  const sources: { url: string; readyState: number; onmessage?: (m: { data: string; lastEventId: string }) => void; close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('EventSource', Object.assign(class {
    readyState = 1
    close = vi.fn()
    constructor(public url: string) { sources.push(this as never) }
  }, { CONNECTING: 0, OPEN: 1, CLOSED: 2 }))
  const states: string[] = []
  const dispose = subscribeEventsIn('w', 's', vi.fn(), (s) => states.push(s))
  sources[0]!.onmessage!({ data: JSON.stringify({ kind: 'snapshot', events: [] }), lastEventId: '7' })
  // A short hide with a healthy source keeps it.
  doc.visibilityState = 'hidden'; docListeners.get('visibilitychange')!()
  vi.advanceTimersByTime(2_000)
  doc.visibilityState = 'visible'; docListeners.get('visibilitychange')!()
  expect(sources).toHaveLength(1)
  // A long hide swaps the source and resumes from the last frame id.
  doc.visibilityState = 'hidden'; docListeners.get('visibilitychange')!()
  vi.advanceTimersByTime(60_000)
  doc.visibilityState = 'visible'; docListeners.get('visibilitychange')!()
  expect(sources[0]!.close).toHaveBeenCalledOnce()
  expect(sources[1]!.url).toBe('/api/workspaces/w/sessions/s/events?cursor=7')
  expect(states).toEqual(['reconnecting'])
  sources[1]!.onmessage!({ data: JSON.stringify({ kind: 'resume', events: [] }), lastEventId: '9' })
  winListeners.get('online')!()
  expect(sources[2]!.url).toBe('/api/workspaces/w/sessions/s/events?cursor=9')
  dispose()
  expect(sources[2]!.close).toHaveBeenCalledOnce()
  expect(docListeners.size + winListeners.size).toBe(0)
  vi.useRealTimers()
})

it('swaps the terminal stream for a fresh one when the page returns after a long hide', () => {
  vi.useFakeTimers()
  const docListeners = new Map<string, () => void>()
  const doc = { visibilityState: 'visible', addEventListener: (k: string, f: () => void) => docListeners.set(k, f), removeEventListener: (k: string) => docListeners.delete(k) }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const sources: { url: string; onmessage?: (m: { data: string }) => void; close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('EventSource', Object.assign(class {
    readyState = 1
    close = vi.fn()
    constructor(public url: string) { sources.push(this as never) }
  }, { CONNECTING: 0, OPEN: 1, CLOSED: 2 }))
  const frames = vi.fn()
  const dispose = subscribeTerminals('w', frames)
  doc.visibilityState = 'hidden'; docListeners.get('visibilitychange')!()
  vi.advanceTimersByTime(60_000)
  doc.visibilityState = 'visible'; docListeners.get('visibilitychange')!()
  expect(sources.map((s) => s.url)).toEqual(['/api/workspaces/w/terminals/events', '/api/workspaces/w/terminals/events'])
  expect(sources[0]!.close).toHaveBeenCalledOnce()
  sources[1]!.onmessage!({ data: JSON.stringify({ kind: 'snapshot', terminals: [] }) })
  expect(frames).toHaveBeenCalledWith({ kind: 'snapshot', terminals: [] })
  dispose()
  expect(sources[1]!.close).toHaveBeenCalledOnce()
  vi.useRealTimers()
})
