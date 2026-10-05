// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MediaPreview } from './MediaPreview.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  projectMediaUrl: (_workspaceId: string, _projectId: string, path: string) => `/media?path=${encodeURIComponent(path)}`,
}))

vi.mock('../chat/ImageLightbox.tsx', () => ({
  ImageLightbox: ({ src, alt }: { readonly src: string | null; readonly alt: string }) =>
    src === null ? null : <div data-testid="lightbox">{alt}</div>,
}))

let host: HTMLDivElement

afterEach(() => {
  host?.remove()
})

async function mount(path: string): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  await act(async () => createRoot(host).render(<MediaPreview workspaceId="ws1" projectId="p1" path={path} />))
  return host
}

it('renders an image with a zoom affordance that opens the lightbox', async () => {
  const view = await mount('shots/01-admin-home.png')
  const image = view.querySelector('img')
  expect(image?.getAttribute('src')).toBe('/media?path=shots%2F01-admin-home.png')
  expect(image?.getAttribute('alt')).toBe('shots/01-admin-home.png')
  await act(async () => { image!.click() })
  expect(view.querySelector('[data-testid="lightbox"]')?.textContent).toBe('shots/01-admin-home.png')
})

it('renders audio and video players pointing at the media route', async () => {
  const audio = (await mount('artifacts/take.mp3')).querySelector('audio')
  expect(audio?.getAttribute('src')).toBe('/media?path=artifacts%2Ftake.mp3')
  expect(audio?.hasAttribute('controls')).toBe(true)
  const video = (await mount('artifacts/demo.mp4')).querySelector('video')
  expect(video?.getAttribute('src')).toBe('/media?path=artifacts%2Fdemo.mp4')
  expect(video?.hasAttribute('controls')).toBe(true)
})

it('says no preview for a binary it cannot render', async () => {
  const view = await mount('data/logo.bin')
  expect(view.textContent).toContain('no preview')
  expect(view.querySelector('img, audio, video')).toBeNull()
})

it('falls back to a note when the media fails to load', async () => {
  const view = await mount('shots/gone.png')
  await act(async () => { view.querySelector('img')!.dispatchEvent(new Event('error')) })
  expect(view.textContent).toContain('Could not load the media preview')
})
