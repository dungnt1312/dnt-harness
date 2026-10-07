// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemory, deleteMemory, readMemory, searchMemory, updateMemory } from '../../lib/api.ts'
import { MemoryPanel } from './MemoryPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  searchMemory: vi.fn(),
  readMemory: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
}))

const mocked = vi.mocked({ searchMemory, readMemory, createMemory, updateMemory, deleteMemory })

const entry = (id: string, title: string, body = `${title} body`) =>
  ({ id, title, body, pinned: false, createdAt: 1, updatedAt: 1, hash: `hash-${id}` })

const projects = [
  { id: 'p1', name: 'Alpha', path: '/a', order: 0 },
  { id: 'p2', name: 'Beta', path: '/b', order: 1 },
] as never

/** Tiers as the server serves them: ?projectId= picks one, none is the workspace. */
const tiers: Record<string, ReturnType<typeof entry>[]> = {
  '': [entry('shared', 'Shared note')],
  p1: [entry('alpha-one', 'Alpha one'), entry('alpha-two', 'Alpha two')],
  p2: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.searchMemory.mockImplementation(async (_ws: string, _q: string, projectId?: string | null) => tiers[projectId ?? ''] ?? [])
  mocked.readMemory.mockImplementation(async (_ws: string, id: string, projectId?: string | null) => {
    const found = (tiers[projectId ?? ''] ?? []).find((row) => row.id === id)
    if (found === undefined) throw new Error('404')
    return found
  })
  mocked.createMemory.mockImplementation(async (_ws, input) => entry(input.id, input.title, input.body))
  mocked.updateMemory.mockImplementation(async (_ws, id, input) => ({ ...entry(id, input.title ?? id, input.body ?? ''), hash: 'hash-new' }))
  mocked.deleteMemory.mockResolvedValue({ forgotten: true })
})

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const click = async (node: HTMLElement): Promise<void> => {
  await act(async () => node.click())
  await settle()
}
const renderPanel = async (withProjects = true): Promise<void> => {
  await act(async () => root!.render(<MemoryPanel workspaceId="ws-1" {...(withProjects ? { projects } : {})} />))
  await settle()
}
const textarea = (): HTMLTextAreaElement => document.body.querySelector('textarea')!
const titleInput = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>('input[placeholder="Deploy notes"]')!

