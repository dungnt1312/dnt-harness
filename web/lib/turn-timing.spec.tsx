// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AssistantMessage, UserBubble } from '../components/chat/MessageParts.tsx'
import { formatTime } from './format.ts'
import { turnTimings } from './turn-timing.ts'
import type { SseEvent } from './types.ts'

let root: Root | undefined
let host: HTMLDivElement
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
async function mount(view: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(view)) }
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })

it('pairs each turn with its recorded start and end stamps', () => {
  const events: SseEvent[] = [
    { type: 'turn/start', seq: 1, turnId: 't1', timestamp: 1_000 },
    { type: 'user/message', seq: 2, content: 'hi', timestamp: 1_500 },
    { type: 'assistant/message', seq: 3, content: 'hello', timestamp: 60_000 },
    { type: 'turn/end', seq: 4, turnId: 't1', reason: 'completed', timestamp: 68_000 },
    { type: 'turn/start', seq: 5, turnId: 't2', timestamp: 90_000 },
  ]
  expect(turnTimings(events).get('t1')).toEqual({ startedAt: 1_000, endedAt: 68_000 })
  // A turn still open has only its start.
  expect(turnTimings(events).get('t2')).toEqual({ startedAt: 90_000 })
})

it('keeps a turn/end without a surviving start (truncated replay)', () => {
  const events: SseEvent[] = [{ type: 'turn/end', seq: 1, turnId: 't9', reason: 'completed', timestamp: 5_000 }]
  expect(turnTimings(events).get('t9')).toEqual({ endedAt: 5_000 })
})

it('renders the user header with You and the send time', async () => {
  // 10:20 local, in a zone offset from UTC so the assertion reads the format.
  const when = new Date(); when.setHours(10, 20, 0, 0)
  await mount(<UserBubble item={{ kind: 'user', content: 'Run the checks', ts: when.getTime() }} />)
  expect(host.textContent).toContain('You')
  expect(host.textContent).toContain('10:20')
})

it('renders the turn footer with the end time and duration', async () => {
  await mount(
    <AssistantMessage
      item={{ kind: 'assistant', content: 'done', live: false, ts: 68_000, thinking: [], thinkingLive: false, turnId: 't1', turnOpen: false }}
      turn={{ text: 'done' }}
      timing={{ startedAt: 1_000, endedAt: 68_000 }}
    />,
  )
  // The footer reads the turn's end stamp, rendered through formatTime — the
  // span (67s → `1m 7s`) comes from start → end.
  expect(host.textContent).toContain(formatTime(68_000))
  expect(host.textContent).toContain('1m 7s')
})

it('keeps the legacy footer time when the turn carried no stamps', async () => {
  const ts = new Date(); ts.setHours(14, 5, 0, 0)
  await mount(
    <AssistantMessage
      item={{ kind: 'assistant', content: 'done', live: false, ts: ts.getTime(), thinking: [], thinkingLive: false }}
      turn={{ text: 'done' }}
    />,
  )
  expect(host.textContent).toContain('02:05')
  expect(host.textContent).not.toMatch(/\d+m \d+s/)
})
