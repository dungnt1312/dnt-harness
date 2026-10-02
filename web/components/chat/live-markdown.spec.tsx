// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AssistantMessage } from './MessageParts.tsx'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
const item = (content: string, live = true): Extract<ViewItem, { kind: 'assistant' }> => ({ kind: 'assistant', content, live, thinking: [], thinkingLive: false })
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; vi.useRealTimers() })

it('does not starve the displayed answer during uninterrupted streaming', async () => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<AssistantMessage item={item('first')} />))
  for (let index = 1; index <= 5; index++) {
    await act(async () => vi.advanceTimersByTime(30))
    await act(async () => root!.render(<AssistantMessage item={item(`first ${index}`)} />))
  }
  expect(host.textContent).toContain('first 4')
})

it('limits live text updates to 100 ms while displaying the final markdown answer immediately', async () => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<AssistantMessage item={item('first')} />))
  await act(async () => root!.render(<AssistantMessage item={item('first second')} />))
  expect(host.textContent).toContain('first')
  expect(host.textContent).not.toContain('second')
  await act(async () => vi.advanceTimersByTime(100))
  expect(host.textContent).toContain('first second')
  await act(async () => root!.render(<AssistantMessage item={item('final answer', false)} />))
  expect(host.textContent).toContain('final answer')
})
