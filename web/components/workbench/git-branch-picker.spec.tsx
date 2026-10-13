// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import { ToastHost } from '../common/Toast.tsx'
import type { GitBranch, GitChange, GitDiffReport, GitOperationDone, GitOperationInput, GitStatusReport } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = { indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging: 'unstaged' } as const
const A: GitChange = { ...raw, path: 'src/a.ts', status: 'modified' }

const status = (): GitStatusReport => ({
  branch: 'main',
  branchInfo: { name: 'main', upstream: { remote: 'origin', branch: 'main' }, upstreamTrack: { kind: 'tracked', ahead: 0, behind: 0 } },
  head: { sha: 'abc1234', subject: 'init', message: 'init', hasParent: true },
  truncated: false,
  changes: [A],
})

const NOW = Math.floor(Date.now() / 1000)
let branches: readonly GitBranch[] = []
let defaultBranch: string | undefined
let listError: string | undefined

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => status())
const answer = (input: GitOperationInput): GitOperationDone => {
  if (input.type === 'branches') return { type: 'done', ok: true, stdout: '', stderr: '', branches, ...(defaultBranch !== undefined ? { defaultBranch } : {}), ...(listError !== undefined ? { error: listError } : {}) }
  if (input.type === 'remotes') return { type: 'done', ok: true, stdout: '', stderr: '', remotes: ['origin'] }
  return { type: 'done', ok: true, stdout: '', stderr: '', status: status() }
}
const gitOperation = vi.fn(async (_ws: string, _project: string, input: GitOperationInput): Promise<GitOperationDone> => answer(input))

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

beforeEach(() => {
  window.localStorage.clear()
  branches = [
    { name: 'main', remote: false, current: true, upstream: 'origin/main', unixTime: NOW - 60, subject: 'tip of main' },
    { name: 'feature', remote: false, current: false, unixTime: NOW - 3600, subject: 'work in progress' },
    { name: 'origin/main', remote: true, current: false, unixTime: NOW - 60, subject: 'tip of main' },
    { name: 'origin/topic', remote: true, current: false, unixTime: NOW - 86_400, subject: 'a remote topic' },
  ]
  defaultBranch = 'main'
  listError = undefined
  gitOperation.mockImplementation(async (_ws, _project, input) => answer(input))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  gitOperation.mockClear()
  fetchGitStatus.mockClear()
})

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanel workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(trigger()).not.toBeNull()) })
}

