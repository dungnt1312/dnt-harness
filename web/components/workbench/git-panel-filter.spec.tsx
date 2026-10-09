// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import type { GitDiffReport, GitStatusReport } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPORT: GitStatusReport = {
  branch: 'main',
  truncated: false,
  changes: [
    { path: 'src/a.ts', status: 'modified', added: 7, removed: 2 },
    { path: 'notes.md', status: 'added', added: 12 },
    { path: 'src/other.ts', status: 'modified', added: 1, removed: 1 },
  ],
}

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => REPORT)
const fetchGitDiff = vi.fn(async (_ws: string, _project: string, path: string): Promise<GitDiffReport> =>
  ({ path, lines: [], truncated: false, binary: path.endsWith('.png') }))

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: (_ws: string, _project: string, path: string) => fetchGitDiff(_ws, _project, path),
  mediaKindOf: (path: string) => (path.endsWith('.png') ? 'image' : path.endsWith('.mp3') ? 'audio' : path.endsWith('.mp4') ? 'video' : null),
  projectMediaUrl: (_ws: string, _project: string, path: string) => `/media?path=${encodeURIComponent(path)}`,
}))

let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  fetchGitStatus.mockClear()
  fetchGitDiff.mockClear()
})

const PROJECT = { id: 'p1', name: 'proj', path: 'C:/proj' }

async function mount(props: Partial<Parameters<typeof GitPanel>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<GitPanel workspaceId="ws1" project={PROJECT} {...props} />))
  return host
}

const rows = (view: HTMLElement): string[] =>
  [...view.querySelectorAll('ul li')].map((li) => li.querySelector('button')?.textContent ?? '')

it('without a filter every changed file is listed', async () => {
  const view = await mount()
  await act(async () => { await vi.waitFor(() => expect(rows(view)).toHaveLength(3)) })
  expect(rows(view).join(' ')).toContain('a.ts')
  expect(rows(view).join(' ')).toContain('other.ts')
})

it('a turn filter lists only the turn files, with a Show all escape', async () => {
  const onShowAll = vi.fn()
  const view = await mount({ pathFilter: ['src/a.ts', 'notes.md'], onShowAll })
  await act(async () => { await vi.waitFor(() => expect(rows(view)).toHaveLength(2)) })
  expect(rows(view).join(' ')).toContain('a.ts')
  expect(rows(view).join(' ')).not.toContain('other.ts')
  expect(view.textContent).toContain("this turn's writes")
  const showAll = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Show all')
  await act(async () => showAll!.click())
  expect(onShowAll).toHaveBeenCalledOnce()
})

it('a filter matching nothing says so instead of reading as a clean tree', async () => {
  const view = await mount({ pathFilter: ['gone.ts'] })
  await act(async () => { await vi.waitFor(() => expect(fetchGitStatus).toHaveBeenCalledOnce()) })
  expect(view.textContent).toContain('None of the files this turn wrote')
})

it('an opened binary media row previews the media instead of a diff', async () => {
  const binaryReport: GitStatusReport = {
    branch: 'main',
    truncated: false,
    changes: [{ path: 'shots/01.png', status: 'untracked' }],
  }
  fetchGitStatus.mockResolvedValueOnce(binaryReport)
  const view = await mount()
  await act(async () => { await vi.waitFor(() => expect(rows(view)).toHaveLength(1)) })
  await act(async () => { view.querySelector<HTMLElement>('ul li button')!.click() })
  expect(view.querySelector('img[alt="shots/01.png"]')).not.toBeNull()
  expect(view.textContent).not.toContain('No textual diff')
})

it('focusPath opens with that diff already expanded', async () => {
  const view = await mount({ focusPath: 'notes.md' })
  await act(async () => { await vi.waitFor(() => expect(fetchGitStatus).toHaveBeenCalledOnce()) })
  expect(view.querySelector('button[aria-expanded="true"]')?.textContent).toContain('notes.md')
  expect(view.textContent).toContain('No textual diff.')
})

it('focusPath scrolls its row to the top of the list once the diff loads, and again on a repeat click', async () => {
  // jsdom has no layout: every row sits 300px into the list's content, so
  // its on-screen top moves with the list's own scrollTop.
  const rect = (top: number) => ({ top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) })
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName !== 'BUTTON') return rect(0)
    const list = this.closest('ul')?.parentElement
    return rect(300 - (list?.scrollTop ?? 0))
  })
  try {
    const view = await mount({ focusPath: 'notes.md', focusNonce: 1 })
    await act(async () => { await vi.waitFor(() => expect(view.textContent).toContain('No textual diff.')) })
    const list = view.querySelector('ul[aria-label="Changed files"]')!.parentElement!
    expect(list.scrollTop).toBe(296)

    // The reader scrolls away; clicking the same file in chat brings it back.
    list.scrollTop = 0
    await act(async () => root!.render(<GitPanel workspaceId="ws1" project={PROJECT} focusPath="notes.md" focusNonce={2} />))
    expect(list.scrollTop).toBe(296)
  } finally {
    spy.mockRestore()
  }
})

it('a focused file row can open the file itself in the workbench', async () => {
  const onOpenFile = vi.fn()
  const view = await mount({ onOpenFile })
  await act(async () => { await vi.waitFor(() => expect(rows(view)).toHaveLength(3)) })
  const openFirst = view.querySelector<HTMLButtonElement>('ul li button[aria-label="Open a.ts in workbench"]')
  expect(openFirst).not.toBeNull()
  await act(async () => openFirst!.click())
  expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')

  // The diff frame carries its own opener: one click on the row's diff body
  // expands it, and the frame's corner button opens the same file.
  fetchGitDiff.mockResolvedValueOnce({ path: 'src/a.ts', lines: [{ kind: 'context' as const, text: 'const a = 1' }], truncated: false, binary: false })
  await act(async () => view.querySelector<HTMLButtonElement>('ul li button[aria-expanded]')!.click())
  await act(async () => { await vi.waitFor(() => expect(view.querySelector('[aria-label="Diff of src/a.ts"]')).not.toBeNull()) })
  const frameOpener = view.querySelector<HTMLButtonElement>('[aria-label="Diff of src/a.ts"] ~ button[aria-label="Open a.ts in workbench"]')
  expect(frameOpener).not.toBeNull()
  await act(async () => frameOpener!.click())
  expect(onOpenFile).toHaveBeenLastCalledWith('src/a.ts')
})
