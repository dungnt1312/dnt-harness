// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceSources, putWorkspaceSources } from '../../lib/api.ts'
import type { ResourceSourcesDoc, WorkspaceSourcesRow } from '../../lib/types.ts'
import { SourcesPanel } from './SourcesPanel.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../lib/api.ts', () => ({
  getWorkspaceSources: vi.fn(),
  putWorkspaceSources: vi.fn(),
}))

const mocked = vi.mocked({ getWorkspaceSources, putWorkspaceSources })

const baseDoc: ResourceSourcesDoc = {
  v: 1,
  skills: { rules: [
    { id: 'project-claude', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'project-agents', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'workspace', kind: 'workspace', enabled: true },
    { id: 'user', kind: 'absolute', path: '~/.claude/skills', enabled: true },
  ] },
  disabled: { skills: [], agents: [], hooks: [], commands: [] },
}

const layer = (id: string, label: string, path: string, available = true) => ({ id, label, path, available })
/** The same shape the server describes: every switchable layer of every kind. */
const layers: WorkspaceSourcesRow['layers'] = {
  skills: [layer('plugin', 'Plugins', "Enabled plugins' skills"), layer('bundled', 'Bundled', 'Shipped with the app')],
  agents: [
    layer('bundled', 'Bundled', 'Built-in roles'),
    layer('user', 'User', '/home/x/.claude/agents'),
    layer('plugin', 'Plugins', "Enabled plugins' agents"),
    layer('workspace', 'Workspace', '/data/ws/agents'),
    layer('project', 'Project', '<project>/.claude/agents'),
  ],
  hooks: [
    layer('user', 'User', '/home/x/.claude/settings.json'),
    layer('plugin', 'Plugins', "Enabled plugins' hooks"),
    layer('workspace', 'Workspace', '/data/ws/settings.json'),
    layer('project', 'Project', '<project>/.claude/settings.json'),
    layer('local', 'Project local', '<project>/.claude/settings.local.json'),
  ],
  commands: [
    layer('bundled', 'Bundled', 'Shipped with the app', false),
    layer('user', 'User', '/home/x/.claude/commands'),
    layer('plugin', 'Plugins', "Enabled plugins' commands"),
    layer('workspace', 'Workspace', '/data/ws/commands'),
    layer('project', 'Project', '<project>/.claude/commands (and ancestors)'),
  ],
}
const row = (doc: ResourceSourcesDoc = baseDoc, hash = 'h1', extra: Partial<WorkspaceSourcesRow> = {}): WorkspaceSourcesRow => ({ doc, hash, layers, ...extra })

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  mocked.getWorkspaceSources.mockReset()
  mocked.putWorkspaceSources.mockReset()
  mocked.getWorkspaceSources.mockResolvedValue(row())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
// Each test opens at most one row menu: opening a second one right after
// choosing an item in the first is flaky under jsdom (see the commit that
// added the 20 ms wait), and nothing here needs the chain.
const render = async (onChanged?: () => void): Promise<void> => {
  await act(async () => root!.render(<SourcesPanel workspaceId="ws-1" {...(onChanged !== undefined ? { onChanged } : {})} />))
  await settle()
}
const tabs = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Source layers"] [role="tab"]')]
const tabNamed = (name: string): HTMLButtonElement => {
  const found = tabs().find((node) => node.textContent?.startsWith(name))
  if (found === undefined) throw new Error(`no tab "${name}"`)
  return found
}
const openTab = async (name: string): Promise<void> => { await act(async () => tabNamed(name).click()); await settle() }
const sw = (label: string): HTMLButtonElement => {
  const found = document.body.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)
  if (found === null) throw new Error(`no switch "${label}"`)
  return found
}
const button = (name: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
const menuItem = (name: string): HTMLButtonElement => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === name)!
const listText = (): string => document.body.querySelector('ul[aria-label$=" layer"]')?.textContent ?? ''

