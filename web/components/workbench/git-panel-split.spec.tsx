// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import { ToastHost } from '../common/Toast.tsx'
import type { GitChange, GitDiffReport, GitOperationDone, GitOperationInput, GitStatusReport } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = { indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging: 'unstaged' } as const
const A: GitChange = { ...raw, path: 'src/a.ts', status: 'modified' }
const B: GitChange = { ...raw, path: 'src/b.ts', status: 'modified' }

function report(changes: readonly GitChange[]): GitStatusReport {
  return {
    branch: 'main',
    branchInfo: { name: 'main', upstream: { remote: 'origin', branch: 'main' }, upstreamTrack: { kind: 'tracked', ahead: 0, behind: 0 } },
    head: { sha: 'abc1234', subject: 'init', message: 'init', hasParent: true },
    truncated: false,
    changes,
  }
}

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => report([A, B]))
const gitOperation = vi.fn(async (_ws: string, _project: string, _input: GitOperationInput): Promise<GitOperationDone> => ({ type: 'done', ok: true, stdout: '', stderr: '' }))
type DiffAnswer = (path: string) => Promise<GitDiffReport>
const diffOf: { current: DiffAnswer } = { current: async (path) => ({ path, lines: [{ kind: 'context', text: `body of ${path}` }], truncated: false, binary: false }) }

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: (_ws: string, _project: string, path: string) => diffOf.current(path),
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
  diffOf.current = async (path) => ({ path, lines: [{ kind: 'context', text: `body of ${path}` }], truncated: false, binary: false })
  fetchGitStatus.mockImplementation(async () => report([A, B]))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  fetchGitStatus.mockReset()
  gitOperation.mockClear()
})

const PROJECT = { id: 'p1', name: 'proj', path: '/proj' }

async function mount(props: Partial<Parameters<typeof GitPanel>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><GitPanel workspaceId="ws1" project={PROJECT} {...props} /></ToastHost>))
  await act(async () => { await vi.waitFor(() => expect(rowButtons()).toHaveLength(2)) })
  return host
}

const rowButtons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('ul li [data-row-main]')]
const rowOf = (name: string): HTMLButtonElement => {
  const found = rowButtons().find((button) => button.textContent?.includes(name))
  if (found === undefined) throw new Error(`no row ${name}`)
  return found
}
const region = (path: string): HTMLElement | null => document.querySelector(`[role="region"][aria-label="Diff of ${path}"]`)
const key = async (target: Element, name: string): Promise<void> => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
}

describe('selecting a file shows its diff in the pane', () => {
  it('selects the first row on load and shows its diff beside the list', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    expect(region('src/a.ts')!.textContent).toContain('body of src/a.ts')
    expect(rowOf('a.ts').getAttribute('aria-current')).toBe('true')
    expect(rowOf('b.ts').getAttribute('aria-current')).toBeNull()
  })

  it('clicking another row swaps the pane to it; the list does not grow', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    const rowsBefore = document.querySelectorAll('ul li').length
    await act(async () => rowOf('b.ts').click())
    await act(async () => { await vi.waitFor(() => expect(region('src/b.ts')).not.toBeNull()) })
    expect(region('src/a.ts')).toBeNull()
    expect(rowOf('b.ts').getAttribute('aria-current')).toBe('true')
    expect(document.querySelectorAll('ul li').length).toBe(rowsBefore)
  })

  it('ArrowDown and ArrowUp move the selection; Space stages the selected row', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    await key(rowOf('a.ts'), 'ArrowDown')
    await act(async () => { await vi.waitFor(() => expect(region('src/b.ts')).not.toBeNull()) })
    expect(rowOf('b.ts').getAttribute('aria-current')).toBe('true')
    await key(rowOf('b.ts'), 'ArrowUp')
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })

    await key(rowOf('a.ts'), ' ')
    await act(async () => { await vi.waitFor(() => expect(gitOperation).toHaveBeenCalledWith('ws1', 'p1', { type: 'stage', paths: ['src/a.ts'] })) })
  })

  it('a slow diff for the file left behind never shows under the new one', async () => {
    const release: { a?: () => void } = {}
    diffOf.current = (path) => path === 'src/a.ts'
      ? new Promise((resolve) => { release.a = () => resolve({ path, lines: [{ kind: 'context', text: 'STALE A' }], truncated: false, binary: false }) })
      : Promise.resolve({ path, lines: [{ kind: 'context', text: 'fresh B' }], truncated: false, binary: false })
    await mount()
    await act(async () => rowOf('b.ts').click())
    await act(async () => { await vi.waitFor(() => expect(region('src/b.ts')).not.toBeNull()) })
    await act(async () => { release.a?.() })
    expect(document.body.textContent).not.toContain('STALE A')
    expect(region('src/b.ts')!.textContent).toContain('fresh B')
  })
})

