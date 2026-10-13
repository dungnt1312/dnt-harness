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
const CREATED: GitChange = { ...raw, path: 'src/new.ts', status: 'added', indexStatus: 'A', worktreeStatus: ' ', created: true, staging: 'staged' }
const CONFLICT: GitChange = { ...raw, path: 'src/c.ts', status: 'conflict', indexStatus: 'U', worktreeStatus: 'U', conflicted: true }

const status = (changes: readonly GitChange[]): GitStatusReport => ({
  branch: 'main',
  branchInfo: { name: 'main', upstream: { remote: 'origin', branch: 'main' }, upstreamTrack: { kind: 'tracked', ahead: 0, behind: 0 } },
  head: { sha: 'abc1234', subject: 'init', message: 'init', hasParent: true },
  truncated: false,
  changes,
})

const TWO_HUNKS: GitDiffReport = {
  path: 'src/a.ts',
  lines: [
    { kind: 'hunk', text: '@@ -3,7 +3,7 @@' }, { kind: 'context', text: 'one' }, { kind: 'del', text: 'two' }, { kind: 'add', text: 'TWO' },
    { kind: 'hunk', text: '@@ -20,7 +20,7 @@' }, { kind: 'context', text: 'three' }, { kind: 'del', text: 'four' }, { kind: 'add', text: 'FOUR' },
  ],
  truncated: false,
  binary: false,
  hunks: [
    { oldStart: 3, oldLines: 7, newStart: 3, newLines: 7, fingerprint: 'f0', status: 'unstaged' },
    { oldStart: 20, oldLines: 7, newStart: 20, newLines: 7, fingerprint: 'f1', status: 'staged' },
  ],
}

const CONFLICTED: GitDiffReport = {
  path: 'src/c.ts',
  lines: [{ kind: 'context', text: 'text' }],
  truncated: false,
  binary: false,
  hunks: [],
  conflicts: [{ index: 0, startLine: 2, endLine: 6, ours: 'mine\n', theirs: 'theirs\n', oursName: 'HEAD', theirsName: 'feature', fingerprint: 'c0' }],
}

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => status([TRACKED]))
const gitOperation = vi.fn(async (_ws: string, _project: string, _input: GitOperationInput): Promise<GitOperationDone> => ({ type: 'done', ok: true, stdout: '', stderr: '' }))
const fetchGitDiff = vi.fn(async (_ws: string, _project: string, _path: string): Promise<GitDiffReport> => TWO_HUNKS)

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: (ws: string, project: string, path: string) => fetchGitDiff(ws, project, path),
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
  fetchGitStatus.mockImplementation(async () => status([TRACKED]))
  fetchGitDiff.mockImplementation(async () => TWO_HUNKS)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  fetchGitStatus.mockReset()
  fetchGitDiff.mockReset()
  gitOperation.mockClear()
})

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanel workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(document.querySelector('[data-diff-pane]')).not.toBeNull()) })
}

/** The buttons inside the nth hunk header of the pane. */
const hunkButtons = (index: number): string[] => {
  const anchor = document.querySelector(`[data-hunk-index="${index}"]`)
  return [...(anchor?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('title') ?? button.textContent ?? '')
}
const hunkButton = (index: number, title: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>(`[data-hunk-index="${index}"] button`)].find((button) => button.title === title)
  if (found === undefined) throw new Error(`no ${title} on hunk ${index}`)
  return found
}

