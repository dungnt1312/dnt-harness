// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AgentRunsPanel } from './AgentRunsPanel.tsx'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** Serve the children read; record every request. */
function stubApi(children: unknown[]): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    return Promise.resolve({ ok: true, json: async () => children })
  }))
  return { calls }
}

async function mount(element: React.ReactElement): Promise<{ host: HTMLDivElement; unmount: () => Promise<void> }> {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const section = (host: HTMLElement, name: string): HTMLElement => host.querySelector(`section[aria-label="${name}"]`)!

afterEach(() => { vi.unstubAllGlobals() })

describe('subagents panel', () => {
  it('manual chooser submits a plain alias, disables unusable aliases, supports direct models, and refreshes children', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let childrenReads = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) })
      const body = url === '/api/model-aliases'
        ? [{ name: 'fast', provider: 'far', model: 'gpt', thinkingLevel: null, revision: 1, status: 'valid', warnings: [] }, { name: 'broken', provider: 'gone', model: 'old', thinkingLevel: null, revision: 1, status: 'invalid', message: 'gone', warnings: [] }]
        : url === '/api/workspaces/ws-1/agents?projectId=project-root' ? [{ source: 'project', definition: { name: 'explorer', description: 'Explore', tools: [], disallowedTools: [], instructions: '' } }]
          : url.includes('/agents/children') ? (childrenReads++, [])
            : { childSessionId: 'child', status: 'running' }
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const { host, unmount } = await mount(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" rootProjectId="project-root" />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const role = host.querySelector<HTMLSelectElement>('select[aria-label="Subagent role"]')!
    const model = host.querySelector<HTMLSelectElement>('select[aria-label="Subagent model"]')!
    expect(role.value).toBe('explorer')
    expect(calls.some((call) => call.url === '/api/workspaces/ws-1/agents?projectId=project-root')).toBe(true)
    expect(model.options[0]?.textContent).toBe('Use role default / conversation fallback')
    expect([...model.options].find((option) => option.value === 'broken')?.disabled).toBe(true)
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(model, 'fast'); model.dispatchEvent(new Event('change', { bubbles: true })) })
    const brief = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Subagent brief"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(brief, 'Do it'); brief.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { host.querySelector<HTMLFormElement>('form[aria-label="Spawn subagent"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
    const spawn = calls.find((call) => call.init?.method === 'POST' && call.url.includes('/agents/explorer'))!
    expect(JSON.parse(String(spawn.init?.body))).toMatchObject({ rootSessionId: 'root', model: 'fast', task: { prompt: 'Do it' } })
    expect(childrenReads).toBeGreaterThan(1)

    const direct = host.querySelector<HTMLInputElement>('input[aria-label="Direct subagent model"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(direct, 'far:gpt'); direct.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Direct subagent model"]')!.value).toBe('far:gpt')
    await unmount()
  })
  it('splits running from ended, newest ended first, titled by the brief', async () => {
    stubApi([
      { childSessionId: 'old', status: 'completed', definitionName: 'explorer', startedAt: 1, endedAt: 2, result: { report: '## Verified findings\n1. first', filesTouched: [] } },
      { childSessionId: 'run', status: 'running', definitionName: 'reviewer', model: 'far:gpt-luna', startedAt: 5 },
      { childSessionId: 'new', status: 'failed', definitionName: 'explorer', startedAt: 3, endedAt: 4, error: 'the child did not complete (failed); its full log is session new' },
    ])
    const briefs = new Map([['old', 'Audit session state leakage\nlong details'], ['run', 'Explore delegation terminal']])
    const { host, unmount } = await mount(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" briefs={briefs} />)

    const running = section(host, 'Active subagents')
    expect(running.textContent).toContain('Active · 1')
    expect(running.textContent).toContain('Explore delegation terminal')
    expect(running.textContent).toContain('reviewer · far:gpt-luna')

    const ended = section(host, 'Ended subagents')
    expect(ended.textContent).toContain('Ended · 2')
    const titles = [...ended.querySelectorAll('li')].map((item) => item.textContent ?? '')
    // Newest ended first; a child with no brief falls back to its role.
    expect(titles[0]).toContain('explorer')
    expect(titles[0]).toContain('Failed')
    expect(titles[0]).toContain('the child did not complete')
    // Only the brief's first line is the title, and the report's first line is the preview.
    expect(titles[1]).toContain('Audit session state leakage')
    expect(titles[1]).not.toContain('long details')
    expect(titles[1]).toContain('Verified findings')
    expect(titles[1]).not.toContain('##')
    await unmount()
  })

  it('shows empty states for both groups', async () => {
    stubApi([])
    const { host, unmount } = await mount(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />)
    expect(host.textContent).toContain('No active subagents')
    expect(host.textContent).toContain('No ended subagents')
    expect(host.querySelector('textarea[aria-label="Subagent brief"]')).not.toBeNull()
    expect(host.textContent).toContain('Spawn subagent')
    await unmount()
  })

  it('opens the child conversation from its row', async () => {
    stubApi([{ childSessionId: 'child-1', status: 'completed', definitionName: 'explorer', startedAt: 1, endedAt: 2, result: { report: 'done', filesTouched: [] } }])
    const opened: string[] = []
    const { host, unmount } = await mount(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" onOpenChild={(id) => opened.push(id)} />)
    await act(async () => section(host, 'Ended subagents').querySelector('button')!.click())
    expect(opened).toEqual(['child-1'])
    await unmount()
  })

  it('flags a child parked on an approval and lets it be stopped', async () => {
    const { calls } = stubApi([{ childSessionId: 'child-2', status: 'running', definitionName: 'explorer', startedAt: 1, awaitingApproval: true }])
    const { host, unmount } = await mount(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />)
    expect(host.textContent).toContain('Waiting for your approval')
    const stop = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Stop')!
    await act(async () => stop.click())
    expect(calls).toContain('POST /api/workspaces/ws-1/sessions/root/children/child-2/cancel')
    await unmount()
  })

  it('keeps an uncertain child with the running ones and offers Retry settlement', async () => {
    const calls: string[] = []
    let reads = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = init?.method === 'POST'
        ? { childSessionId: 'child-u', status: 'completed', definitionName: 'explorer', startedAt: 1 }
        : reads++ === 0
          ? [{ childSessionId: 'child-u', status: 'uncertain', definitionName: 'explorer', startedAt: 1, error: 'canonical reconciliation is pending' }]
          : [{ childSessionId: 'child-u', status: 'completed', definitionName: 'explorer', startedAt: 1, endedAt: 2, result: { report: 'settled', filesTouched: [] } }]
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const { host, unmount } = await mount(<AgentRunsPanel workspaceId="ws-1" rootSessionId="root" />)
    expect(section(host, 'Active subagents').textContent).toContain('Reconciling')
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Stop')).toBe(false)
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry settlement')!
    await act(async () => retry.click())
    expect(calls).toContain('POST /api/workspaces/ws-1/sessions/root/children/child-u/reconcile')
    expect(section(host, 'Ended subagents').textContent).toContain('settled')
    await unmount()
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
