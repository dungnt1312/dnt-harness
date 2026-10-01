// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EnvironmentPanel } from './EnvironmentPanel.tsx'
import type { SseEvent } from '../../lib/types.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

const ev = (type: string, fields: Record<string, unknown>): SseEvent => ({ type, seq: 0, ...fields }) as SseEvent
const onOpenView = vi.fn()
interface Base {
  readonly workspaceId: string | null
  readonly sessionId: string | null
  readonly project: { readonly id: string; readonly name: string; readonly path: string } | null
  readonly events: readonly SseEvent[]
  readonly connected: boolean
  readonly onOpenView: (view: 'git' | 'agents') => void
}
const base: Base = {
  workspaceId: 'ws',
  sessionId: 's1',
  project: { id: 'p1', name: 'repo', path: 'C:/repo' },
  events: [],
  connected: true,
  onOpenView,
}

async function render(props: Base): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<EnvironmentPanel {...props} />))
}

const startEvents = [ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' })]

it('renders collapsed git chips when nothing is live', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ branch: 'main', changes: [{ path: 'a.ts', status: 'modified', added: 5, removed: 2 }], truncated: false }), { status: 200 })))
  await render({ ...base, events: [] })
  // Collapsed with no live process/subagent: only the git chip carries data.
  expect(host.textContent).toContain('main')
  expect(host.textContent).toContain('+5')
  expect(host.textContent).toContain('−2')
})

it('auto-expands once per session scope and a user collapse sticks', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: startEvents })
  expect(host.textContent).toContain('dev')
  const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse environment"]')
  expect(collapse).not.toBeNull()
  await act(async () => collapse!.click())
  expect(host.textContent).not.toContain('dev')
  // A new start must not re-open after the user collapsed (one auto-open per scope).
  await act(async () => root!.render(<EnvironmentPanel {...base} events={[...startEvents, ev('process/start', { processId: 'p2', command: 'build', cwd: 'x' })]} />))
  expect(host.textContent).not.toContain('build')
})

it('resets auto-open for a new session scope', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: [ev('agent/child-spawn', { childSessionId: 'c1', definition: 'researcher' })] })
  const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse environment"]')
  expect(collapse).not.toBeNull()
  await act(async () => collapse!.click())
  await act(async () => root!.render(<EnvironmentPanel {...base} sessionId="s2" events={[ev('agent/child-spawn', { childSessionId: 'c9', definition: 'quiet-query' })]} />))
  expect(host.textContent).toContain('quiet-query')
})

it('stop button posts to the process stop route', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  await render({ ...base, events: startEvents })
  const stop = host.querySelector<HTMLButtonElement>('button[aria-label="Stop dev"]')
  expect(stop).not.toBeNull()
  await act(async () => stop!.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws/sessions/s1/processes/p1/stop', expect.objectContaining({ method: 'POST' }))
})

it('git row click opens the git workbench view', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"branch":null,"changes":[],"truncated":false}', { status: 200 })))
  await render({ ...base })
  const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Expand environment"]')
  expect(expand).not.toBeNull()
  await act(async () => expand!.click())
  const git = host.querySelector<HTMLButtonElement>('button[aria-label="Open git panel"]')
  expect(git).not.toBeNull()
  await act(async () => git!.click())
  expect(onOpenView).toHaveBeenCalledWith('git')
})

it('renders nothing without a session', async () => {
  await render({ ...base, sessionId: null, project: null, events: [] })
  expect(host.textContent).toBe('')
})
