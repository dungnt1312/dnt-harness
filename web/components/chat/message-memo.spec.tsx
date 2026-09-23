// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UserBubble, AssistantMessage } from './MessageParts.tsx'
import { parseMessageText } from '../../lib/inline-chips.ts'
import { highlight } from '../../lib/highlight.ts'
import type { ViewItem } from '../../lib/project.ts'

vi.mock('../../lib/inline-chips.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/inline-chips.ts')>()
  return { ...actual, parseMessageText: vi.fn(actual.parseMessageText) }
})
vi.mock('../../lib/highlight.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/highlight.ts')>()
  return { ...actual, highlight: vi.fn(actual.highlight) }
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
const row: Extract<ViewItem, { kind: 'user' }> = { kind: 'user', content: 'unchanged message' }
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; vi.mocked(parseMessageText).mockClear() })

it('does not highlight an unchanged assistant row during an unrelated parent update', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const answer: Extract<ViewItem, { kind: 'assistant' }> = { kind: 'assistant', content: '```ts\nconst a = 1\n```', live: false, thinking: [], thinkingLive: false }
  const view = (value: number) => <div data-parent={value}><AssistantMessage item={answer} /></div>
  await act(async () => root!.render(view(1)))
  expect(host.textContent).toContain('const a = 1')
  const calls = vi.mocked(highlight).mock.calls.length
  await act(async () => root!.render(view(2)))
  expect(highlight).toHaveBeenCalledTimes(calls)
})

it('does not parse an unchanged transcript row during an unrelated parent update', async () => {
  const reuse = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const view = (value: number) => <div data-parent={value}><UserBubble item={row} workspaceId="w" onReuse={reuse} /></div>
  await act(async () => root!.render(view(1)))
  expect(parseMessageText).toHaveBeenCalledTimes(1)
  await act(async () => root!.render(view(2)))
  expect(parseMessageText).toHaveBeenCalledTimes(1)
})