const trigger = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('button[aria-label="Switch Branch"]')
const open = async (): Promise<void> => {
  await act(async () => trigger()!.click())
  await act(async () => { await vi.waitFor(() => expect(document.querySelector('[data-branch-row]')).not.toBeNull()) })
}
const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[placeholder="Switch or type to create a branch…"]')!
const type = async (value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = async (name: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
}
const rowNames = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-branch-row]')].map((row) => row.getAttribute('data-branch-row') ?? '')
const rowOf = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-branch-row="${name}"]`)!
const sent = (type: GitOperationInput['type']): GitOperationInput[] => gitOperation.mock.calls.map((call) => call[2]).filter((entry) => entry.type === type)

describe('opening the picker', () => {
  it('asks for the branches each time it opens and lists them under Local and Remote headings', async () => {
    await mount()
    await open()
    expect(sent('branches')).toHaveLength(1)
    expect([...document.querySelectorAll('[data-branch-section]')].map((heading) => heading.textContent)).toEqual(['Local Branches', 'Remote Branches'])
    // The remote twin of a tracked local branch is hidden.
    expect(rowNames()).toEqual(['main', 'feature', 'origin/topic'])
  })

  it('marks the current branch and shows a relative time and the subject', async () => {
    await mount()
    await open()
    expect(rowOf('main').getAttribute('aria-current')).toBe('true')
    expect(rowOf('feature').textContent).toContain('work in progress')
    expect(rowOf('feature').textContent).toMatch(/hour/)
    expect(rowOf('origin/topic').textContent).toMatch(/yesterday|day/)
  })

  it('says when the list could not be fully read', async () => {
    listError = 'fatal: broken ref'
    await mount()
    await open()
    expect(document.body.textContent).toContain('Some branches could not be loaded: fatal: broken ref')
  })

  it('the filter menu narrows to local or remote branches', async () => {
    await mount()
    await open()
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Branch filter"]')!.click())
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === 'Remote Branches')!.click())
    expect(rowNames()).toEqual(['origin/topic'])
  })
})

describe('switching', () => {
  it('clicking a branch switches to it and closes the picker', async () => {
    await mount()
    await open()
    await act(async () => rowOf('feature').click())
    await act(async () => { await vi.waitFor(() => expect(sent('switch-branch')).toEqual([{ type: 'switch-branch', name: 'feature' }])) })
    await act(async () => { await vi.waitFor(() => expect(document.querySelector('[data-branch-row]')).toBeNull()) })
  })

  it('choosing the current branch only closes the picker', async () => {
    await mount()
    await open()
    await act(async () => rowOf('main').click())
    expect(sent('switch-branch')).toHaveLength(0)
    await act(async () => { await vi.waitFor(() => expect(document.querySelector('[data-branch-row]')).toBeNull()) })
  })

  it('Enter switches to the highlighted row; the arrows move the highlight', async () => {
    await mount()
    await open()
    // Rows are main, feature, origin/topic: one step down is feature, two is origin/topic, one back is feature.
    await key('ArrowDown')
    await key('ArrowDown')
    await key('ArrowUp')
    await key('Enter')
    await act(async () => { await vi.waitFor(() => expect(sent('switch-branch')).toEqual([{ type: 'switch-branch', name: 'feature' }])) })
  })

  it('typing filters the rows by fuzzy match', async () => {
    await mount()
    await open()
    await type('fea')
    expect(rowNames()).toEqual(['feature'])
  })
})

describe('creating', () => {
  it('a name that is no branch offers Create Branch with the normalized name, based off the current one; Enter creates it', async () => {
    await mount()
    await open()
    await type('new thing')
    const create = document.querySelector<HTMLElement>('[data-create-branch]')
    expect(create).not.toBeNull()
    expect(create!.textContent).toContain('Create Branch: "new-thing"…')
    expect(create!.textContent).toContain('Based off main')
    await key('Enter')
    await act(async () => { await vi.waitFor(() => expect(sent('create-branch')).toEqual([{ type: 'create-branch', name: 'new-thing' }])) })
  })

  it('an exact existing name offers no create row', async () => {
    await mount()
    await open()
    await type('feature')
    expect(document.querySelector('[data-create-branch]')).toBeNull()
  })

  it('"Create New From: <default>" creates off the default branch', async () => {
    // The panel is on `main`; the repository's default branch is `trunk`.
    branches = [{ name: 'main', remote: false, current: true }, { name: 'trunk', remote: false, current: false }]
    defaultBranch = 'trunk'
    await mount()
    await open()
    await type('hotfix')
    const from = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Create New From: trunk')
    expect(from).toBeDefined()
    await act(async () => from!.click())
    await act(async () => { await vi.waitFor(() => expect(sent('create-branch')).toEqual([{ type: 'create-branch', name: 'hotfix', base: 'trunk' }])) })
  })

  it('offers no "Create New From" when the default branch is the one already checked out', async () => {
    defaultBranch = 'main'
    await mount()
    await open()
    await type('hotfix')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Create New From'))).toBe(false)
  })
})

describe('deleting', () => {
  it('a row has a trash button except the current branch; a merged branch deletes at once', async () => {
    await mount()
    await open()
    expect(rowOf('main').querySelector('button[aria-label="Delete Branch"]')).toBeNull()
    await act(async () => rowOf('feature').querySelector<HTMLButtonElement>('button[aria-label="Delete Branch"]')!.click())
    await act(async () => { await vi.waitFor(() => expect(sent('delete-branch')).toEqual([{ type: 'delete-branch', name: 'feature', remote: false, force: false }])) })
  })

  it('a branch git calls unmerged asks to force delete, with no failure toast first', async () => {
    gitOperation.mockImplementation(async (_ws, _project, request) => {
      if (request.type === 'delete-branch' && request.force !== true) return { type: 'done', ok: false, stdout: '', stderr: "error: the branch 'feature' is not fully merged" }
      return answer(request)
    })
    await mount()
    await open()
    await act(async () => rowOf('feature').querySelector<HTMLButtonElement>('button[aria-label="Delete Branch"]')!.click())
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('Branch "feature" is not fully merged. Force delete it?')) })
    expect(document.body.textContent).not.toContain('git delete-branch failed')
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Force Delete')!.click())
    await act(async () => { await vi.waitFor(() => expect(sent('delete-branch').at(-1)).toEqual({ type: 'delete-branch', name: 'feature', remote: false, force: true })) })
  })

  it('a remote branch deletes as a remote ref', async () => {
    await mount()
    await open()
    await act(async () => rowOf('origin/topic').querySelector<HTMLButtonElement>('button[aria-label="Delete Branch"]')!.click())
    await act(async () => { await vi.waitFor(() => expect(sent('delete-branch')).toEqual([{ type: 'delete-branch', name: 'origin/topic', remote: true, force: false }])) })
  })
})

describe('failures', () => {
  it('a refused switch uses the panel\'s toast with View Log, and the picker stays', async () => {
    gitOperation.mockImplementation(async (_ws, _project, request) => {
      if (request.type === 'switch-branch') return { type: 'done', ok: false, stdout: '', stderr: 'error: Your local changes would be overwritten' }
      return answer(request)
    })
    await mount()
    await open()
    await act(async () => rowOf('feature').click())
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('git switch-branch failed')) })
  })
})
