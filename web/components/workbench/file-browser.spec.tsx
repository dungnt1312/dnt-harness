// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileBrowser } from './FileBrowser.tsx'
import type { ProjectListing } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** In-memory project the mocked API reads and writes. */
let tree: Record<string, { name: string; path: string; kind: 'dir' | 'file' }[]>

const listProjectFiles = vi.fn(async (_ws: string, _p: string, folder: string): Promise<ProjectListing> => ({ path: folder, entries: [...(tree[folder] ?? [])] }))
const createProjectEntry = vi.fn(async (_ws: string, _p: string, path: string, kind: 'file' | 'dir') => {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const entry = { name: path.slice(slash + 1), path, kind }
  tree[folder] = [...(tree[folder] ?? []), entry]
  if (kind === 'dir') tree[path] = []
  return entry
})
const renameProjectEntry = vi.fn(async (_ws: string, _p: string, path: string, name: string) => {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const next = folder === '' ? name : `${folder}/${name}`
  const kind = tree[folder]!.find((entry) => entry.path === path)!.kind
  tree[folder] = tree[folder]!.map((entry) => entry.path === path ? { name, path: next, kind } : entry)
  if (tree[path] !== undefined) {
    tree[next] = tree[path]!.map((entry) => ({ ...entry, path: `${next}/${entry.name}` }))
    delete tree[path]
  }
  return { path: next, kind }
})
const deleteProjectEntry = vi.fn(async (_ws: string, _p: string, path: string) => {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  tree[folder] = tree[folder]!.filter((entry) => entry.path !== path)
  delete tree[path]
  return { deleted: true as const, path }
})
const searchProjectFiles = vi.fn(async () => ({ query: '', matches: [], truncated: false }))

vi.mock('../../lib/api.ts', () => ({
  listProjectFiles: (...args: [string, string, string]) => listProjectFiles(...args),
  createProjectEntry: (...args: [string, string, string, 'file' | 'dir']) => createProjectEntry(...args),
  renameProjectEntry: (...args: [string, string, string, string]) => renameProjectEntry(...args),
  deleteProjectEntry: (...args: [string, string, string]) => deleteProjectEntry(...args),
  searchProjectFiles: (...args: unknown[]) => searchProjectFiles(...(args as [])),
}))

let root: Root | undefined
let host: HTMLDivElement
const onOpenFile = vi.fn()
const onRenamed = vi.fn()
const onRemoved = vi.fn()

beforeEach(() => {
  tree = {
    '': [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'README.md', path: 'README.md', kind: 'file' }],
    src: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }],
  }
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  vi.clearAllMocks()
})

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <FileBrowser workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} activeFile={null} onOpenFile={onOpenFile} onRenamed={onRenamed} onRemoved={onRemoved} />,
  ))
}

const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
/** Rows of the tree only (the root `<ul aria-label="Project files">`), never search results or the row menu triggers (`Menu` titles its trigger too). */
const treeRows = () => [...(host.querySelector('[aria-label="Project files"]')?.querySelectorAll<HTMLButtonElement>('li button[title]:not([aria-haspopup])') ?? [])]
const row = (name: string) => treeRows().find((button) => button.textContent === name)!
const rowNames = () => treeRows().map((button) => button.textContent)
const click = async (element: HTMLElement) => act(async () => element.click())
const typeInto = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const enter = async (input: HTMLInputElement) => act(async () => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
const menuItem = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent?.includes(text))!

it('creates a file inside the selected folder and opens it', async () => {
  await mount()
  await click(row('src'))
  await click(byLabel('New file'))
  const input = byLabel('New file name') as HTMLInputElement
  await typeInto(input, 'util.ts')
  await enter(input)
  expect(createProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'src/util.ts', 'file')
  expect(rowNames()).toContain('util.ts')
  expect(onOpenFile).toHaveBeenCalledWith('src/util.ts')
})

it('creates a folder at the root when nothing is selected', async () => {
  await mount()
  await click(byLabel('New folder'))
  const input = byLabel('New folder name') as HTMLInputElement
  await typeInto(input, 'docs')
  await enter(input)
  expect(createProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'docs', 'dir')
  expect(rowNames()).toContain('docs')
  expect(onOpenFile).not.toHaveBeenCalled()
})

it('keeps the draft open with the server error when the name exists', async () => {
  createProjectEntry.mockRejectedValueOnce(Object.assign(new Error('HTTP 409'), { status: 409, body: '{"error":"\'README.md\' already exists"}' }))
  await mount()
  await click(byLabel('New file'))
  const input = byLabel('New file name') as HTMLInputElement
  await typeInto(input, 'README.md')
  await enter(input)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("'README.md' already exists")
  expect(byLabel('New file name')).toBeTruthy()
})

it('renames a folder, reloads its parent and reports the move', async () => {
  await mount()
  await click(row('src'))
  expect(rowNames()).toContain('index.ts')
  await click(byLabel('Actions for src'))
  await click(menuItem('Rename'))
  const input = byLabel('New name for src') as HTMLInputElement
  expect(input.value).toBe('src')
  await typeInto(input, 'lib')
  await enter(input)
  expect(renameProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'src', 'lib')
  expect(onRenamed).toHaveBeenCalledWith('src', 'lib')
  expect(rowNames()).toEqual(['lib', 'index.ts', 'README.md'])
  expect(row('index.ts').title).toBe('lib/index.ts')
})

it('deletes after confirmation and reports the removal', async () => {
  await mount()
  await click(byLabel('Actions for README.md'))
  await click(menuItem('Delete'))
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Delete README.md?')
  expect(dialog.textContent).toContain('This file will be deleted permanently.')
  expect(deleteProjectEntry).not.toHaveBeenCalled()
  await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!)
  expect(deleteProjectEntry).toHaveBeenCalledWith('ws1', 'p1', 'README.md')
  expect(onRemoved).toHaveBeenCalledWith('README.md')
  expect(rowNames()).toEqual(['src'])
})

it('warns that a folder delete takes its contents', async () => {
  await mount()
  await click(byLabel('Actions for src'))
  await click(menuItem('Delete'))
  expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain('This folder and everything inside it will be deleted permanently.')
})

it('cancelling the delete dialog deletes nothing', async () => {
  await mount()
  await click(byLabel('Actions for README.md'))
  await click(menuItem('Delete'))
  const dialog = document.body.querySelector('[role="dialog"]')!
  await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!)
  expect(deleteProjectEntry).not.toHaveBeenCalled()
  expect(rowNames()).toContain('README.md')
})
