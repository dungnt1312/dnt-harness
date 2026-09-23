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

  it('shows a child’s final report, a visible truncation, and an honest no-result error', async () => {
    stubApi([
      { childSessionId: 'child-aaaaaaaaaaaaaa', status: 'completed', definitionName: 'explorer', startedAt: 1, result: { report: 'Answer: the router.\n… [truncated 42 chars]', filesTouched: ['src/a.ts'], truncated: true } },
      { childSessionId: 'child-bbbbbbbbbbbbbb', status: 'cancelled', definitionName: 'explorer', startedAt: 2, error: 'the child did not complete (cancelled); its full log is session child-bbbbbbbbbbbbbb' },
    ])
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />))
    expect(host.textContent).toContain('Answer: the router.')
    expect(host.textContent).toContain('Report truncated')
    expect(host.textContent).toContain('Files touched: src/a.ts')
    expect(host.textContent).toContain('its full log is session child-bbbbbbbbbbbbbb')
    expect(host.textContent).not.toContain('undefined')
    await act(async () => root.unmount())
  })

  it('spawns from a prose brief, and still sends the structured packet on its own', async () => {
    const posts: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') posts.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>)
      const body = url.includes('/agents/children') ? [] : init?.method === 'POST' ? { childSessionId: 'child-new-000000000', definitionName: 'explorer', status: 'running', startedAt: 0 } : [role]
      return Promise.resolve({ ok: true, status: 202, json: async () => body })
    }))
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />))
    const spawnButton = (): HTMLButtonElement => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Spawn agent'))!
    const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    expect(spawnButton().disabled).toBe(true)

    await act(async () => setValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!, 'Find the slow build step in vite.config.ts.'))
    expect(spawnButton().disabled).toBe(false)
    await act(async () => spawnButton().click())
    expect(posts[0]?.['task']).toEqual({ prompt: 'Find the slow build step in vite.config.ts.', requiredResult: 'bounded summary with file references' })
    expect(posts[0]).not.toHaveProperty('inherit')

    const details = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Task packet details'))
    await act(async () => { details?.click() })
    const objective = [...host.querySelectorAll<HTMLInputElement>('input')].find((input) => input.placeholder === 'Investigate why the build is slow')!
    await act(async () => setValue(objective, 'Investigate the build'))
    await act(async () => spawnButton().click())
    expect(posts[1]?.['task']).toEqual({ objective: 'Investigate the build', constraints: [], references: [], requiredResult: 'bounded summary with file references' })
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
