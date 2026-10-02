// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProcessPanel } from './ProcessPanel.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function render(props: { readonly workspaceId: string | null; readonly sessionId: string | null; readonly processId: string | null }): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ProcessPanel {...props} />))
}

const runningDetail = {
  id: 'proc_1',
  command: 'pnpm dev',
  cwd: 'C:/repo',
  status: 'running' as const,
  startedAt: Date.now() - 30_000,
  exitCode: null,
  durationMs: 30_000,
  truncated: false,
  output: 'VITE ready in 320ms\nLocal: http://localhost:5173/',
  outputTruncated: false,
}

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

it('asks for a process when none is focused', async () => {
  await render({ workspaceId: 'ws', sessionId: 's1', processId: null })
  expect(host.textContent).toContain('Environment panel')
})

it('renders the focused process with its live output', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(runningDetail))
  vi.stubGlobal('fetch', fetchMock)
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_1' })
  expect(host.textContent).toContain('pnpm dev')
  expect(host.textContent).toContain('running')
  expect(host.textContent).toContain('VITE ready')
  expect(host.textContent).toContain('localhost:5173')
})

it('polls while running and stops polling once ended', async () => {
  vi.useFakeTimers()
  // A fresh Response per call: a Response body can be consumed exactly once.
  const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(runningDetail))
  vi.stubGlobal('fetch', fetchMock)
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_1' })
  const afterMount = fetchMock.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
  expect(fetchMock.mock.calls.length).toBeGreaterThan(afterMount)
  // Ended: the poll wheel comes off.
  const ended = { ...runningDetail, status: 'exited' as const, exitCode: 0 }
  fetchMock.mockImplementation(async () => jsonResponse(ended))
  await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
  const afterEnd = fetchMock.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(fetchMock.mock.calls.length).toBe(afterEnd)
  expect(host.textContent).toContain('exited')
})

it('stop button posts the stop route and refetches', async () => {
  const fetchMock = vi.fn()
    .mockImplementationOnce(async () => jsonResponse(runningDetail))
    .mockImplementationOnce(async () => jsonResponse({ stopped: true, processId: 'proc_1' }))
    .mockImplementation(async () => jsonResponse({ ...runningDetail, status: 'killed', exitCode: 1 }))
  vi.stubGlobal('fetch', fetchMock)
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_1' })
  const stop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop pnpm dev"]')
  expect(stop).not.toBeNull()
  await act(async () => stop!.click())
  const stopCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/processes/proc_1/stop') && (init as RequestInit | undefined)?.method === 'POST')
  expect(stopCall).toBeDefined()
})

it('a process the host no longer knows says so truthfully', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"no such process"}', { status: 404 })))
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_gone' })
  expect(host.textContent).toContain('no longer running on the host')
})
