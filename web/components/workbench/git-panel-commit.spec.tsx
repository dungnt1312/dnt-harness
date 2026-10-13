// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import { GitOutputHost } from './GitOutputHost.tsx'
import { ToastHost } from '../common/Toast.tsx'
import type { GitAskpassAnswer, GitAskpassFrame, GitBranchInfo, GitChange, GitDiffReport, GitOperationDone, GitOperationInput, GitStatusReport, GitUpstreamTrack } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = { indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging: 'unstaged' } as const
const CONFLICT: GitChange = { ...raw, path: 'src/merge.ts', status: 'conflict', indexStatus: 'U', worktreeStatus: 'U', conflicted: true }
const STAGED: GitChange = { ...raw, path: 'src/staged.ts', status: 'modified', indexStatus: 'M', worktreeStatus: ' ', staging: 'staged' }
const UNSTAGED: GitChange = { ...raw, path: 'src/a.ts', status: 'modified' }
const FRESH: GitChange = { ...raw, path: 'docs/new.md', status: 'untracked', indexStatus: '?', worktreeStatus: '?', created: true }

const HEAD = { sha: 'abc1234def5678', subject: 'init', message: 'init\n\nbody line', hasParent: true }
const tracked = (ahead: number, behind: number): GitUpstreamTrack => ({ kind: 'tracked', ahead, behind })

function report(changes: readonly GitChange[], over: Partial<GitStatusReport> = {}, track: GitUpstreamTrack = tracked(0, 0), upstream: GitBranchInfo['upstream'] = { remote: 'origin', branch: 'main' }): GitStatusReport {
  const branchInfo: GitBranchInfo = { name: 'main', ...(upstream !== undefined && track.kind !== 'none' ? { upstream } : {}), upstreamTrack: track }
  return { branch: 'main', branchInfo, head: HEAD, truncated: false, changes, ...over }
}

