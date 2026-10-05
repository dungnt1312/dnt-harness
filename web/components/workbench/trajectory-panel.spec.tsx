// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TrajectoryPanel } from './TrajectoryPanel.tsx'
import type { SseEvent } from '../../lib/types.ts'

function event(partial: SseEvent): SseEvent {
  return partial
}

const EVENTS: readonly SseEvent[] = [
  event({ type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' }),
  event({ type: 'user/message', seq: 2, timestamp: 1_010, turnId: 't1', content: 'inspect me' }),
  event({ type: 'step/start', seq: 3, timestamp: 1_100, turnId: 't1', stepId: 's1' }),
  event({ type: 'assistant/message', seq: 4, timestamp: 1_400, stepId: 's1', content: 'the answer', controls: { model: 'glm-5.3' } }),
  event({ type: 'turn/end', seq: 5, timestamp: 1_500, turnId: 't1', reason: 'completed' }),
]

let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

async function mount(events: readonly SseEvent[]): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<TrajectoryPanel events={events} workspaceId="ws-1" sessionId="s-1" />))
  return host
}

it('clicking a model row opens the request inspector and Timeline returns', async () => {
  const view = await mount(EVENTS)
  expect(view.textContent).toContain('the answer')
  const row = [...view.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('the answer'))
  expect(row).toBeDefined()
  await act(async () => row!.click())
  expect(view.textContent).toContain('Turn 1 · request 1')
  expect(view.querySelector('[aria-label^="Request inspector"]')).not.toBeNull()
  const back = [...view.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Timeline')
  expect(back).toBeDefined()
  await act(async () => back!.click())
  expect(view.textContent).toContain('the answer')
  expect(view.querySelector('[aria-label^="Request inspector"]')).toBeNull()
})

it('a step with tool calls shows them in the inspector response, alongside the answer', async () => {
  const withCall: readonly SseEvent[] = [
    event({ type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' }),
    event({ type: 'user/message', seq: 2, timestamp: 1_010, turnId: 't1', content: 'inspect me' }),
    event({ type: 'step/start', seq: 3, timestamp: 1_100, turnId: 't1', stepId: 's1' }),
    event({ type: 'assistant/message', seq: 4, timestamp: 1_400, stepId: 's1', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'README.md' } }], controls: { model: 'glm-5.3' } }),
    event({ type: 'tool/call', seq: 5, timestamp: 1_420, call: { id: 'c1', name: 'Read', args: { path: 'README.md' } } }),
    event({ type: 'tool/result', seq: 6, timestamp: 1_900, callId: 'c1', ok: true, output: '# README\n' }),
    event({ type: 'step/start', seq: 7, timestamp: 1_900, turnId: 't1', stepId: 's2' }),
    event({ type: 'assistant/message', seq: 8, timestamp: 2_200, stepId: 's2', content: 'done', controls: { model: 'glm-5.3' } }),
    event({ type: 'turn/end', seq: 9, timestamp: 2_300, turnId: 't1', reason: 'completed' }),
  ]
  const view = await mount(withCall)
  // The first request's row is the tool-call-only answer; open it.
  const row = [...view.querySelectorAll<HTMLButtonElement>('[aria-label="Steps"] button')].find((button) => button.textContent?.includes('tool call'))
  expect(row).toBeDefined()
  await act(async () => row!.click())
  expect(view.textContent).toContain('Tool calls')
  await act(async () => {
    host.querySelectorAll<HTMLButtonElement>('[role="group"] button').forEach((button) => {
      if (button.textContent === 'Response') button.click()
    })
  })
  expect(view.textContent).toContain('Read')
})