describe('SourcesPanel layout', () => {
  it('has one tab per layer, highest precedence first, each with its row count', async () => {
    await render()
    expect(tabs().map((node) => node.textContent)).toEqual(['Project6', 'Workspace4', 'Plugins4', 'User4', 'Bundled3'])
    expect(tabNamed('Project').getAttribute('aria-selected')).toBe('true')
  })

  it('shows only the open layer: project rows, with the local hooks file grouped under Project', async () => {
    await render()
    const text = listText()
    for (const expected of ['.claude/skills', '.agents/skills', '<project>/.claude/agents', '<project>/.claude/settings.json', '<project>/.claude/settings.local.json', '<project>/.claude/commands']) {
      expect(text).toContain(expected)
    }
    for (const other of ['/home/x/.claude/agents', '/data/ws/agents', 'Shipped with the app', "Enabled plugins'"]) expect(text).not.toContain(other)
  })

  it('every other tab lists exactly its own rows', async () => {
    await render()
    await openTab('Workspace')
    expect(listText()).toContain('Workspace skills')
    expect(listText()).toContain('/data/ws/agents')
    expect(listText()).toContain('/data/ws/settings.json')
    expect(listText()).toContain('/data/ws/commands')
    await openTab('Plugins')
    for (const kind of ['skills', 'agents', 'hooks', 'commands']) expect(listText()).toContain(`Enabled plugins' ${kind}`)
    await openTab('User')
    expect(listText()).toContain('~/.claude/skills')
    expect(listText()).toContain('/home/x/.claude/commands')
    await openTab('Bundled')
    expect(listText()).toContain('Built-in roles')
    expect(listText()).not.toContain('settings.json')
  })

  it('gives each resource kind its own colour, the same in the legend and in every row', async () => {
    await render()
    const toneOf = new Map([['Skills', 'text-tool-search'], ['Agents', 'text-tool-agent'], ['Hooks', 'text-warn'], ['Commands', 'text-tool-ext']])
    const badges = (scope: ParentNode, kind: string): HTMLElement[] =>
      [...scope.querySelectorAll<HTMLElement>('span')].filter((node) => node.textContent === kind && node.className.includes('rounded-full'))
    const legend = document.body.querySelector('ul[aria-label="Resource kinds"]')!
    const rows = document.body.querySelector('ul[aria-label="Project layer"]')!
    for (const [kind, tone] of toneOf) {
      expect(badges(legend, kind), `legend ${kind}`).toHaveLength(1)
      expect(badges(legend, kind)[0]!.className).toContain(tone)
      expect(badges(rows, kind).length, `row ${kind}`).toBeGreaterThan(0)
      for (const badge of badges(rows, kind)) expect(badge.className).toContain(tone)
    }
    // Four distinct colours: nothing is told apart by position alone.
    expect(new Set(toneOf.values()).size).toBe(4)
  })

  it('an off layer is dimmed and says so; its kind badge keeps its colour', async () => {
    await render()
    await openTab('User')
    await act(async () => sw('Agents: User layer').click())
    expect(listText()).toContain('Off — not read in this workspace.')
    const dimmed = [...document.body.querySelectorAll<HTMLElement>('ul[aria-label="User layer"] span')].find((node) => node.textContent === 'Agents')!
    expect(dimmed.className).toContain('opacity-50')
    expect(dimmed.className).toContain('text-tool-agent')
  })
})

