// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useGated, useSessionDerivedGates, useSessionDerivedValues } from './session-derived.ts'
import type { SseEvent } from './types.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('skips chunk-only derivations but invalidates same-count replacement histories and recovery boundaries', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const derive = vi.fn(() => ({}))
  let running = false
  let recovered = false
  let phase = ''
  function Probe({ events }: { events: readonly SseEvent[] }) {
    const gates = useSessionDerivedGates(events)
    useGated(gates.turnCount, derive, [])
    const values = useSessionDerivedValues(events, 0, false)
    running = values.running
    recovered = values.recovered
    phase = values.phase
    return null
  }
  const start: SseEvent = { seq: 1, type: 'turn/start', turnId: 'a' }
  try {
    await act(async () => root.render(<Probe events={[start]} />))
    expect(running).toBe(true)
    await act(async () => root.render(<Probe events={[start, { seq: 2, type: 'assistant/chunk', delta: 'hi' }]} />))
    expect(derive).toHaveBeenCalledOnce()
    await act(async () => root.render(<Probe events={[{ seq: 1, type: 'turn/end', turnId: 'b' }]} />))
    expect(derive).toHaveBeenCalledTimes(2)
    expect(running).toBe(false)
    const recovery: SseEvent = { seq: 2, type: 'tool/result', recovery: true }
    await act(async () => root.render(<Probe events={[start, recovery]} />))
    expect(recovered).toBe(true)
    await act(async () => root.render(<Probe events={[start, recovery, { seq: 3, type: 'turn/start', turnId: 'next' }]} />))
    expect(recovered).toBe(false)
    const queued: SseEvent = { seq: 1, type: 'input/queued', inputId: 'q', content: 'waiting' }
    await act(async () => root.render(<Probe events={[queued]} />))
    expect(phase).toBe('preparing')
    await act(async () => root.render(<Probe events={[queued, { seq: 2, type: 'input/settled', inputId: 'q' }]} />))
    expect(phase).toBe('idle')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
