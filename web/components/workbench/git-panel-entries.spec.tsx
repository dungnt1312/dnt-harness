// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import { ToastHost } from '../common/Toast.tsx'
import type { GitChange, GitDiffReport, GitOperationDone, GitOperationInput, GitStatusReport } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = { indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging: 'unstaged' } as const
const TRACKED: GitChange = { ...raw, path: 'src/a.ts', status: 'modified' }
const FRESH: GitChange = { ...raw, path: 'docs/new.md', status: 'untracked', indexStatus: '?', worktreeStatus: '?', created: true }
const STAGED: GitChange = { ...raw, path: 'src/sub/b.ts', status: 'modified', indexStatus: 'M', worktreeStatus: ' ', staging: 'staged' }

const status = (changes: readonly GitChange[]): GitStatusReport => ({
  branch: 'main',
  branchInfo: { name: 'main', upstream: { remote: 'origin', branch: 'main' }, upstreamTrack: { kind: 'tracked', ahead: 0, behind: 0 } },
  head: { sha: 'abc1234', subject: 'init', message: 'init', hasParent: true },
  truncated: false,
  changes,
})

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => status([TRACKED, FRESH, STAGED]))
const gitOperation = vi.fn(async (_ws: string, _project: string, _input: GitOperationInput): Promise<GitOperationDone> => ({ type: 'done', ok: true, stdout: '', stderr: '' }))

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: async (_ws: string, _project: string, path: string): Promise<GitDiffReport> => ({ path, lines: [], truncated: false, binary: false }),
  gitOperation: (ws: string, project: string, input: GitOperationInput) => gitOperation(ws, project, input),
  updateProjectGitTrust: vi.fn(async () => ({})),
  HttpError: class HttpError extends Error {
    constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}: ${body}`) }
  },
  mediaKindOf: () => null,
  projectMediaUrl: () => '',
}))

let root: Root | undefined
let host: HTMLDivElement
const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  window.localStorage.clear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  fetchGitStatus.mockImplementation(async () => status([TRACKED, FRESH, STAGED]))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  fetchGitStatus.mockReset()
  gitOperation.mockClear()
  writeText.mockClear()
})

async function mount(props: Partial<Parameters<typeof GitPanel>[0]> = {}): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanel workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} {...props} /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(document.querySelectorAll('[data-row-main]').length).toBeGreaterThan(0)) })
}

const row = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[data-row-main]')].find((button) => button.textContent?.includes(name))
  if (found === undefined) throw new Error(`no row ${name}`)
  return found
}
const contextMenu = async (target: HTMLElement): Promise<void> => {
  await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })) })
}
const menuTexts = (): string[] => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent?.trim() ?? '')
const menuItem = (text: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((item) => item.textContent?.trim() === text)
  if (found === undefined) throw new Error(`no menu item ${text}`)
  return found
}

describe('the entry context menu (Zed git_panel.rs:8342-8448)', () => {
  it('right-click on a tracked row lists the entry actions in Zed order', async () => {
    await mount()
    await contextMenu(row('a.ts'))
    expect(menuTexts()).toEqual(['Stage File', 'Discard Changes', 'Copy Path', 'Copy Relative Path', 'Add to .gitignore', 'Open Diff', 'View File'])
    expect(menuItem('Add to .gitignore').hasAttribute('disabled')).toBe(true)
  })

  it('an untracked row offers Trash File and an enabled Add to .gitignore that sends the ignore op', async () => {
    await mount()
    await contextMenu(row('new.md'))
    expect(menuTexts().slice(0, 2)).toEqual(['Stage File', 'Trash File'])
    expect(menuItem('Add to .gitignore').hasAttribute('disabled')).toBe(false)
    await act(async () => menuItem('Add to .gitignore').click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'ignore', paths: ['docs/new.md'] })) })
  })

  it('a staged row offers Unstage File', async () => {
    await mount()
    await contextMenu(row('b.ts'))
    expect(menuTexts()[0]).toBe('Unstage File')
  })

  it('Copy Path writes the absolute path and Copy Relative Path the relative one', async () => {
    await mount()
    await contextMenu(row('a.ts'))
    await act(async () => menuItem('Copy Path').click())
    expect(writeText).toHaveBeenLastCalledWith('/proj/src/a.ts')
    await contextMenu(row('a.ts'))
    await act(async () => menuItem('Copy Relative Path').click())
    expect(writeText).toHaveBeenLastCalledWith('src/a.ts')
  })

  it('Stage File sends the stage op for that file', async () => {
    await mount()
    await contextMenu(row('a.ts'))
    await act(async () => menuItem('Stage File').click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage', paths: ['src/a.ts'] })) })
  })

  it('Open Diff selects the row and View File opens it in the workbench', async () => {
    const onOpenFile = vi.fn()
    await mount({ onOpenFile })
    await contextMenu(row('new.md'))
    await act(async () => menuItem('Open Diff').click())
    expect(row('new.md').getAttribute('aria-current')).toBe('true')
    await contextMenu(row('new.md'))
    await act(async () => menuItem('View File').click())
    expect(onOpenFile).toHaveBeenCalledWith('docs/new.md')
  })

  it('the ⋯ button of a row opens the same items', async () => {
    await mount()
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Actions for a.ts"]')!.click())
    expect(menuTexts()).toEqual(['Stage File', 'Discard Changes', 'Copy Path', 'Copy Relative Path', 'Add to .gitignore', 'Open Diff', 'View File'])
  })
})

describe('the tree view', () => {
  const view = async (mode: 'List' | 'Tree'): Promise<void> => {
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="View options"]')!.click())
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === mode)!.click())
  }

  it('defaults to the list and View → Tree draws folders with a Stage Folder checkbox', async () => {
    await mount()
    expect(document.querySelector('[data-tree-dir]')).toBeNull()
    await view('Tree')
    const folders = [...document.querySelectorAll<HTMLElement>('[data-tree-dir]')].map((node) => node.getAttribute('data-tree-dir'))
    expect(folders).toEqual(expect.arrayContaining(['src', 'src/sub']))
    expect(document.querySelector('button[role="checkbox"][aria-label="Stage Folder src"]')).not.toBeNull()
    expect(window.localStorage.getItem('dnt-harness.git.view')).toBe('tree')
  })

  it('remembers the choice across a remount', async () => {
    await mount()
    await view('Tree')
    await act(async () => root!.unmount())
    host.remove()
    await mount()
    expect(document.querySelector('[data-tree-dir]')).not.toBeNull()
  })

  it('a folder checkbox stages only the descendants not staged yet', async () => {
    await mount()
    await view('Tree')
    await act(async () => document.querySelector<HTMLButtonElement>('button[role="checkbox"][aria-label="Stage Folder src"]')!.click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage', paths: ['src/a.ts'] })) })
  })

  it('clicking a folder row collapses and expands it', async () => {
    await mount()
    await view('Tree')
    expect(document.body.textContent).toContain('a.ts')
    await act(async () => document.querySelector<HTMLElement>('[data-tree-dir="src"] [data-dir-toggle]')!.click())
    expect(document.querySelector('[data-row-path="src/a.ts"]')).toBeNull()
    await act(async () => document.querySelector<HTMLElement>('[data-tree-dir="src"] [data-dir-toggle]')!.click())
    expect(document.querySelector('[data-row-path="src/a.ts"]')).not.toBeNull()
  })
})

describe('conflicts marked as resolved (Zed git_panel.rs:5947-5965, 8212-8286)', () => {
  const CONFLICT: GitChange = { ...raw, path: 'src/merge.ts', status: 'conflict', indexStatus: 'U', worktreeStatus: 'U', conflicted: true }
  const RESOLVED: GitChange = { ...CONFLICT, path: 'src/done.ts', staging: 'staged' }
  const checkbox = (label: string): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="${label}"]`)

  it('an unresolved conflict row stages normally', async () => {
    fetchGitStatus.mockImplementation(async () => status([CONFLICT]))
    await mount()
    const box = checkbox('Stage src/merge.ts')
    expect(box).not.toBeNull()
    expect(box!.disabled).toBe(false)
  })

  it('a staged (resolved) conflict row has its checkbox disabled and says why', async () => {
    fetchGitStatus.mockImplementation(async () => status([CONFLICT, RESOLVED]))
    await mount()
    const box = checkbox('Unstage src/done.ts')
    expect(box).not.toBeNull()
    expect(box!.disabled).toBe(true)
    expect(box!.title).toBe('Conflicts marked as resolved')
  })

  it('the Conflicts header reads "All conflicts marked as resolved" once every conflict is staged, and is disabled', async () => {
    fetchGitStatus.mockImplementation(async () => status([RESOLVED]))
    await mount()
    const header = document.querySelector<HTMLButtonElement>('section[aria-label="Conflicts"] button[role="checkbox"]')
    expect(header).not.toBeNull()
    expect(header!.disabled).toBe(true)
    expect(header!.title).toBe('All conflicts marked as resolved')
  })
})
