// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileViewer } from './FileViewer.tsx'
import { settleInProject, type FileDraft, type FilesState } from '../../hooks/useWorkbenchFiles.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
let confirmSpy: MockInstance<typeof window.confirm>

beforeEach(() => {
  disk = { content: 'one\n', hash: 'h1', editable: true }
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.clearAllMocks(); confirmSpy.mockRestore() })

/** Owns the draft like useWorkbenchFiles, so remounting the viewer keeps it. */
function Harness({ path, viewerKey, showViewer = true }: { path: string; viewerKey: number; showViewer?: boolean }) {
  const [state, setState] = useState<FilesState>({ folder: '', openFiles: [], activeFile: null, focus: null, drafts: {} })
  // Observed under the first test path, so a harness showing another path still reports that tab's draft.
  ;(globalThis as { __draft?: FileDraft | null }).__draft = state.drafts['src/a.ts'] ?? null
  const setDraft = (next: FileDraft | null): void => setState((current) => {
    const { [path]: _gone, ...rest } = current.drafts
    return { ...current, drafts: next === null ? rest : { ...rest, [path]: next } }
  })
  return showViewer
    ? <FileViewer key={viewerKey} workspaceId="w1" projectId="p1" projectPath="/proj" path={path} draft={state.drafts[path] ?? null} onDraft={setDraft}
        onSaved={(text, hash) => setState((current) => settleInProject(current, 'p1', new Map(), 'p1', path, text, hash).live)} />
    : null
}

async function mount(path = 'src/a.ts', viewerKey = 1) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<Harness path={path} viewerKey={viewerKey} />))
  await act(async () => { await vi.waitFor(() => expect(host.textContent).not.toContain('Loading file')) })
}

const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
const area = () => host.querySelector('textarea')!
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area(), text)
  area().dispatchEvent(new Event('input', { bubbles: true }))
})
const save = () => act(async () => { area().dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })) })

it('edits, saves with Cmd+S and returns to the highlighted view', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  expect(area().value).toBe('one\n')
  await type('two\n')
  expect(host.textContent).toContain('Unsaved')
  await save()
  expect(saveProjectFile).toHaveBeenCalledWith('w1', 'p1', 'src/a.ts', 'two\n', 'h1')
  expect(host.querySelector('textarea')).toBeNull()
  expect(host.textContent).toContain('two')
  expect((globalThis as { __draft?: FileDraft | null }).__draft).toBeNull()
})

it('keeps the draft on a conflict and Overwrite saves against the current hash', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('changed on disk')
  expect(area().value).toBe('mine\n')
  await act(async () => button('Overwrite').click())
  expect(saveProjectFile).toHaveBeenLastCalledWith('w1', 'p1', 'src/a.ts', 'mine\n', 'h-agent')
  expect(host.querySelector('textarea')).toBeNull()
})

it('Reload after a conflict drops the draft and shows the disk content', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  await act(async () => button('Reload').click())
  await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('agent')) })
  expect(host.querySelector('textarea')).toBeNull()
})

it('asks before cancelling a dirty edit and keeps it when refused', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('changed\n')
  confirmSpy.mockReturnValueOnce(false)
  await act(async () => button('Cancel').click())
  expect(area().value).toBe('changed\n')
  await act(async () => button('Cancel').click())
  expect(host.querySelector('textarea')).toBeNull()
})

it('keeps the draft when the viewer remounts (tab switch)', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('draft\n')
  await act(async () => root!.render(<Harness path="src/a.ts" viewerKey={2} />))
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull()) })
  expect(area().value).toBe('draft\n')
})

it('clears the draft when a save resolves after the viewer unmounted', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('two\n')
  let finish!: (value: { path: string; size: number; hash: string }) => void
  saveProjectFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await save()
  await act(async () => root!.render(<Harness path="src/b.ts" viewerKey={2} showViewer={false} />))
  expect((globalThis as { __draft?: FileDraft | null }).__draft?.dirty).toBe(true)
  await act(async () => finish({ path: 'src/a.ts', size: 4, hash: 'h-4' }))
  expect((globalThis as { __draft?: FileDraft | null }).__draft).toBeNull()
})

it('keeps text typed after a save began when that save resolves on a remounted viewer', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('two\n')
  let finish!: (value: { path: string; size: number; hash: string }) => void
  saveProjectFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await save()
  await act(async () => root!.render(<Harness path="src/a.ts" viewerKey={2} showViewer={false} />))
  await act(async () => root!.render(<Harness path="src/a.ts" viewerKey={3} />))
  await act(async () => { await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull()) })
  expect(area().value).toBe('two\n')
  await type('three\n')
  await act(async () => finish({ path: 'src/a.ts', size: 4, hash: 'h-4' }))
  expect((globalThis as { __draft?: FileDraft | null }).__draft).toEqual({ text: 'three\n', baseHash: 'h-4', dirty: true })
})

it('Overwrite saves even when the draft was edited back to the disk content', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('mine\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await save()
  await type('one\n')
  await act(async () => button('Overwrite').click())
  expect(saveProjectFile).toHaveBeenLastCalledWith('w1', 'p1', 'src/a.ts', 'one\n', 'h-agent')
})

it('drops a clean draft restored after the disk changed', async () => {
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  expect(area().value).toBe('one\n')
  disk = { ...disk, content: 'agent\n', hash: 'h-agent' }
  await act(async () => root!.render(<Harness path="src/a.ts" viewerKey={2} />))
  await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('agent')) })
  expect(host.querySelector('textarea')).toBeNull()
  expect((globalThis as { __draft?: FileDraft | null }).__draft).toBeNull()
})

it('offers no Edit for memory, skill, binary or non-editable files', async () => {
  await mount('memory://workspace/MEMORY.md')
  expect(byLabel('Edit file')).toBeNull()
  await act(async () => root!.unmount()); root = undefined; host.remove()
  disk = { ...disk, editable: false }
  await mount('src/b.ts')
  expect(byLabel('Edit file')).toBeNull()
})

it('does not mark a CRLF file dirty once a typed character is deleted again', async () => {
  disk = { content: 'one\r\ntwo\r\n', hash: 'h1', editable: true }
  await mount()
  await act(async () => byLabel('Edit file')!.click())
  await type('one\ntwo\nx')
  expect(host.textContent).toContain('Unsaved')
  await type('one\ntwo\n')
  expect(host.textContent).not.toContain('Unsaved')
})
