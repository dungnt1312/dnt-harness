// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import { ToastHost } from '../common/Toast.tsx'
import type { GitChange, GitDiffReport, GitOperationDone, GitOperationInput, GitStatusReport } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = { indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging: 'unstaged' } as const
const STAGED: GitChange = { ...raw, path: 'src/staged.ts', status: 'modified', indexStatus: 'M', worktreeStatus: ' ', staging: 'staged' }
const A: GitChange = { ...raw, path: 'src/a.ts', status: 'modified' }
const B: GitChange = { ...raw, path: 'src/b.ts', status: 'modified' }

let current: GitStatusReport
const status = (changes: readonly GitChange[], over: Partial<GitStatusReport> = {}): GitStatusReport => ({
  branch: 'main',
  branchInfo: { name: 'main', upstream: { remote: 'origin', branch: 'main' }, upstreamTrack: { kind: 'tracked', ahead: 0, behind: 0 } },
  head: { sha: 'abc1234', subject: 'init', message: 'init', hasParent: true },
  truncated: false,
  changes,
  ...over,
})

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => current)
const gitOperation = vi.fn(async (_ws: string, _project: string, _input: GitOperationInput): Promise<GitOperationDone> => ({ type: 'done', ok: true, stdout: '', stderr: '' }))
type Generator = (subject: string | undefined, onText: (text: string) => void, signal: AbortSignal) => Promise<void>
const generate: { current: Generator } = { current: async () => {} }
const streamCommitMessage = vi.fn((_ws: string, _project: string, subject: string | undefined, onText: (text: string) => void, signal: AbortSignal) => generate.current(subject, onText, signal))

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: async (_ws: string, _project: string, path: string): Promise<GitDiffReport> => ({ path, lines: [], truncated: false, binary: false }),
  gitOperation: (ws: string, project: string, input: GitOperationInput) => gitOperation(ws, project, input),
  streamCommitMessage: (ws: string, project: string, subject: string | undefined, onText: (text: string) => void, signal: AbortSignal) => streamCommitMessage(ws, project, subject, onText, signal),
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
  current = status([STAGED])
  window.localStorage.clear()
  generate.current = async () => {}
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  gitOperation.mockClear()
  streamCommitMessage.mockClear()
  fetchGitStatus.mockClear()
})

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanel workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(textarea()).not.toBeNull()) })
}

const textarea = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('[role="group"][aria-label="Commit"] textarea[aria-label="Commit message"]')!
const setText = async (value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const byLabel = (label: string): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const click = async (element: Element): Promise<void> => { await act(async () => (element as HTMLElement).click()) }

describe('the suggestion', () => {
  it('one staged file shows Update <file> as the placeholder, and an empty draft commits it', async () => {
    await mount()
    expect(textarea().placeholder).toBe('Update staged.ts')
    const commit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Commit')!
    expect(commit.disabled).toBe(false)
    await click(commit)
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', expect.objectContaining({ type: 'commit', message: 'Update staged.ts' }))) })
  })

  it('several files suggest nothing: the placeholder is the plain prompt and Commit stays off', async () => {
    current = status([STAGED, { ...STAGED, path: 'src/other.ts' }])
    await mount()
    expect(textarea().placeholder).toBe('Enter commit message')
  })

  it('the merge message is the placeholder while merging, and an empty draft commits it', async () => {
    current = status([STAGED], { mergeHeads: true, mergeMessage: "Merge branch 'feature'" })
    await mount()
    expect(textarea().placeholder).toBe("Merge branch 'feature'")
  })
})

describe('Generate Commit Message', () => {
  it('streams deltas into the draft: a typed subject is sent and kept, deltas follow on a new line', async () => {
    generate.current = async (_subject, onText) => { onText('Add'); onText(' x') }
    await mount()
    await setText('Fix')
    await click(byLabel('Generate Commit Message')!)
    await act(async () => { await vi.waitFor(() => expect(textarea().value).toBe('Fix\nAdd x')) })
    expect(streamCommitMessage).toHaveBeenCalledWith('ws1', 'p1', 'Fix', expect.any(Function), expect.any(AbortSignal))
  })

  it('an empty draft is filled with the deltas and sends no subject', async () => {
    generate.current = async (_subject, onText) => { onText('Add widget') }
    await mount()
    await click(byLabel('Generate Commit Message')!)
    await act(async () => { await vi.waitFor(() => expect(textarea().value).toBe('Add widget')) })
    expect(streamCommitMessage.mock.calls[0]![2]).toBeUndefined()
  })

  it('while it runs the button turns into a stop button and the placeholder says so; stopping aborts', async () => {
    let seen: AbortSignal | undefined
    generate.current = (_subject, _onText, signal) => new Promise<void>((resolve) => { seen = signal; signal.addEventListener('abort', () => resolve()) })
    await mount()
    await click(byLabel('Generate Commit Message')!)
    expect(textarea().placeholder).toBe('Generating Commit…')
    const stop = byLabel('Cancel Commit Message Generation')
    expect(stop).not.toBeNull()
    await click(stop!)
    expect(seen?.aborted).toBe(true)
    await act(async () => { await vi.waitFor(() => expect(byLabel('Generate Commit Message')).not.toBeNull()) })
  })

  it('a failure becomes a toast with the server words and leaves the draft alone', async () => {
    generate.current = async () => { throw new Error('No commit message model is configured.') }
    await mount()
    await setText('keep me')
    await click(byLabel('Generate Commit Message')!)
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('No commit message model is configured.')) })
    expect(textarea().value).toBe('keep me')
  })

  it('is disabled with "No Changes to Commit" when nothing is staged or tracked', async () => {
    current = status([{ ...raw, path: 'new.md', status: 'untracked', indexStatus: '?', worktreeStatus: '?', created: true }])
    await mount()
    const button = byLabel('No Changes to Commit')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(true)
  })
})

