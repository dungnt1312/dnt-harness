// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteSkill, getSkill, getSkillFile, getSkillFiles, getSkillSources, listProjects, listSkills, putSkillSources, saveSkill, setSkillHidden } from '../../lib/api.ts'
import { SkillsPanel } from './SkillsPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
  setSkillHidden: vi.fn(),
  getSkillSources: vi.fn(),
  putSkillSources: vi.fn(),
  listProjects: vi.fn(),
  getSkillFiles: vi.fn(),
  getSkillFile: vi.fn(),
}))

const mocked = vi.mocked({ listSkills, getSkill, saveSkill, deleteSkill, setSkillHidden, getSkillSources, putSkillSources, listProjects, getSkillFiles, getSkillFile })

const row = (name: string, source: 'project' | 'workspace' | 'user', extra: Record<string, unknown> = {}) =>
  ({ name, title: name, description: `${name} does things`, source, hash: `hash-${name}`, ...extra })

/** Like the real API: a project-scoped list carries EVERY layer, project rows first. */
const baseList = () => [row('ws-skill', 'workspace'), row('user-skill', 'user', { ruleId: 'user' })]

beforeEach(() => {
  mocked.listSkills.mockImplementation(async (_ws: string, projectId?: string) =>
    projectId === undefined
      ? baseList()
      : projectId === 'p1'
        ? [row('proj-claude', 'project', { ruleId: 'project-claude' }), ...baseList()]
        : baseList())
  mocked.getSkillSources.mockResolvedValue({ rules: [
    { id: 'project-claude', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'project-agents', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'workspace', kind: 'workspace', enabled: true },
    { id: 'user', kind: 'absolute', path: '~/.claude/skills', enabled: true },
  ] })
  mocked.listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] as never)
  mocked.getSkill.mockResolvedValue({ ...row('ws-skill', 'workspace'), instructions: '---\nname: ws-skill\ndescription: x\n---\n\nBODY TEXT' })
  mocked.setSkillHidden.mockResolvedValue({ name: 'ws-skill', hidden: true })
  mocked.getSkillFiles.mockResolvedValue({ files: [{ path: 'SKILL.md', bytes: 40 }, { path: 'scripts/run.sh', bytes: 7 }] })
  mocked.getSkillFile.mockResolvedValue({ path: 'scripts/run.sh', content: 'echo hi', bytes: 7 })
})

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
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

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const menuItem = (name: string): HTMLButtonElement => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === name)!
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const renderPanel = async (): Promise<void> => {
  await act(async () => root!.render(<SkillsPanel workspaceId="ws-1" />))
  await settle()
}

