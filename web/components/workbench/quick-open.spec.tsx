// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QuickOpen } from './QuickOpen.tsx'
import { Workbench } from './Workbench.tsx'
import { useWorkbenchFiles } from '../../hooks/useWorkbenchFiles.ts'
import { SEARCH_DEBOUNCE_MS } from './useFileSearch.ts'
import { ToastHost } from '../common/Toast.tsx'
import { polyfillLayout } from './cm-test.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(() => {
  polyfillLayout()
  // jsdom draws nothing, so it has no scrolling to do.
  Element.prototype.scrollIntoView = () => {}
})

const files = [
  { name: 'index.ts', path: 'src/index.ts' },
  { name: 'index.css', path: 'web/index.css' },
]
const searchProjectFiles = vi.fn(async (_ws: string, _p: string, query: string) => ({ query, matches: files.filter((file) => file.name.includes(query)), truncated: false }))
const listProjectFiles = vi.fn(async (_ws: string, _p: string, path: string) => ({ path, entries: [] }))
const readProjectFile = vi.fn(async (_ws: string, _p: string, path: string) => ({ path, size: 1, binary: false, truncated: false, content: 'x\n', editable: true, hash: 'h' }))
vi.mock('../../lib/api.ts', () => ({
  searchProjectFiles: (...a: [string, string, string]) => searchProjectFiles(...a),
  listProjectFiles: (...a: [string, string, string]) => listProjectFiles(...a),
  readProjectFile: (...a: [string, string, string]) => readProjectFile(...a),
  saveProjectFile: vi.fn(),
  readMemoryFile: vi.fn(),
  getSkillFile: vi.fn(),
  mediaKindOf: () => null,
  projectMediaUrl: () => '',
  createProjectEntry: vi.fn(),
  renameProjectEntry: vi.fn(),
  deleteProjectEntry: vi.fn(),
  SaveConflictError: class extends Error {},
}))

let root: Root | undefined
let host: HTMLDivElement
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(async () => {
  vi.useRealTimers()
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

const input = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Search files by name"]')!
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 20) })
}
const key = (init: KeyboardEventInit) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })

async function mountQuickOpen(onOpen = vi.fn(), onDismiss = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<QuickOpen open workspaceId="w" projectId="p" onOpen={onOpen} onDismiss={onDismiss} />))
  return { onOpen, onDismiss }
}

it('asks for a name first and sends nothing to the server for an empty box', async () => {
  await mountQuickOpen()
  expect(document.body.textContent).toContain('Type part of a file name.')
  expect(searchProjectFiles).not.toHaveBeenCalled()
})

it('lists matches, moves with the arrow keys and opens the chosen one on Enter', async () => {
  const { onOpen, onDismiss } = await mountQuickOpen()
  await type('index')
  expect(options().map((option) => option.textContent)).toEqual(['index.tssrc', 'index.cssweb'])
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
  await key({ key: 'ArrowDown' })
  expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
  await key({ key: 'ArrowDown' })
  expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
  await key({ key: 'ArrowUp' })
  await key({ key: 'ArrowUp' })
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
  await key({ key: 'ArrowDown' })
  await key({ key: 'Enter' })
  expect(onOpen).toHaveBeenCalledWith('web/index.css')
  expect(onDismiss).toHaveBeenCalled()
})

it('opens a match on click and says when nothing matches', async () => {
  const { onOpen } = await mountQuickOpen()
  await type('index')
  await act(async () => options()[0]!.click())
  expect(onOpen).toHaveBeenCalledWith('src/index.ts')
  await type('zzz')
  expect(document.body.textContent).toContain('No matching files')
})

it('does not act on Enter while an IME composition is active', async () => {
  const { onOpen } = await mountQuickOpen()
  await type('index')
  await key({ key: 'Enter', isComposing: true })
  expect(onOpen).not.toHaveBeenCalled()
})

function Shell() {
  const state = useWorkbenchFiles('p1')
  const [view, setView] = useState<'files' | 'git'>('files')
  return (
    <>
      <button type="button" data-testid="outside">outside</button>
      <Workbench
        workspaceId="w" project={{ id: 'p1', name: 'Acme', path: '/acme' }} view={view} onView={(next) => setView(next as 'files' | 'git')}
        views={['files', 'git']} onViews={() => {}} files={state} events={[]} expanded={false} onClose={() => {}}
        context={{ meta: null, stream: 'open', sessionId: 's', sessionFolder: null, eventCount: 0 }}
      />
    </>
  )
}
async function mountShell() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<ToastHost><Shell /></ToastHost>))
}
const press = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'p', ...init })) })

it('Mod-P inside the workbench opens quick open and keeps the browser from printing', async () => {
  await mountShell()
  const section = host.querySelector('section[aria-label="Workbench"]')!
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'p', ctrlKey: true })
  await act(async () => { section.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  expect(input()).not.toBeNull()
})

it('Mod-P elsewhere on the page is left to the browser', async () => {
  await mountShell()
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'p', ctrlKey: true })
  await act(async () => { host.querySelector('[data-testid="outside"]')!.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(false)
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('ignores Shift-P and a plain p, and the search button opens the same box', async () => {
  await mountShell()
  const section = host.querySelector('section[aria-label="Workbench"]')!
  await press(section, { ctrlKey: true, shiftKey: true })
  await press(section, {})
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open file by name"]')!.click())
  expect(input()).not.toBeNull()
})

it('is not offered outside the Files view', async () => {
  await mountShell()
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Workbench views"] button')].find((b) => b.textContent === 'Git')!.click())
  expect(host.querySelector('[aria-label="Open file by name"]')).toBeNull()
  await press(host.querySelector('section[aria-label="Workbench"]')!, { ctrlKey: true })
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('opens a file chosen in quick open as a tab, and asks before closing a tab with unsaved changes', async () => {
  let api!: ReturnType<typeof useWorkbenchFiles>
  function Probe() {
    api = useWorkbenchFiles('p1')
    return (
      <Workbench
        workspaceId="w" project={{ id: 'p1', name: 'Acme', path: '/acme' }} view="files"
        onView={() => {}} views={['files']} onViews={() => {}} files={api} events={[]} expanded={false} onClose={() => {}}
        context={{ meta: null, stream: 'open', sessionId: 's', sessionFolder: null, eventCount: 0 }}
      />
    )
  }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<ToastHost><Probe /></ToastHost>))
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open file by name"]')!.click())
  await type('index.ts')
  await act(async () => options()[0]!.click())
  expect(api.openFiles).toEqual(['src/index.ts'])
  expect(api.activeFile).toBe('src/index.ts')

  await act(async () => api.setDraft('src/index.ts', { text: 'changed', baseHash: 'h', dirty: true }))
  expect(host.querySelector('[aria-label="Unsaved changes"]')!.className).toContain('bg-warn')
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close src/index.ts"]')!.click())
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Discard unsaved changes?')
  expect(dialog.textContent).toContain('index.ts')
  await act(async () => [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click())
  expect(api.openFiles).toEqual(['src/index.ts'])
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close src/index.ts"]')!.click())
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Discard')!.click())
  expect(api.openFiles).toEqual([])
  expect(api.drafts).toEqual({})
})
