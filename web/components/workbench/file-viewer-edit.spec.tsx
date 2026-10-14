// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileViewer } from './FileViewer.tsx'
import { settleInProject, type FileDraft, type FilesState } from '../../hooks/useWorkbenchFiles.ts'
import { editorOf, editorText, pressKey, polyfillLayout, settled, typeAll } from './cm-test.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(polyfillLayout)

// Hoisted: the vi.mock factory runs while FileViewer's imports load, before a plain class declaration.
const { SaveConflictError } = vi.hoisted(() => ({
  SaveConflictError: class SaveConflictError extends Error { constructor(readonly currentHash: string) { super('conflict') } },
}))
let disk = { content: 'one\n', hash: 'h1', editable: true }
const readProjectFile = vi.fn(async (_ws: string, _p: string, path: string) => ({ path, size: disk.content.length, binary: false, truncated: false, ...disk }))
const saveProjectFile = vi.fn(async (_ws: string, _p: string, path: string, content: string, expected: string) => {
  if (expected !== disk.hash) throw new SaveConflictError(disk.hash)
  disk = { ...disk, content, hash: `h-${content.length}` }
  return { path, size: content.length, hash: disk.hash }
})

vi.mock('../../lib/api.ts', () => ({
  readProjectFile: (...a: [string, string, string]) => readProjectFile(...a),
  saveProjectFile: (...a: [string, string, string, string, string]) => saveProjectFile(...a),
  SaveConflictError,
  readMemoryFile: vi.fn(async () => ({ path: 'MEMORY.md', size: 3, binary: false, truncated: false, content: 'm\n' })),
  getSkillFile: vi.fn(async () => ({ path: 'SKILL.md', bytes: 3, content: 's\n' })),
  projectMediaUrl: () => '/media',
  mediaKindOf: () => null,
}))

let root: Root | undefined
let host: HTMLDivElement

beforeEach(() => { disk = { content: 'one\n', hash: 'h1', editable: true } })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.clearAllMocks() })

type Harness = { path?: string; viewerKey?: number; showViewer?: boolean; writeSeq?: number }

/** Owns the draft like useWorkbenchFiles, so remounting the viewer keeps it. */
function HarnessView({ path = 'src/a.ts', viewerKey = 1, showViewer = true, writeSeq }: Harness) {
  const [state, setState] = useState<FilesState>({ folder: '', openFiles: [], activeFile: null, focus: null, drafts: {} })
  // Observed under the first test path, so a harness showing another path still reports that tab's draft.
  ;(globalThis as { __draft?: FileDraft | null }).__draft = state.drafts['src/a.ts'] ?? null
  const setDraft = (next: FileDraft | null): void => setState((current) => {
    const { [path]: _gone, ...rest } = current.drafts
    return { ...current, drafts: next === null ? rest : { ...rest, [path]: next } }
  })
  return showViewer
    ? <FileViewer key={viewerKey} workspaceId="w1" projectId="p1" projectPath="/proj" path={path} draft={state.drafts[path] ?? null} onDraft={setDraft} writeSeq={writeSeq}
        onSaved={(text, hash) => setState((current) => settleInProject(current, 'p1', new Map(), 'p1', path, text, hash).live)} />
    : null
}

const draftNow = () => (globalThis as { __draft?: FileDraft | null }).__draft

async function mount(over: Harness = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<HarnessView {...over} />))
  await settled(host)
}
const rerender = async (over: Harness) => {
  await act(async () => root!.render(<HarnessView {...over} />))
  await settled(host)
}

const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
/** The confirmation dialog renders in a portal, outside the host. */
const dialog = () => document.body.querySelector('[role="dialog"]')
const dialogButton = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === text)!
const edit = async () => { await act(async () => byLabel('Edit file')!.click()); await settled(host) }
// CodeMirror reads `Mod` from navigator.platform, which jsdom leaves empty: there Mod is Ctrl (on a Mac it is Cmd).
const save = () => pressKey(host, { key: 's', ctrlKey: true })
const readOnly = () => host.querySelector('.cm-content')!.getAttribute('aria-readonly') === 'true'

it('edits, saves with Cmd+S and returns to the read-only view', async () => {
  await mount()
  expect(readOnly()).toBe(true)
  await edit()
  expect(readOnly()).toBe(false)
  expect(editorText(host)).toBe('one\n')
  await typeAll(host, 'two\n')
  expect(host.textContent).toContain('Unsaved')
  await save()
  expect(saveProjectFile).toHaveBeenCalledWith('w1', 'p1', 'src/a.ts', 'two\n', 'h1')
  expect(readOnly()).toBe(true)
  expect(editorText(host)).toBe('two\n')
  expect(draftNow()).toBeNull()
})