describe('SourcesPanel editing', () => {
  it('a layer switch only edits the draft; Save sends the whole document with the loaded hash', async () => {
    const onChanged = vi.fn()
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render(onChanged)
    await openTab('User')
    await act(async () => sw('Agents: User layer').click())
    expect(mocked.putWorkspaceSources).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Unsaved changes')

    await act(async () => button('Save changes').click())
    await settle()
    expect(mocked.putWorkspaceSources).toHaveBeenCalledTimes(1)
    const [ws, doc, hash] = mocked.putWorkspaceSources.mock.calls[0]!
    expect(ws).toBe('ws-1')
    expect(hash).toBe('h1')
    expect(doc.disabled).toEqual({ skills: [], agents: ['user'], hooks: [], commands: [] })
    expect(doc.skills.rules).toEqual(baseDoc.skills.rules)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('All changes saved')
  })

  it('the draft survives switching tabs, and the open tab is not reset by Save', async () => {
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    await openTab('User')
    await act(async () => sw('Hooks: User layer').click())
    await openTab('Bundled')
    await openTab('User')
    expect(sw('Hooks: User layer').getAttribute('aria-checked')).toBe('false')
    await act(async () => button('Save changes').click())
    await settle()
    expect(tabNamed('User').getAttribute('aria-selected')).toBe('true')
  })

  it('switching a layer back on and Discard both return to a clean draft', async () => {
    await render()
    await openTab('User')
    await act(async () => sw('Hooks: User layer').click())
    expect(button('Save changes').disabled).toBe(false)
    await act(async () => sw('Hooks: User layer').click())
    expect(button('Save changes').disabled).toBe(true)

    await act(async () => sw('Commands: User layer').click())
    await act(async () => button('Discard').click())
    expect(button('Save changes').disabled).toBe(true)
    expect(sw('Commands: User layer').getAttribute('aria-checked')).toBe('true')
  })

  it('a layer the host does not have is shown but cannot be switched', async () => {
    await render()
    await openTab('Bundled')
    expect(sw('Commands: Bundled layer').disabled).toBe(true)
    expect(listText()).toContain('Not available on this host.')
  })

  it('local hooks sit under Project and switch on their own key', async () => {
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    await act(async () => sw('Hooks: Project local layer').click())
    await act(async () => button('Save changes').click())
    await settle()
    expect(mocked.putWorkspaceSources.mock.calls[0]![1].disabled.hooks).toEqual(['local'])
  })

  it('skill rules: toggle and reorder in the Project tab stay in the draft until Save', async () => {
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    await act(async () => sw('Enable .agents/skills').click())
    await act(async () => button('More actions for .agents/skills').click())
    await act(async () => menuItem('Move up').click())
    expect(mocked.putWorkspaceSources).not.toHaveBeenCalled()
    await act(async () => button('Save changes').click())
    await settle()
    const rules = mocked.putWorkspaceSources.mock.calls[0]![1].skills.rules
    expect(rules.map((rule) => rule.id)).toEqual(['project-agents', 'project-claude', 'workspace', 'user'])
    expect(rules.find((rule) => rule.id === 'project-agents')?.enabled).toBe(false)
  })

  it('reordering moves a rule within its own layer and leaves every other rule where it was', async () => {
    const custom: ResourceSourcesDoc = { ...baseDoc, skills: { rules: [
      { id: 'project-claude', kind: 'project', path: '.claude/skills', enabled: true },
      { id: 'user', kind: 'absolute', path: '~/.claude/skills', enabled: true },
      { id: 'project-agents', kind: 'project', path: '.agents/skills', enabled: true },
    ] } }
    mocked.getWorkspaceSources.mockResolvedValue(row(custom))
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    // `.agents/skills` is last of the project rules: it can go up, and "Move down" is not offered.
    await act(async () => button('More actions for .agents/skills').click())
    expect(menuItem('Move down').disabled).toBe(true)
    await act(async () => menuItem('Move up').click())
    await act(async () => button('Save changes').click())
    await settle()
    // The user rule between them stays in the middle.
    expect(mocked.putWorkspaceSources.mock.calls[0]![1].skills.rules.map((rule) => rule.id)).toEqual(['project-agents', 'user', 'project-claude'])
  })

  it('skill rules: removing a User folder asks first, and Save applies it', async () => {
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    await openTab('User')
    await act(async () => button('More actions for ~/.claude/skills').click())
    await act(async () => menuItem('Remove folder').click())
    expect(document.body.textContent).toContain('Applies when you save')
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent === 'Remove folder').at(-1)!.click())
    expect(mocked.putWorkspaceSources).not.toHaveBeenCalled()
    await act(async () => button('Save changes').click())
    await settle()
    expect(mocked.putWorkspaceSources.mock.calls[0]![1].skills.rules.some((rule) => rule.id === 'user')).toBe(false)
  })

  it('a pending remove confirmation does not follow you to another tab', async () => {
    await render()
    await openTab('User')
    await act(async () => button('More actions for ~/.claude/skills').click())
    await act(async () => menuItem('Remove folder').click())
    expect(document.body.textContent).toContain('Applies when you save')
    await openTab('Bundled')
    await openTab('User')
    expect(document.body.textContent).not.toContain('Applies when you save')
  })

  it('adding a folder: Project adds a relative one, User an absolute one, each at the end', async () => {
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    const type = async (value: string): Promise<void> => {
      const input = document.body.querySelector<HTMLInputElement>('input[aria-label="New rule path"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(button('Add project folder').disabled).toBe(true)
    await type('.team/skills')
    await act(async () => button('Add project folder').click())
    await openTab('User')
    await type('D:/shared-skills')
    await act(async () => button('Add folder').click())
    expect(mocked.putWorkspaceSources).not.toHaveBeenCalled()

    await act(async () => button('Save changes').click())
    await settle()
    const rules = mocked.putWorkspaceSources.mock.calls[0]![1].skills.rules
    expect(rules.slice(-2)).toMatchObject([
      { kind: 'project', path: '.team/skills', enabled: true },
      { kind: 'absolute', path: 'D:/shared-skills', enabled: true },
    ])
    expect(rules).toHaveLength(6)
  })

  it('the Workspace and Plugins tabs offer no folder form: those paths are fixed', async () => {
    await render()
    await openTab('Workspace')
    expect(document.body.querySelector('input[aria-label="New rule path"]')).toBeNull()
    await openTab('Plugins')
    expect(document.body.querySelector('input[aria-label="New rule path"]')).toBeNull()
  })
})

