// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileEditor } from './FileEditor.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })

function props(over: Partial<Parameters<typeof FileEditor>[0]> = {}) {
  return {
    path: 'src/a.ts', text: 'a\n', dirty: false, saving: false, error: null, conflict: false,
    onChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(), onReload: vi.fn(), onOverwrite: vi.fn(),
    ...over,
  }
}

async function mount(p: ReturnType<typeof props>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<FileEditor {...p} />))
  return host.querySelector('textarea')!
}

const key = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!

it('focuses the textarea and labels it with the path', async () => {
  const area = await mount(props())
  expect(document.activeElement).toBe(area)
  expect(area.getAttribute('aria-label')).toBe('Edit src/a.ts')
  expect(area.value).toBe('a\n')
})

it('saves on Cmd+S and Ctrl+S, cancels on Escape', async () => {
  const p = props({ dirty: true })
  const area = await mount(p)
  await key(area, { key: 's', metaKey: true })
  await key(area, { key: 's', ctrlKey: true })
  await key(area, { key: 'Escape' })
  expect(p.onSave).toHaveBeenCalledTimes(2)
  expect(p.onCancel).toHaveBeenCalledTimes(1)
})

it('inserts two spaces on Tab, or a tab when the file is tab-indented', async () => {
  const spaces = props({ text: 'ab' })
  const area = await mount(spaces)
  area.setSelectionRange(1, 1)
  await key(area, { key: 'Tab' })
  expect(spaces.onChange).toHaveBeenLastCalledWith('a  b')
  await act(async () => root!.unmount()); root = undefined; host.remove()

  const tabs = props({ text: '\tx\nab' })
  const area2 = await mount(tabs)
  area2.setSelectionRange(4, 5)
  await key(area2, { key: 'Tab' })
  expect(tabs.onChange).toHaveBeenLastCalledWith('\tx\na\t')
})

it('shows Unsaved only when dirty and disables Save when clean or saving', async () => {
  await mount(props())
  expect(host.textContent).not.toContain('Unsaved')
  expect(button('Save').disabled).toBe(true)
  await act(async () => root!.render(<FileEditor {...props({ dirty: true })} />))
  expect(host.textContent).toContain('Unsaved')
  expect(button('Save').disabled).toBe(false)
  await act(async () => root!.render(<FileEditor {...props({ dirty: true, saving: true })} />))
  expect(button('Saving…').disabled).toBe(true)
  expect(host.querySelector('textarea')!.disabled).toBe(true)
})

it('shows the conflict banner with Reload and Overwrite', async () => {
  const p = props({ dirty: true, conflict: true })
  await mount(p)
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('This file changed on disk since you opened it.')
  await act(async () => button('Reload').click())
  await act(async () => button('Overwrite').click())
  expect(p.onReload).toHaveBeenCalledTimes(1)
  expect(p.onOverwrite).toHaveBeenCalledTimes(1)
})

it('reports typing through onChange', async () => {
  const p = props()
  const area = await mount(p)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'b\n')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(p.onChange).toHaveBeenLastCalledWith('b\n')
})
