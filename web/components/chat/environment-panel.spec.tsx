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
  vi.useRealTimers()
})

const ev = (type: string, fields: Record<string, unknown>): SseEvent => ({ type, seq: 0, ...fields }) as SseEvent
const onOpenView = vi.fn()
const onOpenProcess = vi.fn()
interface Base {
  readonly workspaceId: string | null
  readonly sessionId: string | null
  readonly project: { readonly id: string; readonly name: string; readonly path: string } | null
  readonly events: readonly SseEvent[]
  readonly connected: boolean
  readonly onOpenView: (view: 'git' | 'agents') => void
  readonly onOpenProcess: (processId: string) => void
}
const base: Base = {
  workspaceId: 'ws',
  sessionId: 's1',
  project: { id: 'p1', name: 'repo', path: 'C:/repo' },
  events: [],
  connected: true,
  onOpenView,
  onOpenProcess,
}

async function render(props: Base): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<EnvironmentPanel {...props} />))
}

const startEvents = [ev('process/start', { processId: 'p1', command: 'dev', cwd: 'x' })]

it('renders collapsed git chips when nothing is live', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ branch: 'main', changes: [{ path: 'a.ts', status: 'modified', added: 2173, removed: 628 }], truncated: false, ahead: 70, behind: 0 }), { status: 200 })))
  await render({ ...base, events: [] })
  expect(host.textContent).toContain('main')
  expect(host.textContent).toContain('+2,173')
  expect(host.textContent).toContain('−628')
  expect(host.textContent).toContain('↑70')
  // Zero counts never render (↓0 noise).
  expect(host.textContent).not.toContain('↓0')
  // Collapse affordance is a chevron, never a close glyph.
  expect(host.querySelector('button[aria-label="Expand environment"] .icon-chevron') ?? host.querySelector('button[aria-label="Expand environment"] svg[class*="rotate"]')).not.toBeNull()
})

it('auto-expands into headed sections with counts', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: [...startEvents, ev('agent/child-spawn', { childSessionId: 'c1', definition: 'researcher' })] })
  // Section headings in the dntspace arrangement: icon + title + live count.
  expect(host.querySelector('section[aria-label="Background processes"]')?.textContent).toContain('Background processes')
  expect(host.querySelector('section[aria-label="Background processes"]')?.textContent).toContain('1 running')
  expect(host.querySelector('section[aria-label="Subagents"]')?.textContent).toContain('Subagents')
  expect(host.querySelector('section[aria-label="Subagents"]')?.textContent).toContain('1 running')
  expect(host.textContent).toContain('dev')
})

it('groups ended processes behind a collapsed toggle and clears them', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  const events = [
    ev('process/start', { processId: 'p1', command: 'live-dev', cwd: 'x' }),
    ev('process/start', { processId: 'p2', command: 'old-build', cwd: 'x' }),
    ev('process/exit', { processId: 'p2', exitCode: 1, termination: 'killed', durationMs: 5_000 }),
  ]
  await render({ ...base, events })
  const section = () => host.querySelector('section[aria-label="Background processes"]')!.textContent ?? ''
  // Running stays in view; the ended row is behind the collapsed group.
  expect(section()).toContain('live-dev')
  expect(section()).not.toContain('old-build')
  expect(section()).toContain('Ended · 1')
  // Expanding the group reveals it.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Toggle ended processes"]')!.click())
  expect(section()).toContain('old-build')
  // Clear drops every ended row; running is untouched.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear ended processes"]')!.click())
  expect(section()).not.toContain('old-build')
  expect(section()).not.toContain('Ended · 1')
  expect(section()).toContain('live-dev')
  // The dismissal survives a new event for the same id (no resurrection).
  await act(async () => root!.render(<EnvironmentPanel {...base} events={[...events, ev('process/exit', { processId: 'p2', exitCode: 1, termination: 'killed', durationMs: 5_000 })]} />))
  expect(section()).not.toContain('old-build')
})

it('header shows a working indicator while a turn is open', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  const t = Date.now()
  await render({ ...base, events: [ev('turn/start', { turnId: 't1', timestamp: t - 100_000 })] })
  expect(host.textContent).toContain('Working')
  expect(host.textContent).toContain('1m 40s')
  // A closed turn clears it.
  await act(async () => root!.render(<EnvironmentPanel {...base} events={[ev('turn/start', { turnId: 't1', timestamp: t - 100_000 }), ev('turn/end', { turnId: 't1', timestamp: t })]} />))
  expect(host.textContent).not.toContain('Working')
})

it('auto-expand fires once per session scope and a user collapse sticks', async () => {
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
  // The click on the row itself never triggers a stop — separate targets.
  expect(onOpenProcess).not.toHaveBeenCalled()
})

it('a process row click opens its workbench detail', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: startEvents })
  const row = host.querySelector<HTMLButtonElement>('button[title="Open dev in the workbench"]')
  expect(row).not.toBeNull()
  await act(async () => row!.click())
  expect(onOpenProcess).toHaveBeenCalledWith('p1')
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

const todoEvents = [
  ev('tool/call', { call: { id: 'c1', name: 'TodoWrite', args: { todos: [
    { content: 'Research', status: 'completed', activeForm: 'Researching' },
    { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' },
    { content: 'Test', status: 'pending', activeForm: 'Testing' },
  ] } } }),
  ev('tool/result', { callId: 'c1', ok: true, output: 'Todo list updated: 3 tasks (1 completed, 1 in progress, 1 pending)' }),
]

it('shows the Tasks section with counter and item rows', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: todoEvents })
  // The section is the expanded detail (the chip is the collapsed glance):
  // tasks never auto-open the panel, so expand explicitly.
  const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Expand environment"]')
  expect(expand).not.toBeNull()
  await act(async () => expand!.click())
  const section = host.querySelector('section[aria-label="Tasks"]')
  expect(section).not.toBeNull()
  expect(section?.textContent).toContain('1/3')
  expect(section?.textContent).toContain('Research')
  expect(section?.textContent).toContain('Implement')
  expect(section?.textContent).toContain('Test')
})

it('stays collapsed for tasks and shows the capsule chip instead', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: todoEvents })
  // No auto-open: the collapse button is still the collapsed one.
  expect(host.querySelector('button[aria-label="Expand environment"]')).not.toBeNull()
  expect(host.querySelector('[data-todo-chip]')?.textContent).toContain('1/3')
})

it('omits the Tasks section and chip when there is no list or after clearing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: [] })
  expect(host.querySelector('section[aria-label="Tasks"]')).toBeNull()
  expect(host.querySelector('[data-todo-chip]')).toBeNull()

  const cleared = [
    ev('tool/call', { call: { id: 'c1', name: 'TodoWrite', args: { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing a' }] } } }),
    ev('tool/result', { callId: 'c1', ok: true, output: 'Todo list updated: 1 task (1 completed)' }),
    ev('tool/call', { call: { id: 'c2', name: 'TodoWrite', args: { todos: [] } } }),
    ev('tool/result', { callId: 'c2', ok: true, output: 'Todo list cleared' }),
  ]
  await render({ ...base, events: cleared })
  expect(host.querySelector('section[aria-label="Tasks"]')).toBeNull()
  expect(host.querySelector('[data-todo-chip]')).toBeNull()
})
