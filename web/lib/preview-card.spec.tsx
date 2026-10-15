// @vitest-environment jsdom
/** A SendPreview row shows the image or the chart inline, not the tool's JSON. */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToolCard, previewOf } from '../components/chat/MessageParts.tsx'
import type { ViewItem } from './project.ts'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })

const ID = 'b'.repeat(64)
const chart = { type: 'bar', labels: ['Mon', 'Tue'], series: [{ name: 'hits', values: [3, 5] }, { name: 'miss', values: [1, 0] }] }
const item = (output?: unknown, ok = true): ToolItem => ({
  kind: 'tool', call: { id: 'p1', name: 'SendPreview', args: {} }, ts: 0, doneAt: 5,
  ...(output !== undefined ? { result: { ok, output: typeof output === 'string' ? output : JSON.stringify(output) } } : {}),
})

async function mount(view: ToolItem, workspaceId: string | null = 'ws 1') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToolCard item={view} workspaceId={workspaceId} />))
}

describe('SendPreview row', () => {
  it('reads a preview only from a successful, well-formed result', () => {
    expect(previewOf(item({ kind: 'image', attachmentId: ID, title: 'Shot' }))).toMatchObject({ kind: 'image', id: ID, title: 'Shot' })
    expect(previewOf(item({ kind: 'chart', chart }))).toMatchObject({ kind: 'chart' })
    expect(previewOf(item())).toBeNull()
    expect(previewOf(item('boom', false))).toBeNull()
    expect(previewOf(item({ kind: 'image', attachmentId: '../etc' }))).toBeNull()
    expect(previewOf(item({ kind: 'chart', chart: { ...chart, series: [{ name: 'x', values: ['1', 2] }] } }))).toBeNull()
    expect(previewOf(item({ kind: 'chart', chart: { ...chart, series: [{ name: 'x', values: [1] }] } }))).toBeNull()
    expect(previewOf(item({ kind: 'video' }))).toBeNull()
  })

  it('renders an image from the attachment store with its title and caption', async () => {
    await mount(item({ kind: 'image', attachmentId: ID, title: 'Login page', caption: 'after the fix' }))
    expect(host.querySelector('img')?.getAttribute('src')).toBe(`/api/workspaces/ws%201/attachments/${ID}`)
    expect(host.textContent).toContain('Login page')
    expect(host.textContent).toContain('after the fix')
    expect(host.textContent).not.toContain(ID)
  })

  it('draws a chart as SVG with one bar per value and a readable data table', async () => {
    await mount(item({ kind: 'chart', chart, title: 'Traffic' }))
    const svg = host.querySelector('svg[role="img"]')
    expect(svg?.getAttribute('aria-label')).toContain('Traffic')
    expect(host.querySelectorAll('svg rect[data-bar]')).toHaveLength(4)
    expect(host.querySelector('table')).not.toBeNull()
    expect(host.textContent).toContain('Mon')
    expect(host.textContent).toContain('hits')
  })

  it('draws a line chart as one polyline per series', async () => {
    await mount(item({ kind: 'chart', chart: { ...chart, type: 'line' } }))
    expect(host.querySelectorAll('svg polyline')).toHaveLength(2)
  })

  it('never renders model text as markup', async () => {
    await mount(item({ kind: 'chart', chart: { ...chart, labels: ['<img src=x onerror=1>', 'b'] }, caption: '<b>bold</b>' }))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('b')).toBeNull()
  })

  it('shows a failure with its reason and no preview', async () => {
    await mount(item('give exactly one of', false))
    expect(host.textContent).toContain('Failed')
    expect(host.querySelector('img, svg[role="img"]')).toBeNull()
  })
})
