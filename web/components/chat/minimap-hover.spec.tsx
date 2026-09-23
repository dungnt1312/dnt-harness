// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConversationMinimap } from './ConversationMinimap.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

it('uses touching full-width hit areas and keeps the tooltip while moving between markers', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const scrollRef = createRef<HTMLDivElement>()
  const contentRef = createRef<HTMLDivElement>()
  await act(async () => root!.render(
    <div ref={scrollRef}>
      <div ref={contentRef}>
        <div data-minimap-index="0" />
        <div data-minimap-index="1" />
      </div>
      <ConversationMinimap items={[{ kind: 'user', content: 'First message' }, { kind: 'user', content: 'Second message' }]} scrollRef={scrollRef} contentRef={contentRef} />
    </div>,
  ))
  const navigation = host.querySelector<HTMLElement>('[aria-label="Jump through conversation"]')!
  const buttons = [...navigation.querySelectorAll('button')]
  expect(buttons).toHaveLength(2)
  expect(navigation.className).not.toContain('gap-')
  expect(buttons.every((button) => button.className.includes('h-3') && button.className.includes('w-full'))).toBe(true)
  expect(buttons.every((button) => button.querySelector('span')?.className.includes('h-[3px]'))).toBe(true)

  await act(async () => buttons[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('First message')
  await act(async () => {
    buttons[0]!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: buttons[1] }))
    buttons[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: buttons[0] }))
  })
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('Second message')
})
