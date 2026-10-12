// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addMarketplace, listMarketplaces, listPlugins, pluginAction, type PluginRowView } from '../../lib/api.ts'
import { PluginsPanel, componentSummary } from './PluginsPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  listPlugins: vi.fn(),
  listMarketplaces: vi.fn(),
  pluginAction: vi.fn(),
  addMarketplace: vi.fn(),
  updateMarketplace: vi.fn(),
  removeMarketplace: vi.fn(),
}))

const installed: PluginRowView = {
  id: 'toolkit@market', name: 'toolkit', marketplace: 'market', description: 'Everything', version: '1.2.0',
  installed: true, installedScopes: ['workspace'], enabled: { value: true, scope: 'workspace' }, active: true,
  components: { commands: 2, skills: 1, agents: 0, hooks: true, mcpServers: ['docs'] },
}
const fromUser: PluginRowView = {
  id: 'superpowers@claude-plugins-official', name: 'superpowers', marketplace: 'claude-plugins-official',
  installed: false, installedScopes: [], enabled: { value: true, scope: 'user' }, active: false,
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.mocked(listPlugins).mockResolvedValue({ plugins: [installed, fromUser], suggestedMarketplaces: {} })
  vi.mocked(listMarketplaces).mockResolvedValue({ marketplaces: [{
    name: 'market', source: { source: 'directory', path: '/m' }, lastUpdated: '2026-10-10',
    document: { name: 'market', plugins: [{ name: 'toolkit' }, { name: 'extra', description: 'More things', category: 'dev' }] },
  }] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async (projectId?: string): Promise<void> => {
  await act(async () => { root.render(<PluginsPanel workspaceId="ws" {...(projectId !== undefined ? { projectId } : {})} />) })
}
const button = (text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text))
  if (found === undefined) throw new Error(`no button '${text}'`)
  return found
}

describe('PluginsPanel', () => {
  it('summarizes what a plugin contributes', () => {
    expect(componentSummary(installed.components)).toBe('2 commands · 1 skill · hooks · MCP: docs')
    expect(componentSummary(undefined)).toBe('')
  })

  it('lists installed and user-enabled plugins, and only not-installed entries as available', async () => {
    await mount()
    const installedList = host.querySelector('[aria-label="Installed plugins"]')!.textContent ?? ''
    expect(installedList).toContain('toolkit@market')
    expect(installedList).toContain('active')
    expect(installedList).toContain('superpowers@claude-plugins-official')
    expect(installedList).toContain('not installed')
    expect(installedList).toContain('on · ~/.claude')
    const available = host.querySelector('[aria-label="Available plugins"]')!.textContent ?? ''
    expect(available).toContain('extra')
    expect(available).not.toContain('toolkit')
  })

  it('installs at the chosen scope and toggles enabledPlugins', async () => {
    vi.mocked(pluginAction).mockResolvedValue({ plugins: [installed] })
    await mount('proj')
    await act(async () => { button('Project').click() })
    const availableInstall = [...host.querySelectorAll('[aria-label="Available plugins"] button')].find((candidate) => candidate.textContent?.includes('Install')) as HTMLButtonElement
    await act(async () => { availableInstall.click() })
    expect(pluginAction).toHaveBeenCalledWith('ws', 'extra@market', 'install', 'project', 'proj')
    const toggle = host.querySelector('[aria-label="Enable toolkit@market in Project settings"]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    expect(pluginAction).toHaveBeenLastCalledWith('ws', 'toolkit@market', 'disable', 'project', 'proj')
  })

  it('adds a marketplace from owner/repo', async () => {
    vi.mocked(addMarketplace).mockResolvedValue({ name: 'claude-plugins-official', plugins: 315 })
    await mount()
    const input = host.querySelector('[aria-label="Marketplace source"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'anthropics/claude-plugins-official')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('Add').click() })
    expect(addMarketplace).toHaveBeenCalledWith('anthropics/claude-plugins-official')
    expect(host.textContent).toContain('Added claude-plugins-official (315 plugins)')
  })
})
