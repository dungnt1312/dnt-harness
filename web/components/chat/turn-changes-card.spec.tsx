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
}
async function mount(changes: TurnChanges, props: Partial<Parameters<typeof TurnChangesCard>[0]> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <TurnChangesCard
      turnId="t1"
      changes={changes}
      {...props}
    />,
  ))
  return host
}

it('the workbench turn view stacks every file\'s turn-only diff from the log alone', async () => {
  const { TurnChangesView } = await import('../workbench/TurnChangesView.tsx')
  const events = [
    { type: 'turn/start', turnId: 't1' },
    { type: 'tool/call', call: { id: 'c1', name: 'Edit', args: { path: 'C:/outside/a.ts', old: 'a\nb', new: 'a\nc' } } },
    { type: 'tool/result', callId: 'c1', ok: true, output: 'edited C:/outside/a.ts' },
    { type: 'tool/call', call: { id: 'c2', name: 'Write', args: { path: 'notes.md', content: 'hi' } } },
    { type: 'tool/result', callId: 'c2', ok: true, output: 'created notes.md' },
    { type: 'turn/end', turnId: 't1' },
  ] as unknown as Parameters<typeof TurnChangesView>[0]['events']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<TurnChangesView turnId="t1" events={events} />))
  expect(host.textContent).toContain('2 files')
  expect(host.querySelector('[aria-label="This turn\'s diff of C:/outside/a.ts"] [data-kind="add"]')?.textContent).toContain('c')
  expect(host.querySelector('[aria-label="This turn\'s diff of notes.md"]')?.textContent).toContain('New')
  expect(fetchGitStatus).not.toHaveBeenCalled()
})

const header = (view: HTMLElement): HTMLButtonElement => view.querySelector<HTMLButtonElement>('section > div > button[aria-expanded]')!
const fileRows = (view: HTMLElement): HTMLLIElement[] => [...view.querySelectorAll<HTMLLIElement>('ul li')]

it('the collapsed row totals the turn\'s own lines and fetches nothing', async () => {
  const view = await mount(CHANGES, { onReviewAll: () => {} })
  expect(view.textContent).toContain('2 files changed')
  expect(view.textContent).toContain('+3')
  expect(view.textContent).toContain('−1')
  expect(view.textContent).toContain('Review all')
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

it('clicking a file shows the turn-only diff inline', async () => {
  const onReviewAll = vi.fn()
  const view = await mount(CHANGES, { onReviewAll })
  await act(async () => header(view).click())
  const row = fileRows(view)[0]!
  await act(async () => row.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  const diff = view.querySelector('[role="region"][aria-label="This turn\'s diff of src/a.ts"]')
  expect(diff).not.toBeNull()
  // `a` was context the edit carried: it reads as context, not as -a +a.
  const kinds = [...diff!.querySelectorAll('[data-kind]')].map((line) => `${line.getAttribute('data-kind')}:${line.textContent?.trim().slice(-1)}`)
  expect(kinds).toEqual(['context:a', 'del:b', 'add:c'])
  expect(onReviewAll).not.toHaveBeenCalled()
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
  })
  await act(async () => header(view).click())
  await act(async () => fileRows(view)[0]!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  expect(view.textContent).toContain('Write 1 of 2')
  expect(view.textContent).toContain('Edit 2 of 2')
})

it('an overwritten file is tagged and states no invented counts', async () => {
  const view = await mount({
    files: [{ path: 'src/a.ts', status: 'modified', overwrote: true, edits: [{ kind: 'write', content: 'x\ny', created: false }] }],
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

it('Review all opens the turn tab, and nothing on the card is git', async () => {
  const onReviewAll = vi.fn()
  const view = await mount(CHANGES, { onReviewAll, onOpenPath: () => () => {} })
  const all = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Review all')!
  await act(async () => all.click())
  expect(onReviewAll).toHaveBeenCalledOnce()
  await act(async () => header(view).click())
  expect(view.querySelector('button[aria-label="Open a.ts in workbench"]')).not.toBeNull()
  expect(view.textContent).not.toMatch(/git/i)

  const plain = await mount(CHANGES)
  expect([...plain.querySelectorAll('button')].some((button) => button.textContent === 'Review all')).toBe(false)
})
