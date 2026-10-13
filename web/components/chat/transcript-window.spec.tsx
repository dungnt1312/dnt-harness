// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Transcript } from './Transcript.tsx'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })

it('mounts only the recent transcript window and loads older rows on demand', async () => {
  const items: ViewItem[] = Array.from({ length: 320 }, (_, index) => ({ kind: 'user', content: `message ${index}` }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Transcript items={items} conversationId="s" />))
  expect(host.textContent).not.toContain('message 0')
  expect(host.textContent).not.toContain('message 200')
  expect(host.textContent).toContain('message 319')
  const load = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('earlier items'))
  expect(load).toBeDefined()
  await act(async () => load!.click())
  expect(host.textContent).toContain('message 0')
})

it('loads older rows by itself when the reader scrolls near the top', async () => {
  const items: ViewItem[] = Array.from({ length: 320 }, (_, index) => ({ kind: 'user', content: `message ${index}` }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Transcript items={items} conversationId="s" />))
  const scroller = host.querySelector<HTMLElement>('[aria-label="Conversation transcript"]')!
  expect(host.textContent).not.toContain('message 0')
  // Far from the top: nothing loads.
  scroller.scrollTop = 5000
  await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
  expect(host.textContent).not.toContain('message 0')
  // Near the top: the older window mounts without a click.
  scroller.scrollTop = 100
  await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
  expect(host.textContent).toContain('message 0')
})
