// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileBrowser } from './FileBrowser.tsx'
import { ToastHost } from '../common/Toast.tsx'
import { PROJECT_FILE_DRAG_TYPE } from '../../lib/file-tree.ts'
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
    <ToastHost>
      <FileBrowser workspaceId="ws1" project={{ id: 'p1', name: 'proj', path: '/proj' }} activeFile={null} onOpenFile={onOpenFile} onRenamed={onRenamed} onRemoved={onRemoved} />
    </ToastHost>,
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

/** A clipboard double so copy actions can be asserted; jsdom has none. Runs (and clicks) inside the install window. */
async function copyThrough(run: () => void | Promise<void>): Promise<string[]> {
  const writes: string[] = []
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')?.value
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => { writes.push(text); return Promise.resolve() } },
  })
  try {
    await act(async () => { await run() })
    return writes
  } finally {
    if (original !== undefined) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original })
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
}

/** Dispatch dragstart on a row and capture the store it filled. */
function dragStart(button: HTMLButtonElement): Map<string, string> {
  const written = new Map<string, string>()
  const event = new Event('dragstart', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      setData: (type: string, value: string) => { written.set(type, value) },
      getData: (type: string) => written.get(type) ?? '',
    },
  })
  button.dispatchEvent(event)
  return written
}

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

it('keeps New file in the header and puts the rarer actions under ⋯', async () => {
  await mount()
  expect(host.querySelector('[aria-label="New file"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="New folder"]')).toBeNull()
  expect(host.querySelector('[aria-label="Refresh files"]')).toBeNull()
  await click(byLabel('More explorer actions'))
  expect([...document.body.querySelectorAll('[role="menu"] button')].map((b) => b.textContent)).toEqual(['New folder', 'Refresh', 'Copy project path'])
  const writes = await copyThrough(() => menuItem('Copy project path').click())
  expect(writes).toEqual(['/proj'])
  await click(byLabel('More explorer actions'))
  await click(menuItem('Refresh'))
  expect(listProjectFiles).toHaveBeenLastCalledWith('ws1', 'p1', '')
})

