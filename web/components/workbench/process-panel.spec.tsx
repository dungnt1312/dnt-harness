// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProcessPanel, processStatus } from './ProcessPanel.tsx'
import { resetDismissedCache } from '../../lib/dismissed-rows.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  window.localStorage.clear()
  resetDismissedCache()
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
const doneDetail = { ...runningDetail, id: 'proc_2', command: 'npm test', status: 'exited' as const, exitCode: 0, startedAt: Date.now() - 60_000, durationMs: 8_000, output: '# pass 5\n# fail 0' }
const failedDetail = { ...doneDetail, id: 'proc_3', command: 'npm run lint', exitCode: 2, startedAt: Date.now() - 90_000 }

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** Route the list and detail endpoints over a mutable set of processes. */
function routes(initial: readonly (typeof runningDetail | typeof doneDetail)[]) {
  let processes = [...initial]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'POST') return jsonResponse({ stopped: true, processId: 'proc_1' })
    if (path.endsWith('/processes')) return jsonResponse(processes.map(({ output: _o, outputTruncated: _t, ...row }) => row))
    const id = path.split('/').pop()
    const found = processes.find((row) => row.id === id)
    return found === undefined ? new Response('{"error":"no such process"}', { status: 404 }) : jsonResponse(found)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, set: (next: typeof processes) => { processes = next } }
}

const card = (id: string) => host.querySelector<HTMLElement>(`[data-process-id="${id}"]`)

it('says so when the conversation has no background tasks', async () => {
  routes([])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: null })
  expect(host.textContent).toContain('No background tasks')
})

it('lists running and finished tasks with Claude-style status labels', async () => {
  routes([runningDetail, doneDetail, failedDetail])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: null })
  expect(host.textContent).toContain('Background tasks')
  expect(host.textContent).toContain('1 running')
  expect(host.textContent).toContain('Finished 2')
  expect(card('proc_2')!.textContent).toContain('Completed')
  expect(card('proc_3')!.textContent).toContain('Failed (exit 2)')
  // Collapsed cards do not fetch or show output.
  expect(host.textContent).not.toContain('# pass 5')
})

it('opens the focused process expanded with its live output', async () => {
  routes([runningDetail])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_1' })
  expect(card('proc_1')!.textContent).toContain('pnpm dev')
  expect(card('proc_1')!.textContent).toContain('Running')
  expect(host.querySelector('[aria-label="Process output"]')!.textContent).toContain('localhost:5173')
})

it('expands a finished card on click to show its output', async () => {
  routes([doneDetail])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: null })
  await act(async () => card('proc_2')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  expect(host.querySelector('[aria-label="Process output"]')!.textContent).toContain('# pass 5')
})

it('polls while running and the detail follows the exit', async () => {
  vi.useFakeTimers()
  const { fetchMock, set } = routes([runningDetail])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_1' })
  const afterMount = fetchMock.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
  expect(fetchMock.mock.calls.length).toBeGreaterThan(afterMount)
  set([{ ...runningDetail, status: 'exited' as const, exitCode: 0, output: 'bye' } as unknown as typeof runningDetail])
  await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  expect(card('proc_1')!.textContent).toContain('Completed')
  expect(host.querySelector('[aria-label="Process output"]')!.textContent).toContain('bye')
})

it('stop button posts the stop route', async () => {
  const { fetchMock } = routes([runningDetail])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: null })
  const stop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop pnpm dev"]')
  expect(stop).not.toBeNull()
  await act(async () => stop!.click())
  const stopCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/processes/proc_1/stop') && init?.method === 'POST')
  expect(stopCall).toBeDefined()
})

it('clears finished tasks from the view', async () => {
  routes([runningDetail, doneDetail])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: null })
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear finished tasks"]')!.click())
  expect(card('proc_2')).toBeNull()
  expect(card('proc_1')).not.toBeNull()
})

it('a focused process the host no longer knows says so truthfully', async () => {
  routes([])
  await render({ workspaceId: 'ws', sessionId: 's1', processId: 'proc_gone' })
  await act(async () => { await Promise.resolve() })
  expect(host.textContent).toContain('no longer running on the host')
})

it('maps statuses to labels', () => {
  expect(processStatus({ status: 'exited', exitCode: 0 }).label).toBe('Completed')
  expect(processStatus({ status: 'exited', exitCode: 1 }).label).toBe('Failed (exit 1)')
  expect(processStatus({ status: 'killed', exitCode: null }).label).toBe('Stopped')
  expect(processStatus({ status: 'failed', exitCode: null }).label).toBe('Failed')
})
