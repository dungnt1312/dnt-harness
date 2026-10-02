// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteSkill, getSkill, getSkillSources, listProjects, listSkills, putSkillSources, saveSkill, setSkillHidden } from '../../lib/api.ts'
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
}))

const mocked = vi.mocked({ listSkills, getSkill, saveSkill, deleteSkill, setSkillHidden, getSkillSources, putSkillSources, listProjects })

const row = (name: string, source: 'project' | 'workspace' | 'user', extra: Record<string, unknown> = {}) =>
  ({ name, title: name, description: `${name} does things`, source, hash: `hash-${name}`, ...extra })

beforeEach(() => {
  mocked.listSkills.mockImplementation(async (_ws: string, projectId?: string) =>
    projectId === undefined
      ? [row('ws-skill', 'workspace'), row('user-skill', 'user')]
      : projectId === 'p1'
        ? [row('proj-claude', 'project', { ruleId: 'project-claude' })]
        : [])
  mocked.getSkillSources.mockResolvedValue({ rules: [
    { id: 'project-claude', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'project-agents', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'workspace', kind: 'workspace', enabled: true },
    { id: 'user', kind: 'absolute', path: '~/.claude/skills', enabled: true },
  ] })
  mocked.listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] as never)
  mocked.getSkill.mockResolvedValue({ ...row('ws-skill', 'workspace'), instructions: '---\nname: ws-skill\ndescription: x\n---\n\nBODY TEXT' })
  mocked.setSkillHidden.mockResolvedValue({ name: 'ws-skill', hidden: true })
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
  it('groups rows by project rule then workspace then user, with project names in headers', async () => {
    await renderPanel()
    expect(document.body.textContent).toContain('proj-claude')
    expect(document.body.textContent).toContain('.claude/skills · Alpha')
    expect(document.body.textContent).toContain('Workspace')
    expect(document.body.textContent).toContain('User (~/.claude/skills)')
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
})

describe('SkillsPanel source folders tab', () => {
  beforeEach(() => {
    mocked.putSkillSources.mockReset()
    mocked.putSkillSources.mockResolvedValue({ rules: [] })
  })

  const openFolders = async (): Promise<void> => {
    await renderPanel()
    await act(async () => button('Source folders').click())
    await settle()
  }

  it('renders rule rows with kind badges and a locked workspace row', async () => {
    await openFolders()
    expect(document.body.textContent).toContain('.claude/skills')
    expect(document.body.textContent).toContain('.agents/skills')
    expect(document.body.textContent).toContain('Workspace skills')
    expect(buttons().some((node) => (node.getAttribute('aria-label') ?? '').startsWith('Remove Workspace skills'))).toBe(false)
  })

  it('toggling a rule persists immediately via putSkillSources', async () => {
    await openFolders()
    const box = document.body.querySelector<HTMLInputElement>('input[aria-label="Enable .agents/skills"]')!
    await act(async () => box.click())
    await settle()
    expect(mocked.putSkillSources).toHaveBeenCalledTimes(1)
    const rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string; enabled: boolean }[]
    expect(rules.find((rule) => rule.id === 'project-agents')?.enabled).toBe(false)
  })

  it('reorder buttons move a rule up and persist the swapped order', async () => {
    await openFolders()
    await act(async () => button('Move .agents/skills up').click())
    await settle()
    const rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string }[]
    expect(rules.map((rule) => rule.id)).toEqual(['project-agents', 'project-claude', 'workspace', 'user'])
  })

  it('remove deletes a rule and add appends a new one', async () => {
    await openFolders()
    await act(async () => button('Remove .agents/skills').click())
    await settle()
    let rules = mocked.putSkillSources.mock.calls[0]?.[1] as readonly { id: string }[]
    expect(rules.some((rule) => rule.id === 'project-agents')).toBe(false)
    const kind = document.body.querySelector<HTMLSelectElement>('select[aria-label="New rule kind"]')!
    await act(async () => {
      kind.value = 'absolute'
      kind.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const pathInput = document.body.querySelector<HTMLInputElement>('input[aria-label="New rule path"]')!
    await act(async () => type(pathInput, 'D:/shared-skills'))
    await act(async () => button('Add rule').click())
    await settle()
    rules = mocked.putSkillSources.mock.calls[1]?.[1] as readonly { id: string }[]
    expect(rules[rules.length - 1]).toMatchObject({ kind: 'absolute', path: 'D:/shared-skills', enabled: true })
  })
})
