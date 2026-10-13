// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import { GitOutputHost } from './GitOutputHost.tsx'
import { ToastHost } from '../common/Toast.tsx'
import type { GitAskpassAnswer, GitAskpassFrame, GitChange, GitDiffReport, GitOperationDone, GitOperationInput, GitStatusReport } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = { indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging: 'unstaged' } as const

const CONFLICT: GitChange = { ...raw, path: 'src/merge.ts', status: 'conflict', indexStatus: 'U', worktreeStatus: 'U', conflicted: true }
const PARTIAL: GitChange = { ...raw, path: 'src/partial.ts', status: 'modified', indexStatus: 'M', staging: 'partial' }
const STAGED: GitChange = { ...raw, path: 'src/staged.ts', status: 'modified', indexStatus: 'M', worktreeStatus: ' ', staging: 'staged' }
const UNSTAGED: GitChange = { ...raw, path: 'src/a.ts', status: 'modified' }
const FRESH: GitChange = { ...raw, path: 'docs/new.md', status: 'untracked', indexStatus: '?', worktreeStatus: '?', created: true }

function report(changes: readonly GitChange[]): GitStatusReport {
  return {
    branch: 'main',
    branchInfo: { name: 'main', upstream: { remote: 'origin', branch: 'main' }, upstreamTrack: { kind: 'tracked', ahead: 0, behind: 0 } },
    head: { sha: 'abc1234', subject: 'init', message: 'init', hasParent: true },
    truncated: false,
    changes,
  }
}

const MIXED = report([FRESH, UNSTAGED, STAGED, PARTIAL, CONFLICT])

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => MIXED)
type OnAskpass = (prompt: GitAskpassFrame, signal: AbortSignal) => Promise<GitAskpassAnswer>
const gitOperation = vi.fn(async (_ws: string, _project: string, _input: GitOperationInput, _onAskpass: OnAskpass): Promise<GitOperationDone> => ({ type: 'done', ok: true, stdout: '', stderr: '' }))
const updateProjectGitTrust = vi.fn(async (_ws: string, _project: string, _trusted: boolean) => ({}))

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: async (_ws: string, _project: string, path: string): Promise<GitDiffReport> => ({ path, lines: [], truncated: false, binary: false }),
  gitOperation: (ws: string, project: string, input: GitOperationInput, onAskpass: OnAskpass) => gitOperation(ws, project, input, onAskpass),
  updateProjectGitTrust: (ws: string, project: string, trusted: boolean) => updateProjectGitTrust(ws, project, trusted),
  HttpError: class HttpError extends Error {
    constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}: ${body}`) }
  },
  mediaKindOf: () => null,
  projectMediaUrl: () => '',
}))

let root: Root | undefined
let host: HTMLDivElement

beforeEach(() => {
  fetchGitStatus.mockImplementation(async () => MIXED)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  fetchGitStatus.mockReset()
  gitOperation.mockReset()
  gitOperation.mockImplementation(async () => ({ type: 'done', ok: true, stdout: '', stderr: '' }))
  updateProjectGitTrust.mockClear()
})

/** The panel can be unmounted on its own, as when the user leaves the Git tab. */
let hidePanel: (() => void) | undefined
function GitPanelSlot({ props }: { readonly props: Partial<Parameters<typeof GitPanel>[0]> }) {
  const [shown, setShown] = useState(true)
  hidePanel = () => setShown(false)
  return shown ? <GitPanel workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} {...props} /> : null
}

async function mount(props: Partial<Parameters<typeof GitPanel>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanelSlot props={props} /><GitOutputHost /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('section')).not.toBeNull()) })
  return host
}

const checkbox = (label: string): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="${label}"]`)
  if (found === null) throw new Error(`no checkbox ${label}`)
  return found
}
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (found === undefined) throw new Error(`no button ${text}`)
  return found
}
const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()) }
const openHeaderMenu = async (): Promise<void> => click(document.querySelector<HTMLButtonElement>('button[aria-label="More changes actions"]')!)

