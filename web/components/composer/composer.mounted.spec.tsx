// @vitest-environment jsdom
/**
 * Composer behaviour around the rich input: the `@` and `/` menus, mention
 * chips, pasted files, and ArrowUp recall. Sending, chips in the
 * control row and permissions are covered by the product-copy specs.
 */
import { act, StrictMode, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer.tsx'
import { ToastHost } from '../common/Toast.tsx'
import { draftText, emptyDraft, type AttachmentRef, type RichDraft } from '../../lib/composer-draft.ts'
import type { CompletionItem } from '../../lib/composer-completion.ts'

const files: readonly CompletionItem[] = [
  { id: 'web/composer.ts', insert: 'web/composer.ts', segment: { kind: 'mention', path: 'web/composer.ts' }, label: 'composer.ts', detail: 'web' },
  { id: 'web/api.ts', insert: 'web/api.ts', segment: { kind: 'mention', path: 'web/api.ts' }, label: 'api.ts', detail: 'web' },
]

const PNG_REF: AttachmentRef = { id: 'a'.repeat(64), name: 'shot.png', mediaType: 'image/png', bytes: 2048 }

const baseProps = {
  connected: true,
  running: false,
  onSend: () => {},
  onStop: () => {},
  modelValue: 'openai::gpt-4o',
  modes: [],
  modeValue: null,
  onMode: () => {},
}

let host: HTMLDivElement
let root: Root
/** The draft the harness currently holds, as the app would. */
let current: RichDraft = emptyDraft

/** Mirror the app: the parent owns the draft and echoes back what it is given. */
function Harness(props: Partial<React.ComponentProps<typeof Composer>>): React.ReactNode {
  const [draft, setDraft] = useState<RichDraft>(props.draft ?? emptyDraft)
  useEffect(() => { if (props.draft !== undefined) setDraft(props.draft) }, [props.draft])
  current = draft
  return (
    <ToastHost>
      <Composer {...baseProps} {...props} draft={draft} onDraft={(next) => { current = next; props.onDraft?.(next); setDraft(next) }} />
    </ToastHost>
  )
}

function render(props: Partial<React.ComponentProps<typeof Composer>> = {}): void {
  act(() => root.render(<Harness {...props} />))
}

const input = (): HTMLElement => host.querySelector('[data-composer-input]') as HTMLElement
const options = (): HTMLElement[] => Array.from(host.querySelectorAll('[role="option"]'))
const chips = (): HTMLElement[] => Array.from(input().querySelectorAll('[data-chip-segment]'))
const groupHeaders = (): string[] => Array.from(host.querySelectorAll('[role="listbox"] .uppercase')).map((node) => node.textContent ?? '')

/** Type text and leave the caret at its end, the way a browser would. */
function type(text: string): void {
  const element = input()
  act(() => {
    element.textContent = text
    const node = element.firstChild as Text
    const range = document.createRange()
    range.setStart(node, text.length)
    range.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(value: string, modifiers: KeyboardEventInit = {}): void {
  act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value, ...modifiers })) })
}

function paste(text: string, files: readonly File[] = []): void {
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => text } })
    input().dispatchEvent(event)
  })
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) }) }

