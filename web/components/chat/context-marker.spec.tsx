// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextMarker } from './MessageParts.tsx'
import type { ContextManifestView } from '../../lib/types.ts'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

const MANIFEST: ContextManifestView = {
  modeId: 'default',
  modeRevision: 2,
  model: 'gpt-x',
  budget: { availableTokens: 994_880, usedTokens: 18_400, contextLimitTokens: 1_000_000, estimated: true },
  breakdown: { systemPrompt: 1_200, systemTools: 6_000, mcpTools: 0, metaContext: 1_200, skills: 2_000, messages: 8_000 },
  history: { setting: 'recent', includedTurns: 1, omittedTurns: 0, includedSeqRange: [1, 9] },
  sources: {
    skills: ['alpha@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    memory: ['mem-1@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    toolNames: ['Read', 'Glob', 'Grep'],
    toolSchemas: 6,
  },
  omissions: ['memory: dropped for budget'],
}

const item = { kind: 'context', ts: 1_700_000_000_000, manifest: MANIFEST } as Extract<ViewItem, { kind: 'context' }>

async function openMarker(contextItem: ViewItem & { kind: 'context' }, expand: boolean): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ContextMarker item={contextItem} workspaceId="ws-1" sessionId="s-1" />))
  if (expand) {
    const trigger = host.querySelector<HTMLButtonElement>('button')!
    await act(async () => trigger.click())
  }
  return host
}

it('the collapsed line names the size and the per-request facts', async () => {
  const view = await openMarker(item, false)
  expect(view.textContent).toContain('Context')
  expect(view.textContent).toContain('18.4k tok est')
  expect(view.textContent).toContain('1 turn')
  expect(view.textContent).toContain('1 skill')
  expect(view.textContent).toContain('1 mem')
  expect(view.textContent).toContain('1 omitted')
  expect(view.textContent).toContain('gpt-x')
  expect(view.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
})

it('the collapsed line drops the model fact when the manifest has none', async () => {
  const { model: _omitted, ...noModel } = MANIFEST
  void _omitted
  const view = await openMarker({ ...item, manifest: noModel } as Extract<ViewItem, { kind: 'context' }>, false)
  expect(view.textContent).not.toContain('gpt-x')
})

it('expanding reveals the manifest: window, mode, history, sources, omissions', async () => {
  const view = await openMarker(item, true)
  expect(view.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
  expect(view.textContent).toContain('18.4k/1M tok')
  expect(view.textContent).toContain('est')
  expect(view.textContent).toContain('default')
  expect(view.textContent).toContain('rev 2')
  expect(view.textContent).toContain('gpt-x')
  expect(view.textContent).toContain('recent: 1 included, 0 omitted')
  expect(view.textContent).toContain('seq 1–9')
  expect(view.textContent).toContain('Read')
  expect(view.textContent).toContain('6 schemas')
  expect(view.textContent).toContain('alpha@aaaaaaaaaaaa')
  expect(view.textContent).toContain('mem-1@bbbbbbbbbbbb')
  expect(view.textContent).toContain('memory: dropped for budget')
})

it('a clean request shows no omission line and no pinned source chips', async () => {
  const clean: ContextManifestView = {
    ...MANIFEST,
    sources: { ...MANIFEST.sources, skills: [], memory: [] },
    omissions: [],
  }
  const view = await openMarker({ ...item, manifest: clean } as Extract<ViewItem, { kind: 'context' }>, true)
  expect(view.textContent).not.toContain('omitted:')
  expect(view.textContent).not.toContain('alpha@aaaaaaaaaaaa')
  expect(view.textContent).not.toContain('mem-1@bbbbbbbbbbbb')
})

it('a multi-request turn says how many requests it folded', async () => {
  const view = await openMarker({ ...item, requests: 3 } as Extract<ViewItem, { kind: 'context' }>, true)
  expect(view.textContent).toContain('3 requests')
  expect(view.textContent).toContain('3 this turn — this is the latest')
  await act(async () => root!.unmount())
  root = undefined
  host.remove()
  const shut = await openMarker({ kind: 'context', manifest: { ...MANIFEST }, requests: 2 } as Extract<ViewItem, { kind: 'context' }>, false)
  expect(shut.textContent).toContain('2 requests')
  expect(shut.textContent).not.toContain('this is the latest')
})

const SYSTEM_HASH = 'c'.repeat(64)
const SECTION_MANIFEST: ContextManifestView = {
  ...MANIFEST,
  sections: [
    { kind: 'system', hash: SYSTEM_HASH, chars: 44 },
    { kind: 'skill', name: 'alpha', hash: 'd'.repeat(64), chars: 30 },
  ],
}

it('expanding lists the raw blocks and clicking one fetches its exact text', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ kind: 'system', hash: SYSTEM_HASH, chars: 44, body: 'You are dnt-harness, a local coding assistant.' }),
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    const view = await openMarker({ ...item, manifest: SECTION_MANIFEST } as Extract<ViewItem, { kind: 'context' }>, true)
    expect(view.textContent).toContain('system block')
    expect(view.textContent).toContain('skill · alpha')
    const systemButton = [...view.querySelectorAll('button')].find((button) => button.textContent?.includes('system block'))!
    await act(async () => systemButton.click())
    // The body fetch resolves through several microtask hops; a macrotask
    // lets the whole chain settle before asserting.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(view.querySelector('pre')?.textContent).toContain('You are dnt-harness, a local coding assistant.')
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(calledUrl).toContain(`/context/${SYSTEM_HASH}`)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('a block the server never recorded says so instead of failing silently', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({ error: 'no context body recorded for this hash' }),
    text: async () => JSON.stringify({ error: 'no context body recorded for this hash' }),
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    const view = await openMarker({ ...item, manifest: SECTION_MANIFEST } as Extract<ViewItem, { kind: 'context' }>, true)
    const systemButton = [...view.querySelectorAll('button')].find((button) => button.textContent?.includes('system block'))!
    await act(async () => systemButton.click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(view.textContent).toContain('Not recorded')
    expect(view.querySelector('pre')).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})