describe('SkillsPanel skills tab', () => {
  it('groups rows by project rule then rule-keyed base layers, with project names in headers', async () => {
    await renderPanel()
    expect(document.body.textContent).toContain('proj-claude')
    expect(document.body.textContent).toContain('.claude/skills · Alpha')
    expect(document.body.textContent).toContain('Workspace skills')
    // Base groups are labeled by the ACTUAL absolute rule path, not a hardcoded title.
    expect(document.body.textContent).toContain('~/.claude/skills')
  })

  it('does not mark base rows shadowed just because project lists include every layer', async () => {
    await renderPanel()
    expect(document.body.querySelector('[aria-label="Shadowed in a project"]')).toBeNull()
  })

  it('marks a base row shadowed when a project defines the same name', async () => {
    mocked.listSkills.mockImplementation(async (_ws: string, projectId?: string) =>
      projectId === 'p1'
        ? [row('ws-skill', 'project', { ruleId: 'project-claude' }), row('user-skill', 'user', { ruleId: 'user' })]
        : projectId === undefined
          ? [row('ws-skill', 'workspace'), row('user-skill', 'user', { ruleId: 'user' })]
          : [row('ws-skill', 'workspace'), row('user-skill', 'user', { ruleId: 'user' })])
    await renderPanel()
    const dots = [...document.body.querySelectorAll('[aria-label="Shadowed in a project"]')]
    // Only ws-skill (project-owned in Alpha) is shadowed, and only by Alpha.
    expect(dots).toHaveLength(1)
    expect(dots[0]?.getAttribute('title')).toContain('Alpha')
    expect(dots[0]?.getAttribute('title')).not.toContain('Beta')
    // The project copy itself carries the "overrides" marker naming the layer it replaces.
    const overrides = document.body.querySelector('[aria-label="Overrides another layer"]')
    expect(overrides).not.toBeNull()
    expect(overrides?.getAttribute('title')).toContain('workspace')
  })

  it('a project row without a base twin carries no overrides marker', async () => {
    await renderPanel()
    expect(document.body.querySelector('[aria-label="Overrides another layer"]')).toBeNull()
  })

  it('save warnings from the server surface in the notice', async () => {
    mocked.saveSkill.mockResolvedValue({ name: 'ws-skill', hash: 'hash-new', warnings: ['Project folders define the same name and win in their sessions: Alpha.'] })
    await renderPanel()
    await act(async () => button('ws-skill').click())
    await settle()
    await act(async () => button('Edit raw').click())
    await settle()
    const area = document.body.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => type(area, '---\nname: ws-skill\ndescription: x\n---\n\nNEW BODY'))
    await act(async () => button('Save skill').click())
    await settle()
    expect(document.body.textContent).toContain('win in their sessions: Alpha')
  })

  it('opens the detail pane with rendered preview and edit only for workspace rows', async () => {
    await renderPanel()
    await act(async () => button('ws-skill').click())
    await settle()
    expect(document.body.textContent).toContain('BODY TEXT')
    await act(async () => button('Edit raw').click())
    await settle()
    const area = document.body.querySelector<HTMLTextAreaElement>('textarea')!
    expect(area.value).toContain('BODY TEXT')
  })

  it('expands a skill into its file tree and opens a resource file in the detail pane', async () => {
    await renderPanel()
    await act(async () => button('Toggle ws-skill').click())
    await settle()
    expect(document.body.textContent).toContain('scripts/run.sh')
    await act(async () => button('scripts/run.sh').click())
    await settle()
    expect(document.body.textContent).toContain('echo hi')
    expect(mocked.getSkillFile).toHaveBeenCalledWith('ws-1', 'ws-skill', 'scripts/run.sh', undefined)
  })

  it('keeps rows compact — the description rides the title tooltip, not the row', async () => {
    await renderPanel()
    expect(button('ws-skill').title).toContain('ws-skill does things')
    expect(document.body.textContent).not.toContain('ws-skill does things')
  })

  it('project rows show a read-only notice and no editor', async () => {
    await renderPanel()
    await act(async () => button('proj-claude').click())
    await settle()
    expect(document.body.textContent).toMatch(/read-only/i)
    expect(buttons().some((node) => node.textContent === 'Edit raw')).toBe(false)
  })

  it('the In catalog switch hides a skill via setSkillHidden', async () => {
    await renderPanel()
    await act(async () => button('ws-skill').click())
    await settle()
    const box = document.body.querySelector<HTMLInputElement>('input[aria-label="Offer ws-skill in the skill catalog"]')!
    await act(async () => box.click())
    await settle()
    expect(mocked.setSkillHidden).toHaveBeenCalledWith('ws-1', 'ws-skill', true)
  })

  it('search narrows the tree across groups', async () => {
    await renderPanel()
    const search = document.body.querySelector<HTMLInputElement>('input[placeholder="Search skills"]')!
    await act(async () => type(search, 'proj-cla'))
    await settle()
    expect(document.body.textContent).toContain('proj-claude')
    expect(document.body.textContent).not.toContain('ws-skill')
  })

  it('the workspace editor saves through saveSkill with the loaded hash', async () => {
    mocked.saveSkill.mockResolvedValue({ name: 'ws-skill', hash: 'hash-new' })
    await renderPanel()
    await act(async () => button('ws-skill').click())
    await settle()
    await act(async () => button('Edit raw').click())
    await settle()
    const area = document.body.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => type(area, '---\nname: ws-skill\ndescription: x\n---\n\nNEW BODY'))
    await act(async () => button('Save skill').click())
    await settle()
    expect(mocked.saveSkill).toHaveBeenCalledWith('ws-1', 'ws-skill', '---\nname: ws-skill\ndescription: x\n---\n\nNEW BODY', 'hash-ws-skill')
  })

  it('the + button starts a new workspace skill draft', async () => {
    await renderPanel()
    await act(async () => button('New skill').click())
    await settle()
    expect(document.body.textContent).toContain('New skill')
    expect(document.body.querySelector('textarea')).not.toBeNull()
  })

  it("refuses the reserved name 'sources' before saving", async () => {
    await renderPanel()
    await act(async () => button('New skill').click())
    await settle()
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="deploy-notes"]')!
    await act(async () => type(input, 'sources'))
    await act(async () => type(document.body.querySelector<HTMLTextAreaElement>('textarea')!, '---\nname: sources\n---\n\nBODY'))
    await settle()
    expect(document.body.textContent).toContain('reserved')
    expect(button('Save skill').disabled).toBe(true)
  })
})