let current: GitStatusReport = report([STAGED])
const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => current)
type OnAskpass = (prompt: GitAskpassFrame, signal: AbortSignal) => Promise<GitAskpassAnswer>
let remotes: readonly string[] = ['origin']
let pushedTo: readonly string[] = []
const done = (over: Partial<GitOperationDone> = {}): GitOperationDone => ({ type: 'done', ok: true, stdout: '', stderr: '', ...over })
const defaultOp = async (input: GitOperationInput): Promise<GitOperationDone> => {
  if (input.type === 'remotes') return done({ remotes })
  if (input.type === 'pushed-to') return done({ pushedTo })
  return done()
}
const gitOperation = vi.fn(async (_ws: string, _project: string, input: GitOperationInput, _onAskpass: OnAskpass): Promise<GitOperationDone> => defaultOp(input))

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: async (_ws: string, _project: string, path: string): Promise<GitDiffReport> => ({ path, lines: [], truncated: false, binary: false }),
  gitOperation: (ws: string, project: string, input: GitOperationInput, onAskpass: OnAskpass) => gitOperation(ws, project, input, onAskpass),
  updateProjectGitTrust: async () => ({}),
  HttpError: class HttpError extends Error {
    constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}: ${body}`) }
  },
  mediaKindOf: () => null,
  projectMediaUrl: () => '',
}))

let root: Root | undefined
let host: HTMLDivElement

beforeEach(() => {
  current = report([STAGED])
  remotes = ['origin']
  pushedTo = []
  window.localStorage.clear()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  gitOperation.mockReset()
  gitOperation.mockImplementation(async (_ws, _project, input) => defaultOp(input))
  fetchGitStatus.mockClear()
})

async function mount(props: Partial<Parameters<typeof GitPanel>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanel workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} {...props} /><GitOutputHost /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(document.body.textContent).not.toContain('Checking git…')) })
  return host
}

const click = async (element: Element): Promise<void> => { await act(async () => (element as HTMLElement).click()) }
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (found === undefined) throw new Error(`no button ${text}`)
  return found
}
const textarea = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!
const type = async (value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = async (init: KeyboardEventInit): Promise<void> => {
  await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
}
const openMenu = async (label: string): Promise<void> => click(document.querySelector(`button[aria-label="${label}"]`)!)
const menuItem = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')].find((entry) => entry.textContent?.trim() === name)
  if (found === undefined) throw new Error(`no menu item ${name}`)
  return found
}
const menuItems = (): string[] => [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map((entry) => entry.textContent?.trim() ?? '')
const dialogText = (): string => document.querySelector('[role="dialog"]')?.textContent ?? ''
const sent = (type: GitOperationInput['type']): GitOperationInput[] => gitOperation.mock.calls.map((call) => call[2]).filter((input) => input.type === type)
const commitButton = (label: string): HTMLButtonElement => button(label)
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

describe('commit button', () => {
  it('names the reason in the tooltip and disables itself', async () => {
    current = report([UNSTAGED, CONFLICT])
    await mount()
    expect(commitButton('Commit Tracked').disabled).toBe(true)
    expect(commitButton('Commit Tracked').title).toBe('You must resolve conflicts before committing')

    document.body.innerHTML = ''
    await act(async () => root!.unmount())
    current = report([])
    await mount()
    expect(commitButton('Commit Tracked').title).toBe('No changes to commit')

    await act(async () => root!.unmount())
    current = report([FRESH])
    await mount()
    expect(commitButton('Commit Tracked').title).toBe('No changes to commit')

    // Two staged files suggest nothing, so an empty editor has no message to commit.
    await act(async () => root!.unmount())
    current = report([STAGED, { ...STAGED, path: 'src/other.ts' }])
    await mount()
    expect(commitButton('Commit').disabled).toBe(true)
    expect(commitButton('Commit').title).toBe('No commit message')
  })

  it('one staged file suggests its message, so an empty editor can commit (Zed has_commit_message)', async () => {
    current = report([STAGED])
    await mount()
    expect(commitButton('Commit').disabled).toBe(false)
  })

  it('reads Commit with staged changes, Commit Tracked with only unstaged tracked ones, and shows the command', async () => {
    await mount()
    await type('msg')
    expect(commitButton('Commit').disabled).toBe(false)
    expect(commitButton('Commit').title).toBe('Commit\ngit commit')
    await act(async () => root!.unmount())
    current = report([UNSTAGED])
    await mount()
    await type('msg')
    expect(commitButton('Commit Tracked').disabled).toBe(false)
  })

  it('Cmd+Enter and Ctrl+Enter commit; a plain Enter only types', async () => {
    await mount()
    await type('first')
    await press({ key: 'Enter' })
    expect(sent('commit')).toHaveLength(0)
    await press({ key: 'Enter', metaKey: true })
    expect(sent('commit')).toEqual([{ type: 'commit', message: 'first', amend: false, signoff: false, noVerify: false, tracked: false }])
    await type('second')
    await press({ key: 'Enter', ctrlKey: true })
    expect(sent('commit')).toHaveLength(2)
  })

  it('Commit Tracked sends tracked:true; staged changes send tracked:false', async () => {
    current = report([UNSTAGED])
    await mount()
    await type('tracked work')
    await click(commitButton('Commit Tracked'))
    expect(sent('commit')).toEqual([{ type: 'commit', message: 'tracked work', amend: false, signoff: false, noVerify: false, tracked: true }])
  })

  it('clears the editor on success and keeps it, with a toast, on failure', async () => {
    await mount()
    await type('keep me')
    gitOperation.mockImplementationOnce(async () => done({ ok: false, stderr: 'hook failed' }))
    await click(commitButton('Commit'))
    expect(textarea().value).toBe('keep me')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('git commit failed')
    await click(commitButton('Commit'))
    expect(textarea().value).toBe('')
  })

  it('shows the status the commit answered with', async () => {
    await mount()
    await type('x')
    gitOperation.mockImplementationOnce(async () => done({ status: report([], { head: { sha: 'f00', subject: 'x', message: 'x', hasParent: true } }) }))
    await click(commitButton('Commit'))
    expect(document.querySelector('[aria-label="Commit"]')?.textContent).toContain('x')
    expect(fetchGitStatus).toHaveBeenCalledTimes(1)
  })

  it('warns instead of committing while conflicts are unstaged', async () => {
    current = report([STAGED, CONFLICT])
    await mount()
    await type('msg')
    await press({ key: 'Enter', metaKey: true })
    expect(dialogText()).toContain('There are still conflicts. You must stage these before committing')
    expect(sent('commit')).toHaveLength(0)
    await click(button('OK'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

const gate = () => {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { opened, release }
}

describe('commit and the operation queue', () => {
  const SECOND: GitChange = { ...raw, path: 'src/b.ts', status: 'modified' }

  it('runs a commit after the stage clicks before it resolve, and counts them as staged', async () => {
    current = report([UNSTAGED, SECOND])
    await mount()
    await type('queued')
    const gates = [gate(), gate()]
    let stages = 0
    gitOperation.mockImplementation(async (_ws, _project, input) => {
      if (input.type === 'stage') await gates[stages++]!.opened
      return defaultOp(input)
    })
    await click(document.querySelector('button[role="checkbox"][aria-label="Stage src/a.ts"]')!)
    await click(document.querySelector('button[role="checkbox"][aria-label="Stage src/b.ts"]')!)
    expect(sent('stage')).toHaveLength(1)
    await press({ key: 'Enter', metaKey: true })
    expect(sent('commit')).toHaveLength(0)
    await act(async () => { gates[0]!.release() })
    await flush()
    expect(sent('stage')).toHaveLength(2)
    expect(sent('commit')).toHaveLength(0)
    await act(async () => { gates[1]!.release() })
    await act(async () => { await vi.waitFor(() => expect(sent('commit')).toHaveLength(1)) })
    expect(gitOperation.mock.calls.map((call) => call[2].type).filter((kind) => kind === 'stage' || kind === 'commit')).toEqual(['stage', 'stage', 'commit'])
    expect(sent('commit')[0]).toMatchObject({ tracked: false, message: 'queued' })
  })

  it('queues the uncommit and its pushed-to query behind a pending stage', async () => {
    current = report([UNSTAGED])
    await mount()
    const stageGate = gate()
    gitOperation.mockImplementation(async (_ws, _project, input) => {
      if (input.type === 'stage') await stageGate.opened
      return defaultOp(input)
    })
    await click(document.querySelector('button[role="checkbox"][aria-label="Stage src/a.ts"]')!)
    await click(document.querySelector('button[aria-label="Uncommit"]')!)
    expect(sent('pushed-to')).toHaveLength(0)
    await act(async () => { stageGate.release() })
    await act(async () => { await vi.waitFor(() => expect(sent('uncommit')).toHaveLength(1)) })
    expect(gitOperation.mock.calls.map((call) => call[2].type)).toEqual(['stage', 'pushed-to', 'uncommit'])
  })
})

describe('commit menu', () => {
  it('does not wipe a draft restored during an amend: Cancel and Amend wait for the answer', async () => {
    await mount()
    await type('draft')
    await openMenu('Commit options')
    await click(menuItem('Amend'))
    const answer = gate()
    gitOperation.mockImplementationOnce(async () => { await answer.opened; return done() })
    await click(commitButton('Amend'))
    expect(button('Cancel').disabled).toBe(true)
    await click(button('Cancel'))
    expect(textarea().value).toBe('init\n\nbody line')
    await openMenu('Commit options')
    expect(menuItem('Amend').disabled).toBe(true)
    await click(menuItem('Amend'))
    expect(textarea().value).toBe('init\n\nbody line')
    await act(async () => { answer.release() })
    await act(async () => { await vi.waitFor(() => expect(document.body.textContent).not.toContain('This will update your most recent commit.')) })
    expect(textarea().value).toBe('draft')
  })

  it('offers Amend only when there is a commit to amend', async () => {
    await mount()
    await openMenu('Commit options')
    expect(menuItems()).toEqual(['Amend', 'Signoff', 'Skip Hooks'])
    expect(menuItem('Skip Hooks').title).toBe('git commit --no-verify')
    await act(async () => root!.unmount())
    current = report([STAGED], { head: null })
    await mount()
    await openMenu('Commit options')
    expect(menuItems()).toEqual(['Signoff', 'Skip Hooks'])
  })

  it('Amend loads the last commit message and Amend again restores the draft', async () => {
    await mount()
    await type('my draft')
    await openMenu('Commit options')
    await click(menuItem('Amend'))
    expect(textarea().value).toBe('init\n\nbody line')
    expect(document.body.textContent).toContain('This will update your most recent commit.')
    expect(commitButton('Amend').disabled).toBe(false)
    await openMenu('Commit options')
    expect(menuItem('Amend').getAttribute('aria-checked')).toBe('true')
    await click(menuItem('Amend'))
    expect(textarea().value).toBe('my draft')
    expect(document.body.textContent).not.toContain('This will update your most recent commit.')
  })

  it('the Cancel of the amend row restores the draft', async () => {
    await mount()
    await type('draft')
    await openMenu('Commit options')
    await click(menuItem('Amend'))
    await click(button('Cancel'))
    expect(textarea().value).toBe('draft')
  })

  it('an amend sends amend:true with the loaded message, then turns amend off and restores the draft', async () => {
    await mount()
    await type('draft')
    await openMenu('Commit options')
    await click(menuItem('Amend'))
    await click(commitButton('Amend'))
    expect(sent('commit')).toEqual([{ type: 'commit', message: 'init\n\nbody line', amend: true, signoff: false, noVerify: false, tracked: false }])
    expect(textarea().value).toBe('draft')
    expect(document.body.textContent).not.toContain('This will update your most recent commit.')
  })

  it('a failed amend stays in amend mode', async () => {
    await mount()
    await openMenu('Commit options')
    await click(menuItem('Amend'))
    gitOperation.mockImplementationOnce(async () => done({ ok: false, stderr: 'nope' }))
    await click(commitButton('Amend'))
    expect(document.body.textContent).toContain('This will update your most recent commit.')
    expect(textarea().value).toBe('init\n\nbody line')
  })

  it('Signoff is sent, persists per project and survives a remount', async () => {
    await mount()
    await openMenu('Commit options')
    await click(menuItem('Signoff'))
    expect(window.localStorage.getItem('dnt-harness.git.signoff.p1')).toBe('1')
    await type('signed')
    expect(commitButton('Commit').title).toBe('Commit\ngit commit --signoff')
    await click(commitButton('Commit'))
    expect(sent('commit')).toEqual([expect.objectContaining({ signoff: true })])

    await act(async () => root!.unmount())
    await mount()
    await openMenu('Commit options')
    expect(menuItem('Signoff').getAttribute('aria-checked')).toBe('true')
    await click(menuItem('Signoff'))
    expect(window.localStorage.getItem('dnt-harness.git.signoff.p1')).toBe('0')
  })

  it('Skip Hooks sends noVerify and turns itself off after a successful commit, not after a failure', async () => {
    await mount()
    await openMenu('Commit options')
    await click(menuItem('Skip Hooks'))
    await type('quick')
    expect(commitButton('Commit').title).toBe('Commit\ngit commit --no-verify')
    gitOperation.mockImplementationOnce(async () => done({ ok: false, stderr: 'x' }))
    await click(commitButton('Commit'))
    await openMenu('Commit options')
    expect(menuItem('Skip Hooks').getAttribute('aria-checked')).toBe('true')
    await click(menuItem('Skip Hooks'))
    await openMenu('Commit options')
    await click(menuItem('Skip Hooks'))
    await click(commitButton('Commit'))
    expect(sent('commit').at(-1)).toMatchObject({ noVerify: true })
    await type('again')
    await openMenu('Commit options')
    expect(menuItem('Skip Hooks').getAttribute('aria-checked')).toBe('false')
  })
})

describe('last commit and Uncommit', () => {
  const uncommitButton = (): HTMLButtonElement | null => document.querySelector('button[aria-label="Uncommit"]')

  it('shows the subject and an Uncommit button with the command in its tooltip', async () => {
    await mount()
    expect(document.querySelector('[aria-label="Commit"]')?.textContent).toContain('init')
    expect(uncommitButton()!.title).toBe('Uncommit\ngit reset HEAD^ --soft')
  })

  it('has no Uncommit for a root commit', async () => {
    current = report([STAGED], { head: { ...HEAD, hasParent: false } })
    await mount()
    expect(uncommitButton()).toBeNull()
    expect(document.querySelector('[aria-label="Commit"]')?.textContent).toContain('init')
  })

  it('uncommits at once when nothing was pushed, and puts the prior message in the editor', async () => {
    await mount()
    await click(uncommitButton()!)
    expect(gitOperation.mock.calls.map((call) => call[2].type)).toEqual(['pushed-to', 'uncommit'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(textarea().value).toBe('init\n\nbody line')
  })

  it('asks first when the commit was pushed, naming the remote refs', async () => {
    pushedTo = ['refs/remotes/origin/main', 'refs/remotes/backup/main']
    await mount()
    await click(uncommitButton()!)
    expect(dialogText()).toContain('Are you sure?')
    expect(dialogText()).toContain('This commit was already pushed to origin/main, backup/main.')
    expect(sent('uncommit')).toHaveLength(0)
    await click(button('Uncommit'))
    expect(sent('uncommit')).toHaveLength(1)
    expect(textarea().value).toBe('init\n\nbody line')
  })

  it('Cancel leaves the commit alone and the editor untouched', async () => {
    pushedTo = ['refs/remotes/origin/main']
    await mount()
    await type('mine')
    await click(uncommitButton()!)
    await click(button('Cancel'))
    expect(sent('uncommit')).toHaveLength(0)
    expect(textarea().value).toBe('mine')
    expect(uncommitButton()!.disabled).toBe(false)
  })

  it('keeps the editor when the uncommit fails', async () => {
    await mount()
    await type('mine')
    gitOperation.mockImplementationOnce(async () => done({ pushedTo: [] }))
    gitOperation.mockImplementationOnce(async () => done({ ok: false, stderr: 'bad' }))
    await click(uncommitButton()!)
    expect(textarea().value).toBe('mine')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('git uncommit failed')
  })
})

describe('remote button', () => {
  const group = (): HTMLElement | null => document.querySelector('[role="group"][aria-label="Remote"]')
  const mainButton = (): HTMLButtonElement => group()!.querySelector<HTMLButtonElement>('span[title] button')!

  it('picks the main button from the upstream relation', async () => {
    const cases: readonly [GitStatusReport, string, string][] = [
      [report([]), 'Fetch', 'Fetch updates from remote\ngit fetch'],
      [report([], {}, tracked(2, 0)), 'Push↑2', 'Push committed changes to remote\ngit push'],
      [report([], {}, tracked(2, 1)), 'Pull↑2↓1', 'Pull\ngit pull'],
      [report([], {}, tracked(0, 3)), 'Pull↓3', 'Pull\ngit pull'],
      [report([], {}, { kind: 'none' }), 'Publish', 'Publish branch to remote\ngit push --set-upstream'],
      [report([], {}, { kind: 'gone' }), 'Republish', 'Re-publish branch to remote\ngit push --set-upstream'],
    ]
    for (const [shape, label, tooltip] of cases) {
      current = shape
      await mount()
      expect(mainButton().textContent, label).toBe(label)
      expect(mainButton().title, label).toBe(tooltip)
      await act(async () => root!.unmount())
      host.remove()
    }
  })

  it('sits in the footer beside the branch name', async () => {
    await mount()
    const footer = document.querySelector('[role="group"][aria-label="Branch"]')!
    expect(footer.textContent).toContain('main')
    expect(footer.contains(group())).toBe(true)
  })

  it('lists Fetch, Fetch From, Pull, Pull (Rebase), a separator, Push, Push To and Force Push', async () => {
    await mount()
    await openMenu('Remote actions')
    expect(menuItems()).toEqual(['Fetch', 'Fetch From', 'Pull', 'Pull (Rebase)', 'Push', 'Push To', 'Force Push'])
    expect(document.querySelector('[role="menu"] [role="separator"]')).not.toBeNull()
  })

  it('has no button for a detached HEAD: the footer shows the short sha', async () => {
    current = report([STAGED], { branch: null, branchInfo: null })
    await mount()
    expect(group()).toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Branch"]')!.textContent).toBe('abc1234')
    expect(document.querySelector('button[aria-label="Remote actions"]')).toBeNull()
  })

  it('Fetch runs fetch-all and reports it as a fetch', async () => {
    await mount()
    gitOperation.mockImplementationOnce(async () => done({ stderr: 'From origin' }))
    await click(mainButton())
    expect(gitOperation.mock.calls.map((call) => call[2])).toEqual([{ type: 'fetch-all' }])
    expect(document.body.textContent).toContain('Synchronized with remotes')
  })

  it('Fetch reports an up-to-date remote', async () => {
    await mount()
    await click(mainButton())
    expect(document.body.textContent).toContain('Fetch: Already up to date')
  })

  it('Fetch From with one remote fetches it without a picker', async () => {
    await mount()
    await openMenu('Remote actions')
    await click(menuItem('Fetch From'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(gitOperation.mock.calls.map((call) => call[2])).toEqual([
      { type: 'remotes', branch: 'main', push: false, all: true },
      { type: 'fetch', remote: 'origin' },
    ])
  })

  it('Fetch From with several remotes opens the picker with --all, and the choice decides', async () => {
    remotes = ['origin', 'backup']
    await mount()
    await openMenu('Remote actions')
    await click(menuItem('Fetch From'))
    expect(dialogText()).toContain('Pick which remote to fetch')
    expect([...document.querySelectorAll('[role="dialog"] li button')].map((entry) => entry.textContent)).toEqual(['origin', 'backup', '--all'])
    await click(button('backup'))
    expect(sent('fetch')).toEqual([{ type: 'fetch', remote: 'backup' }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await openMenu('Remote actions')
    await click(menuItem('Fetch From'))
    await click(button('--all'))
    expect(sent('fetch-all')).toHaveLength(1)
  })

  it('Escape on the picker runs nothing and frees the button', async () => {
    remotes = ['origin', 'backup']
    await mount()
    await openMenu('Remote actions')
    await click(menuItem('Fetch From'))
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(sent('fetch')).toHaveLength(0)
    expect(mainButton().disabled).toBe(false)
  })

  it('Pull names the branch only when it has no upstream, and Pull (Rebase) rebases', async () => {
    current = report([], {}, tracked(0, 2))
    await mount()
    await click(mainButton())
    expect(sent('pull')).toEqual([{ type: 'pull', remote: 'origin', rebase: false }])
    await openMenu('Remote actions')
    await click(menuItem('Pull (Rebase)'))
    expect(sent('pull')[1]).toEqual({ type: 'pull', remote: 'origin', rebase: true })
    expect(gitOperation.mock.calls.map((call) => call[2]).filter((input) => input.type === 'remotes')[0]).toEqual({ type: 'remotes', branch: 'main', push: false, all: false })

    await act(async () => root!.unmount())
    current = report([], {}, { kind: 'none' })
    await mount()
    await openMenu('Remote actions')
    await click(menuItem('Pull'))
    expect(sent('pull').at(-1)).toEqual({ type: 'pull', remote: 'origin', branch: 'main', rebase: false })
  })

  it('Pull reports the merged files', async () => {
    current = report([], {}, tracked(0, 1))
    await mount()
    gitOperation.mockImplementationOnce(async () => done({ remotes }))
    gitOperation.mockImplementationOnce(async () => done({ stdout: 'Updating a..b\nFast-forward\n a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n' }))
    await click(mainButton())
    expect(document.body.textContent).toContain('Received 1 file change from origin')
  })

  it('Push to a tracked upstream sends the exact branches, with no confirmation', async () => {
    current = report([], {}, tracked(1, 0), { remote: 'origin', branch: 'feature' })
    await mount()
    gitOperation.mockImplementationOnce(async () => done({ remotes }))
    await click(mainButton())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(sent('push')).toEqual([{ type: 'push', remote: 'origin', branch: 'main', upstreamBranch: 'feature', setUpstream: false, force: false }])
    expect(gitOperation.mock.calls[0]![2]).toEqual({ type: 'remotes', branch: 'main', push: true, all: false })
    expect(document.body.textContent).toContain('Pushed main to origin')
  })

  it('Publish and Republish set the upstream; the upstream name is the branch name', async () => {
    current = report([], {}, { kind: 'none' })
    await mount()
    await click(mainButton())
    expect(sent('push')).toEqual([{ type: 'push', remote: 'origin', branch: 'main', upstreamBranch: 'main', setUpstream: true, force: false }])
    await act(async () => root!.unmount())
    current = report([], {}, { kind: 'gone' }, { remote: 'origin', branch: 'old' })
    await mount()
    await click(mainButton())
    expect(sent('push').at(-1)).toEqual({ type: 'push', remote: 'origin', branch: 'main', upstreamBranch: 'main', setUpstream: true, force: false })
  })

  it('Force Push sends force:true, still without a confirmation', async () => {
    current = report([], {}, tracked(1, 0))
    await mount()
    await openMenu('Remote actions')
    await click(menuItem('Force Push'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(sent('push')).toEqual([{ type: 'push', remote: 'origin', branch: 'main', upstreamBranch: 'main', setUpstream: false, force: true }])
  })

  it('Push To always asks which remote, even for a branch bound to one', async () => {
    remotes = ['origin', 'backup']
    current = report([], {}, tracked(1, 0))
    await mount()
    await openMenu('Remote actions')
    await click(menuItem('Push To'))
    expect(gitOperation.mock.calls[0]![2]).toEqual({ type: 'remotes', branch: 'main', push: true, all: true })
    expect(dialogText()).toContain('Pick which remote to push to')
    await click(button('backup'))
    expect(sent('push')).toEqual([expect.objectContaining({ remote: 'backup' })])
  })

  it('says so when there is no remote to push to', async () => {
    remotes = []
    current = report([], {}, { kind: 'none' })
    await mount()
    await click(mainButton())
    expect(sent('push')).toHaveLength(0)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('No remote available to push to. Add a remote to be able to publish changes.')
    expect(mainButton().disabled).toBe(false)
  })

  it('shows a spinner and the in-progress tooltip, disables the menu and allows one remote operation at a time', async () => {
    current = report([], {}, tracked(1, 0))
    let finish!: (value: GitOperationDone) => void
    gitOperation.mockImplementation(async (_ws, _project, input) => (
      input.type === 'push' ? new Promise<GitOperationDone>((resolve) => { finish = resolve }) : defaultOp(input)
    ))
    await mount()
    await click(mainButton())
    await flush()
    expect(mainButton().disabled).toBe(true)
    expect(mainButton().title).toBe('Push in Progress…')
    expect(mainButton().querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Remote actions"]')!.disabled).toBe(true)
    await click(mainButton())
    expect(sent('push')).toHaveLength(1)
    expect(sent('remotes')).toHaveLength(1)

    await act(async () => finish(done({ stderr: 'Everything up-to-date\n' })))
    expect(mainButton().disabled).toBe(false)
    expect(mainButton().querySelector('[role="status"]')).toBeNull()
    expect(document.body.textContent).toContain('Push: Everything is up-to-date')
  })

  it('a push that Git refuses is a failure toast, and the button is free again', async () => {
    current = report([], {}, tracked(1, 0))
    gitOperation.mockImplementation(async (_ws, _project, input) => (input.type === 'push' ? done({ ok: false, stderr: 'rejected' }) : defaultOp(input)))
    await mount()
    await click(mainButton())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('git push failed')
    expect(mainButton().disabled).toBe(false)
  })

  it('shows the new status after a remote operation', async () => {
    current = report([], {}, tracked(1, 0))
    await mount()
    gitOperation.mockImplementation(async (_ws, _project, input) => (
      input.type === 'push' ? done({ status: report([], {}, tracked(0, 0)) }) : defaultOp(input)
    ))
    await click(mainButton())
    expect(mainButton().textContent).toBe('Fetch')
  })
})

describe('turn filter', () => {
  it('hides the commit area and the footer', async () => {
    await mount({ pathFilter: ['src/staged.ts'] })
    expect(document.querySelector('[role="group"][aria-label="Commit"]')).toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Branch"]')).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('shows them in the whole-project view', async () => {
    await mount()
    expect(document.querySelector('[role="group"][aria-label="Commit"]')).not.toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Branch"]')).not.toBeNull()
  })
})
