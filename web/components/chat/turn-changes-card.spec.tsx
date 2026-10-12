// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TurnChangesCard } from './TurnChangesCard.tsx'
import type { TurnChanges } from '../../lib/turn-changes.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchGitStatus = vi.fn()

vi.mock('../../lib/api.ts', () => ({
  fetchGitStatus: () => fetchGitStatus(),
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
})

const CHANGES: TurnChanges = {
  files: [
    { path: 'src/a.ts', status: 'modified', lines: { added: 1, removed: 1 }, edits: [{ kind: 'edit', old: 'a\nb', new: 'a\nc', output: 'edited src/a.ts' }] },
    { path: 'notes.md', status: 'created', lines: { added: 2 }, edits: [{ kind: 'write', content: 'hello\nworld', created: true }] },
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
      {...props}
    />,
  ))
  return host
}

const header = (view: HTMLElement): HTMLButtonElement => view.querySelector<HTMLButtonElement>('section > div > button[aria-expanded]')!
const fileRows = (view: HTMLElement): HTMLLIElement[] => [...view.querySelectorAll<HTMLLIElement>('ul li')]

it('the collapsed row totals the turn\'s own lines and fetches nothing', async () => {
  const view = await mount(CHANGES, { onReviewAll: () => {} })
  expect(view.textContent).toContain('2 files changed')
  expect(view.textContent).toContain('+3')
  expect(view.textContent).toContain('−1')
  expect(view.textContent).toContain('Open in Git')
  expect(view.querySelector('ul')).toBeNull()
  expect(fetchGitStatus).not.toHaveBeenCalled()
})

it('expanding lists each file with this turn\'s counts and tags', async () => {
  const view = await mount(CHANGES)
  await act(async () => header(view).click())
  expect(view.querySelector('ul')?.getAttribute('aria-label')).toBe('Files changed by turn t1')
  const rows = fileRows(view)
  expect(rows).toHaveLength(2)
  expect(rows[0]?.textContent).toContain('a.ts')
  expect(rows[0]?.textContent).toContain('+1')
  expect(rows[0]?.textContent).toContain('−1')
  expect(rows[1]?.textContent).toContain('notes.md')
  expect(rows[1]?.textContent).toContain('New')
  expect(fetchGitStatus).not.toHaveBeenCalled()
})

it('clicking a file shows the turn-only diff inline, not the Git view', async () => {
  const onReviewFile = vi.fn()
  const view = await mount(CHANGES, { onReviewFile })
  await act(async () => header(view).click())
  const row = fileRows(view)[0]!
  await act(async () => row.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  const diff = view.querySelector('[role="region"][aria-label="This turn\'s diff of src/a.ts"]')
  expect(diff).not.toBeNull()
  // `a` was context the edit carried: it reads as context, not as -a +a.
  const kinds = [...diff!.querySelectorAll('[data-kind]')].map((line) => `${line.getAttribute('data-kind')}:${line.textContent?.trim().slice(-1)}`)
  expect(kinds).toEqual(['context:a', 'del:b', 'add:c'])
  expect(onReviewFile).not.toHaveBeenCalled()
})

it('a file edited several times lists every call in order', async () => {
  const view = await mount({
    files: [{
      path: 'src/a.ts',
      status: 'created',
      lines: { added: 2 },
      edits: [
        { kind: 'write', content: 'one\ntwo', created: true },
        { kind: 'edit', old: 'two', new: 'three', output: 'edited src/a.ts' },
      ],
    }],
    uncertain: [],
  })
  await act(async () => header(view).click())
  await act(async () => fileRows(view)[0]!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  expect(view.textContent).toContain('Write 1 of 2')
  expect(view.textContent).toContain('Edit 2 of 2')
})

it('an overwritten file is tagged and states no invented counts', async () => {
  const view = await mount({
    files: [{ path: 'src/a.ts', status: 'modified', overwrote: true, edits: [{ kind: 'write', content: 'x\ny', created: false }] }],
    uncertain: [],
  })
  await act(async () => header(view).click())
  const row = fileRows(view)[0]!
  expect(row.textContent).toContain('Rewritten')
  expect(row.textContent).not.toMatch(/[+−]\d/)
})

it('a live card says the turn is still editing, and starts closed like any other', async () => {
  const view = await mount(CHANGES, { live: true })
  expect(header(view).getAttribute('aria-expanded')).toBe('false')
  expect(view.textContent).toContain('Editing')
  expect(view.textContent).toContain('2 files changed')
  expect(fileRows(view)).toHaveLength(0)
  await act(async () => header(view).click())
  expect(fileRows(view)).toHaveLength(2)
  const closed = await mount(CHANGES)
  expect(closed.textContent).not.toContain('Editing')
})

it('a write whose result never landed reads as unconfirmed, not clean', async () => {
  const view = await mount({ files: [], uncertain: ['c9'] })
  expect(view.textContent).toContain('outcome unconfirmed')
  await act(async () => header(view).click())
  expect(view.textContent).toContain('did not report')
})

it('the Git actions are labelled as git and offered only with their callbacks', async () => {
  const onReviewAll = vi.fn()
  const onReviewFile = vi.fn()
  const view = await mount(CHANGES, { onReviewAll, onReviewFile, onOpenPath: () => () => {} })
  const all = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Open in Git')!
  expect(all.getAttribute('title')).toContain('not only this turn')
  await act(async () => all.click())
  expect(onReviewAll).toHaveBeenCalledOnce()
  await act(async () => header(view).click())
  const git = view.querySelector<HTMLButtonElement>('button[aria-label="Show git diff of a.ts (all uncommitted changes)"]')!
  await act(async () => git.click())
  // The Git view narrows to project-relative paths, the form git reports.
  expect(onReviewFile).toHaveBeenCalledWith('src/a.ts')
  expect(view.querySelector('button[aria-label="Open a.ts in workbench"]')).not.toBeNull()

  const plain = await mount(CHANGES)
  expect([...plain.querySelectorAll('button')].some((button) => button.textContent === 'Open in Git')).toBe(false)
})

it('a file outside the project has no git action; the file opener stays', async () => {
  const onReviewFile = vi.fn()
  const OUTSIDE: TurnChanges = {
    files: [{ path: 'C:/elsewhere/x.md', status: 'modified', lines: { added: 1, removed: 1 }, edits: [{ kind: 'edit', old: 'before', new: 'after', output: 'edited x.md' }] }],
    uncertain: [],
  }
  const view = await mount(OUTSIDE, { onReviewFile, onOpenPath: () => () => {} })
  await act(async () => header(view).click())
  expect(view.querySelector('button[aria-label^="Show git diff"]')).toBeNull()
  expect(view.querySelector('button[aria-label="Open x.md in workbench"]')).not.toBeNull()
  expect(view.textContent).toContain('outside the project folder')
})
