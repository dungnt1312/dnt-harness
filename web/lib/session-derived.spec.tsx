// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useSessionDerivedValues } from './session-derived.ts'
import type { SseEvent } from './types.ts'

it('invalidates derived state for replacement sessions with equal boundary counts', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  let running = false
  function Probe({ events }: { events: SseEvent[] }) { running = useSessionDerivedValues(events, 0, false).running; return null }
  try {
    await act(async () => root.render(<Probe events={[{ type: 'turn/start', seq: 1 }]} />))
    expect(running).toBe(true)
    await act(async () => root.render(<Probe events={[{ type: 'turn/end', seq: 1 }]} />))
    expect(running).toBe(false)
  } finally { await act(async () => root.unmount()) }
})