describe('MemoryPanel', () => {
  it('lists the workspace tier and every project tier together, grouped, empty tiers dropped', async () => {
    await renderPanel()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Workspace memory')
    expect(text).toContain('Shared note')
    // The agent writes to the project tier, so it must show without switching anything.
    expect(text).toContain('Alpha')
    expect(text).toContain('Alpha one')
    expect(text).toContain('Alpha two')
    // Beta has no entries, so it has no group row.
    expect(document.body.querySelector('[role="group"] [title="Beta"]')).toBeNull()
    expect(mocked.searchMemory).toHaveBeenCalledWith('ws-1', '', null)
    expect(mocked.searchMemory).toHaveBeenCalledWith('ws-1', '', 'p1')
  })

  it('previews an entry from its own tier and offers Edit and Delete', async () => {
    await renderPanel()
    await click(button('Alpha one'))
    expect(mocked.readMemory).toHaveBeenCalledWith('ws-1', 'alpha-one', 'p1')
    expect(document.body.textContent).toContain('alpha-one.md')
    expect(document.body.textContent).toContain('Project · Alpha')
    expect(buttons().some((node) => node.textContent === 'Edit')).toBe(true)
    expect(button('Delete alpha-one')).toBeDefined()
  })

  it('saves an edit against the tier it was opened from, with the expected hash', async () => {
    await renderPanel()
    await click(button('Alpha one'))
    await click(button('Edit'))
    await act(async () => type(textarea(), 'changed body'))
    await click(button('Save'))
    expect(mocked.updateMemory).toHaveBeenCalledTimes(1)
    expect(mocked.updateMemory).toHaveBeenCalledWith('ws-1', 'alpha-one', expect.objectContaining({ expectedHash: 'hash-alpha-one', body: 'changed body' }), 'p1')
    // Back to the preview of the saved entry.
    expect(document.body.textContent).toContain('Saved alpha-one.')
  })

  it('offers reload or overwrite on a 409 and overwrites with the fresh hash', async () => {
    mocked.updateMemory.mockRejectedValueOnce(new Error('409 conflict'))
    await renderPanel()
    await click(button('Alpha one'))
    await click(button('Edit'))
    await act(async () => type(textarea(), 'mine'))
    await click(button('Save'))
    expect(button('Reload server version')).toBeDefined()
    expect(button('Overwrite anyway')).toBeDefined()

    mocked.readMemory.mockResolvedValueOnce({ ...entry('alpha-one', 'Alpha one'), hash: 'hash-fresh' })
    await click(button('Overwrite anyway'))
    expect(mocked.updateMemory).toHaveBeenLastCalledWith('ws-1', 'alpha-one', expect.objectContaining({ expectedHash: 'hash-fresh', body: 'mine' }), 'p1')
  })

  it('creates a new entry in the tier picked in the form', async () => {
    await renderPanel()
    await click(button('New memory entry'))
    // The scope picker is part of the form once projects exist; default is the workspace.
    expect(document.body.textContent).toContain('Scope')
    await act(async () => type(titleInput(), 'Deploy Notes'))
    await act(async () => type(textarea(), 'run pm2'))
    expect(document.body.textContent).toContain('ID: deploy-notes')
    await click(button('Create entry'))
    expect(mocked.createMemory).toHaveBeenCalledWith('ws-1', { id: 'deploy-notes', title: 'Deploy Notes', body: 'run pm2' }, null)
  })

  it('refuses an ID that already exists in the same tier', async () => {
    await renderPanel()
    await click(button('New memory entry'))
    // The workspace tier already holds the id `shared`; the title slugs to it.
    await act(async () => type(titleInput(), 'Shared'))
    await act(async () => type(textarea(), 'dupe'))
    expect(document.body.textContent).toContain('An entry with this ID exists in this scope')
    expect(button('Create entry').disabled).toBe(true)
  })

  it('allows the same ID in another tier', async () => {
    await renderPanel()
    await click(button('New memory entry'))
    await act(async () => type(titleInput(), 'Alpha one'))
    await act(async () => type(textarea(), 'body'))
    // `alpha-one` exists in Alpha only; the form is on the workspace tier.
    expect(document.body.textContent).not.toContain('An entry with this ID exists')
    expect(button('Create entry').disabled).toBe(false)
  })

  it('deletes from the tier of the open entry after an inline confirmation', async () => {
    await renderPanel()
    await click(button('Alpha two'))
    await click(button('Delete alpha-two'))
    expect(mocked.deleteMemory).not.toHaveBeenCalled()
    await click(button('Delete permanently'))
    expect(mocked.deleteMemory).toHaveBeenCalledWith('ws-1', 'alpha-two', 'p1')
  })

  it('filters by scope and by search text', async () => {
    await renderPanel()
    await act(async () => type(document.body.querySelector<HTMLInputElement>('input[aria-label="Search memory"]')!, 'two'))
    expect(document.body.textContent).toContain('Alpha two')
    expect(document.body.textContent).not.toContain('Alpha one')
    expect(document.body.textContent).not.toContain('Shared note')

    await act(async () => type(document.body.querySelector<HTMLInputElement>('input[aria-label="Search memory"]')!, 'zzz'))
    expect(document.body.textContent).toContain('No entries match.')
  })

  it('has no scope filter and only the workspace tier when the workspace has no projects', async () => {
    await renderPanel(false)
    expect(document.body.querySelector('[aria-label="Filter by scope"]')).toBeNull()
    expect(document.body.textContent).toContain('Shared note')
    expect(mocked.searchMemory).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state when no tier has entries', async () => {
    mocked.searchMemory.mockResolvedValue([])
    await renderPanel()
    expect(document.body.textContent).toContain('No memory entries yet.')
  })
})
