// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPanel } from './GitPanel.tsx'
import type { GitStatusReport } from '../../lib/api.ts'

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

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: vi.fn(async (_ws: string, _project: string, path: string) =>
    ({ path, lines: [], truncated: false, binary: path.endsWith('.png') })),
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

it('a focused file row can open the file itself in the workbench', async () => {
  const onOpenFile = vi.fn()
  const view = await mount({ onOpenFile })
  await act(async () => { await vi.waitFor(() => expect(rows(view)).toHaveLength(3)) })
  const openFirst = view.querySelector<HTMLButtonElement>('ul li button[aria-label="Open a.ts in workbench"]')
  expect(openFirst).not.toBeNull()
  await act(async () => openFirst!.click())
  expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
})
