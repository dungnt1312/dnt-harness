// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AssistantMessage } from './MessageParts.tsx'
import type { ViewItem } from '../../lib/project.ts'

const markdown = vi.fn()
vi.mock('../../Markdown.tsx', () => ({ Markdown: (props: { content: string }) => { markdown(props.content); return <span>{props.content}</span> } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
const answer: Extract<ViewItem, { kind: 'assistant' }> = { kind: 'assistant', content: 'Completed answer', live: false, thinking: [], thinkingLive: false }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); markdown.mockClear() })
it('keeps completed answer mounted when the transcript recomputes an equivalent footer', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<AssistantMessage item={answer} turn={{ text: 'Completed answer' }} />))
  expect(markdown).toHaveBeenCalledTimes(1)
  await act(async () => root!.render(<AssistantMessage item={answer} turn={{ text: 'Completed answer' }} />))
  expect(markdown).toHaveBeenCalledTimes(1)
})
