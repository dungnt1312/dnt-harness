// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToastHost, useToast } from './Toast.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let api!: ReturnType<typeof useToast>

function Probe() {
  api = useToast()
  return null
}

beforeEach(async () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><Probe /></ToastHost>))
})

afterEach(async () => {
  await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const toasts = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('toast lifetime', () => {
  it('auto-dismisses ok after 5s and errors after 8s', async () => {
    act(() => { api.notify('saved', 'ok'); api.notify('broke') })
    expect(toasts()).toHaveLength(2)
    await advance(5_000)
    expect(toasts()).toHaveLength(1)
    await advance(3_000)
    expect(toasts()).toHaveLength(0)
  })

  it('a persistent toast has no auto-dismiss timer, only the dismiss button closes it', async () => {
    act(() => { api.notify('git push failed', 'bad', { persistent: true }) })
    await advance(10 * 60_000)
    expect(toasts()).toHaveLength(1)
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')!.click())
    expect(toasts()).toHaveLength(0)
  })

  it('returns the toast id, and a repeat collapses into the same toast', async () => {
    let first = 0
    let second = 0
    act(() => { first = api.notify('again', 'info') })
    act(() => { second = api.notify('again', 'info') })
    expect(typeof first).toBe('number')
    expect(second).toBe(first)
    expect(toasts()).toHaveLength(1)
    expect(document.body.textContent).toContain('x2')
  })

  it('a repeat restarts the clock of a timed toast', async () => {
    act(() => { api.notify('again', 'info') })
    await advance(4_000)
    act(() => { api.notify('again', 'info') })
    await advance(4_000)
    expect(toasts()).toHaveLength(1)
    await advance(1_000)
    expect(toasts()).toHaveLength(0)
  })

  it('a persistent repeat of a timed toast makes it stay', async () => {
    act(() => { api.notify('same', 'info') })
    act(() => { api.notify('same', 'info', { persistent: true }) })
    await advance(60_000)
    expect(toasts()).toHaveLength(1)
  })
})

describe('plain toast', () => {
  it('a plain bad toast shows its own text as the headline; a bad toast without it keeps the error summary', () => {
    act(() => { api.notify('git push failed', 'bad', { plain: true }) })
    expect(document.querySelector('[role="alert"] p')?.textContent).toBe('git push failed')
    act(() => { api.notify('git push failed', 'bad') })
    expect(toasts()).toHaveLength(2)
  })
})

describe('toast action', () => {
  it('renders the action as a button; clicking runs it and closes the toast', async () => {
    const onClick = vi.fn()
    act(() => { api.notify('Pushed main to origin', 'ok', { action: { label: 'View Log', onClick } }) })
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'View Log')
    expect(button).toBeDefined()
    await act(async () => button!.click())
    expect(onClick).toHaveBeenCalledOnce()
    expect(toasts()).toHaveLength(0)
  })

  it('a repeat carries the newest action', async () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    act(() => { api.notify('git push failed', 'bad', { persistent: true, action: { label: 'View Log', onClick: stale } }) })
    act(() => { api.notify('git push failed', 'bad', { persistent: true, action: { label: 'View Log', onClick: fresh } }) })
    expect(toasts()).toHaveLength(1)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'View Log')!.click())
    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledOnce()
  })

  it('stays reachable while a modal dialog hides the rest of the page', async () => {
    const { hideOthers } = await import('aria-hidden')
    const dialog = document.createElement('div')
    document.body.append(dialog)
    const undo = hideOthers(dialog)
    try {
      act(() => { api.notify('git commit failed', 'bad', { plain: true, persistent: true }) })
      const toast = toasts()[0]!
      expect(toast.closest('[aria-hidden="true"]')).toBeNull()
      expect(toast.closest('[inert]')).toBeNull()
    } finally {
      undo()
    }
  })

  it('a toast without options renders no action button', () => {
    act(() => { api.notify('plain', 'info') })
    expect([...document.querySelectorAll('button')].map((candidate) => candidate.getAttribute('aria-label'))).toEqual(['Dismiss notification'])
  })
})