describe('SourcesPanel saving', () => {
  it('a stale save shows the conflict banner; Overwrite re-reads the hash and saves again', async () => {
    mocked.putWorkspaceSources
      .mockRejectedValueOnce(new Error('409: the sources changed on the server since you opened them'))
      .mockImplementation(async (_ws, doc) => row(doc, 'h3'))
    await render()
    await openTab('Bundled')
    await act(async () => sw('Agents: Bundled layer').click())
    await act(async () => button('Save changes').click())
    await settle()
    expect(document.body.textContent).toContain('changed on the server')

    mocked.getWorkspaceSources.mockResolvedValue(row(baseDoc, 'fresh'))
    await act(async () => button('Overwrite anyway').click())
    await settle()
    expect(mocked.putWorkspaceSources).toHaveBeenCalledTimes(2)
    expect(mocked.putWorkspaceSources.mock.calls[1]![2]).toBe('fresh')
    expect(mocked.putWorkspaceSources.mock.calls[1]![1].disabled.agents).toEqual(['bundled'])
    expect(document.body.textContent).not.toContain('changed on the server since you opened')
  })

  it('Reload on a conflict drops the draft for the server copy', async () => {
    mocked.putWorkspaceSources.mockRejectedValueOnce(new Error('409: stale'))
    await render()
    await openTab('User')
    await act(async () => sw('Hooks: User layer').click())
    await act(async () => button('Save changes').click())
    await settle()
    mocked.getWorkspaceSources.mockResolvedValue(row({ ...baseDoc, disabled: { ...baseDoc.disabled, commands: ['user'] } }, 'other'))
    await act(async () => button('Reload server version').click())
    await settle()
    expect(sw('Hooks: User layer').getAttribute('aria-checked')).toBe('true')
    expect(sw('Commands: User layer').getAttribute('aria-checked')).toBe('false')
  })

  it('a non-conflict save error is shown and the draft is kept', async () => {
    mocked.putWorkspaceSources.mockRejectedValueOnce(new Error('400: rule too broad'))
    await render()
    await openTab('User')
    await act(async () => sw('Hooks: User layer').click())
    await act(async () => button('Save changes').click())
    await settle()
    expect(document.body.textContent).toContain('too broad')
    expect(sw('Hooks: User layer').getAttribute('aria-checked')).toBe('false')
    expect(button('Save changes').disabled).toBe(false)
  })

  it('an unusable stored file is called out', async () => {
    mocked.getWorkspaceSources.mockResolvedValue(row(baseDoc, 'h1', { error: 'resource-sources.json is unusable (invalid JSON)' }))
    await render()
    expect(document.body.textContent).toContain('resource-sources.json is unusable')
  })

  it('a failed load offers a retry', async () => {
    mocked.getWorkspaceSources.mockRejectedValueOnce(new Error('500: boom'))
    await render()
    expect(document.body.textContent).toContain('Could not load sources')
    mocked.getWorkspaceSources.mockResolvedValue(row())
    await act(async () => button('Retry').click())
    await settle()
    expect(tabs()).toHaveLength(5)
  })
})