describe('sections and tri-state checkboxes', () => {
  it('lists Conflicts, Tracked and Untracked in order, omitting empty sections', async () => {
    const view = await mount()
    expect([...view.querySelectorAll('section')].map((section) => section.getAttribute('aria-label'))).toEqual(['Conflicts', 'Tracked', 'Untracked'])
    const names = (title: string): string[] => [...view.querySelectorAll(`section[aria-label="${title}"] li`)].map((li) => li.querySelector('button')?.getAttribute('title') ?? '')
    expect(names('Conflicts')).toEqual(['src/merge.ts'])
    expect(names('Tracked')).toEqual(['src/a.ts', 'src/partial.ts', 'src/staged.ts'])
    expect(names('Untracked')).toEqual(['docs/new.md'])
  })

  it('shows a conflict-free report with only the sections it needs', async () => {
    fetchGitStatus.mockImplementation(async () => report([UNSTAGED]))
    const view = await mount()
    expect([...view.querySelectorAll('section')].map((section) => section.getAttribute('aria-label'))).toEqual(['Tracked'])
  })

  it('labels each row checkbox and marks a partly staged row mixed', async () => {
    await mount()
    expect(checkbox('Stage src/partial.ts').getAttribute('aria-checked')).toBe('mixed')
    expect(checkbox('Unstage src/staged.ts').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Stage src/a.ts').getAttribute('aria-checked')).toBe('false')
    expect(checkbox('Stage docs/new.md').getAttribute('aria-checked')).toBe('false')
  })

  it('names the checkbox for what the click does: Unstage only when fully staged', async () => {
    await mount()
    // A partly staged row stages; the fully staged one unstages.
    expect(checkbox('Stage src/partial.ts')).toBeDefined()
    expect(checkbox('Unstage src/staged.ts')).toBeDefined()
    // The Tracked section is mixed (an unstaged file), so its click stages.
    expect(checkbox('Stage all tracked')).toBeDefined()
  })

  it('derives each section checkbox from its own entries', async () => {
    await mount()
    // Tracked has one staged, one partial and one unstaged file: indeterminate.
    expect(checkbox('Stage all tracked').getAttribute('aria-checked')).toBe('mixed')
    expect(checkbox('Stage all untracked').getAttribute('aria-checked')).toBe('false')
    expect(checkbox('Stage all conflicts').getAttribute('aria-checked')).toBe('false')
  })

  it('a section checkbox stages only its own entries that are not staged yet', async () => {
    await mount()
    await click(checkbox('Stage all tracked'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage', paths: ['src/a.ts', 'src/partial.ts'] }, expect.any(Function))
  })

  it('a fully staged section checkbox unstages its entries', async () => {
    fetchGitStatus.mockImplementation(async () => report([STAGED, { ...STAGED, path: 'src/b.ts' }]))
    await mount()
    expect(checkbox('Unstage all tracked').getAttribute('aria-checked')).toBe('true')
    await click(checkbox('Unstage all tracked'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'unstage', paths: ['src/b.ts', 'src/staged.ts'] }, expect.any(Function))
  })

  it('the row hover controls keep the no-layout-cost contract', async () => {
    const view = await mount({ onOpenFile: () => {} })
    const opener = view.querySelector<HTMLButtonElement>('button[aria-label="Open a.ts in workbench"]')!
    const actions = view.querySelector<HTMLButtonElement>('button[aria-label="Actions for a.ts"]')!
    for (const control of [opener, actions]) {
      for (const token of ['absolute', 'opacity-0', 'invisible', 'group-hover/row:visible', 'focus-visible:visible', '[@media(pointer:coarse)]:visible']) {
        expect(control.className).toContain(token)
      }
    }
  })

  it('exempts the three row controls from the 44px touch floor so they keep their slots', async () => {
    const view = await mount({ onOpenFile: () => {} })
    for (const label of ['Open a.ts in workbench', 'Actions for a.ts', 'Stage src/a.ts']) {
      expect(view.querySelector(`button[aria-label="${label}"]`)?.hasAttribute('data-compact-control')).toBe(true)
    }
  })
})

describe('optimistic staging', () => {
  it('shows a partial row as staged before Git answers, and takes the answer as the new report', async () => {
    let finish!: (done: GitOperationDone) => void
    gitOperation.mockImplementationOnce(() => new Promise<GitOperationDone>((resolve) => { finish = resolve }))
    await mount()
    await click(checkbox('Stage src/partial.ts'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage', paths: ['src/partial.ts'] }, expect.any(Function))
    // Now fully staged, so the control offers Unstage.
    expect(checkbox('Unstage src/partial.ts').getAttribute('aria-checked')).toBe('true')

    const staged = { ...PARTIAL, staging: 'staged' as const, worktreeStatus: ' ' }
    await act(async () => finish({ type: 'done', ok: true, stdout: '', stderr: '', status: report([FRESH, UNSTAGED, STAGED, staged, CONFLICT]) }))
    expect(checkbox('Unstage src/partial.ts').getAttribute('aria-checked')).toBe('true')
    // The answer is the report now: the override is gone, so a later report moves the row.
    expect(fetchGitStatus).toHaveBeenCalledTimes(1)
  })

  it('rolls the row back and toasts Git\'s stderr when the operation fails', async () => {
    let fail!: (error: Error) => void
    gitOperation.mockImplementationOnce(() => new Promise<GitOperationDone>((_resolve, reject) => { fail = reject }))
    await mount()
    await click(checkbox('Stage src/partial.ts'))
    expect(checkbox('Unstage src/partial.ts').getAttribute('aria-checked')).toBe('true')
    await act(async () => fail(new Error('boom')))
    expect(checkbox('Stage src/partial.ts').getAttribute('aria-checked')).toBe('mixed')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('git stage failed')
    await click(button('View Log'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('boom')
  })

  it('a done frame with ok false rolls back and toasts its stderr', async () => {
    gitOperation.mockResolvedValueOnce({ type: 'done', ok: false, stdout: '', stderr: 'fatal: index.lock exists' })
    await mount()
    await click(checkbox('Stage src/partial.ts'))
    expect(checkbox('Stage src/partial.ts').getAttribute('aria-checked')).toBe('mixed')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('git stage failed')
    await click(button('View Log'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('fatal: index.lock exists')
  })

  it('runs queued actions one after the other', async () => {
    const order: string[] = []
    let finishFirst!: () => void
    gitOperation.mockImplementationOnce(async (_ws, _project, input) => {
      order.push(`start ${input.type}`)
      await new Promise<void>((resolve) => { finishFirst = resolve })
      order.push('end first')
      return { type: 'done', ok: true, stdout: '', stderr: '' }
    })
    gitOperation.mockImplementationOnce(async (_ws, _project, input) => {
      order.push(`start ${input.type}`)
      return { type: 'done', ok: true, stdout: '', stderr: '' }
    })
    await mount()
    await click(checkbox('Stage src/partial.ts'))
    await click(checkbox('Stage src/a.ts'))
    expect(order).toEqual(['start stage'])
    await act(async () => finishFirst())
    await act(async () => { await vi.waitFor(() => expect(order).toEqual(['start stage', 'end first', 'start stage'])) })
  })
})

describe('header split button', () => {
  it('stages everything through stage-all when something is unstaged', async () => {
    await mount()
    expect(button('Stage All')).toBeDefined()
    await click(button('Stage All'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage-all' }, expect.any(Function))
  })

  it('reads Unstage All, and unstages everything, when nothing is left unstaged', async () => {
    fetchGitStatus.mockImplementation(async () => report([STAGED]))
    await mount()
    expect(() => button('Stage All')).toThrow()
    await click(button('Unstage All'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'unstage-all' }, expect.any(Function))
  })

  it('disables the menu items that have nothing to act on', async () => {
    fetchGitStatus.mockImplementation(async () => report([UNSTAGED]))
    await mount()
    await openHeaderMenu()
    const item = (name: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find((entry) => entry.textContent === name)!
    expect(item('Stage All').disabled).toBe(false)
    expect(item('Unstage All').disabled).toBe(true)
    // Zed `staged_tracked_entries`: an unstaged-only report has nothing to discard.
    expect(item('Discard Tracked Changes').disabled).toBe(true)
    expect(item('Trash Untracked Files').disabled).toBe(true)
  })

  it('Discard Tracked Changes is disabled when no tracked file has anything staged', async () => {
    fetchGitStatus.mockImplementation(async () => report([UNSTAGED, FRESH]))
    await mount()
    await openHeaderMenu()
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find((entry) => entry.textContent === 'Discard Tracked Changes')!
    expect(item.disabled).toBe(true)
  })

  it('Discard Tracked Changes sends only the staged and partly staged tracked files', async () => {
    await mount()
    await openHeaderMenu()
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Discard Tracked Changes')!)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard changes to these files?')
    await click(button('Restore Tracked Files'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'discard', paths: ['src/staged.ts', 'src/partial.ts'] }, expect.any(Function))
  })

  it('keeps Stage All to the visible files in a turn filter', async () => {
    await mount({ pathFilter: ['src/a.ts', 'src/partial.ts'] })
    await click(button('Stage All'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage', paths: ['src/a.ts', 'src/partial.ts'] }, expect.any(Function))
  })
})

describe('discard and trash confirmations', () => {
  const rowMenu = async (name: string, item: string): Promise<void> => {
    await click(document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!)
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find((candidate) => candidate.textContent === item)
    await click(entry!)
  }
  const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]')

  it('asks before discarding one tracked file, and Cancel runs nothing', async () => {
    await mount()
    await rowMenu('a.ts', 'Discard Changes')
    expect(dialog()?.textContent).toContain('Are you sure you want to discard changes to `a.ts`?')
    await click(button('Cancel'))
    expect(dialog()).toBeNull()
    expect(gitOperation).not.toHaveBeenCalled()
  })

  it('discards the confirmed tracked path', async () => {
    await mount()
    await rowMenu('a.ts', 'Discard Changes')
    await click(button('Discard Changes'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'discard', paths: ['src/a.ts'] }, expect.any(Function))
  })

  it('asks before trashing an untracked file and sends the exact path', async () => {
    await mount()
    await rowMenu('new.md', 'Trash File')
    expect(dialog()?.textContent).toContain('Trash `new.md`?')
    await click(button('Trash'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'trash', paths: ['docs/new.md'] }, expect.any(Function))
  })

  it('reloads the status after a discard or trash that answers ok without a status', async () => {
    await mount()
    expect(fetchGitStatus).toHaveBeenCalledTimes(1)
    await rowMenu('a.ts', 'Discard Changes')
    await click(button('Discard Changes'))
    await act(async () => { await vi.waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(2)) })
    await rowMenu('new.md', 'Trash File')
    await click(button('Trash'))
    await act(async () => { await vi.waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(3)) })
  })

  it('lists at most five names for the header Discard Tracked Changes action', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name): GitChange => ({ ...STAGED, path: `src/${name}.ts` }))
    fetchGitStatus.mockImplementation(async () => report(many))
    await mount()
    await openHeaderMenu()
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Discard Tracked Changes')!)
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Discard changes to these files?')
    expect(text).toContain('a.ts')
    expect(text).toContain('e.ts')
    expect(text).not.toContain('f.ts')
    expect(text).toContain('and 2 more…')
    await click(button('Restore Tracked Files'))
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'discard', paths: many.map((change) => change.path) }, expect.any(Function))
  })

  it('trashes every untracked file from the header menu', async () => {
    const fresh = ['x', 'y'].map((name): GitChange => ({ ...FRESH, path: `tmp/${name}.txt` }))
    fetchGitStatus.mockImplementation(async () => report([UNSTAGED, ...fresh]))
    await mount()
    await openHeaderMenu()
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Trash Untracked Files')!)
    expect(dialog()?.textContent).toContain('Trash these files?')
    await click(button('Trash'))
    expect(gitOperation).toHaveBeenCalledOnce()
    expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'trash', paths: ['tmp/x.txt', 'tmp/y.txt'] }, expect.any(Function))
  })
})

/** Make the next operation raise one prompt, and settle with `done` once it is answered or its signal aborts. */
function promptingOperation(prompt: string, finish: (answer: GitAskpassAnswer) => GitOperationDone = () => ({ type: 'done', ok: true, stdout: '', stderr: '' })): { readonly answers: GitAskpassAnswer[]; readonly end: (done: GitOperationDone) => void } {
  const answers: GitAskpassAnswer[] = []
  let end!: (done: GitOperationDone) => void
  gitOperation.mockImplementationOnce((_ws, _project, _input, onAskpass) => new Promise<GitOperationDone>((resolve) => {
    end = resolve
    const controller = new AbortController()
    void onAskpass({ type: 'askpass', promptId: 'q1', operation: 'push', prompt }, controller.signal).then((answer) => {
      answers.push(answer)
      resolve(finish(answer))
    })
    // The caller ends the operation by itself: abort the prompt first, as `gitOperation` does.
    end = (done) => { controller.abort(); resolve(done) }
  }))
  return { answers, end: (done) => end(done) }
}

const dialogText = (): string => document.querySelector('[role="dialog"]')?.textContent ?? ''
const passwordInput = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('[role="dialog"] input')
const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('askpass modal', () => {
  const stageFirst = async (): Promise<void> => { await click(checkbox('Stage src/a.ts')) }

  it('shows the operation, the exact prompt and a masked single-line input', async () => {
    promptingOperation("Password for 'https://user@example.com': ")
    await mount()
    await stageFirst()
    expect(dialogText()).toContain('push')
    expect(dialogText()).toContain("Password for 'https://user@example.com': ")
    expect(dialogText()).not.toContain('You may need to configure git for Github.')
    const input = passwordInput()!
    expect(input.type).toBe('password')
    expect(input.tagName).toBe('INPUT')
    expect(document.querySelector('[role="dialog"] textarea')).toBeNull()
  })

  it('does not mask a username prompt', async () => {
    promptingOperation("Username for 'https://example.com': ")
    await mount()
    await stageFirst()
    expect(passwordInput()!.type).toBe('text')
  })

  it('keeps Confirm disabled while the input is empty', async () => {
    promptingOperation('Password:')
    await mount()
    await stageFirst()
    expect(button('Confirm').disabled).toBe(true)
    await type(passwordInput()!, 'x')
    expect(button('Confirm').disabled).toBe(false)
    await type(passwordInput()!, '')
    expect(button('Confirm').disabled).toBe(true)
  })

  it('Confirm answers with the password and closes the modal', async () => {
    const prompt = promptingOperation('Password:')
    await mount()
    await stageFirst()
    await type(passwordInput()!, 's3cret')
    await click(button('Confirm'))
    expect(prompt.answers).toEqual([{ password: 's3cret' }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.innerHTML).not.toContain('s3cret')
  })

  it('Enter in the input confirms', async () => {
    const prompt = promptingOperation('Password:')
    await mount()
    await stageFirst()
    await type(passwordInput()!, 'pw')
    await act(async () => { passwordInput()!.form!.requestSubmit() })
    expect(prompt.answers).toEqual([{ password: 'pw' }])
  })

  it('Cancel answers with a cancel and stays silent', async () => {
    const prompt = promptingOperation('Password:', () => ({ type: 'done', ok: false, stdout: '', stderr: 'fatal: could not read Password', cancelled: true }))
    await mount()
    await stageFirst()
    await click(button('Cancel'))
    expect(prompt.answers).toEqual([{ cancel: true }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('Escape cancels the prompt', async () => {
    const prompt = promptingOperation('Password:')
    await mount()
    await stageFirst()
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(prompt.answers).toEqual([{ cancel: true }])
  })

  it('cancels a prompt that arrives after the panel unmounted, so git is not left waiting', async () => {
    let askLater!: OnAskpass
    let finish!: (done: GitOperationDone) => void
    gitOperation.mockImplementationOnce((_ws, _project, _input, onAskpass) => new Promise<GitOperationDone>((resolve) => {
      askLater = onAskpass
      finish = resolve
    }))
    await mount()
    await stageFirst()
    await act(async () => hidePanel!())
    expect(host.querySelector('section')).toBeNull()
    const answer = await askLater({ type: 'askpass', promptId: 'late', operation: 'push', prompt: 'Password:' }, new AbortController().signal)
    expect(answer).toEqual({ cancel: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => finish({ type: 'done', ok: false, stdout: '', stderr: '', cancelled: true }))
  })

  it('closes itself when the operation ends without an answer', async () => {
    const prompt = promptingOperation('Password:')
    await mount()
    await stageFirst()
    expect(dialogText()).toContain('Password:')
    await act(async () => prompt.end({ type: 'done', ok: true, stdout: '', stderr: '' }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the Github hint with a Learn more link', async () => {
    promptingOperation("Password for 'https://github.com': ")
    await mount()
    await stageFirst()
    expect(dialogText()).toContain('You may need to configure git for Github.')
    const link = [...document.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')].find((anchor) => anchor.textContent === 'Learn more')!
    expect(link.href).toBe('https://docs.github.com/en/get-started/git-basics/set-up-git#authenticating-with-github-from-git')
    expect(link.target).toBe('_blank')
  })

  it('shows the Github hint for a Username prompt, and not for yes/no', async () => {
    promptingOperation("Username for 'https://github.com': ")
    await mount()
    await stageFirst()
    expect(dialogText()).toContain('Learn more')
    await click(button('Cancel'))
    promptingOperation('Are you sure you want to continue connecting (yes/no)? github.com')
    await click(checkbox('Stage src/a.ts'))
    expect(dialogText()).not.toContain('Learn more')
  })
})

describe('operation toasts', () => {
  const stage = async (): Promise<void> => { await click(checkbox('Stage src/a.ts')) }
  const alerts = (): string => document.querySelector('[role="alert"]')?.textContent ?? ''

  it('a failed operation is a persistent `git <action> failed` toast; View Log shows stderr in the output dialog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      gitOperation.mockResolvedValueOnce({ type: 'done', ok: false, stdout: 'some stdout', stderr: 'fatal: nope' })
      await mount()
      await stage()
      expect(alerts()).toContain('git stage failed')
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(alerts()).toContain('git stage failed')
      await click(button('View Log'))
      expect(dialogText()).toContain('stage output')
      expect(dialogText()).toContain('fatal: nope')
      expect(dialogText()).not.toContain('some stdout')
      // The toast action closes the toast; the dialog closes with Close.
      expect(document.querySelector('[role="alert"]')).toBeNull()
      await click(button('Close'))
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the toast headline reads `git <action> failed`, not an error-category summary', async () => {
    gitOperation.mockResolvedValueOnce({ type: 'done', ok: false, stdout: '', stderr: 'fatal: Authentication failed for https://x' })
    await mount()
    await stage()
    const headline = document.querySelector('[role="alert"] p')
    expect(headline?.textContent).toBe('git stage failed')
  })

  it('View Log still opens the stderr after the panel that raised the toast unmounted', async () => {
    gitOperation.mockResolvedValueOnce({ type: 'done', ok: false, stdout: '', stderr: 'fatal: lock held' })
    await mount()
    await stage()
    await act(async () => hidePanel!())
    expect(host.querySelector('section')).toBeNull()
    expect(alerts()).toContain('git stage failed')
    await click(button('View Log'))
    expect(dialogText()).toContain('stage output')
    expect(dialogText()).toContain('fatal: lock held')
    await click(button('Close'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('a refused request (thrown) opens the same log with the server\'s error text', async () => {
    gitOperation.mockRejectedValueOnce(new Error('network down'))
    await mount()
    await stage()
    expect(alerts()).toContain('git stage failed')
    await click(button('View Log'))
    expect(dialogText()).toContain('network down')
  })

  it('a cancelled operation is silent', async () => {
    gitOperation.mockResolvedValueOnce({ type: 'done', ok: false, stdout: '', stderr: 'fatal: could not read Password', cancelled: true })
    await mount()
    await stage()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('[role="status"][class*="animate"]')).toBeNull()
    expect(document.body.textContent).not.toContain('failed')
  })
})

describe('trust banner', () => {
  it('an untrusted project shows Restricted Mode with a Trust button and no Restrict Git item', async () => {
    await mount()
    expect(document.body.textContent).toContain('Restricted Mode')
    await openHeaderMenu()
    expect([...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)).not.toContain('Restrict Git')
  })

  it('Trust PATCHes the project, drops the banner and reloads the status', async () => {
    const onGitTrustChange = vi.fn()
    await mount({ onGitTrustChange })
    expect(fetchGitStatus).toHaveBeenCalledTimes(1)
    await click(button('Trust'))
    expect(updateProjectGitTrust).toHaveBeenCalledWith('ws1', 'p1', true)
    expect(document.body.textContent).not.toContain('Restricted Mode')
    expect(onGitTrustChange).toHaveBeenCalledWith(true)
    expect(fetchGitStatus).toHaveBeenCalledTimes(2)
  })

  it('Restrict Git reloads the status too, and a failed change does not', async () => {
    await mount({ project: { id: 'p1', name: 'proj', path: '/proj', gitTrusted: true } })
    expect(fetchGitStatus).toHaveBeenCalledTimes(1)
    updateProjectGitTrust.mockRejectedValueOnce(new Error('nope'))
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Git options"]')!)
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Restrict Git')!)
    expect(fetchGitStatus).toHaveBeenCalledTimes(1)
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Git options"]')!)
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Restrict Git')!)
    expect(fetchGitStatus).toHaveBeenCalledTimes(2)
  })

  it('a failed Trust keeps the banner and says why', async () => {
    updateProjectGitTrust.mockRejectedValueOnce(new Error('nope'))
    await mount()
    await click(button('Trust'))
    expect(document.body.textContent).toContain('Restricted Mode')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('nope')
  })

  it('a trusted project has no banner; Restrict Git in the menu PATCHes false and brings it back', async () => {
    await mount({ project: { id: 'p1', name: 'proj', path: '/proj', gitTrusted: true } })
    expect(document.body.textContent).not.toContain('Restricted Mode')
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Git options"]')!)
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Restrict Git')!)
    expect(updateProjectGitTrust).toHaveBeenCalledWith('ws1', 'p1', false)
    expect(document.body.textContent).toContain('Restricted Mode')
  })

  it('Restrict Git is reachable when the working tree is clean', async () => {
    fetchGitStatus.mockImplementation(async () => report([]))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<ToastHost><GitPanelSlot props={{ project: { id: 'p1', name: 'proj', path: '/proj', gitTrusted: true } }} /></ToastHost>))
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('No changes')) })
    expect(document.querySelector('button[aria-label="More changes actions"]')).toBeNull()
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Git options"]')!)
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Restrict Git')!)
    expect(updateProjectGitTrust).toHaveBeenCalledWith('ws1', 'p1', false)
    expect(document.body.textContent).toContain('Restricted Mode')
  })
})
