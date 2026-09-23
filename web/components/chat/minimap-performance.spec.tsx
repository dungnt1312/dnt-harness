// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConversationMinimap } from './ConversationMinimap.tsx'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
const first: ViewItem = { kind: 'user', content: 'first' }
const second: ViewItem = { kind: 'user', content: 'second' }
const scrollRef = createRef<HTMLDivElement>()
const contentRef = createRef<HTMLDivElement>()
const observe = vi.fn()
const disconnect = vi.fn()
let notifyResize: ResizeObserverCallback | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); observe.mockClear(); disconnect.mockClear() })

it('does not create a new positioned state for an unchanged ResizeObserver measurement', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { notifyResize = callback } observe = observe; disconnect = disconnect })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<div ref={scrollRef}><div ref={contentRef}><div data-minimap-index="0" /><div data-minimap-index="1" /></div><ConversationMinimap items={[first, second]} scrollRef={scrollRef} contentRef={contentRef} /></div>))
  const firstButton = host.querySelector('button')
  const commits = vi.fn()
  const observer = new MutationObserver(commits)
  observer.observe(firstButton!, { attributes: true, childList: true, subtree: true })
  await act(async () => notifyResize?.([], {} as ResizeObserver))
  await act(async () => frames.shift()?.(0))
  expect(host.querySelector('button')).toBe(firstButton)
  observer.disconnect()
})

it('throttles continuous content resizes to one geometry pass per 150 ms', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { notifyResize = callback } observe = observe; disconnect = disconnect })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<div ref={scrollRef}><div ref={contentRef}><div data-minimap-index="0" /><div data-minimap-index="1" /></div><ConversationMinimap items={[first, second]} scrollRef={scrollRef} contentRef={contentRef} /></div>))
  vi.useFakeTimers()
  const reads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  for (let index = 0; index < 6; index++) {
    await act(async () => notifyResize?.([{ target: contentRef.current! } as unknown as ResizeObserverEntry], {} as ResizeObserver))
    await act(async () => vi.advanceTimersByTime(30))
    while (frames.length > 0) await act(async () => frames.shift()?.(0))
  }
  expect(reads.mock.calls.length).toBeLessThanOrEqual(6)
  vi.useRealTimers()
})

it('keeps minimap geometry observers and user row measurements stable as assistant content streams', async () => {
  vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = disconnect })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const render = (assistant: string) => <div ref={scrollRef}><div ref={contentRef}><div data-minimap-index="0" /><div data-minimap-index="1" /></div><ConversationMinimap items={[first, second, { kind: 'assistant', content: assistant, live: true, thinking: [], thinkingLive: false }]} scrollRef={scrollRef} contentRef={contentRef} /></div>
  await act(async () => root!.render(render('a')))
  const reads = measured.mock.calls.length
  const subscribed = observe.mock.calls.length
  await act(async () => root!.render(render('ab')))
  expect(observe).toHaveBeenCalledTimes(subscribed)
  expect(disconnect).not.toHaveBeenCalled()
  expect(measured).toHaveBeenCalledTimes(reads)
})
