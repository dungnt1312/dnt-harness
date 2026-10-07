// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfigView } from '../../../src/harness/config/types.ts'
import { DEFAULT_LIMITS } from '../../../src/harness/limits.ts'
import { LIMIT_FIELDS, type LimitKey } from '../../../src/harness/limits-config.ts'
import { getAppConfig, HttpError, patchAppConfig, reloadAppConfig } from '../../lib/api.ts'
import { AdvancedPanel } from './AdvancedPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  HttpError: class HttpError extends Error {
    constructor(readonly status: number, readonly body: string) {
      super(`HTTP ${status}: ${body}`)
      this.name = 'HttpError'
    }
  },
  getAppConfig: vi.fn(),
  patchAppConfig: vi.fn(),
  reloadAppConfig: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ViewField = AppConfigView['fields'][number]

/**
 * Descriptor for all 18 limits: Tool timeout overridden by the file, Approval
 * expiry pinned by the host (its file value shadowed), everything else inherited.
 */
function descriptor(options: {
  readonly hash?: string | null
  readonly fields?: Partial<Record<LimitKey, Partial<ViewField>>>
  readonly active?: Partial<Record<LimitKey, number>>
  readonly outOfSync?: boolean
  readonly error?: string
} = {}): AppConfigView {
  const overrides: Partial<Record<LimitKey, Partial<ViewField>>> = {
    toolTimeoutMs: { source: 'file', fileValue: 120_000 },
    approvalExpiryMs: { source: 'explicit', locked: true, fileValue: 1_000, shadowed: true },
    ...options.fields,
  }
  const fields = LIMIT_FIELDS.map((field): ViewField => ({ ...field, source: 'library', locked: false, shadowed: false, ...overrides[field.key] }))
  const fileLimits = Object.fromEntries(fields.flatMap((field) => field.fileValue === undefined ? [] : [[field.key, field.fileValue]]))
  const hash = options.hash === undefined ? 'h1' : options.hash
  return {
    document: hash === null ? null : { v: 1, limits: fileLimits },
    hash,
    active: { revision: 0, values: { ...DEFAULT_LIMITS, toolTimeoutMs: 120_000, approvalExpiryMs: 5_000, ...options.active } },
    inherited: DEFAULT_LIMITS,
    fields,
    outOfSync: options.outOfSync ?? false,
    ...(options.error !== undefined ? { error: options.error } : {}),
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (cause: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((ok, bad) => { resolve = ok; reject = bad })
  return { promise, resolve, reject }
}

let host: HTMLDivElement
let root: Root
let guard: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
  guard = vi.fn()
  vi.mocked(getAppConfig).mockResolvedValue(descriptor())
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
const input = (label: string): HTMLInputElement => {
  const found = [...document.body.querySelectorAll('label')].find((node) => node.textContent === label)?.control
  if (!(found instanceof HTMLInputElement)) throw new Error(`no field "${label}"`)
  return found
}
function type(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const lastGuard = (): { dirty: boolean; busy: boolean; discard: () => void } => guard.mock.calls.at(-1)![0]
const text = (): string => document.body.textContent ?? ''

async function render(): Promise<void> {
  await act(async () => root.render(<AdvancedPanel onGuardChanged={guard} />))
  await settle()
}

describe('advanced settings panel', () => {
  it('renders every limit from component metadata, grouped, with locked fields disabled and explained', async () => {
    await render()
    for (const heading of ['Requests', 'Tools', 'Context', 'Admission']) {
      expect([...document.body.querySelectorAll('h3')].some((node) => node.textContent?.includes(heading))).toBe(true)
    }
    expect(document.body.querySelectorAll('input')).toHaveLength(18)
    expect(input('Tool timeout').value).toBe('120000')
    expect(input('Tool timeout').inputMode).toBe('decimal')
    expect(input('Step retries').inputMode).toBe('numeric')
    expect(input('Stream idle timeout').value).toBe(String(DEFAULT_LIMITS.streamIdleMs))
    expect(text()).toContain('Default foreground wait before eligible Bash commands auto-background.')
    const locked = input('Approval expiry')
    expect(locked.disabled).toBe(true)
    expect(locked.value).toBe('5000')
    expect(text()).toMatch(/Locked/)
    expect(lastGuard()).toMatchObject({ dirty: false, busy: false })
  })

  it('saves exactly the changed field, not the whole limit set', async () => {
    const saved = descriptor({ hash: 'h2', fields: { toolTimeoutMs: { source: 'file', fileValue: 300_000 } } })
    vi.mocked(patchAppConfig).mockResolvedValue(saved)
    await render()
    expect(button('Save changes').disabled).toBe(true)
    await act(async () => type(input('Tool timeout'), '300000'))
    expect(lastGuard().dirty).toBe(true)
    await act(async () => button('Save changes').click())
    await settle()
    expect(patchAppConfig).toHaveBeenCalledTimes(1)
    expect(patchAppConfig).toHaveBeenCalledWith([{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }], 'h1')
    expect(input('Tool timeout').value).toBe('300000')
    expect(lastGuard().dirty).toBe(false)
    expect(button('Save changes').disabled).toBe(true)
  })

  it('resets a file override by sending unset, never the default number', async () => {
    vi.mocked(patchAppConfig).mockResolvedValue(descriptor({ hash: 'h2', fields: { toolTimeoutMs: { source: 'library' } } }))
    await render()
    expect(button('Reset Stream idle timeout').disabled).toBe(true)
    expect(button('Reset Approval expiry').disabled).toBe(true)
    await act(async () => button('Reset Tool timeout').click())
    expect(input('Tool timeout').value).toBe(String(DEFAULT_LIMITS.toolTimeoutMs))
    expect(lastGuard().dirty).toBe(true)
    await act(async () => button('Save changes').click())
    await settle()
    expect(patchAppConfig).toHaveBeenCalledWith([{ op: 'unset', key: 'toolTimeoutMs' }], 'h1')
  })

  it('blocks saving an invalid draft using the descriptor bounds', async () => {
    await render()
    await act(async () => type(input('Stream idle timeout'), '0'))
    expect(text()).toContain('greater than 0')
    expect(input('Stream idle timeout').getAttribute('aria-invalid')).toBe('true')
    expect(button('Save changes').disabled).toBe(true)
    await act(async () => type(input('Stream idle timeout'), '1000'))
    await act(async () => type(input('Step retries'), '1.5'))
    expect(text()).toContain('whole number')
    expect(button('Save changes').disabled).toBe(true)
    await act(async () => type(input('Step retries'), '1e20'))
    expect(text()).toMatch(/at most/)
    await act(async () => type(input('Step retries'), String(DEFAULT_LIMITS.stepRetries)))
    // Zero is in range where the minimum is inclusive.
    await act(async () => type(input('Compaction tail turns'), '0'))
    expect(button('Save changes').disabled).toBe(false)
    await act(async () => type(input('Compaction tail turns'), ''))
    expect(text()).toContain('Enter a value')
    expect(button('Save changes').disabled).toBe(true)
    expect(patchAppConfig).not.toHaveBeenCalled()
  })

  it('treats a draft typed back to its saved value as no change', async () => {
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    expect(button('Save changes').disabled).toBe(false)
    await act(async () => type(input('Tool timeout'), '120000'))
    expect(button('Save changes').disabled).toBe(true)
    expect(lastGuard().dirty).toBe(false)
  })

  it('keeps the draft and shows the server refusal when a save fails', async () => {
    vi.mocked(patchAppConfig).mockRejectedValue(new HttpError(400, JSON.stringify({ error: 'toolTimeoutMs is out of range', code: 'invalid' })))
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => button('Save changes').click())
    await settle()
    expect(text()).toContain('toolTimeoutMs is out of range')
    expect(input('Tool timeout').value).toBe('300000')
    expect(lastGuard().dirty).toBe(true)
  })

  it('recovers from a locked refusal through refresh, removing only the locked edit', async () => {
    vi.mocked(patchAppConfig).mockRejectedValueOnce(new HttpError(409, JSON.stringify({ error: 'toolTimeoutMs is locked by the host', code: 'locked', key: 'toolTimeoutMs' })))
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => type(input('Stream idle timeout'), '45000'))
    await act(async () => button('Save changes').click())
    await settle()
    expect(text()).toContain('toolTimeoutMs is locked by the host')
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/changed since this was loaded/)
    expect(input('Tool timeout').value).toBe('300000')
    expect(button('Save changes').disabled).toBe(true)
    vi.mocked(getAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h2', fields: { toolTimeoutMs: { source: 'explicit', locked: true, fileValue: 120_000, shadowed: true } } }))
    await act(async () => button('Refresh and keep edits').click())
    await settle()
    expect(text()).toContain('Tool timeout is now locked by the host; your edit was removed.')
    expect(text()).toContain('Host override (locked)')
    expect(input('Stream idle timeout').value).toBe('45000')
    expect(document.activeElement).toBe(button('Save changes'))
    vi.mocked(patchAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h3' }))
    await act(async () => button('Save changes').click())
    await settle()
    expect(patchAppConfig).toHaveBeenLastCalledWith([{ op: 'set', key: 'streamIdleMs', value: 45_000 }], 'h2')
  })

  it('recovers from a conflict by refreshing the descriptor and keeping pending edits', async () => {
    vi.mocked(patchAppConfig).mockRejectedValueOnce(new HttpError(409, JSON.stringify({ error: 'configuration changed', code: 'conflict' })))
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => button('Reset Tool timeout').click())
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => button('Save changes').click())
    await settle()
    expect(text()).toMatch(/changed since/i)
    expect(input('Tool timeout').value).toBe('300000')
    // Retrying the same stale hash would only conflict again.
    expect(button('Save changes').disabled).toBe(true)

    // Someone else changed an unrelated field.
    vi.mocked(getAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h2', fields: { streamIdleMs: { source: 'file', fileValue: 90_000 } } }))
    await act(async () => button('Refresh and keep edits').click())
    await settle()
    expect(getAppConfig).toHaveBeenCalledTimes(2)
    expect(reloadAppConfig).not.toHaveBeenCalled()
    expect(patchAppConfig).toHaveBeenCalledTimes(1)
    expect(input('Tool timeout').value).toBe('300000')
    expect(input('Stream idle timeout').value).toBe('90000')
    expect(lastGuard().dirty).toBe(true)

    vi.mocked(patchAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h3' }))
    await act(async () => button('Save changes').click())
    await settle()
    expect(patchAppConfig).toHaveBeenLastCalledWith([{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }], 'h2')
  })

  it('requires confirmation before resubmitting a field that also changed remotely', async () => {
    vi.mocked(patchAppConfig).mockRejectedValueOnce(new HttpError(409, JSON.stringify({ error: 'configuration changed', code: 'conflict' })))
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => button('Save changes').click())
    await settle()
    vi.mocked(getAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h2', fields: { toolTimeoutMs: { source: 'file', fileValue: 200_000 } } }))
    await act(async () => button('Refresh and keep edits').click())
    await settle()
    expect(text()).toContain('200000')
    expect(text()).toMatch(/Changed in file/)
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Also changed in the file: Tool timeout')
    expect(document.activeElement).toBe(button('Keep my edits'))
    expect(input('Tool timeout').value).toBe('300000')
    expect(button('Save changes').disabled).toBe(true)
    expect(patchAppConfig).toHaveBeenCalledTimes(1)
    await act(async () => button('Keep my edits').click())
    expect(button('Save changes').disabled).toBe(false)
    expect(document.activeElement).toBe(button('Save changes'))
    expect(patchAppConfig).toHaveBeenCalledTimes(1)
    vi.mocked(patchAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h3', fields: { toolTimeoutMs: { source: 'file', fileValue: 300_000 } } }))
    await act(async () => button('Save changes').click())
    await settle()
    expect(patchAppConfig).toHaveBeenLastCalledWith([{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }], 'h2')
  })

  it('removes an edit to a field the host locked meanwhile, naming it, and keeps the rest', async () => {
    vi.mocked(patchAppConfig).mockRejectedValueOnce(new HttpError(409, JSON.stringify({ error: 'configuration changed', code: 'conflict' })))
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => type(input('Stream idle timeout'), '45000'))
    await act(async () => button('Save changes').click())
    await settle()
    vi.mocked(getAppConfig).mockResolvedValueOnce(descriptor({
      hash: 'h2',
      fields: { toolTimeoutMs: { source: 'explicit', locked: true, fileValue: 120_000, shadowed: true } },
      active: { toolTimeoutMs: 60_000 },
    }))
    await act(async () => button('Refresh and keep edits').click())
    await settle()
    expect(text()).toContain('Tool timeout is now locked by the host; your edit was removed.')
    expect(input('Tool timeout').disabled).toBe(true)
    expect(input('Tool timeout').value).toBe('60000')
    expect(input('Stream idle timeout').value).toBe('45000')
    // A locked field never enters the review path.
    expect(() => button('Keep my edits')).toThrow()
    expect(text()).not.toMatch(/Changed in file/)
    expect(lastGuard().dirty).toBe(true)
    vi.mocked(patchAppConfig).mockResolvedValueOnce(descriptor({ hash: 'h3' }))
    await act(async () => button('Save changes').click())
    await settle()
    expect(patchAppConfig).toHaveBeenLastCalledWith([{ op: 'set', key: 'streamIdleMs', value: 45_000 }], 'h2')
  })

  it('discards explicitly without touching the server', async () => {
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => button('Discard edits').click())
    expect(input('Tool timeout').value).toBe('120000')
    expect(lastGuard().dirty).toBe(false)
    expect(getAppConfig).toHaveBeenCalledTimes(1)
    expect(reloadAppConfig).not.toHaveBeenCalled()
  })

  it('discards through the guard handed to the parent', async () => {
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => lastGuard().discard())
    expect(input('Tool timeout').value).toBe('120000')
    expect(lastGuard().dirty).toBe(false)
  })

  it('shows manual file drift and applies the file separately from saving', async () => {
    vi.mocked(getAppConfig).mockResolvedValue(descriptor({ outOfSync: true, fields: { toolTimeoutMs: { source: 'file', fileValue: 150_000 } } }))
    vi.mocked(reloadAppConfig).mockResolvedValue(descriptor({ fields: { toolTimeoutMs: { source: 'file', fileValue: 150_000 } }, active: { toolTimeoutMs: 150_000 } }))
    await render()
    expect(input('Tool timeout').value).toBe('150000')
    expect(text()).toMatch(/Active[^0-9]*120000/)
    await act(async () => button('Apply file changes').click())
    await settle()
    expect(reloadAppConfig).toHaveBeenCalledTimes(1)
    expect(patchAppConfig).not.toHaveBeenCalled()
    expect(text()).not.toMatch(/Active[^0-9]*120000/)
  })

  it('confirms applying file changes over a dirty draft, clearing it only once applied', async () => {
    vi.mocked(getAppConfig).mockResolvedValue(descriptor({ outOfSync: true }))
    vi.mocked(reloadAppConfig).mockResolvedValue(descriptor())
    await render()
    await act(async () => type(input('Stream idle timeout'), '1234'))
    await act(async () => button('Apply file changes').click())
    expect(reloadAppConfig).not.toHaveBeenCalled()
    expect(text()).toMatch(/discard/i)
    expect(document.activeElement).toBe(button('Apply and discard edits'))
    await act(async () => button('Cancel').click())
    expect(input('Stream idle timeout').value).toBe('1234')
    expect(document.activeElement).toBe(button('Apply file changes'))
    await act(async () => button('Apply file changes').click())
    await act(async () => button('Apply and discard edits').click())
    await settle()
    expect(reloadAppConfig).toHaveBeenCalledTimes(1)
    expect(input('Stream idle timeout').value).toBe(String(DEFAULT_LIMITS.streamIdleMs))
    expect(lastGuard().dirty).toBe(false)
  })

  it('shows an invalid file without guessing a hash to save against', async () => {
    vi.mocked(getAppConfig).mockResolvedValue(descriptor({ hash: null, outOfSync: true, error: 'limits.toolTimeoutMs must be a number' }))
    await render()
    expect(text()).toContain('limits.toolTimeoutMs must be a number')
    expect(button('Save changes').disabled).toBe(true)
    expect(input('Tool timeout').disabled).toBe(true)
    expect(patchAppConfig).not.toHaveBeenCalled()
  })

  it('offers Retry when the first load fails instead of loading forever', async () => {
    vi.mocked(getAppConfig).mockRejectedValueOnce(new HttpError(500, JSON.stringify({ error: 'disk unreadable', code: 'io' })))
    await render()
    expect(text()).toContain('disk unreadable')
    expect(text()).not.toContain('Loading')
    const retry = deferred<AppConfigView>()
    vi.mocked(getAppConfig).mockReturnValueOnce(retry.promise)
    await act(async () => button('Retry').click())
    expect(button('Retrying…').disabled).toBe(true)
    expect(text()).toContain('disk unreadable')
    await act(async () => retry.resolve(descriptor()))
    await settle()
    expect(document.body.querySelectorAll('input')).toHaveLength(18)
  })

  // Late responses are safe by construction: every async setter comes from
  // useScopedState (ignored once unmounted) and the guard is only published
  // from a layout effect, which cannot run without a render. These tests pin
  // the observable half of that contract — the parent hears nothing after
  // unmount, and React reports nothing — so a handler that called the guard
  // directly from a late response would fail here.
  it('reports no guard after unmount when a late load resolves', async () => {
    const late = deferred<AppConfigView>()
    vi.mocked(getAppConfig).mockReturnValueOnce(late.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    const calls = guard.mock.calls.length
    act(() => root.unmount())
    await act(async () => late.resolve(descriptor()))
    expect(guard.mock.calls.length).toBe(calls)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    root = createRoot(host)
  })

  it('reports busy while saving, and no guard after unmount when the save resolves late', async () => {
    const late = deferred<AppConfigView>()
    vi.mocked(patchAppConfig).mockReturnValueOnce(late.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    await act(async () => type(input('Tool timeout'), '300000'))
    await act(async () => button('Save changes').click())
    expect(lastGuard()).toMatchObject({ dirty: true, busy: true })
    const calls = guard.mock.calls.length
    act(() => root.unmount())
    await act(async () => late.resolve(descriptor({ hash: 'h2' })))
    expect(guard.mock.calls.length).toBe(calls)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    root = createRoot(host)
  })
})
