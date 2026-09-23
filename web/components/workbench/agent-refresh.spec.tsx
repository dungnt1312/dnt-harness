// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Workbench } from './Workbench.tsx'
import type { SseEvent } from '../../lib/types.ts'

vi.mock('./AgentRunsPanel.tsx', () => ({ AgentRunsPanel: ({ refreshSignal }: { refreshSignal: number }) => <span>refresh {refreshSignal}</span> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })
it('counts child events only when a new event array arrives', async () => {
  const events: SseEvent[] = [{ seq: 1, type: 'agent/child-spawn', childSessionId: 'child' }]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const files = { activeFile: null, openFiles: [], folder: '', showFixedView: vi.fn(), setFolder: vi.fn(), openFile: vi.fn(), closeFile: vi.fn(), focus: null }
  const render = (expanded: boolean) => <Workbench workspaceId="w" project={null} view="agents" onView={() => {}} views={['files', 'agents']} onViews={() => {}} files={files as never} context={{ meta: null, stream: 'open', sessionId: 's', sessionFolder: null, eventCount: events.length }} events={events} expanded={expanded} onClose={() => {}} />
  const filter = vi.spyOn(events, 'filter')
  await act(async () => root!.render(render(false)))
  const before = filter.mock.calls.length
  await act(async () => root!.render(render(true)))
  const after = filter.mock.calls.length
  expect(after).toBe(before)
  expect(host.textContent).toContain('refresh 1')
})
