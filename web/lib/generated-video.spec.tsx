// @vitest-environment jsdom
/** A GenerateVideo row shows a player for the stored video, not the tool's JSON. */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToolCard, generatedVideoOf } from '../components/chat/MessageParts.tsx'
import type { ViewItem } from './project.ts'

type ToolItem = Extract<ViewItem, { kind: 'tool' }>
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined })

const ID = 'e'.repeat(64)
const item = (result?: { ok: boolean; output: string }, args: Record<string, unknown> = { prompt: 'a cat walking', seconds: '4', attachmentId: 'f'.repeat(64) }): ToolItem => ({
  kind: 'tool', call: { id: 'v1', name: 'GenerateVideo', args }, ts: 0, doneAt: 5,
  ...(result !== undefined ? { result } : {}),
})
const done = item({ ok: true, output: JSON.stringify({ videoId: ID, mediaType: 'video/mp4', bytes: 10, model: 'm', requestId: 'r', duration: 4, progress: 100 }) })

async function mount(view: ToolItem, workspaceId: string | null = 'ws 1') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToolCard item={view} workspaceId={workspaceId} />))
}

describe('GenerateVideo row', () => {
  it('reads the video id only from a successful, well-formed result', () => {
    expect(generatedVideoOf(done)).toEqual({ id: ID, duration: 4 })
    expect(generatedVideoOf(item())).toBeNull()
    expect(generatedVideoOf(item({ ok: false, output: 'Video generation is not configured.' }))).toBeNull()
    expect(generatedVideoOf(item({ ok: true, output: '{"videoId":"../etc"}' }))).toBeNull()
    expect(generatedVideoOf(item({ ok: true, output: 'not json' }))).toBeNull()
  })

  it('renders a controllable player pointing at the Range-capable video route', async () => {
    await mount(done)
    const video = host.querySelector('video')
    expect(video?.getAttribute('src')).toBe(`/api/workspaces/ws%201/videos/${ID}`)
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(video?.getAttribute('preload')).toBe('metadata')
    expect(video?.getAttribute('aria-label')).toBe('Generated video: a cat walking')
    expect(host.textContent).toContain('Video')
    expect(host.textContent).toContain('a cat walking')
    expect(host.textContent).toContain('4s')
    expect(host.textContent).not.toContain(ID)
  })

  it('names a reference image by role, not by its id', async () => {
    await mount(done)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')?.click())
    expect(host.textContent).toContain('reference image')
    expect(host.textContent).not.toContain('f'.repeat(64))
  })

  it('shows a labelled placeholder while the job runs, with no player', async () => {
    await mount(item())
    expect(host.textContent).toContain('Generating video')
    expect(host.querySelector('[role="status"][aria-label="Generating video"]')).not.toBeNull()
    expect(host.textContent).toContain('few minutes')
    expect(host.querySelector('video')).toBeNull()
  })

  it('shows a failure with its reason and no player', async () => {
    await mount(item({ ok: false, output: 'video generation failed: moderation blocked; request_id=r' }))
    expect(host.textContent).toContain('Failed')
    expect(host.querySelector('video')).toBeNull()
    expect(host.querySelector('[role="status"][aria-label="Generating video"]')).toBeNull()
  })

  it('swaps a player that cannot load for a note', async () => {
    await mount(done)
    await act(async () => { host.querySelector('video')!.dispatchEvent(new Event('error')) })
    expect(host.querySelector('video')).toBeNull()
    expect(host.querySelector('[role="note"]')?.textContent).toMatch(/Could not play this video/)
  })

  it('renders no player when the workspace is unknown', async () => {
    await mount(done, null)
    expect(host.querySelector('video')).toBeNull()
  })
})