describe('hunk buttons', () => {
  it('offers Stage/Restore on an unstaged hunk and Unstage/Restore on a staged one', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(hunkButtons(0).length).toBeGreaterThan(0)) })
    expect(hunkButtons(0)).toEqual(['Stage Hunk', 'Restore Hunk'])
    expect(hunkButtons(1)).toEqual(['Unstage Hunk', 'Restore Hunk'])
  })

  it('a partial hunk offers both Stage and Unstage', async () => {
    fetchGitDiff.mockImplementation(async () => ({ ...TWO_HUNKS, hunks: [{ ...TWO_HUNKS.hunks![0]!, status: 'partial' }, TWO_HUNKS.hunks![1]!] }))
    await mount()
    await act(async () => { await vi.waitFor(() => expect(hunkButtons(0).length).toBeGreaterThan(0)) })
    expect(hunkButtons(0)).toEqual(['Stage Hunk', 'Unstage Hunk', 'Restore Hunk'])
  })

  it('Stage Hunk sends the hunk identity, then the pane reads the diff again', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(hunkButtons(0).length).toBeGreaterThan(0)) })
    const reads = fetchGitDiff.mock.calls.length
    gitOperation.mockImplementationOnce(async () => ({ type: 'done', ok: true, stdout: '', stderr: '', status: status([TRACKED]) }))
    await act(async () => hunkButton(0, 'Stage Hunk').click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', {
      type: 'stage-hunk', path: 'src/a.ts', hunk: { oldStart: 3, oldLines: 7, newStart: 3, newLines: 7, fingerprint: 'f0' },
    })) })
    await act(async () => { await vi.waitFor(() => expect(fetchGitDiff.mock.calls.length).toBeGreaterThan(reads)) })
  })

  it('Restore Hunk and Unstage Hunk send their own operations', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(hunkButtons(1).length).toBeGreaterThan(0)) })
    await act(async () => hunkButton(1, 'Unstage Hunk').click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', expect.objectContaining({ type: 'unstage-hunk', hunk: expect.objectContaining({ fingerprint: 'f1' }) }))) })
    await act(async () => hunkButton(0, 'Restore Hunk').click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', expect.objectContaining({ type: 'restore-hunk', hunk: expect.objectContaining({ fingerprint: 'f0' }) }))) })
  })

  it('shows no Restore on a created file, and no buttons when the server offers no hunks', async () => {
    fetchGitStatus.mockImplementation(async () => status([CREATED]))
    fetchGitDiff.mockImplementation(async () => ({ ...TWO_HUNKS, path: 'src/new.ts' }))
    await mount()
    await act(async () => { await vi.waitFor(() => expect(hunkButtons(0).length).toBeGreaterThan(0)) })
    // Hunk 0 is unstaged, so it offers Stage; a created file never offers Restore.
    expect(hunkButtons(0)).toEqual(['Stage Hunk'])
    expect(hunkButtons(1)).toEqual(['Unstage Hunk'])

    await act(async () => root!.unmount())
    host.remove()
    fetchGitStatus.mockImplementation(async () => status([TRACKED]))
    fetchGitDiff.mockImplementation(async () => ({ ...TWO_HUNKS, hunks: [] }))
    await mount()
    await act(async () => { await vi.waitFor(() => expect(document.querySelector('[data-hunk-index="0"]')).not.toBeNull()) })
    expect(hunkButtons(0)).toEqual([])
  })
})

describe('conflict blocks', () => {
  it('shows Use <ours>, Use <theirs> and Use Both, and resolves with the chosen side', async () => {
    fetchGitStatus.mockImplementation(async () => status([CONFLICT]))
    fetchGitDiff.mockImplementation(async () => CONFLICTED)
    await mount()
    await act(async () => { await vi.waitFor(() => expect(document.querySelector('[data-conflict-index="0"]')).not.toBeNull()) })
    const block = document.querySelector<HTMLElement>('[data-conflict-index="0"]')!
    const labels = [...block.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toEqual(['Use HEAD', 'Use feature', 'Use Both'])
    expect(block.textContent).toContain('mine')
    expect(block.textContent).toContain('theirs')

    await act(async () => [...block.querySelectorAll('button')].find((button) => button.textContent === 'Use Both')!.click())
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', {
      type: 'resolve-conflict', path: 'src/c.ts', index: 0, fingerprint: 'c0', choice: 'both',
    })) })
  })
})