describe('growing and the expanded editor', () => {
  it('starts at two lines and grows with the text up to six', async () => {
    await mount()
    expect(textarea().rows).toBe(2)
    await setText('1\n2\n3\n4')
    expect(textarea().rows).toBe(4)
    await setText('1\n2\n3\n4\n5\n6\n7\n8\n9')
    expect(textarea().rows).toBe(6)
  })

  it('Expand opens an 18-line editor on the same draft; Cmd+Enter there commits; Escape closes', async () => {
    await mount()
    await setText('Big change')
    await click(byLabel('Expand Commit Editor')!)
    const modal = document.querySelector<HTMLElement>('[role="dialog"]')!
    const big = modal.querySelector<HTMLTextAreaElement>('textarea')!
    expect(big.rows).toBe(18)
    expect(big.value).toBe('Big change')
    await act(async () => { big.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })) })
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', expect.objectContaining({ type: 'commit', message: 'Big change' }))) })
  })

  it('typing in the expanded editor changes the draft the panel shows', async () => {
    await mount()
    await click(byLabel('Expand Commit Editor')!)
    const big = document.querySelector<HTMLElement>('[role="dialog"]')!.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(big, 'typed large')
      big.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull()) })
    expect(textarea().value).toBe('typed large')
  })
})

describe('the last commit row', () => {
  it('is one muted line: the subject and an Uncommit button', async () => {
    await mount()
    const row = document.querySelector('[data-last-commit]')!
    expect(row.textContent).toContain('init')
    expect(row.querySelector('button[aria-label="Uncommit"]')).not.toBeNull()
    void A
    void B
  })
})

describe('committing while a message is generating (final review web I1)', () => {
  it('the Commit button is off and Cmd+Enter does nothing until generation ends; the stream never lands in a cleared editor', async () => {
    let push: ((text: string) => void) | undefined
    let finish: (() => void) | undefined
    generate.current = (_subject, onText) => new Promise<void>((resolve) => { push = onText; finish = resolve })
    current = status([STAGED, { ...STAGED, path: 'src/other.ts' }])
    await mount()
    await setText('Fix')
    await click(byLabel('Generate Commit Message')!)
    await act(async () => { push?.('\nAdd') })

    const commitBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Commit"] button')].find((button) => button.textContent?.trim() === 'Commit')!
    expect(commitBtn.disabled).toBe(true)
    expect(commitBtn.title).toBe('Generating commit message...')
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })) })
    expect(gitOperation.mock.calls.filter((call) => call[2].type === 'commit')).toHaveLength(0)

    await act(async () => { finish?.() })
    await act(async () => { await vi.waitFor(() => expect(commitBtn.disabled).toBe(false)) })
  })

  it('the ✨ button is off while conflicts are unstaged (Zed can_commit)', async () => {
    current = status([{ ...raw, path: 'src/merge.ts', status: 'conflict', indexStatus: 'U', worktreeStatus: 'U', conflicted: true }, STAGED])
    await mount()
    const generateButton = document.querySelector<HTMLButtonElement>('button[aria-label="Generate Commit Message"], button[aria-label="No Changes to Commit"]')!
    expect(generateButton.disabled).toBe(true)
  })
})
