// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProcessLinkContext, ToolCard } from './MessageParts.tsx'
import type { ProcessLink } from './MessageParts.tsx'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  vi.restoreAllMocks()
})

const backgroundItem = (output: string): Extract<ViewItem, { kind: 'tool' }> => ({
  kind: 'tool',
  call: { id: 'c1', name: 'Bash', args: { command: 'pnpm dev', run_in_background: true } },
  result: { ok: true, output },
} as unknown as Extract<ViewItem, { kind: 'tool' }>)

const STARTED = 'background process started: id=proc_abc-1; read output with BashOutput; kill with KillShell'

async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}

it('a background Bash row carries a live Background status from the process link', async () => {
  const statuses = new Map([['proc_abc-1', { id: 'proc_abc-1', command: 'pnpm dev', status: 'running' as const, exitCode: null, startedAt: 0, durationMs: 0 }]])
  const open = vi.fn()
  const link: ProcessLink = { statuses, open }
  await render(<ProcessLinkContext.Provider value={link}><ToolCard item={backgroundItem(STARTED)} /></ProcessLinkContext.Provider>)
  expect(host.textContent).toContain('Background · running')
  // The jump to the workbench detail lives in the expanded body.
  const expander = host.querySelector<HTMLButtonElement>('button[aria-expanded]')
  expect(expander).not.toBeNull()
  await act(async () => expander!.click())
  const jumpButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('View process in workbench'))
  expect(jumpButton).toBeDefined()
  await act(async () => jumpButton!.click())
  expect(open).toHaveBeenCalledWith('proc_abc-1')
})

it('an ended process shows its termination; a foreign id degrades to plain Background', async () => {
  const statuses = new Map([['proc_abc-1', { id: 'proc_abc-1', command: 'pnpm dev', status: 'killed' as const, exitCode: 1, startedAt: 0, durationMs: 5 }]])
  await render(
    <ProcessLinkContext.Provider value={{ statuses, open: () => undefined }}>
      <ToolCard item={backgroundItem(STARTED)} />
    </ProcessLinkContext.Provider>,
  )
  expect(host.textContent).toContain('Background · killed')

  await act(async () => root!.render(<ToolCard item={backgroundItem(STARTED)} />))
  expect(host.textContent).toContain('Background')
  expect(host.textContent).not.toContain('Background ·')
})

it('a foreground Bash row shows no Background chip', async () => {
  const item = {
    kind: 'tool',
    call: { id: 'c2', name: 'Bash', args: { command: 'ls' } },
    result: { ok: true, output: 'file.txt\n[exit code: 0]' },
  } as unknown as Extract<ViewItem, { kind: 'tool' }>
  await render(<ToolCard item={item} />)
  expect(host.textContent).not.toContain('Background')
})
