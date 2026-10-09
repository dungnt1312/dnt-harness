// @vitest-environment jsdom
/** A GenerateImage row shows the stored image inline, not the tool's JSON. */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToolCard, describedImageOf, generatedImageOf } from '../components/chat/MessageParts.tsx'
import type { ViewItem } from './project.ts'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })

const ID = 'b'.repeat(64)
const item = (result?: { ok: boolean; output: string }): ToolItem => ({
  kind: 'tool', call: { id: 'c1', name: 'GenerateImage', args: { prompt: 'a cat on a sofa' } }, ts: 0, doneAt: 5,
  ...(result !== undefined ? { result } : {}),
})
const ok = item({ ok: true, output: JSON.stringify({ attachmentId: ID, mediaType: 'image/png', bytes: 10, model: 'm', revisedPrompt: 'a fluffy cat' }) })

async function mount(view: ToolItem, workspaceId: string | null = 'ws 1') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToolCard item={view} workspaceId={workspaceId} />))
}

describe('GenerateImage row', () => {
  it('reads the attachment id only from a successful, well-formed result', () => {
    expect(generatedImageOf(ok)).toEqual({ id: ID, revisedPrompt: 'a fluffy cat' })
    expect(generatedImageOf(item())).toBeNull()
    expect(generatedImageOf(item({ ok: false, output: 'Image generation is not configured.' }))).toBeNull()
    expect(generatedImageOf(item({ ok: true, output: '{"attachmentId":"../etc"}' }))).toBeNull()
  })

  it('renders the stored image under a row naming the prompt', async () => {
    await mount(ok)
    const image = host.querySelector('img')
    expect(image?.getAttribute('src')).toBe(`/api/workspaces/ws%201/attachments/${ID}`)
    expect(image?.getAttribute('alt')).toBe('a cat on a sofa')
    expect(host.textContent).toContain('Image')
    expect(host.textContent).toContain('a cat on a sofa')
    expect(host.textContent).not.toContain(ID)
  })

  it('renders an EditImage result the same way, named as an edit', async () => {
    const edited: ToolItem = {
      kind: 'tool', call: { id: 'c2', name: 'EditImage', args: { prompt: 'make it night', attachmentId: 'c'.repeat(64) } }, ts: 0, doneAt: 5,
      result: { ok: true, output: JSON.stringify({ attachmentId: ID, mediaType: 'image/png', bytes: 10, model: 'm', revisedPrompt: null, sourceAttachmentId: 'c'.repeat(64) }) },
    }
    expect(generatedImageOf(edited)).toEqual({ id: ID, revisedPrompt: null })
    await mount(edited)
    expect(host.querySelector('img')?.getAttribute('src')).toBe(`/api/workspaces/ws%201/attachments/${ID}`)
    expect(host.textContent).toContain('Edited image')
    expect(host.querySelector('[aria-label="Preview edited image"]')).not.toBeNull()
  })

  it('renders DescribeImage as markdown description instead of raw JSON', async () => {
    const described: ToolItem = {
      kind: 'tool', call: { id: 'c3', name: 'DescribeImage', args: { attachmentId: ID, question: 'What is shown?' } }, ts: 0, doneAt: 5,
      result: { ok: true, output: JSON.stringify({ description: '- A sidebar\n- **Settings** panel', model: 'gpt-4o', attachmentId: ID }) },
    }
    expect(describedImageOf(described)).toEqual({ description: '- A sidebar\n- **Settings** panel', model: 'gpt-4o' })
    await mount(described)
    expect(host.textContent).toContain('Describe image')
    expect(host.textContent).toContain('What is shown?')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')?.click())
    expect(host.textContent).toContain('Settings')
    expect(host.textContent).not.toContain('attachmentId')
  })

  it('shows a running row with no image, and a failure with its reason', async () => {
    await mount(item())
    expect(host.textContent).toContain('Generating image')
    expect(host.querySelector('img')).toBeNull()
    await act(async () => root!.unmount()); host.remove(); root = undefined

    await mount(item({ ok: false, output: 'Image generation is not configured.' }))
    expect(host.textContent).toContain('Failed')
    expect(host.querySelector('img')).toBeNull()
  })
})
