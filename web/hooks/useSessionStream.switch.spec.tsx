// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionStream } from './useSessionStream.ts'
import type { Envelope, SseEvent } from '../lib/types.ts'

const subscriptions: { session: string; cursor?: number | undefined; receive: (envelope: Envelope, cursor?: number) => void; close: ReturnType<typeof vi.fn> }[] = []
vi.mock('../lib/api.ts', () => ({ subscribeEventsIn: (_ws: string, session: string, receive: (envelope: Envelope, cursor?: number) => void, _state: unknown, cursor?: number) => {
  const close = vi.fn()
  subscriptions.push({ session, cursor, receive, close })
  return close
} }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
const renders: { session: string; content: string[]; events: readonly SseEvent[]; approvals: number; questions: number }[] = []
let strict = false
function Probe({ session, workspace = 'w' }: { session: string; workspace?: string }) {
  const state = useSessionStream(workspace, session)
  renders.push({ session, content: state.items.map((item) => 'content' in item ? item.content : ''), events: state.events, approvals: state.approvals.length, questions: state.questions.length })
  return null
}
async function select(session: string) {
  if (!root) root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root!.render(strict ? <StrictMode><Probe session={session} /></StrictMode> : <Probe session={session} />))
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  strict = false
  subscriptions.length = 0
  renders.length = 0
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
it('never renders old-session rows under a newly selected scope and resumes cached rows', async () => {
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'A' }] }, 5))
  const first = subscriptions.at(-1)!
  renders.length = 0
  await select('b')
  expect(renders.every((row) => !row.content.includes('A'))).toBe(true)
  expect(first.close).toHaveBeenCalledOnce()
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'B' }] }, 1))
  renders.length = 0
  await select('a')
  expect(renders[0]!.content).toEqual(['A'])
  expect(subscriptions.at(-1)!.cursor).toBe(5)
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'resume', events: [] }, 7))
  expect(renders.at(-1)!.content).toEqual(['A'])
  await select('b')
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBe(7)
})
it('replaces cached projection and compaction state when the server falls back to snapshot', async () => {
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'old' }] }))
  await select('b')
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'replacement' }] }))
  expect(renders.at(-1)!.content).toEqual(['replacement'])
  expect(renders.at(-1)!.events.map((event) => event.content)).toEqual(['replacement'])
})
it('drops cached thinking folds when a replacement snapshot arrives', async () => {
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [
    { seq: 1, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'old ' },
    { seq: 2, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'thought' },
  ] }, 2))
  await select('b')
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'new' }] }, 1))
  expect(renders.at(-1)!.events.map((event) => event.delta)).toEqual(['new'])
  await select('b')
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBe(1)
})
it('keeps the thinking fold across a cache roundtrip and skips compacted/duplicate replay without loss', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const runFrames = () => act(async () => { for (const frame of frames.splice(0)) frame(0) })
  await select('a')
  // The frame id (5) is ahead of the last raw event (2): replay compaction removed 3–5.
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [
    { seq: 1, type: 'user/message', content: 'A' },
    { seq: 2, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'x' },
  ] }, 5))
  await select('b')
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBe(5)
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'resume', events: [
    { seq: 4, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'stale' },
    { seq: 5, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'dup' },
    { seq: 6, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'y' },
    { seq: 7, type: 'assistant/chunk', stepId: 's', thinking: true, delta: 'z' },
  ] }, 7))
  await runFrames()
  expect(renders.at(-1)!.events.filter((event) => event.thinking === true).map((event) => event.delta)).toEqual(['xyz'])
  expect(renders.at(-1)!.events.map((event) => event.seq)).toEqual([1, 2])
  await select('b')
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBe(7)
  expect(renders.at(-1)!.events.filter((event) => event.thinking === true).map((event) => event.delta)).toEqual(['xyz'])
  // An empty replay still advances the retained cursor and leaves events untouched.
  const before = renders.at(-1)!.events
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'resume', events: [] }, 9))
  expect(renders.at(-1)!.events).toBe(before)
  await select('b')
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBe(9)
})
for (const mode of ['plain', 'StrictMode'] as const) {
  it(`paints the selected cached history on every render when a full inactive cache evicts at navigation (${mode})`, async () => {
    strict = mode === 'StrictMode'
    const sessions = ['a', 'b', 'c', 'd', 'e']
    for (const [index, session] of sessions.entries()) {
      await select(session)
      await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: session }] }, 10 + index))
    }
    // a–d are inactive, e is active. Selecting a must hand its cached entry
    // to the new effect even though e's cleanup inserts e into a full cache.
    renders.length = 0
    await select('a')
    expect(renders.length).toBeGreaterThan(0)
    expect(renders.every((row) => row.content.length === 1 && row.content[0] === 'a')).toBe(true)
    expect(renders.every((row) => row.events.length === 1 && row.events[0]!.content === 'a')).toBe(true)
    expect(renders.every((row) => row.approvals === 0 && row.questions === 0)).toBe(true)
    expect(subscriptions.at(-1)!.session).toBe('a')
    expect(subscriptions.at(-1)!.cursor).toBe(10)
    // The count bound still holds for inactive entries: b–e remain, the oldest of
    // them is the first to leave once another conversation is opened.
    await select('f')
    await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'f' }] }, 20))
    await select('b')
    expect(subscriptions.at(-1)!.cursor).toBeUndefined()
    await select('e')
    expect(subscriptions.at(-1)!.cursor).toBe(14)
  })
}
it('flushes buffered events before caching so the resume cursor cannot skip unpublished rows', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  await select('a')
  await act(async () => {
    subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'A' }] })
    subscriptions.at(-1)!.receive({ kind: 'session', event: { seq: 2, type: 'assistant/chunk', delta: 'pending' } })
  })
  await select('b')
  await select('a')
  expect(renders.at(-1)!.content).toEqual(['A', 'pending'])
  expect(subscriptions.at(-1)!.cursor).toBe(2)
})
it('does not resurrect stale approval or question actions when restoring cached history', async () => {
  await select('a')
  const source = subscriptions.at(-1)!
  await act(async () => {
    source.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'A' }] })
    source.receive({ kind: 'approval', approvalId: 'approval', call: { id: 'call', name: 'Bash', args: {} } })
    source.receive({ kind: 'question', questionId: 'question', callId: 'call', questions: [], expiresAt: 9999999999999 } as Envelope)
  })
  expect(renders.at(-1)!.approvals).toBe(1)
  expect(renders.at(-1)!.questions).toBe(1)
  await select('b')
  await select('a')
  expect(renders.at(-1)!.approvals).toBe(0)
  expect(renders.at(-1)!.questions).toBe(0)
  await act(async () => source.receive({ kind: 'session', event: { seq: 2, type: 'user/message', content: 'late' } }))
  expect(renders.at(-1)!.content).toEqual(['A'])
})
it('isolates identical session ids across workspaces', async () => {
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'workspace w' }] }))
  renders.length = 0
  await act(async () => root!.render(<Probe session="a" workspace="other" />))
  expect(renders.every((row) => row.content.length === 0)).toBe(true)
  expect(subscriptions.at(-1)!.cursor).toBeUndefined()
})
it('does not retain a history exceeding the payload budget', async () => {
  await select('a')
  await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'x'.repeat(4_000_001) }] }))
  await select('b')
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBeUndefined()
  expect(renders.at(-1)!.content).toEqual([])
})
it('evicts least recently viewed sessions after the inactive cache count limit', async () => {
  for (const session of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await select(session)
    await act(async () => subscriptions.at(-1)!.receive({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: session }] }))
  }
  await select('a')
  expect(subscriptions.at(-1)!.cursor).toBeUndefined()
  expect(renders.at(-1)!.content).toEqual([])
})
