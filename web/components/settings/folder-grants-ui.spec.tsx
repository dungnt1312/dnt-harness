// @vitest-environment jsdom
/**
 * Folder-grant UI: the approval card's out-of-grant warning and its
 * "allow this folder for the session" answer (never for a child), the
 * project's extra-folders editor, and the composer's session folders chip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ApprovalBar } from '../chat/ApprovalBar.tsx'
import { ProjectFoldersEditor } from './ProjectFoldersEditor.tsx'
import { SessionFoldersChip } from '../composer/SessionFoldersChip.tsx'
import { getSessionGrants, setProjectFolders, setSessionGrants } from '../../lib/api.ts'
import type { ProjectRow } from '../../lib/types.ts'

vi.mock('../../lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api.ts')>()),
  setProjectFolders: vi.fn(async () => ({})),
  getSessionGrants: vi.fn(async () => ({
    revision: 2,
    roots: [{ path: 'D:/mine', access: 'write' }],
    effective: [{ path: 'D:/mine', access: 'write' }, { path: 'D:/shared', access: 'read' }],
  })),
  setSessionGrants: vi.fn(async () => ({ revision: 3, roots: [], effective: [{ path: 'D:/shared', access: 'read' }] })),
}))

if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement

async function mount(node: ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(node) })
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function button(name: string | RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) =>
    typeof name === 'string' ? (candidate.textContent ?? '').trim() === name || candidate.getAttribute('aria-label') === name : name.test(candidate.textContent ?? ''))
  if (found === undefined) throw new Error(`no button ${String(name)}`)
  return found as HTMLButtonElement
}

describe('approval card for out-of-grant paths', () => {
  const row = { approvalId: 'a', call: { id: 'c', name: 'Read', args: { path: 'D:/other/x.ts' } }, scopeWarning: 'Outside granted folders: D:/other/x.ts (read)', proposedGrant: 'D:/other', proposedAccess: 'read' as const }

  it('shows the warning and answers for the session with the exact folder', async () => {
    const answer = vi.fn()
    await mount(<ApprovalBar approvals={[row]} onAnswer={answer} />)
    expect(host.textContent).toContain('Outside granted folders: D:/other/x.ts (read)')
    const session = button(/Allow read in D:\/other for this session/)
    await act(async () => session.click())
    expect(answer).toHaveBeenCalledWith('a', true, 'session')
    await act(async () => button('Allow once').click())
    expect(answer).toHaveBeenLastCalledWith('a', true)
  })

  it('keeps the end of a long folder visible on the session button', async () => {
    const long = 'C:\\Users\\someone\\AppData\\Local\\Temp\\run-1\\outside'
    await mount(<ApprovalBar approvals={[{ ...row, proposedGrant: long }]} onAnswer={vi.fn()} />)
    const session = button(/for this session/)
    expect(session.textContent).toContain('…\\run-1\\outside')
    expect(session.getAttribute('title')).toBe(long)
  })

  it('never offers a session answer to a child agent\'s question', async () => {
    await mount(<ApprovalBar approvals={[{ ...row, childSessionId: 'child-1' }]} onAnswer={vi.fn()} />)
    expect(host.textContent).not.toMatch(/for this session/)
  })
})

describe('project extra folders editor', () => {
  const projects: ProjectRow[] = [
    { id: 'p1', name: 'Main', workspaceId: 'w', path: 'D:/main', createdAt: 0, additionalDirectories: [{ kind: 'project', projectId: 'p2', access: 'read' }] },
    { id: 'p2', name: 'Shared lib', workspaceId: 'w', path: 'D:/lib', createdAt: 0 },
  ]

  it('lists, edits access, adds a folder, and saves the whole list', async () => {
    const saved = vi.fn(async () => {})
    await mount(<ProjectFoldersEditor workspaceId="w" project={projects[0]!} projects={projects} onSaved={saved} onCancel={vi.fn()} />)
    expect(host.textContent).toContain('Shared lib')
    await act(async () => button('Read & write').click())
    const input = host.querySelector('input[aria-label="Folder to add"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'D:/docs')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Add folder').click())
    await act(async () => button('Save folders').click())
    expect(setProjectFolders).toHaveBeenCalledWith('w', 'p1', [
      { kind: 'project', projectId: 'p2', access: 'write' },
      { kind: 'path', path: 'D:/docs', access: 'read' },
    ])
    expect(saved).toHaveBeenCalled()
  })
})

describe('session folders chip', () => {
  it('counts effective folders and removes a conversation folder with its revision', async () => {
    await mount(<SessionFoldersChip workspaceId="w" sessionId="s" revision={0} />)
    expect(getSessionGrants).toHaveBeenCalledWith('w', 's')
    const trigger = host.querySelector('button[aria-label="Extra folders (2)"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); trigger.click() })
    expect(document.body.textContent).toContain('D:/shared')
    await act(async () => button('Remove D:/mine').click())
    expect(setSessionGrants).toHaveBeenCalledWith('w', 's', 2, [])
  })

  it('re-applies a removal once to the fresh list when an approval changed it first', async () => {
    const { HttpError } = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts')
    vi.mocked(setSessionGrants).mockRejectedValueOnce(new HttpError(409, 'stale'))
    // The fresh list carries a folder an approval added meanwhile.
    vi.mocked(getSessionGrants)
      .mockResolvedValueOnce({ revision: 2, roots: [{ path: 'D:/mine', access: 'write' }], effective: [{ path: 'D:/mine', access: 'write' }] })
      .mockResolvedValueOnce({ revision: 3, roots: [{ path: 'D:/mine', access: 'write' }, { path: 'D:/approved', access: 'read' }], effective: [] })
    await mount(<SessionFoldersChip workspaceId="w" sessionId="s" revision={0} />)
    const trigger = host.querySelector('button[aria-label="Extra folders (1)"]') as HTMLButtonElement
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); trigger.click() })
    await act(async () => button('Remove D:/mine').click())
    expect(setSessionGrants).toHaveBeenLastCalledWith('w', 's', 3, [{ path: 'D:/approved', access: 'read' }])
  })

  it('reloads when the stream reports a new grants revision', async () => {
    await mount(<SessionFoldersChip workspaceId="w" sessionId="s" revision={0} />)
    await act(async () => root!.render(<SessionFoldersChip workspaceId="w" sessionId="s" revision={1} />))
    expect(getSessionGrants).toHaveBeenCalledTimes(2)
  })
})