describe('the split layout', () => {
  it('Hide Diff removes the pane, remembers it per project, and Show Diff brings it back', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    const hide = document.querySelector<HTMLButtonElement>('button[aria-label="Hide Diff"]')
    expect(hide).not.toBeNull()
    await act(async () => hide!.click())
    expect(region('src/a.ts')).toBeNull()
    expect(window.localStorage.getItem('dnt-harness.git.split.p1')).toBe('{"ratio":0.4,"collapsed":true}')

    // A remount keeps it hidden.
    await act(async () => root!.unmount())
    host.remove()
    await mount()
    expect(region('src/a.ts')).toBeNull()
    const show = document.querySelector<HTMLButtonElement>('button[aria-label="Show Diff"]')
    expect(show).not.toBeNull()
    await act(async () => show!.click())
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
  })

  it('the separator moves by 5% on the arrow keys and persists the ratio', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    const separator = document.querySelector<HTMLElement>('[role="separator"]')
    expect(separator).not.toBeNull()
    expect(separator!.getAttribute('aria-valuenow')).toBe('40')
    await key(separator!, 'ArrowRight')
    expect(separator!.getAttribute('aria-valuenow')).toBe('45')
    expect(window.localStorage.getItem('dnt-harness.git.split.p1')).toBe('{"ratio":0.45,"collapsed":false}')
    await key(separator!, 'ArrowLeft')
    await key(separator!, 'ArrowLeft')
    expect(separator!.getAttribute('aria-valuenow')).toBe('35')
  })

  it('keeps the ratio inside 20%..80%', async () => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    const separator = document.querySelector<HTMLElement>('[role="separator"]')!
    for (let index = 0; index < 20; index++) await key(separator, 'ArrowLeft')
    expect(separator.getAttribute('aria-valuenow')).toBe('20')
    for (let index = 0; index < 20; index++) await key(separator, 'ArrowRight')
    expect(separator.getAttribute('aria-valuenow')).toBe('80')
  })
})

describe('dragging the handle (final review web I3)', () => {
  const sep = (): HTMLElement => document.querySelector<HTMLElement>('[role="separator"]')!
  const pointer = async (type: string, init: { clientX?: number; clientY?: number; pointerId?: number } = {}): Promise<void> => {
    await act(async () => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { clientX?: number; clientY?: number; pointerId?: number }
      Object.assign(event, { clientX: init.clientX ?? 0, clientY: init.clientY ?? 0, pointerId: init.pointerId ?? 1, pointerType: 'touch' })
      sep().dispatchEvent(event)
    })
  }
  const withLayout = async (): Promise<void> => {
    await mount()
    await act(async () => { await vi.waitFor(() => expect(region('src/a.ts')).not.toBeNull()) })
    // jsdom has no layout: give the split box a width so pointer positions mean something.
    const box = document.querySelector<HTMLElement>('[data-split="open"] > div')!
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    Object.defineProperty(sep(), 'setPointerCapture', { value: () => {}, configurable: true })
    Object.defineProperty(sep(), 'releasePointerCapture', { value: () => {}, configurable: true })
  }

  it('opts out of the browser\'s touch scrolling so a finger can drag it', async () => {
    await withLayout()
    expect(sep().className).toContain('touch-none')
  })

  it('a cancelled pointer ends the drag: later moves with no button down do not resize it', async () => {
    await withLayout()
    await pointer('pointerdown', { clientX: 400 })
    await pointer('pointercancel')
    await pointer('pointermove', { clientX: 900 })
    expect(sep().getAttribute('aria-valuenow')).toBe('40')
  })

  it('losing the pointer capture ends the drag too', async () => {
    await withLayout()
    await pointer('pointerdown', { clientX: 400 })
    await pointer('lostpointercapture')
    await pointer('pointermove', { clientX: 900 })
    expect(sep().getAttribute('aria-valuenow')).toBe('40')
  })

  it('dragging updates the ratio live but writes storage once, on release', async () => {
    await withLayout()
    const writes: string[] = []
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith('dnt-harness.git.split.')) writes.push(value); return original.call(this, key, value) }
    try {
      await pointer('pointerdown', { clientX: 400 })
      await pointer('pointermove', { clientX: 500 })
      await pointer('pointermove', { clientX: 600 })
      expect(sep().getAttribute('aria-valuenow')).toBe('60')
      expect(writes).toHaveLength(0)
      await pointer('pointerup', { clientX: 600 })
      expect(writes).toEqual(['{"ratio":0.6,"collapsed":false}'])
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
