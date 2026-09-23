// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const modalLoad = vi.fn()
vi.mock('./SettingsModal.tsx', () => { modalLoad(); return { SettingsModal: ({ open }: { open: boolean }) => <div>Settings loaded: {open ? 'open' : 'closed'}</div> } })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); modalLoad.mockClear() })
it('loads settings only when its panel first opens and keeps it available afterward', async () => {
  const { LazySettings } = await import('./LazySettings.tsx')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const props = { workspaceId: null, providers: [], activeProvider: '', onDismiss: () => {}, onRefresh: async () => {} }
  await act(async () => root!.render(<LazySettings open={false} {...props} />))
  expect(modalLoad).not.toHaveBeenCalled()
  await act(async () => root!.render(<LazySettings open {...props} />))
  expect(host.textContent).toContain('Settings loaded')
  expect(modalLoad).toHaveBeenCalledTimes(1)
  await act(async () => root!.render(<LazySettings open={false} {...props} />))
  expect(host.textContent).toContain('Settings loaded: closed')
  expect(modalLoad).toHaveBeenCalledTimes(1)
})
