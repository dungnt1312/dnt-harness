import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { expect, vi } from 'vitest'

/**
 * jsdom has no layout, so CodeMirror's measuring calls need stand-ins. This is
 * the whole polyfill: enough for the editor to mount, take input and report text.
 */
export function polyfillLayout(): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  const rects = Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Range.prototype.getClientRects = () => rects
  if (typeof document.elementFromPoint !== 'function') document.elementFromPoint = () => null
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} }
  }
}

/**
 * Waits until the file and the lazy editor chunk have both loaded. The first
 * import of CodeMirror in a test run is slow, so the wait is generous; later
 * ones resolve at once from the module cache.
 */
export async function settled(host: ParentNode): Promise<void> {
  // Each poll flushes React in its own act(): inside one long act() the queued
  // re-render after the lazy chunk resolves would never run until the act ended.
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(host.textContent ?? '').not.toMatch(/Loading (file|editor)/)
  }, { timeout: 8_000, interval: 20 })
}

/** The live EditorView behind the first `.cm-editor` under `host`. */
export function editorOf(host: ParentNode): EditorView {
  const dom = host.querySelector<HTMLElement>('.cm-editor')
  const view = dom === null ? null : EditorView.findFromDOM(dom)
  if (view === null) throw new Error('no editor mounted')
  return view
}

/** The text the first editor under `host` holds. */
export const editorText = (host: ParentNode): string => editorOf(host).state.doc.toString()

/** Replaces the whole document the way typing would, so `onChange` hears it. */
export async function typeAll(host: ParentNode, text: string): Promise<void> {
  const view = editorOf(host)
  await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' }) })
}

/** Presses a key on the editor's content element; CodeMirror's keymap listens to keydown there. */
export async function pressKey(host: ParentNode, init: KeyboardEventInit): Promise<void> {
  const content = host.querySelector<HTMLElement>('.cm-content')
  if (content === null) throw new Error('no editor content')
  await act(async () => { content.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
}
