// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TaskStatus } from './TaskStatus.tsx'
import { taskPhase } from '../../lib/project.ts'
import type { SseEvent } from '../../lib/types.ts'

vi.mock('../../lib/project.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/project.ts')>()
  return { ...actual, taskPhase: vi.fn(actual.taskPhase) }
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
const events: SseEvent[] = [{ type: 'turn/start', seq: 1 }]
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.mocked(taskPhase).mockClear() })
it('does not rescan unchanged events when only connection status changes', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<TaskStatus events={events} pending={0} sending={false} connected />))
  expect(taskPhase).toHaveBeenCalledTimes(1)
  await act(async () => root!.render(<TaskStatus events={events} pending={0} sending={false} connected={false} />))
  expect(taskPhase).toHaveBeenCalledTimes(1)
})