describe('composer placeholder', () => {
  it('hides after pasting into an editor with a lone br element and visible text', () => {
    render()
    const element = input()
    expect(element.dataset['editorEmpty']).toBe('true')
    act(() => {
      const anchor = document.createTextNode('')
      element.append(anchor, document.createElement('br'))
      const range = document.createRange()
      range.setStart(anchor, 0)
      range.collapse(true)
      document.getSelection()?.removeAllRanges()
      document.getSelection()?.addRange(range)
      paste('campaign925Byod')
    })
    expect(current.segments).toEqual([{ kind: 'text', text: 'campaign925Byod\n' }])
    expect(element.dataset['editorEmpty']).toBe('false')
  })

  it('shows again after text is removed, including a browser-inserted br', () => {
    render()
    type('hello')
    expect(input().dataset['editorEmpty']).toBe('false')
    act(() => {
      input().replaceChildren(document.createElement('br'))
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input().dataset['editorEmpty']).toBe('true')
  })
})

// jsdom ships no CSS.escape, which every browser has; the completion popover
// uses it to find its active option by a React useId (":r1:"-style) id.
if (typeof globalThis.CSS?.escape !== 'function') {
  const escape = (value: string): string =>
    value.replace(/^(\d)/, '\\3$1 ').replace(/[^a-zA-Z0-9_ -￿-]/g, (char) => `\\${char}`)
  ;(globalThis as { CSS?: unknown }).CSS = { ...(globalThis.CSS ?? {}), escape }
}
// jsdom does no layout, so it has no scrollIntoView either; the popover only
// uses it to keep the active option visible.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  current = emptyDraft
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('file mentions', () => {
  it('searches after the caret settles and inserts the choice as a chip', async () => {
    const onSearchFiles = vi.fn(async () => files)
    render({ onSearchFiles })

    type('look at @comp')
    await settle()

    expect(onSearchFiles).toHaveBeenCalledWith('comp')
    expect(options().map((option) => option.textContent)).toEqual(['composer.tsweb', 'api.tsweb'])

    key('Enter')
    expect(chips()).toHaveLength(1)
    expect(chips()[0]?.getAttribute('aria-label')).toBe('File mention web/composer.ts')
    expect(current.segments).toEqual([
      { kind: 'text', text: 'look at ' },
      { kind: 'mention', path: 'web/composer.ts' },
      { kind: 'text', text: ' ' },
    ])
  })

  it('moves the active option with the arrow keys', async () => {
    render({ onSearchFiles: async () => files })
    type('@comp')
    await settle()
    key('ArrowDown')
    key('Enter')
    expect(current.segments).toContainEqual({ kind: 'mention', path: 'web/api.ts' })
  })

  it('stays shut without a project and closes on Escape', async () => {
    render({})
    type('@comp')
    await settle()
    expect(options()).toHaveLength(0)

    render({ onSearchFiles: async () => files })
    type('@comp')
    await settle()
    expect(options()).toHaveLength(2)
    key('Escape')
    expect(options()).toHaveLength(0)
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('skill commands', () => {
  const skills = [{ name: 'review', description: 'Check a diff' }, { name: 'test', description: 'Run the suite' }]

  it('opens on a leading slash and inserts an atomic /name chip that keeps the established wire text', () => {
    render({ skills })
    type('/rev')
    expect(options().map((option) => option.textContent)).toEqual(['reviewCheck a diff'])
    key('Enter')
    expect(chips()).toHaveLength(1)
    expect(chips()[0]?.getAttribute('aria-label')).toBe('Skill command review')
    expect(chips()[0]?.textContent).toBe('/review')
    expect(draftText(current)).toBe('Use the review skill: ')
    expect(current.segments).toEqual([{ kind: 'command', name: 'review' }, { kind: 'text', text: ' ' }])
  })

  it('ignores a slash that is not the start of the draft', () => {
    render({ skills })
    type('run /rev')
    expect(options()).toHaveLength(0)
  })
})

describe('built-in commands', () => {
  it('picking /compact executes at once through onCommand — nothing lands in the draft', () => {
    const onCommand = vi.fn()
    render({ onCommand })
    type('/')
    expect(options().map((option) => option.textContent)).toEqual(['/compactSummarize older turns into a compaction checkpoint'])
    // No catalog, no caption: the bare command list reads unheadered.
    expect(groupHeaders()).toEqual([])
    key('Enter')
    expect(onCommand).toHaveBeenCalledWith('compact')
    expect(chips()).toHaveLength(0)
    expect(current.segments).toEqual([])
  })

  it('a query narrows commands the way it narrows skills', () => {
    render({})
    type('/comp')
    expect(options().map((option) => option.textContent)).toEqual(['/compactSummarize older turns into a compaction checkpoint'])
    type('/nope')
    expect(options()).toHaveLength(0)
  })

  it('a reserved command shadows a same-named workspace skill', () => {
    render({ skills: [{ name: 'compact', description: 'A workspace skill impersonating the host' }, { name: 'review', description: 'Check a diff' }] })
    type('/')
    const texts = options().map((option) => option.textContent)
    expect(texts.filter((text) => text.startsWith('/compact'))).toHaveLength(1)
    expect(texts).not.toContain('compactA workspace skill impersonating the host')
    expect(texts).toContain('reviewCheck a diff')
  })

  it('commands rank before skills under a Skills caption; only commands drop the icon', () => {
    render({ skills: [{ name: 'review', description: 'Check a diff' }] })
    type('/')
    expect(options().map((option) => option.textContent)[0]).toBe('/compactSummarize older turns into a compaction checkpoint')
    // The caption sits between the groups and is not itself an option.
    expect(groupHeaders()).toEqual(['Skills'])
    expect(options()).toHaveLength(2)
    expect(options()[0]?.querySelector('svg')).toBeNull()
    expect(options()[1]?.querySelector('svg')).not.toBeNull()
  })
})

describe('attachments', () => {
  it('uploads pasted files into the attachment tray, outside the text', async () => {
    const onUploadFiles = vi.fn(async () => [PNG_REF])
    render({ onUploadFiles })

    const file = new File([new Uint8Array([1, 2])], 'shot.png', { type: 'image/png' })
    await act(async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      Object.defineProperty(event, 'clipboardData', { value: { files: [file], getData: () => '' } })
      input().dispatchEvent(event)
      await Promise.resolve()
    })
    await settle()

    expect(onUploadFiles).toHaveBeenCalledTimes(1)
    expect(current.attachments).toEqual([PNG_REF])
    expect(current.segments).toEqual([])
    expect(chips()).toHaveLength(0)
  })

  it('uploads meaningful mixed clipboard data once without duplicating its text', async () => {
    const onUploadFiles = vi.fn(async () => [PNG_REF])
    render({ onUploadFiles })
    paste('A screenshot', [new File(['png'], 'shot.png', { type: 'image/png' })])
    await settle()
    expect(onUploadFiles).toHaveBeenCalledTimes(1)
    expect(current.attachments).toEqual([PNG_REF])
    expect(current.segments).toEqual([{ kind: 'text', text: 'A screenshot' }])
  })

  it('offers no attach control when the conversation cannot take files', () => {
    render({})
    expect(host.querySelector('[aria-label="Attach a file"]')).toBeNull()
    render({ onUploadFiles: async () => [] })
    expect(host.querySelector('[aria-label="Attach a file"]')).not.toBeNull()
  })
})

describe('attachment tray and uploads', () => {
  it('renders images and text files as separate accessible tray cards', () => {
    const text: AttachmentRef = { id: 'b'.repeat(64), name: 'data.json', mediaType: 'application/json', bytes: 512 }
    render({ workspaceId: 'workspace', draft: { segments: [], attachments: [PNG_REF, text] } } as Partial<React.ComponentProps<typeof Composer>>)
    expect(host.querySelector('[aria-label="2 attachments"]')).not.toBeNull()
    expect(host.querySelector('[data-composer-input] [data-chip-segment]')).toBeNull()
    expect(host.querySelector('img[alt="Image attachment: shot.png"]')).not.toBeNull()
    expect(host.textContent).toContain('data.json')
  })

  it('keeps attachments when editor segments change and removes only the selected ref', () => {
    render({ draft: { segments: [], attachments: [PNG_REF] } } as Partial<React.ComponentProps<typeof Composer>>)
    type('keep attachment')
    expect(current.attachments).toEqual([PNG_REF])
    act(() => (host.querySelector('[aria-label="Remove shot.png"]') as HTMLButtonElement).click())
    expect(current.segments).toEqual([{ kind: 'text', text: 'keep attachment' }])
    expect(current.attachments).toEqual([])
  })

  it('declares a valid combobox, busy upload state, and the exact accepted MIME list', async () => {
    let resolve!: (refs: readonly AttachmentRef[]) => void
    render({ onUploadFiles: () => new Promise<readonly AttachmentRef[]>((done) => { resolve = done }) })
    // aria-multiline is not allowed on a combobox; the contenteditable itself is multi-line.
    expect(input().getAttribute('role')).toBe('combobox')
    expect(input().hasAttribute('aria-multiline')).toBe(false)
    expect(host.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp,image/gif,text/*,application/json,application/xml')
    paste('', [new File(['x'], 'a.txt', { type: 'text/plain' })])
    expect(host.querySelector('form')?.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[aria-label="Send"]')).toHaveProperty('disabled', true)
    await act(async () => { resolve([PNG_REF]); await Promise.resolve() })
  })

  it('retains and blocks an oversized UTF-8 paste until it is resolved', () => {
    const onSend = vi.fn()
    render({ onSend })
    paste('🙂'.repeat(15_001))
    expect(current.segments).toEqual([{ kind: 'text', text: '🙂'.repeat(15_001) }])
    expect(host.textContent).toContain('60,000-byte')
    expect(host.querySelector('[aria-label="Send"]')).toHaveProperty('disabled', true)
    type('short')
    expect(host.querySelector('[aria-label="Send"]')).toHaveProperty('disabled', false)
    key('Enter')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('treats an empty upload response as an alerting failure', async () => {
    render({ onUploadFiles: async () => [] })
    paste('', [new File(['x'], 'a.txt', { type: 'text/plain' })])
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Upload returned no attachments')
  })

  it('drains a later completed upload after an earlier empty terminal slot', async () => {
    let resolveFirst!: (refs: readonly AttachmentRef[]) => void
    let resolveSecond!: (refs: readonly AttachmentRef[]) => void
    const later = { ...PNG_REF, id: 'l'.repeat(64), name: 'later.png' }
    const onUploadFiles = vi.fn(() => new Promise<readonly AttachmentRef[]>((resolve) => {
      if (onUploadFiles.mock.calls.length === 1) resolveFirst = resolve
      else resolveSecond = resolve
    }))
    render({ onUploadFiles })
    paste('', [new File(['first'], 'first.txt', { type: 'text/plain' })])
    paste('', [new File(['second'], 'second.txt', { type: 'text/plain' })])
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Waiting for 2 attachments')
    await act(async () => { resolveSecond([later]); await Promise.resolve() })
    expect(current.attachments).toEqual([])
    await act(async () => { resolveFirst([]); await Promise.resolve() })
    expect(current.attachments).toEqual([later])
    expect(host.querySelector('form')?.getAttribute('aria-busy')).toBeNull()
  })

  it('restores successful long-paste recovery exactly once and removes its attachment', async () => {
    render({ onUploadFiles: async () => [{ ...PNG_REF, id: 't'.repeat(64), name: 'pasted.txt', mediaType: 'text/plain' }] })
    paste('x'.repeat(8_001))
    await settle()
    const insert = host.querySelector('button') as HTMLButtonElement
    const insertBack = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Insert back') as HTMLButtonElement
    expect(insertBack).toBeTruthy()
    act(() => insertBack.click())
    expect(current.attachments).toEqual([])
    expect(current.segments).toEqual([{ kind: 'text', text: 'x'.repeat(8_001) }])
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Insert back')).toBe(false)
    void insert
  })

  it('emits one atomic draft transition for Insert back', async () => {
    const transitions = vi.fn()
    render({ onDraft: transitions, onUploadFiles: async () => [{ ...PNG_REF, id: 'r'.repeat(64), name: 'pasted.txt', mediaType: 'text/plain' }] })
    paste('x'.repeat(8_001))
    await settle()
    transitions.mockClear()
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Insert back') as HTMLButtonElement).click())
    expect(transitions).toHaveBeenCalledTimes(1)
    expect(transitions).toHaveBeenLastCalledWith({ segments: [{ kind: 'text', text: 'x'.repeat(8_001) }], attachments: [] })
  })

  it('restores rejected conversion atomically at its original prefix/text/suffix position', async () => {
    const text = 'x'.repeat(5_000)
    let reject!: (reason?: unknown) => void
    render({ onUploadFiles: () => new Promise<readonly AttachmentRef[]>((_, fail) => { reject = fail }) })
    type('prefixsuffix')
    const node = input().firstChild as Text
    act(() => { const range = document.createRange(); range.setStart(node, 6); range.collapse(true); const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range) })
    paste(text)
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Convert to attachment') as HTMLButtonElement).click())
    await act(async () => { reject(new Error('nope')); await Promise.resolve() })
    expect(current.segments).toEqual([{ kind: 'text', text: `prefix${text}suffix` }])
  })

  it('makes successful conversion recoverable exactly once with a timestamped filename', async () => {
    const text = 'x'.repeat(5_000)
    let uploadedFilename: string | undefined
    const onUploadFiles = async (files: readonly File[]): Promise<readonly AttachmentRef[]> => {
      uploadedFilename = files[0]?.name
      return [{ ...PNG_REF, id: 'v'.repeat(64), name: 'stored.txt', mediaType: 'text/plain' }]
    }
    render({ onUploadFiles })
    paste(text)
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Convert to attachment') as HTMLButtonElement).click())
    await settle()
    expect(uploadedFilename).toMatch(/^pasted-text-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/)
    const insert = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Insert back') as HTMLButtonElement
    act(() => insert.click())
    expect(current.segments).toEqual([{ kind: 'text', text }])
    expect(host.textContent).not.toContain('Insert back')
  })

  it('refuses conversion after an intervening edit and removes inline text on valid conversion', async () => {
    const text = 'x'.repeat(5_000)
    render({ onUploadFiles: async () => [{ ...PNG_REF, id: 'c'.repeat(64), name: 'converted.txt', mediaType: 'text/plain' }] })
    paste(text)
    const convert = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Convert to attachment') as HTMLButtonElement
    act(() => convert.click())
    await settle()
    expect(current.segments).toEqual([])
    expect(current.attachments).toHaveLength(1)

    render({ onUploadFiles: async () => [PNG_REF] })
    paste(text)
    type(`edited ${text}`)
    const staleConvert = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Convert to attachment') as HTMLButtonElement
    act(() => staleConvert.click())
    expect(current.segments).toEqual([{ kind: 'text', text: `edited ${text}` }])
    expect(host.textContent).toContain('Cannot convert')
  })

  it('restores removed attachments in their original first and middle positions', () => {
    const first = { ...PNG_REF, id: '1'.repeat(64), name: 'first.png' }
    const middle = { ...PNG_REF, id: '2'.repeat(64), name: 'middle.png' }
    const last = { ...PNG_REF, id: '3'.repeat(64), name: 'last.png' }
    render({ draft: { segments: [], attachments: [first, middle, last] } })
    act(() => (host.querySelector('[aria-label="Remove first.png"]') as HTMLButtonElement).click())
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Undo') as HTMLButtonElement).click())
    expect(current.attachments).toEqual([first, middle, last])
    act(() => (host.querySelector('[aria-label="Remove middle.png"]') as HTMLButtonElement).click())
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Undo') as HTMLButtonElement).click())
    expect(current.attachments).toEqual([first, middle, last])
  })

  it('withdraws the undo offer after a few seconds', () => {
    vi.useFakeTimers()
    render({ draft: { segments: [], attachments: [PNG_REF] } })
    act(() => (host.querySelector('[aria-label="Remove shot.png"]') as HTMLButtonElement).click())
    expect(host.textContent).toContain('Removed shot.png.')
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Undo')).toBe(false)
  })

  it('tells a sighted user why Enter did not send while files upload', async () => {
    let resolve!: (refs: readonly AttachmentRef[]) => void
    const onSend = vi.fn()
    render({ onSend, onUploadFiles: () => new Promise<readonly AttachmentRef[]>((done) => { resolve = done }) })
    type('with a file')
    paste('', [new File(['x'], 'a.txt', { type: 'text/plain' })])
    key('Enter')
    expect(onSend).not.toHaveBeenCalled()
    const hint = Array.from(host.querySelectorAll('li')).find((item) => item.textContent?.includes('finish uploading'))
    expect(hint?.classList.contains('sr-only')).toBe(false)
    expect(input().getAttribute('aria-describedby')).toBe(hint?.id)
    await act(async () => { resolve([PNG_REF]); await Promise.resolve() })
    expect(host.textContent).not.toContain('finish uploading')
  })

  it('converts a middle paste between prefix and suffix without changing surrounding text', async () => {
    const text = 'x'.repeat(5_000)
    render({ onUploadFiles: async () => [{ ...PNG_REF, id: 'm'.repeat(64), name: 'converted.txt', mediaType: 'text/plain' }] })
    type('prefixsuffix')
    const node = input().firstChild as Text
    act(() => {
      const range = document.createRange()
      range.setStart(node, 6)
      range.collapse(true)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    paste(text)
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Convert to attachment') as HTMLButtonElement).click())
    await settle()
    expect(current.segments).toEqual([{ kind: 'text', text: 'prefixsuffix' }])
  })

  it('restores failed long paste after a chip without serializing chip contents as text', async () => {
    let reject!: (reason?: unknown) => void
    render({ skills: [{ name: 'review' }], onUploadFiles: () => new Promise<readonly AttachmentRef[]>((_, fail) => { reject = fail }) })
    type('/rev')
    key('Enter')
    paste('x'.repeat(8_001))
    await act(async () => { reject(new Error('failed')); await Promise.resolve() })
    expect(current.segments).toEqual([
      { kind: 'command', name: 'review' },
      { kind: 'text', text: ` ${'x'.repeat(8_001)}` },
    ])
  })

  it('applies concurrent uploads by initiation order despite out-of-order completion', async () => {
    let resolveFirst!: (refs: readonly AttachmentRef[]) => void
    let resolveSecond!: (refs: readonly AttachmentRef[]) => void
    const first = { ...PNG_REF, id: 'a'.repeat(64), name: 'first.png' }
    const second = { ...PNG_REF, id: 'b'.repeat(64), name: 'second.png' }
    const onUploadFiles = vi.fn(() => new Promise<readonly AttachmentRef[]>((resolve) => {
      if (onUploadFiles.mock.calls.length === 1) resolveFirst = resolve
      else resolveSecond = resolve
    }))
    render({ onUploadFiles })
    paste('', [new File(['first'], 'first.txt', { type: 'text/plain' })])
    paste('', [new File(['second'], 'second.txt', { type: 'text/plain' })])
    await act(async () => { resolveSecond([second]); await Promise.resolve() })
    expect(current.attachments).toEqual([])
    await act(async () => { resolveFirst([first]); await Promise.resolve() })
    expect(current.attachments).toEqual([first, second])

    act(() => root.unmount())
    let resolveLate!: (refs: readonly AttachmentRef[]) => void
    const lateHost = document.createElement('div')
    document.body.append(lateHost)
    const lateRoot = createRoot(lateHost)
    await act(async () => {
      lateRoot.render(<ToastHost><Composer {...baseProps} draft={emptyDraft} onDraft={() => {}} onUploadFiles={() => new Promise<readonly AttachmentRef[]>((resolve) => { resolveLate = resolve })} /></ToastHost>)
    })
    const lateInput = lateHost.querySelector('[data-composer-input]') as HTMLElement
    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['late'], 'late.txt', { type: 'text/plain' })], getData: () => '' } })
      lateInput.dispatchEvent(event)
      lateRoot.unmount()
    })
    await act(async () => { resolveLate([PNG_REF]); await Promise.resolve() })
    lateHost.remove()
  })

  it('keeps overlapping uploads atomic and ignores unmounted completions', async () => {
    let resolveFirst!: (refs: readonly AttachmentRef[]) => void
    let resolveSecond!: (refs: readonly AttachmentRef[]) => void
    const onUploadFiles = vi.fn(() => new Promise<readonly AttachmentRef[]>((resolve) => {
      if (onUploadFiles.mock.calls.length === 1) resolveFirst = resolve
      else resolveSecond = resolve
    }))
    render({ onUploadFiles })
    paste('', [new File(['first'], 'first.txt', { type: 'text/plain' })])
    paste('', [new File(['second'], 'second.txt', { type: 'text/plain' })])
    await act(async () => { resolveSecond([PNG_REF]); await Promise.resolve() })
    await act(async () => { resolveFirst([{ ...PNG_REF, id: 'b'.repeat(64), name: 'second.png' }]); await Promise.resolve() })
    expect(current.attachments.map((attachment) => attachment.id)).toEqual(['b'.repeat(64), PNG_REF.id])

    act(() => root.unmount())
    let resolveLate!: (refs: readonly AttachmentRef[]) => void
    const lateHost = document.createElement('div')
    document.body.append(lateHost)
    const lateRoot = createRoot(lateHost)
    await act(async () => {
      lateRoot.render(<ToastHost><Composer {...baseProps} draft={emptyDraft} onDraft={() => {}} onUploadFiles={() => new Promise<readonly AttachmentRef[]>((resolve) => { resolveLate = resolve })} /></ToastHost>)
    })
    const lateInput = lateHost.querySelector('[data-composer-input]') as HTMLElement
    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['late'], 'late.txt', { type: 'text/plain' })], getData: () => '' } })
      lateInput.dispatchEvent(event)
      lateRoot.unmount()
    })
    await act(async () => { resolveLate([PNG_REF]); await Promise.resolve() })
    lateHost.remove()
  })
})

describe('chip-aware bookmarks', () => {
  it('restores long paste at both sides of mention and command chips, including adjacent chips', async () => {
    const long = 'x'.repeat(8_001)
    const mention: RichDraft = { segments: [{ kind: 'mention', path: 'src/a.ts' }, { kind: 'command', name: 'review' }], attachments: [] }
    let reject!: (reason?: unknown) => void
    render({ draft: mention, onUploadFiles: () => new Promise<readonly AttachmentRef[]>((_, fail) => { reject = fail }) })
    const editor = input()
    const command = chips()[1] as HTMLElement
    act(() => { const range = document.createRange(); range.setStartBefore(command); range.collapse(true); const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range) })
    paste(long)
    await act(async () => { reject(new Error('failed')); await Promise.resolve() })
    expect(current.segments).toEqual([{ kind: 'mention', path: 'src/a.ts' }, { kind: 'text', text: long }, { kind: 'command', name: 'review' }])
    void editor
  })
})

describe('keyboard and replacement safety', () => {
  it('uses Ctrl/Cmd+Enter to send even with Shift, while Shift+Enter stays an editor newline', () => {
    const onSend = vi.fn()
    render({ onSend })
    type('message')
    key('Enter', { shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    key('Enter', { shiftKey: true, ctrlKey: true })
    key('Enter', { shiftKey: true, metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('does not submit when activating a command chip remove button', () => {
    const onSend = vi.fn()
    render({ onSend, skills: [{ name: 'review' }] })
    type('/rev')
    key('Enter')
    const remove = chips()[0]?.querySelector('[data-chip-remove]') as HTMLButtonElement
    act(() => remove.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
    expect(onSend).not.toHaveBeenCalled()
    act(() => remove.click())
    expect(current.segments).toEqual([{ kind: 'text', text: ' ' }])
  })

  it('recomputes oversized blocking after external draft replacements', () => {
    const onSend = vi.fn()
    const oversized = { segments: [{ kind: 'text' as const, text: '🙂'.repeat(15_001) }], attachments: [] }
    render({ onSend, draft: oversized })
    expect(host.querySelector('[aria-label="Send"]')).toHaveProperty('disabled', true)
    render({ onSend, draft: { segments: [{ kind: 'text' as const, text: 'safe' }], attachments: [] } })
    expect(host.querySelector('[aria-label="Send"]')).toHaveProperty('disabled', false)
  })

  it('ignores stale completions after real external draft replacement in StrictMode', async () => {
    let resolve!: (refs: readonly AttachmentRef[]) => void
    const onUploadFiles = () => new Promise<readonly AttachmentRef[]>((done) => { resolve = done })
    act(() => root.render(<StrictMode><Harness onUploadFiles={onUploadFiles} /></StrictMode>))
    paste('', [new File(['x'], 'old.txt', { type: 'text/plain' })])
    act(() => root.render(<StrictMode><Harness onUploadFiles={onUploadFiles} draft={{ segments: [{ kind: 'text', text: 'replacement' }], attachments: [] }} /></StrictMode>))
    await act(async () => { resolve([PNG_REF]); await Promise.resolve() })
    expect(current).toEqual({ segments: [{ kind: 'text', text: 'replacement' }], attachments: [] })
  })
})

describe('control row', () => {
  it('puts attach first and the app-owned model picker beside Send', () => {
    render({ onUploadFiles: async () => [], modelControl: <button type="button">gpt-4o</button> })
    const buttons = Array.from(host.querySelectorAll('form button'))
    const attach = buttons.findIndex((button) => button.getAttribute('aria-label') === 'Attach a file')
    const model = buttons.findIndex((button) => button.textContent === 'gpt-4o')
    const send = buttons.findIndex((button) => button.getAttribute('aria-label') === 'Send')
    expect(attach).toBeGreaterThanOrEqual(0)
    expect(attach).toBeLessThan(model)
    expect(model).toBe(send - 1)
    expect(host.querySelector('[aria-label^="Conversation scope"]')).toBeNull()
  })
})

describe('recall', () => {
  it('loads the last message only when the draft is empty', () => {
    const onRecallLast = vi.fn(() => 'previous question')
    render({ onRecallLast })
    key('ArrowUp')
    expect(current.segments).toEqual([{ kind: 'text', text: 'previous question' }])

    onRecallLast.mockClear()
    type('typing')
    key('ArrowUp')
    expect(onRecallLast).not.toHaveBeenCalled()
  })

  it('does nothing when there is no earlier message', () => {
    render({ onRecallLast: () => null })
    key('ArrowUp')
    expect(current.segments).toEqual([])
  })
})
