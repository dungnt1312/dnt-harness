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
const row = (doc: ResourceSourcesDoc = baseDoc, hash = 'h1', extra: Partial<WorkspaceSourcesRow> = {}): WorkspaceSourcesRow => ({
  doc,
  hash,
  layers: {
    skills: [layer('plugin', 'Plugins', "Enabled plugins' skills"), layer('bundled', 'Bundled', 'Shipped with the app')],
    agents: [layer('bundled', 'Bundled', 'Built-in roles'), layer('user', 'User', '/home/x/.claude/agents'), layer('workspace', 'Workspace', '/data/ws/agents')],
    hooks: [layer('user', 'User', '/home/x/.claude/settings.json'), layer('local', 'Project local', '<project>/.claude/settings.local.json')],
    commands: [layer('bundled', 'Bundled', 'Shipped with the app', false), layer('user', 'User', '/home/x/.claude/commands')],
  },
  ...extra,
})

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
/**
 * Opening a second row menu right after choosing an item in the first one is
 * flaky under jsdom: measured, the second menu opened 4 times in 12 with no
 * wait and 12 in 12 after a 20 ms wait. Something Radix does after a menu
 * closes (probably returning focus to its trigger) finishes on a later
 * macrotask; that mechanism is a hypothesis, the timing effect is what was
 * measured. Wait before opening the next menu.
 */
const afterMenuChoice = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const render = async (onChanged?: () => void): Promise<void> => {
  await act(async () => root!.render(<SourcesPanel workspaceId="ws-1" {...(onChanged !== undefined ? { onChanged } : {})} />))
  await settle()
}
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

describe('SourcesPanel', () => {
  it('lists the four resource kinds with their layers and skill rules', async () => {
    await render()
    for (const title of ['Skills', 'Agents', 'Hooks', 'Commands']) expect(document.body.textContent).toContain(title)
    expect(document.body.textContent).toContain('.claude/skills')
    expect(document.body.textContent).toContain('/home/x/.claude/agents')
    expect(document.body.textContent).toContain('<project>/.claude/settings.local.json')
    expect(button('Save changes').disabled).toBe(true)
  })

  it('a layer switch only edits the draft; Save sends the whole document with the loaded hash', async () => {
    const onChanged = vi.fn()
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render(onChanged)
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

  it('switching a layer back on and Discard both return to a clean draft', async () => {
    await render()
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
    expect(sw('Commands: Bundled layer').disabled).toBe(true)
    expect(document.body.textContent).toContain('Not available on this host.')
  })

  it('skill rules: toggle, reorder, remove and add stay in the draft until Save', async () => {
    mocked.putWorkspaceSources.mockImplementation(async (_ws, doc) => row(doc, 'h2'))
    await render()
    await act(async () => sw('Enable .agents/skills').click())
    await act(async () => button('More actions for .agents/skills').click())
    await act(async () => menuItem('Move up').click())
    await afterMenuChoice()
    await act(async () => button('More actions for ~/.claude/skills').click())
    await act(async () => menuItem('Remove folder').click())
    expect(document.body.textContent).toContain('Applies when you save')
    expect(document.body.textContent).toContain('~/.claude/skills')
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent === 'Remove folder').at(-1)!.click())

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="New rule path"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '.team/skills')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Add rule').click())
    expect(mocked.putWorkspaceSources).not.toHaveBeenCalled()

    await act(async () => button('Save changes').click())
    await settle()
    const rules = mocked.putWorkspaceSources.mock.calls[0]![1].skills.rules
    // Reordered, one disabled, one removed, and the new rule sits last
    // (lowest precedence).
    expect(rules.map((rule) => rule.id).slice(0, 3)).toEqual(['project-agents', 'project-claude', 'workspace'])
    expect(rules.find((rule) => rule.id === 'project-agents')?.enabled).toBe(false)
    expect(rules.some((rule) => rule.id === 'user')).toBe(false)
    expect(rules).toHaveLength(4)
    expect(rules.at(-1)).toMatchObject({ kind: 'project', path: '.team/skills', enabled: true })
  })

  it('a stale save shows the conflict banner; Overwrite re-reads the hash and saves again', async () => {
    mocked.putWorkspaceSources
      .mockRejectedValueOnce(new Error('409: the sources changed on the server since you opened them'))
      .mockImplementation(async (_ws, doc) => row(doc, 'h3'))
    await render()
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
    expect(document.body.textContent).toContain('Agents')
  })
})
