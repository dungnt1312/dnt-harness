// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useHotkeys } from './useHotkeys.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ onPress, allowInEditable = false }: { readonly onPress: () => void; readonly allowInEditable?: boolean }) {
  useHotkeys([{ key: 'k', mod: true, ...(allowInEditable ? { allowInEditable: true } : {}), onPress }])
  return <><button type="button">Plain</button><div contentEditable suppressContentEditableWarning>Editor</div></>
}

describe('useHotkeys', () => {
  it('ignores shortcuts while the user is editing contenteditable text', () => {
    const onPress = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<Probe onPress={onPress} />))
    const editor = host.querySelector('[contenteditable="true"]') as HTMLElement
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', ctrlKey: true })))
    expect(onPress).not.toHaveBeenCalled()
    const button = host.querySelector('button') as HTMLButtonElement
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', ctrlKey: true })))
    expect(onPress).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    host.remove()
  })

  it('lets an allowInEditable shortcut run from an editor, and ignores Shift', () => {
    const onPress = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<Probe onPress={onPress} allowInEditable />))
    const editor = host.querySelector('[contenteditable="true"]') as HTMLElement
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', ctrlKey: true, shiftKey: true })))
    expect(onPress).not.toHaveBeenCalled()
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', ctrlKey: true })))
    expect(onPress).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    host.remove()
  })
})
