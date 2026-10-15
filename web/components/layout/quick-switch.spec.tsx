// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QuickSwitch, quickSwitchItems } from './QuickSwitch.tsx'
import type { ProjectRow, SessionListing, WorkspaceRow } from '../../lib/types.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(() => { Element.prototype.scrollIntoView = () => {} })

const session = (id: string, title: string, at: number, extra: Partial<SessionListing> = {}): SessionListing =>
  ({ id, title, eventCount: 1, folder: null, updatedAt: at, ...extra })
const sessions = [
  session('s1', 'Fix login', 1, { projectId: 'p1' }),
  session('s2', 'Login page polish', 2),
  session('c1', 'Login subagent', 3, { parentSessionId: 's1' }),
]
const projects: ProjectRow[] = [{ id: 'p1', name: 'harness', workspaceId: 'w1', path: '/x', createdAt: 1 }]
const workspaces: WorkspaceRow[] = [
  { id: 'w1', name: 'Main', archived: false, createdAt: 1 },
  { id: 'w2', name: 'Harness lab', archived: false, createdAt: 2 },
  { id: 'w3', name: 'Old harness', archived: true, createdAt: 3 },
]

describe('quickSwitchItems', () => {
  it('lists conversations newest first, then projects, then other live workspaces', () => {
    expect(quickSwitchItems('', sessions, projects, workspaces, 'w1').map((item) => `${item.kind}:${item.id}`))
      .toEqual(['session:s2', 'session:s1', 'project:p1', 'workspace:w2'])
  })
  it('filters every group by a case-insensitive substring', () => {
    expect(quickSwitchItems('HARNESS', sessions, projects, workspaces, 'w1').map((item) => item.id)).toEqual(['p1', 'w2'])
    expect(quickSwitchItems('login', sessions, projects, workspaces, 'w1').map((item) => item.id)).toEqual(['s2', 's1'])
  })
})

describe('QuickSwitch', () => {
  let root: Root | undefined
  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
  })

  const input = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Search conversations, projects and workspaces"]')!
  const key = (k: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function mount() {
    const onChoose = vi.fn()
    const onDismiss = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<QuickSwitch open sessions={sessions} projects={projects} workspaces={workspaces} activeWorkspaceId="w1" onChoose={onChoose} onDismiss={onDismiss} />))
    return { onChoose, onDismiss }
  }

  it('chooses the highlighted match with Enter after arrowing down, and closes', async () => {
    const { onChoose, onDismiss } = await mount()
    await type('harness')
    await key('ArrowDown')
    await key('Enter')
    expect(onDismiss).toHaveBeenCalled()
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workspace', id: 'w2' }))
  })

  it('says so when nothing matches', async () => {
    const { onChoose } = await mount()
    await type('zzz')
    expect(document.body.textContent).toContain('No matches')
    await key('Enter')
    expect(onChoose).not.toHaveBeenCalled()
  })
})