it('keeps the draft on a conflict and Overwrite, once confirmed, saves against the current hash', async () => {
  await mount()
  await edit()
  await typeAll(host, 'mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('changed on disk')
  expect(editorText(host)).toBe('mine\n')
  await act(async () => button('Overwrite').click())
  // Nothing is written until the reader confirms.
  expect(saveProjectFile).toHaveBeenCalledTimes(1)
  expect(dialog()!.textContent).toContain('Overwrite the file on disk?')
  await act(async () => dialogButton('Overwrite').click())
  expect(saveProjectFile).toHaveBeenLastCalledWith('w1', 'p1', 'src/a.ts', 'mine\n', 'h-agent')
  expect(readOnly()).toBe(true)
})

it('Reload after a conflict asks, then drops the draft and shows the disk content', async () => {
  await mount()
  await edit()
  await typeAll(host, 'mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  await act(async () => button('Reload').click())
  expect(dialog()!.textContent).toContain('Discard your changes?')
  await act(async () => dialogButton('Discard and reload').click())
  await act(async () => { await vi.waitFor(() => expect(editorText(host)).toBe('agent\n')) })
  expect(readOnly()).toBe(true)
  expect(draftNow()).toBeNull()
})

it('asks before cancelling a dirty edit and keeps it when refused', async () => {
  await mount()
  await edit()
  await typeAll(host, 'changed\n')
  await act(async () => button('Cancel').click())
  expect(dialog()!.textContent).toContain('Discard unsaved changes?')
  await act(async () => dialogButton('Cancel').click())
  expect(dialog()).toBeNull()
  expect(editorText(host)).toBe('changed\n')
  expect(readOnly()).toBe(false)
  await act(async () => button('Cancel').click())
  await act(async () => dialogButton('Discard').click())
  expect(readOnly()).toBe(true)
  expect(editorText(host)).toBe('one\n')
})

it('cancels a clean edit on Escape without asking', async () => {
  await mount()
  await edit()
  await pressKey(host, { key: 'Escape' })
  expect(dialog()).toBeNull()
  expect(readOnly()).toBe(true)
})

it('keeps the draft when the viewer remounts (tab switch)', async () => {
  await mount()
  await edit()
  await typeAll(host, 'draft\n')
  await rerender({ viewerKey: 2 })
  expect(editorText(host)).toBe('draft\n')
  expect(readOnly()).toBe(false)
})

it('clears the draft when a save resolves after the viewer unmounted', async () => {
  await mount()
  await edit()
  await typeAll(host, 'two\n')
  let finish!: (value: { path: string; size: number; hash: string }) => void
  saveProjectFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await save()
  await rerender({ path: 'src/b.ts', viewerKey: 2, showViewer: false })
  expect(draftNow()?.dirty).toBe(true)
  await act(async () => finish({ path: 'src/a.ts', size: 4, hash: 'h-4' }))
  expect(draftNow()).toBeNull()
})

it('keeps text typed after a save began when that save resolves on a remounted viewer', async () => {
  await mount()
  await edit()
  await typeAll(host, 'two\n')
  let finish!: (value: { path: string; size: number; hash: string }) => void
  saveProjectFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await save()
  await rerender({ viewerKey: 2, showViewer: false })
  await rerender({ viewerKey: 3 })
  expect(editorText(host)).toBe('two\n')
  await typeAll(host, 'three\n')
  await act(async () => finish({ path: 'src/a.ts', size: 4, hash: 'h-4' }))
  expect(draftNow()).toEqual({ text: 'three\n', baseHash: 'h-4', dirty: true })
})

it('Overwrite saves even when the draft was edited back to the disk content', async () => {
  await mount()
  await edit()
  await typeAll(host, 'mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  await typeAll(host, 'one\n')
  await act(async () => button('Overwrite').click())
  await act(async () => dialogButton('Overwrite').click())
  expect(saveProjectFile).toHaveBeenLastCalledWith('w1', 'p1', 'src/a.ts', 'one\n', 'h-agent')
})

it('drops a clean draft restored after the disk changed', async () => {
  await mount()
  await edit()
  expect(editorText(host)).toBe('one\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await rerender({ viewerKey: 2 })
  await act(async () => { await vi.waitFor(() => expect(editorText(host)).toBe('agent\n')) })
  expect(readOnly()).toBe(true)
  expect(draftNow()).toBeNull()
})

it('offers no Edit for memory, skill, binary or non-editable files', async () => {
  await mount({ path: 'memory://workspace/MEMORY.md' })
  expect(byLabel('Edit file')).toBeNull()
  await act(async () => root!.unmount()); root = undefined; host.remove()
  disk = { ...disk, editable: false }
  await mount({ path: 'src/b.ts' })
  expect(byLabel('Edit file')).toBeNull()
  expect(host.textContent).toContain('Read-only')
})

it('does not mark a CRLF file dirty once a typed character is deleted again', async () => {
  disk = { content: 'one\r\ntwo\r\n', hash: 'h1', editable: true }
  await mount()
  await edit()
  // The editor holds the file as LF text.
  expect(editorText(host)).toBe('one\ntwo\n')
  await typeAll(host, 'one\ntwo\nx')
  expect(host.textContent).toContain('Unsaved')
  await typeAll(host, 'one\ntwo\n')
  expect(host.textContent).not.toContain('Unsaved')
})

it('saves with Mod-S while focus is on a button, not only inside the editor', async () => {
  await mount()
  await edit()
  await typeAll(host, 'two\n')
  // After clicking the Edit/Changes switch focus stays on that button; the editor never sees the key.
  const changes = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Editor view"] button')].find((b) => b.textContent === 'Changes')!
  await act(async () => changes.click())
  const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
  await act(async () => { changes.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(saveProjectFile).toHaveBeenCalledTimes(1)
  expect(saveProjectFile).toHaveBeenCalledWith('w1', 'p1', 'src/a.ts', 'two\n', 'h1')
})

it('saves once, not twice, when the key is pressed inside the editor', async () => {
  await mount()
  await edit()
  await typeAll(host, 'two\n')
  await save()
  expect(saveProjectFile).toHaveBeenCalledTimes(1)
})

it('Mod-S does nothing while reading, and leaves other shortcuts alone', async () => {
  await mount()
  const idle = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
  await act(async () => { host.querySelector('.cm-content')!.dispatchEvent(idle) })
  expect(idle.defaultPrevented).toBe(false)
  await edit()
  await typeAll(host, 'two\n')
  const shifted = new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
  await act(async () => { host.querySelector('[aria-label="Editor view"] button')!.dispatchEvent(shifted) })
  expect(shifted.defaultPrevented).toBe(false)
  expect(saveProjectFile).not.toHaveBeenCalled()
})

it('does not save with Cmd+S while composing text through an IME', async () => {
  await mount()
  await edit()
  await typeAll(host, 'two\n')
  const view = editorOf(host)
  Object.defineProperty(view, 'composing', { value: true, configurable: true })
  await save()
  expect(saveProjectFile).not.toHaveBeenCalled()
})

it('shows what an edit changes against the opened text, and puts back one chunk', async () => {
  disk = { content: 'a\nb\nc\n', hash: 'h1', editable: true }
  await mount()
  await edit()
  await typeAll(host, 'a\nB\nc\n')
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Editor view"] button')].find((b) => b.textContent === 'Changes')!.click())
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('.cm-deletedChunk')).not.toBeNull()) })
  expect(host.querySelector('.cm-deletedChunk')!.textContent).toContain('b')
  // Reverting the chunk is a button in the deleted-chunk widget.
  await act(async () => host.querySelector('.cm-deletedChunk button[name="reject"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  expect(editorText(host)).toBe('a\nb\nc\n')
  expect(host.textContent).not.toContain('Unsaved')
})

it('Compare lays the disk text beside an edit after a conflict', async () => {
  await mount()
  await edit()
  await typeAll(host, 'mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  await act(async () => button('Compare').click())
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('.cm-deletedChunk')).not.toBeNull()) })
  expect(host.querySelector('.cm-deletedChunk')!.textContent).toContain('agent')
  expect(button('Hide comparison')).toBeTruthy()
  // The draft is untouched by looking.
  expect(editorText(host)).toBe('mine\n')
})

it('follows an agent write: a clean view shows the new text, an edit in progress gets the conflict banner', async () => {
  await mount({ writeSeq: 1 })
  disk = { content: 'agent v2\n', hash: 'h-2', editable: true }
  await rerender({ writeSeq: 2 })
  await act(async () => { await vi.waitFor(() => expect(editorText(host)).toBe('agent v2\n')) })
  expect(host.querySelector('[role="alert"]')).toBeNull()

  await edit()
  await typeAll(host, 'mine\n')
  disk = { content: 'agent v3\n', hash: 'h-3', editable: true }
  await rerender({ writeSeq: 3 })
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull()) })
  // The edit is never replaced under the reader's hands.
  expect(editorText(host)).toBe('mine\n')
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('changed on disk')
})

it('ignores an agent write that left the file the same', async () => {
  await mount({ writeSeq: 1 })
  const reads = readProjectFile.mock.calls.length
  await rerender({ writeSeq: 2 })
  await act(async () => { await vi.waitFor(() => expect(readProjectFile.mock.calls.length).toBeGreaterThan(reads)) })
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(editorText(host)).toBe('one\n')
})