describe('SkillsPanel source folders tab', () => {
  beforeEach(() => {
    mocked.putSkillSources.mockReset()
    mocked.putSkillSources.mockResolvedValue({ rules: [] })
  })

  const openFolders = async (): Promise<void> => {
    await renderPanel()
    const tab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith('Source folders'))!
    await act(async () => tab.click())
    await settle()
  }

  it('renders rule rows with kind badges and a locked workspace row', async () => {
    await openFolders()
    expect(document.body.textContent).toContain('.claude/skills')
    expect(document.body.textContent).toContain('.agents/skills')
    expect(document.body.textContent).toContain('Workspace skills')
    await act(async () => button('More actions for Workspace skills').click())
    expect([...document.body.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent === 'Remove folder')).toBe(false)
  })

  it('toggling a rule persists immediately and notifies catalog consumers', async () => {
    const onChanged = vi.fn()
    await act(async () => root!.render(<SkillsPanel workspaceId="ws-1" onChanged={onChanged} />))
    await settle()
    const tab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith('Source folders'))!
    await act(async () => tab.click())
    const box = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable .agents/skills"]')!
    await act(async () => box.click())
    await settle()
    expect(mocked.putSkillSources).toHaveBeenCalledTimes(1)
    const rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string; enabled: boolean }[]
    expect(rules.find((rule) => rule.id === 'project-agents')?.enabled).toBe(false)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('reorder buttons move a rule up and persist the swapped order', async () => {
    await openFolders()
    await act(async () => button('More actions for .agents/skills').click())
    await act(async () => menuItem('Move up').click())
    await settle()
    const rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string }[]
    expect(rules.map((rule) => rule.id)).toEqual(['project-agents', 'project-claude', 'workspace', 'user'])
  })

  it('remove deletes a rule and add appends a new one', async () => {
    await openFolders()
    // Remove is in the row menu and asks first: nothing saved until confirmed.
    await act(async () => button('More actions for .agents/skills').click())
    await act(async () => menuItem('Remove folder').click())
    expect(mocked.putSkillSources).not.toHaveBeenCalled()
    await act(async () => buttons().filter((node) => node.textContent === 'Remove folder').at(-1)!.click())
    await settle()
    let rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string }[]
    expect(rules.some((rule) => rule.id === 'project-agents')).toBe(false)
    await act(async () => button('New rule kind').click())
    await settle()
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent === 'Absolute path')!
    await act(async () => option.click())
    await settle()
    const pathInput = document.body.querySelector<HTMLInputElement>('input[aria-label="New rule path"]')!
    await act(async () => type(pathInput, 'D:/shared-skills'))
    await act(async () => button('Add rule').click())
    await settle()
    rules = mocked.putSkillSources.mock.calls[1]?.[1] as readonly { id: string }[]
    expect(rules[rules.length - 1]).toMatchObject({ kind: 'absolute', path: 'D:/shared-skills', enabled: true })
  })
})
