// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileNameInput } from './FileNameInput.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

async function mount(props: Partial<Parameters<typeof FileNameInput>[0]> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn(async () => null)
  const onCancel = props.onCancel ?? vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <FileNameInput initial={props.initial ?? ''} label={props.label ?? 'File name'} selectStem={props.selectStem ?? false} onSubmit={onSubmit} onCancel={onCancel} />,
  ))
  const input = host.querySelector('input')!
  return { input, onSubmit, onCancel }
}

const type = async (input: HTMLInputElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = async (input: HTMLInputElement, name: string) => act(async () => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
})

it('focuses and selects the stem of a file name', async () => {
  const { input } = await mount({ initial: 'notes.test.md', selectStem: true })
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'notes.test'.length])
  expect(input.getAttribute('aria-label')).toBe('File name')
})

it('selects the whole name when there is no stem to keep', async () => {
  const { input } = await mount({ initial: '.env', selectStem: true })
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4])
})

it('submits the typed name on Enter', async () => {
  const { input, onSubmit } = await mount()
  await type(input, 'a.ts')
  await key(input, 'Enter')
  expect(onSubmit).toHaveBeenCalledWith('a.ts')
})

it('sends one request when Enter is pressed twice while pending', async () => {
  let release: (value: string | null) => void = () => {}
  const onSubmit = vi.fn(() => new Promise<string | null>((resolve) => { release = resolve }))
  const { input } = await mount({ onSubmit })
  await type(input, 'a.ts')
  await key(input, 'Enter')
  await key(input, 'Enter')
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(input.disabled).toBe(true)
  await act(async () => release(null))
})

it('shows a server error and stays open for another try', async () => {
  let field: HTMLInputElement | undefined
  // Browsers may drop focus when the input is disabled; simulate that while pending.
  const onSubmit = vi.fn(async () => {
    field?.blur()
    return "'a.ts' already exists"
  })
  const { input, onCancel } = await mount({ onSubmit })
  field = input
  await type(input, 'a.ts')
  await key(input, 'Enter')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("'a.ts' already exists")
  expect(input.disabled).toBe(false)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(input)
  expect(onCancel).not.toHaveBeenCalled()
})

it('cancels on Escape, on blur and on an empty Enter', async () => {
  const first = await mount({ initial: 'x' })
  await key(first.input, 'Escape')
  expect(first.onCancel).toHaveBeenCalledTimes(1)
  // React's onBlur listens for the bubbling `focusout`.
  await act(async () => first.input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(first.onCancel).toHaveBeenCalledTimes(2)
  await type(first.input, '   ')
  await key(first.input, 'Enter')
  expect(first.onSubmit).not.toHaveBeenCalled()
  expect(first.onCancel).toHaveBeenCalledTimes(3)
})
