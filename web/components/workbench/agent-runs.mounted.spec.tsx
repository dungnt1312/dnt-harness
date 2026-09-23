// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AgentRunsPanel } from './AgentRunsPanel.tsx'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const role = { source: 'workspace', definition: { name: 'explorer', description: 'reads', tools: ['Read'], disallowedTools: [] } }

/** Serve the panel's two reads; `children` is what the lifecycle returns. */
function stubApi(children: unknown[]): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url)
    return Promise.resolve({ ok: true, json: async () => (url.includes('/agents/children') ? children : [role]) })
  }))
  return { calls }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('agent runs panel, mounted', () => {
  it('offers the conversation’s model list for a child, defaulting to inherit', async () => {
    stubApi([])
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(
      <AgentRunsPanel workspaceId="ws-1" rootSessionId="root" modelOptions={[{ value: 'far:gpt-luna', label: 'far / gpt-luna' }]} />,
    ))
    // The picker lives in the packet details, which the disclosure mounts
    // only once it is open.
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Task packet details'))
    await act(async () => { details?.click() })
    expect(host.textContent).toContain('Inherit from this conversation')
    expect(host.textContent).toContain('inherits this conversation’s model unless you pick another')
    await act(async () => root.unmount())
  })

  it('shows each child’s model and flags one parked on an approval', async () => {
    stubApi([
      { childSessionId: 'child-1234567890abcd', status: 'running', definitionName: 'explorer', model: 'far:gpt-luna', startedAt: 1, awaitingApproval: true },
    ])
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />))
    expect(host.textContent).toContain('far:gpt-luna')
    expect(host.textContent).toContain('awaiting approval')
    await act(async () => root.unmount())
  })

  it('refetches children when the conversation itself delegates', async () => {
    const { calls } = stubApi([])
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" refreshSignal={0} />))
    const before = calls.filter((url) => url.includes('/agents/children')).length
    // A spawn the model made lands as child traffic in the root's log; the
    // panel must not wait for the running-child poll to notice it.
    await act(async () => root.render(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" refreshSignal={1} />))
    expect(calls.filter((url) => url.includes('/agents/children')).length).toBe(before + 1)
    await act(async () => root.unmount())
  })
})
