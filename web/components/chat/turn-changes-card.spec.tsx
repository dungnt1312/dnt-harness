// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TurnChangesCard } from './TurnChangesCard.tsx'
import type { GitDiffReport, GitStatusReport } from '../../lib/api.ts'
import type { TurnChanges } from '../../lib/turn-changes.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchGitStatus = vi.fn(async (): Promise<GitStatusReport> => ({
  branch: 'main',
  truncated: false,
  changes: [{ path: 'src/a.ts', status: 'modified', added: 7, removed: 2 }],
}))

const fetchGitDiff = vi.fn(async (_workspaceId: string, _projectId: string, path: string): Promise<GitDiffReport> => ({
  path,
  truncated: false,
  binary: false,
  lines: [
    { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
    { kind: 'context', text: 'line one' },
    { kind: 'del', text: 'old line' },
    { kind: 'add', text: 'new line' },
  ],
}))

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
  fetchGitDiff: (ws: string, p: string, path: string) => fetchGitDiff(ws, p, path),
  mediaKindOf: () => null,
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

const CHANGES: TurnChanges = {
  files: [
    { path: 'src/a.ts', status: 'modified', lines: { added: 4, removed: 1 }, args: { path: 'src/a.ts', old: 'a\nb', new: 'a\nc' } },
    { path: 'notes.md', status: 'created', lines: { added: 12 }, args: { path: 'notes.md', content: 'hello\nworld' } },
  ],
  uncertain: [],
}

const PROJECT = { id: 'p1', name: 'proj', path: 'C:/proj' }

async function mount(changes: TurnChanges, props: Partial<Parameters<typeof TurnChangesCard>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <TurnChangesCard
      turnId="t1"
      changes={changes}
      project={PROJECT}
      workspaceId="ws1"
      {...props}
    />,
  ))
  return host
}

it('the collapsed row counts lines from the log and fetches nothing', async () => {
  const view = await mount(CHANGES, { onReviewAll: () => {} })
  expect(view.textContent).toContain('2 files changed')
  expect(view.textContent).toContain('+16')
  expect(view.textContent).toContain('−1')
  expect(view.textContent).toContain('Review all')
  expect(fetchGitStatus).not.toHaveBeenCalled()
})

it('expanding loads the git overlay and marks counted rows', async () => {
  const view = await mount(CHANGES)
  const trigger = view.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  await act(async () => trigger.click())
  await act(async () => { await vi.waitFor(() => expect(fetchGitStatus).toHaveBeenCalledOnce()) })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const list = view.querySelector('ul')
  expect(list?.getAttribute('aria-label')).toBe('Files changed by turn t1')
  const rows = [...list?.querySelectorAll('li') ?? []]
  expect(rows).toHaveLength(2)
  expect(rows[0]?.textContent).toContain('a.ts')
  expect(rows[0]?.textContent).toContain('+7')
  expect(rows[0]?.textContent).toContain('−2')
  // notes.md is inside the project root but git does not list it: the note
  // says the counts do not cover every row rather than implying a clean file.
  expect(view.textContent).toContain('shared across turns')
})

it('a write whose result never landed reads as unconfirmed, not clean', async () => {
  const view = await mount({ files: [], uncertain: ['c9'] })
  expect(view.textContent).toContain('outcome unconfirmed')
  const trigger = view.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  await act(async () => trigger.click())
  expect(view.textContent).toContain('did not report')
})

it('Review all is offered only with the callback', async () => {
  const onReviewAll = vi.fn()
  const view = await mount(CHANGES, { onReviewAll })
  const review = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Review all')
  expect(review).toBeDefined()
  await act(async () => review!.click())
  expect(onReviewAll).toHaveBeenCalledOnce()
  const plain = await mount(CHANGES)
  expect([...plain.querySelectorAll('button')].some((button) => button.textContent === 'Review all')).toBe(false)
})

it('clicking a file expands its git diff in place, not the raw file', async () => {
  const view = await mount(CHANGES, { onOpenPath: () => () => {} })
  await act(async () => view.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  await act(async () => { await vi.waitFor(() => expect(fetchGitStatus).toHaveBeenCalledOnce()) })
  expect(fetchGitDiff).not.toHaveBeenCalled()
  const fileRow = [...view.querySelectorAll<HTMLButtonElement>('ul li button')].find((button) => button.textContent?.includes('a.ts'))!
  await act(async () => fileRow.click())
  await act(async () => { await vi.waitFor(() => expect(fetchGitDiff).toHaveBeenCalledWith('ws1', 'p1', 'src/a.ts')) })
  const diff = view.querySelector('[role="region"][aria-label="Diff of src/a.ts"]')
  expect(diff).not.toBeNull()
  expect(diff?.textContent).toContain('new line')
  expect(diff?.textContent).toContain('old line')
  // The workbench file remains reachable, as a secondary link inside the row.
  expect(view.textContent).toContain('Open a.ts in workbench')
})

it('a file outside the project diffs from the recorded call instead', async () => {
  const OUTSIDE: TurnChanges = {
    files: [{ path: 'C:/elsewhere/x.md', status: 'modified', lines: { added: 1, removed: 1 }, args: { path: 'C:/elsewhere/x.md', old: 'before', new: 'after' } }],
    uncertain: [],
  }
  const view = await mount(OUTSIDE)
  await act(async () => view.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  expect(fetchGitDiff).not.toHaveBeenCalled()
  const fileRow = [...view.querySelectorAll<HTMLButtonElement>('ul li button')].find((button) => button.textContent?.includes('x.md'))!
  await act(async () => fileRow.click())
  const diff = view.querySelector('[role="region"][aria-label="Recorded change to C:/elsewhere/x.md"]')
  expect(diff).not.toBeNull()
  expect(diff?.textContent).toContain('before')
  expect(diff?.textContent).toContain('after')
})
