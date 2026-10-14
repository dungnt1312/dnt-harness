// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { openSearchPanel } from '@codemirror/search'
import CodePane, { type CodePaneProps } from './CodePane.tsx'
import { editorOf, editorText, polyfillLayout, pressKey, typeAll } from './cm-test.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(polyfillLayout)

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })

function props(over: Partial<CodePaneProps> = {}): CodePaneProps {
  return {
    fileName: 'src/a.ts', value: 'ab', editable: true, indent: { kind: 'spaces', width: 2 }, ariaLabel: 'Edit src/a.ts',
    onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(),
    ...over,
  }
}

async function mount(p: CodePaneProps): Promise<void> {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<CodePane {...p} />))
}
const rerender = (p: CodePaneProps) => act(async () => root!.render(<CodePane {...p} />))
const select = async (anchor: number, head = anchor) => { await act(async () => editorOf(host).dispatch({ selection: { anchor, head } })) }

it('focuses an editable pane and labels it with the path', async () => {
  await mount(props())
  expect(document.activeElement).toBe(host.querySelector('.cm-content'))
  expect(host.querySelector('.cm-content')!.getAttribute('aria-label')).toBe('Edit src/a.ts')
  expect(editorText(host)).toBe('ab')
})

it('a read-only pane stays reachable by keyboard but refuses input', async () => {
  const p = props({ editable: false, ariaLabel: 'Contents of src/a.ts' })
  await mount(p)
  const content = host.querySelector('.cm-content')!
  expect(content.getAttribute('aria-readonly')).toBe('true')
  expect(content.getAttribute('tabindex')).toBe('0')
  await typeAll(host, 'zz')
  // A programmatic change is a change; what a reader cannot do is type: Tab does nothing here.
  await pressKey(host, { key: 'Tab' })
  expect(editorText(host)).toBe('zz')
})

it('saves on Mod-S and cancels on Escape', async () => {
  const p = props()
  await mount(p)
  await pressKey(host, { key: 's', ctrlKey: true })
  await pressKey(host, { key: 'Escape' })
  expect(p.onSave).toHaveBeenCalledTimes(1)
  expect(p.onCancel).toHaveBeenCalledTimes(1)
})

it('does not treat Mod-Shift-S as save', async () => {
  const p = props()
  await mount(p)
  await pressKey(host, { key: 'S', ctrlKey: true, shiftKey: true })
  expect(p.onSave).not.toHaveBeenCalled()
})

it('the first Escape closes the search panel instead of leaving the edit', async () => {
  const p = props()
  await mount(p)
  await act(async () => { openSearchPanel(editorOf(host)) })
  expect(host.querySelector('.cm-search')).not.toBeNull()
  await pressKey(host, { key: 'Escape' })
  expect(host.querySelector('.cm-search')).toBeNull()
  expect(p.onCancel).not.toHaveBeenCalled()
  await pressKey(host, { key: 'Escape' })
  expect(p.onCancel).toHaveBeenCalledTimes(1)
})

it('inserts the indent unit on Tab, and a tab for a tab-indented file', async () => {
  const spaces = props({ value: 'ab' })
  await mount(spaces)
  await select(1)
  await pressKey(host, { key: 'Tab' })
  expect(spaces.onChange).toHaveBeenLastCalledWith('a  b')
  await act(async () => root!.unmount()); root = undefined; host.remove()

  const tabs = props({ value: '\tx\nab', indent: { kind: 'tab' } })
  await mount(tabs)
  await select(4, 5)
  await pressKey(host, { key: 'Tab' })
  expect(tabs.onChange).toHaveBeenLastCalledWith('\tx\na\t')
})

it('indents every selected line on Tab and outdents on Shift-Tab', async () => {
  const p = props({ value: 'a\nb' })
  await mount(p)
  await select(0, 3)
  await pressKey(host, { key: 'Tab' })
  expect(editorText(host)).toBe('  a\n  b')
  await pressKey(host, { key: 'Tab', shiftKey: true })
  expect(editorText(host)).toBe('a\nb')
})

it('keeps the caret after the indent', async () => {
  const p = props({ value: 'ab' })
  await mount(p)
  await select(1)
  await pressKey(host, { key: 'Tab' })
  expect(editorOf(host).state.selection.main.head).toBe(3)
})

it('ignores Escape, Mod-S and Tab while an IME composition is active', async () => {
  const p = props({ value: 'ab' })
  await mount(p)
  Object.defineProperty(editorOf(host), 'composing', { value: true, configurable: true })
  await pressKey(host, { key: 'Escape' })
  await pressKey(host, { key: 's', ctrlKey: true })
  await pressKey(host, { key: 'Tab' })
  expect(p.onCancel).not.toHaveBeenCalled()
  expect(p.onSave).not.toHaveBeenCalled()
  expect(p.onChange).not.toHaveBeenCalled()
})

it('reports typing through onChange, but not a value it was handed', async () => {
  const p = props({ value: 'a\n' })
  await mount(p)
  await typeAll(host, 'b\n')
  expect(p.onChange).toHaveBeenLastCalledWith('b\n')
  const calls = (p.onChange as ReturnType<typeof vi.fn>).mock.calls.length
  await rerender({ ...p, value: 'from outside\n' })
  expect(editorText(host)).toBe('from outside\n')
  expect((p.onChange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
})

it('follows a new value by changing only what differs, so the caret and undo history survive', async () => {
  const p = props({ value: 'one\ntwo\nthree\n' })
  await mount(p)
  await select(5)
  await rerender({ ...p, value: 'one\ntwo\nthree\nfour\n' })
  expect(editorText(host)).toBe('one\ntwo\nthree\nfour\n')
  expect(editorOf(host).state.selection.main.head).toBe(5)
})

it('highlights and shows the lines a tool read while read-only', async () => {
  const p = props({ editable: false, value: 'a\nb\nc\nd\n', focus: { line: 2, lines: 2, seq: 1 } })
  await mount(p)
  expect(host.querySelectorAll('.cm-focus-band').length).toBe(2)
  await rerender({ ...p, editable: true })
  expect(host.querySelectorAll('.cm-focus-band').length).toBe(0)
})

it('states the cursor position and any selection', async () => {
  await mount(props({ value: 'ab\ncd' }))
  expect(host.textContent).toContain('Ln 1, Col 1')
  await select(4)
  expect(host.textContent).toContain('Ln 2, Col 2')
  await select(0, 4)
  expect(host.textContent).toContain('4 selected')
})

it('wraps long lines on demand and remembers the choice', async () => {
  await mount(props())
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Wrap')!
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(host.querySelector('.cm-lineWrapping')).toBeNull()
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelector('.cm-lineWrapping')).not.toBeNull()
  expect(window.localStorage.getItem('dnt.editor.wrap')).toBe('1')
  await act(async () => toggle.click())
  expect(window.localStorage.getItem('dnt.editor.wrap')).toBe('0')
})

it('restyles with the page theme without rebuilding the editor', async () => {
  await mount(props())
  const before = editorOf(host)
  await act(async () => { document.documentElement.dataset['theme'] = 'dark' })
  await act(async () => { await Promise.resolve() })
  // Reconfigured in place: the same view, with its text and caret intact.
  expect(editorOf(host)).toBe(before)
  expect(editorText(host)).toBe('ab')
  delete document.documentElement.dataset['theme']
})