it('creates a folder at the root when nothing is selected', async () => {
  await mount()
  await click(byLabel('More explorer actions'))
  await click(menuItem('New folder'))
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

it('mounts a fresh, enabled name input when a new draft starts while a create is in flight', async () => {
  createProjectEntry.mockImplementationOnce(() => new Promise(() => {}))
  await mount()
  await click(byLabel('New file'))
  const first = byLabel('New file name') as HTMLInputElement
  await typeInto(first, 'a.ts')
  await enter(first)
  expect(first.disabled).toBe(true)
  await click(byLabel('New file'))
  const second = byLabel('New file name') as HTMLInputElement
  expect(second.disabled).toBe(false)
  expect(second.value).toBe('')
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

describe('copy path', () => {
  it('copies a file path relative and absolute from the row menu', async () => {
    await mount()
    await click(byLabel('Actions for README.md'))
    expect(await copyThrough(() => menuItem('Copy relative path').click())).toEqual(['README.md'])
    await click(byLabel('Actions for README.md'))
    expect(await copyThrough(() => menuItem('Copy absolute path').click())).toEqual(['/proj/README.md'])
  })

  it('copies a folder path absolute too', async () => {
    await mount()
    await click(byLabel('Actions for src'))
    expect(await copyThrough(() => menuItem('Copy absolute path').click())).toEqual(['/proj/src'])
  })
})

describe('drag rows', () => {
  it('writes the project-file payload and the relative path on dragstart', async () => {
    await mount()
    const written = dragStart(row('README.md'))
    expect(written.get(PROJECT_FILE_DRAG_TYPE)).toBe('{"path":"README.md","kind":"file"}')
    expect(written.get('text/plain')).toBe('README.md')
  })

  it('drags a folder row as the folder, and a search result like a tree row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      expect(dragStart(row('src')).get(PROJECT_FILE_DRAG_TYPE)).toBe('{"path":"src","kind":"dir"}')
      searchProjectFiles.mockResolvedValueOnce({ query: 'ind', truncated: false, matches: [{ name: 'index.ts', path: 'src/index.ts', score: 3 }] } as never)
      await typeInto(byLabel('Search files') as HTMLInputElement, 'ind')
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      const results = host.querySelector('[aria-label="Search results"]')!
      const written = dragStart(results.querySelector<HTMLButtonElement>('button[title="src/index.ts"]')!)
      expect(written.get(PROJECT_FILE_DRAG_TYPE)).toBe('{"path":"src/index.ts","kind":"file"}')
      expect(written.get('text/plain')).toBe('src/index.ts')
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers copy actions on search result rows too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      searchProjectFiles.mockResolvedValueOnce({ query: 'ind', truncated: false, matches: [{ name: 'index.ts', path: 'src/index.ts', score: 3 }] } as never)
      await mount()
      await typeInto(byLabel('Search files') as HTMLInputElement, 'ind')
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      await click(byLabel('Actions for index.ts'))
      expect(await copyThrough(() => menuItem('Copy absolute path').click())).toEqual(['/proj/src/index.ts'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('explorer search', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  const search = () => byLabel('Search files') as HTMLInputElement
  const settle = async (ms = 250) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  it('debounces, lists matches with their folder, and opens a result', async () => {
    searchProjectFiles.mockResolvedValueOnce({ query: 'ind', truncated: false, matches: [{ name: 'index.ts', path: 'src/index.ts', score: 3 }] } as never)
    await mount()
    await typeInto(search(), 'ind')
    expect(searchProjectFiles).not.toHaveBeenCalled()
    await settle()
    expect(searchProjectFiles).toHaveBeenCalledWith('ws1', 'p1', 'ind', 50)
    const results = host.querySelector('[aria-label="Search results"]')!
    expect(results.textContent).toContain('index.ts')
    expect(results.textContent).toContain('src')
    await click(results.querySelector<HTMLButtonElement>('button[title="src/index.ts"]')!)
    expect(onOpenFile).toHaveBeenCalledWith('src/index.ts')
  })

  it('says when nothing matches and when results may be incomplete', async () => {
    searchProjectFiles.mockResolvedValueOnce({ query: 'zzz', truncated: true, matches: [] } as never)
    await mount()
    await typeInto(search(), 'zzz')
    await settle()
    expect(host.textContent).toContain('No matching files')
    expect(host.textContent).toContain('Results may be incomplete.')
  })

  it('ignores a slow response for an older query', async () => {
    let releaseOld: (value: unknown) => void = () => {}
    searchProjectFiles
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }) as never)
      .mockResolvedValueOnce({ query: 'new', truncated: false, matches: [{ name: 'new.ts', path: 'new.ts', score: 3 }] } as never)
    await mount()
    await typeInto(search(), 'old')
    await settle()
    await typeInto(search(), 'new')
    await settle()
    await act(async () => releaseOld({ query: 'old', truncated: false, matches: [{ name: 'old.ts', path: 'old.ts', score: 3 }] }))
    const results = host.querySelector('[aria-label="Search results"]')!
    expect(results.textContent).toContain('new.ts')
    expect(results.textContent).not.toContain('old.ts')
  })

  it('returns to the tree with its folders still open on Escape', async () => {
    await mount()
    await click(row('src'))
    expect(rowNames()).toContain('index.ts')
    await typeInto(search(), 'x')
    await settle()
    await act(async () => search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(search().value).toBe('')
    expect(host.querySelector('[aria-label="Search results"]')).toBeNull()
    expect(rowNames()).toContain('index.ts')
  })

  it('never searches a blank query', async () => {
    await mount()
    await typeInto(search(), '   ')
    await settle()
    expect(searchProjectFiles).not.toHaveBeenCalled()
  })

  it('leaves search mode when New file is clicked, so the focused draft is visible', async () => {
    searchProjectFiles.mockResolvedValueOnce({ query: 'ind', truncated: false, matches: [{ name: 'index.ts', path: 'src/index.ts', score: 3 }] } as never)
    await mount()
    await typeInto(search(), 'ind')
    await settle()
    expect(host.querySelector('[aria-label="Search results"]')).not.toBeNull()
    await click(byLabel('New file'))
    expect(search().value).toBe('')
    expect(host.querySelector('[aria-label="Search results"]')).toBeNull()
    const input = byLabel('New file name')
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(input)
  })
})
