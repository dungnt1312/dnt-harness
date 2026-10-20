// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionStream } from './useSessionStream.ts'
import type { Envelope } from '../lib/types.ts'

let receive: ((envelope: Envelope, cursor?: number) => void) | undefined
const dispose = vi.fn()
vi.mock('../lib/api.ts', () => ({ subscribeEventsIn: (_workspace: string, _session: string, callback: (envelope: Envelope, cursor?: number) => void) => { receive = callback; return dispose } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let renders: number[] = []
let approvals: string[] = []
let projected: readonly import('../lib/project.ts').ViewItem[] = []
function Probe({ session = 's' }: { session?: string }) {
  const { events, items, approvals: pending } = useSessionStream('w', session)
  projected = items
  renders.push(events.length)
  approvals = pending.map((row) => row.approvalId)
  return <span>{events.map((event) => event.seq).join(',')}</span>
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Probe />))
  return host
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; receive = undefined; renders = []; approvals = []; dispose.mockClear(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('session stream frame batching', () => {
  it('replaces the compactor as well as the projection on a fresh snapshot', async () => {
    const host = await mount()
    await act(async () => receive?.({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'old' }] }))
    await act(async () => receive?.({ kind: 'snapshot', events: [{ seq: 9, type: 'user/message', content: 'replacement' }] }))
    expect(host.textContent).toBe('9')
    expect(projected).toHaveLength(1)
  })
  it('restores a visited session and accepts an empty cursor resume without duplicate rows', async () => {
    const host = await mount()
    await act(async () => receive?.({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'cached' }] }, 5))
    await act(async () => root!.render(<Probe session="other" />))
    await act(async () => receive?.({ kind: 'snapshot', events: [{ seq: 2, type: 'user/message', content: 'other' }] }))
    await act(async () => root!.render(<Probe />))
    expect(host.textContent).toBe('1')
    await act(async () => receive?.({ kind: 'resume', events: [] }, 8))
    await act(async () => receive?.({ kind: 'session', event: { seq: 7, type: 'user/message', content: 'duplicate' } }))
    expect(projected).toHaveLength(1)
  })
  it('resumes buffered live projection without replaying or duplicating old rows', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    await mount()
    await act(async () => receive?.({ kind: 'snapshot', events: [{ seq: 1, type: 'user/message', content: 'hello' }] }))
    const user = projected[0]
    await act(async () => {
      receive?.({ kind: 'session', event: { seq: 2, type: 'assistant/chunk', delta: 'one' } })
      receive?.({ kind: 'resume', events: [{ seq: 2, type: 'assistant/chunk', delta: 'one' }, { seq: 3, type: 'assistant/chunk', delta: ' two' }] })
    })
    await act(async () => frames.shift()?.(0))
    expect(projected[0]).toBe(user)
    expect(projected[1]).toMatchObject({ content: 'one two' })
    await act(async () => receive?.({ kind: 'resume', events: [] }))
    expect(projected).toHaveLength(2)
  })
  it('commits a burst once per frame in event order, without duplicated sequence numbers', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const host = await mount()
    const before = renders.length
    await act(async () => {
      receive?.({ kind: 'session', event: { type: 'assistant/chunk', seq: 1, delta: 'a' } })
      receive?.({ kind: 'session', event: { type: 'assistant/chunk', seq: 1, delta: 'duplicate' } })
      receive?.({ kind: 'session', event: { type: 'assistant/chunk', seq: 2, delta: 'b' } })
      receive?.({ kind: 'session', event: { type: 'assistant/chunk', seq: 3, delta: 'c' } })
    })
    expect(renders).toHaveLength(before)
    expect(frames).toHaveLength(1)
    await act(async () => frames.shift()?.(0))
    expect(host.textContent).toBe('1,2,3')
    expect(renders).toHaveLength(before + 1)
  })

  it('settles an approval without waiting for a frame even when its request is buffered', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    await mount()
    const call = { id: 'c', name: 'Bash', args: {} }
    await act(async () => {
      receive?.({ kind: 'session', event: { type: 'approval/request', seq: 1, approvalId: 'a', call } })
      receive?.({ kind: 'approval-settled', approvalId: 'a' })
    })
    await act(async () => frames.shift()?.(0))
    expect(approvals).toEqual([])
  })

  it('drops buffered old-session events on snapshot replacement and cleanup', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const host = await mount()
    await act(async () => {
      receive?.({ kind: 'session', event: { type: 'assistant/chunk', seq: 1, delta: 'stale' } })
      receive?.({ kind: 'snapshot', events: [{ type: 'user/message', seq: 4, content: 'new' }] })
    })
    await act(async () => frames.shift()?.(0))
    expect(host.textContent).toBe('4')
    await act(async () => receive?.({ kind: 'session', event: { type: 'assistant/chunk', seq: 5, delta: 'pending' } }))
    await act(async () => root!.unmount())
    root = undefined
    await act(async () => frames.shift()?.(0))
    expect(dispose).toHaveBeenCalledOnce()
  })
})
