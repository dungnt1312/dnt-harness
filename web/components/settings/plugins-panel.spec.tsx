// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addMarketplace, listMarketplaces, listPlugins, pluginAction, pluginDetails, type PluginRowView } from '../../lib/api.ts'
import { PluginsPanel, componentSummary } from './PluginsPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  listPlugins: vi.fn(),
  pluginDetails: vi.fn(),
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
const tab = async (name: string): Promise<void> => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Plugins view"] [role="tab"]')].find((node) => node.textContent?.startsWith(name))
  if (found === undefined) throw new Error(`no tab '${name}'`)
  await act(async () => { found.click() })
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
    expect(installedList).toContain('toolkit')
    expect(installedList).toContain('@market')
    expect(installedList).toContain('On')
    expect(installedList).toContain('superpowers')
    expect(installedList).toContain('Not installed')
    expect(installedList).toContain('Enabled in ~/.claude settings')
    await tab('Browse')
    const available = host.querySelector('[aria-label="Available plugins"]')!.textContent ?? ''
    expect(available).toContain('extra')
    expect(available).not.toContain('toolkit')
  })

  it('installs at the chosen scope and toggles enabledPlugins', async () => {
    vi.mocked(pluginAction).mockResolvedValue({ plugins: [installed] })
    await mount('proj')
    await act(async () => { button('Project').click() })
    await tab('Browse')
    const availableInstall = [...host.querySelectorAll('[aria-label="Available plugins"] button')].find((candidate) => candidate.textContent?.includes('Install')) as HTMLButtonElement
    await act(async () => { availableInstall.click() })
    expect(pluginAction).toHaveBeenCalledWith('ws', 'extra@market', 'install', 'project', 'proj')
    await tab('Installed')
    const toggle = host.querySelector('[aria-label="Enable toolkit@market in Project settings"]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    expect(pluginAction).toHaveBeenLastCalledWith('ws', 'toolkit@market', 'disable', 'project', 'proj')
  })

  it('adds a marketplace from owner/repo', async () => {
    vi.mocked(addMarketplace).mockResolvedValue({ name: 'claude-plugins-official', plugins: 315 })
    await mount()
    await tab('Marketplaces')
    const input = host.querySelector('[aria-label="Marketplace source"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'anthropics/claude-plugins-official')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { (host.querySelector('form button[type="submit"]') as HTMLButtonElement).click() })
    expect(addMarketplace).toHaveBeenCalledWith('anthropics/claude-plugins-official')
    expect(host.textContent).toContain('Added claude-plugins-official (315 plugins)')
  })

  it('offers the official marketplace with one click until it is added', async () => {
    vi.mocked(addMarketplace).mockResolvedValue({ name: 'claude-plugins-official', plugins: 315 })
    await mount()
    await tab('Marketplaces')
    const recommended = host.querySelector('[aria-label="Recommended marketplaces"]')!
    expect(recommended.textContent).toContain('claude-plugins-official')
    await act(async () => { (recommended.querySelector('button') as HTMLButtonElement).click() })
    expect(addMarketplace).toHaveBeenCalledWith('anthropics/claude-plugins-official')
    expect(host.textContent).toContain('Added claude-plugins-official (315 plugins)')
  })

  it('tabs available plugins by marketplace and filters by category', async () => {
    vi.mocked(listMarketplaces).mockResolvedValue({ marketplaces: [
      { name: 'market', source: { source: 'directory', path: '/m' }, lastUpdated: 'x', document: { name: 'market', plugins: [{ name: 'extra', category: 'dev' }, { name: 'lint', category: 'dev' }, { name: 'audit', category: 'security' }] } },
      { name: 'mine', source: { source: 'github', repo: 'me/mine' }, lastUpdated: 'x', document: { name: 'mine', plugins: [{ name: 'solo' }] } },
    ] })
    await mount()
    await tab('Browse')
    const chips = [...host.querySelectorAll('[aria-label="Marketplace"] button')].map((chip) => chip.textContent)
    expect(chips).toEqual(['All marketplaces4', 'market3', 'mine1'])
    const names = (): string[] => [...host.querySelectorAll('[aria-label="Available plugins"] li .break-all')].map((node) => node.textContent ?? '')
    expect(names()).toEqual(['extra', 'lint', 'audit', 'solo'])
    const market = (label: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Marketplace"] button')].find((node) => node.textContent?.startsWith(label))!
    await act(async () => { market('mine').click() })
    expect(names()).toEqual(['solo'])
    await act(async () => { market('market').click() })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Category"] button')].find((chip) => chip.textContent?.startsWith('security'))!.click() })
    expect(names()).toEqual(['audit'])
  })

  it('opens plugin details showing what it contains', async () => {
    vi.mocked(pluginDetails).mockResolvedValue({
      id: 'extra@market', name: 'extra', marketplace: 'market', description: 'More things', author: 'Ann',
      source: { kind: 'github', location: 'ann/extra' },
      commands: [{ name: 'extra:go', description: 'Go' }], skills: [{ name: 'extra:think' }], agents: [],
      hooks: ['SessionStart'], mcpServers: [{ name: 'db', type: 'stdio' }], notes: [],
    })
    await mount()
    await tab('Browse')
    await act(async () => { (host.querySelector('[aria-label="Details for extra@market"]') as HTMLButtonElement).click() })
    expect(pluginDetails).toHaveBeenCalledWith('ws', 'extra@market', undefined)
    const dialog = document.body.querySelector('[role="dialog"]')!
    for (const text of ['/extra:go', 'extra:think', 'SessionStart', 'db', 'ann/extra', 'Ann']) expect(dialog.textContent).toContain(text)
  })

  it('hides the recommendation once the official marketplace is present', async () => {
    vi.mocked(listMarketplaces).mockResolvedValue({ marketplaces: [{
      name: 'claude-plugins-official', source: { source: 'github', repo: 'anthropics/claude-plugins-official' }, lastUpdated: '2026-10-12',
      document: { name: 'claude-plugins-official', plugins: [] },
    }] })
    await mount()
    await tab('Marketplaces')
    expect(host.querySelector('[aria-label="Recommended marketplaces"]')).toBeNull()
  })
})
