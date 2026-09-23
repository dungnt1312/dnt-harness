// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ArtifactsPanel } from './ArtifactsPanel.tsx'
import { projectArtifacts } from './artifact-projector.ts'
import type { SseEvent } from '../../lib/types.ts'

vi.mock('./artifact-projector.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./artifact-projector.ts')>()
  return { ...actual, projectArtifacts: vi.fn(actual.projectArtifacts) }
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
const events: SseEvent[] = [{ type: 'user/message', seq: 1, content: 'hello' }]
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.mocked(projectArtifacts).mockClear() })
it('does not reproject an unchanged artifact log on parent update', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ArtifactsPanel events={events} />))
  expect(projectArtifacts).toHaveBeenCalledTimes(1)
  await act(async () => root!.render(<ArtifactsPanel events={events} openPath={() => null} />))
  expect(projectArtifacts).toHaveBeenCalledTimes(1)
})
