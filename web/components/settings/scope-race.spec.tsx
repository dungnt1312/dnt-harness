// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'
import { AgentsPanel, McpPanel, HooksPanel, SecretsPanel } from './ManagementPanels.tsx'
import { ProjectsPanel } from './ProjectsPanel.tsx'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('management scope isolation', () => {
  it.each(['agents', 'mcp', 'hooks', 'secrets'])('drops delayed A loads and clears drafts before B actions: %s', async kind => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
    const pending: (() => void)[] = []; const calls: string[] = []
    const data = (scope: string, url: string) => kind === 'agents' ? (url.includes('children') ? [] : [{ source: 'workspace', definition: { name: scope + '-agent', description: scope + ' description', tools: [], disallowedTools: [] } }]) : kind === 'mcp' ? [{ name: scope + '-server', transport: 'stdio', enabled: false, status: 'disabled', breakerOpenUntil: null }] : kind === 'hooks' ? { file: `/${scope}/settings.json`, hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${scope}.mjs` }] }] }, disableAllHooks: false, sources: [], effective: [], disabled: false, diagnostics: [] } : [{ name: scope + '_SECRET' }]
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calls.push(url)
      const scope = url.includes('/A/') ? 'A' : 'B'
      const response = { ok: true, json: async () => data(scope, url) }
      return scope === 'A' ? new Promise(resolve => pending.push(() => resolve(response))) : Promise.resolve(response)
    }))
    const panel = (workspaceId: string) => kind === 'agents' ? <AgentsPanel workspaceId={workspaceId} /> : kind === 'mcp' ? <McpPanel workspaceId={workspaceId} /> : kind === 'hooks' ? <HooksPanel workspaceId={workspaceId} /> : <SecretsPanel workspaceId={workspaceId} />
    try {
      await act(async () => root.render(panel('A')))
      await act(async () => root.render(panel('B')))
      await act(async () => pending.forEach(resolve => resolve()))
      expect(host.textContent).not.toContain('A-agent')
      expect(host.textContent).not.toContain('A-server')
      expect(host.textContent).not.toContain('A_SECRET')
      if (kind === 'hooks') {
        // The form-first editor reflects B through its raw JSON escape hatch.
        const advanced = [...host.querySelectorAll('button')].find(b => b.textContent === 'Edit raw JSON')
        await act(async () => advanced!.click())
        expect(host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')?.value).toContain('node B.mjs')
        expect(host.querySelector<HTMLTextAreaElement>('textarea.manage-code-tall')?.value).not.toContain('node A.mjs')
      }
      else expect(host.textContent).toContain(kind === 'agents' ? 'B-agent' : kind === 'mcp' ? 'B-server' : 'B_SECRET')
      const action = [...host.querySelectorAll('button')].find(b => b.textContent === 'Enable' || b.getAttribute('aria-label') === 'Delete B_SECRET')
      if (action) await act(async () => action.click())
      expect(calls.filter(url => url.includes('/B/')).every(url => !url.includes('A-server') && !url.includes('A_SECRET'))).toBe(true)
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
  })

  it('resets project drafts on A to B and ignores a late A completion before a B mutation', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
    let finishA!: () => void
    const requests: { readonly url: string; readonly method: string; readonly body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      requests.push({ url, method, body })
      const response = { ok: true, json: async () => ({ id: 'saved', workspaceId: url.includes('/A/') ? 'A' : 'B', name: 'saved', path: 'C:/saved', createdAt: 0 }) }
      return url.includes('/A/') ? new Promise(resolve => { finishA = () => resolve(response) }) : Promise.resolve(response)
    }))
    const changedA = vi.fn(async () => {})
    const changedB = vi.fn(async () => {})
    const projects = (scope: string) => [{ id: 'p', workspaceId: scope, name: `${scope} project`, path: `C:/${scope}`, createdAt: 0 }]
    const input = (label: string) => [...host.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === label)?.control as HTMLInputElement
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!
    const setValue = (element: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    try {
      await act(async () => root.render(<ProjectsPanel workspaceId="A" projects={projects('A')} onChanged={changedA} />))
      await act(async () => { setValue(input('Project name'), 'A draft'); setValue(input('Project folder'), 'C:/A/new') })
      await act(async () => button('Register project').click())
      expect(button('Registering…').disabled).toBe(true)

      await act(async () => root.render(<ProjectsPanel workspaceId="B" projects={projects('B')} onChanged={changedB} />))
      expect(input('Project name').value).toBe('')
      expect(input('Project folder').value).toBe('')
      expect(button('Register project').disabled).toBe(true)
      expect(host.textContent).not.toContain('Project registered')

      await act(async () => finishA())
      expect(host.textContent).not.toContain('Project registered')
      expect(changedA).not.toHaveBeenCalled()

      await act(async () => { setValue(input('Project folder'), 'C:/B/new'); button('Register project').click() })
      expect(requests.at(-1)).toMatchObject({ url: '/api/workspaces/B/projects', method: 'POST', body: { name: 'new', path: 'C:/B/new' } })
      await act(async () => {})
      expect(changedB).toHaveBeenCalledTimes(1)
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
  })
})
