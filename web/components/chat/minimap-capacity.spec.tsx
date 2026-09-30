// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConversationMinimap, minimapPitch } from './ConversationMinimap.tsx'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement

const userItems = (count: number): ViewItem[] => Array.from({ length: count }, (_, index) => ({ kind: 'user' as const, content: `Message ${index + 1}` }))

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  vi.restoreAllMocks()
})

describe('minimapPitch', () => {
  it('keeps the natural 12px slot when the transcript height is unknown or fits', () => {
    expect(minimapPitch(10, null)).toBe(12)
    expect(minimapPitch(10, 0)).toBe(12)
    expect(minimapPitch(10, 120)).toBe(12)
  })

  it('compresses every slot proportionally once the natural stack would overflow', () => {
    expect(minimapPitch(11, 120)).toBeCloseTo(120 / 11)
    expect(minimapPitch(40, 240)).toBe(6)
    expect(minimapPitch(60, 240)).toBe(4)
  })
})

it('compresses the rail into the visible transcript height and keeps hover navigation', async () => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(272)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  await act(async () => root!.render(
    <div ref={scrollRef}>
      <div ref={contentRef}>{userItems(40).map((_, index) => <div key={index} data-minimap-index={index} />)}</div>
      <ConversationMinimap items={userItems(40)} scrollRef={scrollRef} contentRef={contentRef} />
    </div>,
  ))
  const navigation = host.querySelector<HTMLElement>('[aria-label="Jump through conversation"]')!
  const buttons = [...navigation.querySelectorAll('button')]
  expect(buttons).toHaveLength(40)
  // 272px visible minus 2×16px inset leaves 240px for the stack: 40 × 6px.
  expect(buttons.every((button) => button.style.height === '6px')).toBe(true)
  expect(buttons.every((button) => button.className.includes('h-3') && button.className.includes('w-full'))).toBe(true)
  expect(buttons.every((button) => button.querySelector('span')?.className.includes('h-[3px]'))).toBe(true)
  expect(40 * 6).toBeLessThanOrEqual(272)

  await act(async () => buttons[7]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('Message 8')
})

it('shrinks the visible line once the compressed slot drops below 5px', async () => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(272)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  await act(async () => root!.render(
    <div ref={scrollRef}>
      <div ref={contentRef}>{userItems(60).map((_, index) => <div key={index} data-minimap-index={index} />)}</div>
      <ConversationMinimap items={userItems(60)} scrollRef={scrollRef} contentRef={contentRef} />
    </div>,
  ))
  const buttons = [...host.querySelectorAll('button')]
  expect(buttons.every((button) => button.style.height === '4px')).toBe(true)
  expect(buttons.every((button) => button.querySelector('span')?.style.height === '2px')).toBe(true)
})

it('leaves short conversations on the natural class-driven layout', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  await act(async () => root!.render(
    <div ref={scrollRef}>
      <div ref={contentRef}>{userItems(3).map((_, index) => <div key={index} data-minimap-index={index} />)}</div>
      <ConversationMinimap items={userItems(3)} scrollRef={scrollRef} contentRef={contentRef} />
    </div>,
  ))
  const buttons = [...host.querySelectorAll('button')]
  expect(buttons).toHaveLength(3)
  expect(buttons.every((button) => button.style.height === '')).toBe(true)
  expect(buttons.every((button) => button.querySelector('span')?.style.height === '')).toBe(true)
})
