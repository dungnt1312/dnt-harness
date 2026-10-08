// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelAliasesPanel } from './ModelAliasesPanel.tsx'
import { UnsavedChangesContext } from './unsaved-changes.tsx'
import * as api from '../../lib/api.ts'

vi.mock('../../lib/api.ts', () => ({
  listModelAliases: vi.fn(), createModelAlias: vi.fn(), updateModelAlias: vi.fn(), deleteModelAlias: vi.fn(),
}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const providers = [
  { id: 'alpha', name: 'Alpha', enabled: true, models: ['a1', 'a2'], keyMasked: '', baseUrl: '' },
  { id: 'off', name: 'Off', enabled: false, models: ['o1'], keyMasked: '', baseUrl: '' },
] as never
const valid = { name: 'fast', provider: 'alpha', model: 'a1', thinkingLevel: null, revision: 1, status: 'valid', warnings: ['shadows advertised model'] } as const
const broken = { name: 'broken', provider: 'gone', model: 'old', thinkingLevel: 'high', revision: 3, status: 'invalid', message: "no usable provider 'gone'", warnings: [] } as const
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const settle = async () => { await act(async () => { await Promise.resolve() }) }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(text))!
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const choose = async (label: string, option: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes(option))!
  await act(async () => item.click())
}
const set = (element: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.clearAllMocks()
  vi.mocked(api.listModelAliases).mockResolvedValue([valid, broken] as never)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('ModelAliasesPanel mounted CRUD', () => {
  it('creates, edits/renames and deletes aliases with accessible controls and collision warning', async () => {
    vi.mocked(api.createModelAlias).mockResolvedValue({ ...valid, name: 'new-one' } as never)
    vi.mocked(api.updateModelAlias).mockResolvedValue({ ...valid, name: 'quick', revision: 2 } as never)
    vi.mocked(api.deleteModelAlias).mockResolvedValue({ deleted: true } as never)
    await act(async () => root.render(<ModelAliasesPanel providers={providers} />)); await settle()
    await act(async () => button('fast').click())
    expect(host.textContent).toContain('Warning: shadows advertised model')
    await act(async () => button('New').click())
    await act(async () => set(input('Alias name'), 'new-one'))
    await choose('Alias provider', 'Alpha')
    await choose('Alias model', 'a2')
    await act(async () => button('Save alias').click())
    expect(api.createModelAlias).toHaveBeenCalledWith({ name: 'new-one', provider: 'alpha', model: 'a2', thinkingLevel: null })

    await act(async () => button('fast').click())
    await act(async () => set(input('Alias name'), 'quick'))
    await act(async () => button('Save alias').click())
    expect(api.updateModelAlias).toHaveBeenCalledWith('fast', expect.objectContaining({ expectedRevision: 1, name: 'quick' }))
    await act(async () => button('Delete alias').click())
    expect(api.deleteModelAlias).toHaveBeenCalledWith('quick', 2)
  })

  it('keeps a broken mapping repairable/deleteable, disables unavailable providers, and validates names inline', async () => {
    vi.mocked(api.updateModelAlias).mockResolvedValue({ ...broken, provider: 'alpha', model: 'a2', status: 'valid', message: undefined, revision: 4 } as never)
    vi.mocked(api.deleteModelAlias).mockResolvedValue({ deleted: true } as never)
    await act(async () => root.render(<ModelAliasesPanel providers={providers} />)); await settle()
    await act(async () => button('broken').click())
    expect(host.textContent).toContain("Unusable: no usable provider 'gone'")
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Alias provider"]')!.click())
    expect([...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes('Off'))?.disabled).toBe(true)
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await choose('Alias provider', 'Alpha')
    await choose('Alias model', 'a2')
    await act(async () => button('Save alias').click())
    expect(api.updateModelAlias).toHaveBeenCalledWith('broken', expect.objectContaining({ provider: 'alpha', model: 'a2', expectedRevision: 3 }))
    await act(async () => button('Delete alias').click())
    expect(api.deleteModelAlias).toHaveBeenCalled()
    await act(async () => { button('New').click(); set(input('Alias name'), 'bad name') })
    expect(host.textContent).toContain('without whitespace')
    expect(button('Save alias').disabled).toBe(true)
  })

  it('guards row switches and New when a draft is dirty', async () => {
    const confirmDiscard = vi.fn()
    await act(async () => root.render(<UnsavedChangesContext.Provider value={{ report: vi.fn(), confirmDiscard }}><ModelAliasesPanel providers={providers} /></UnsavedChangesContext.Provider>)); await settle()
    await act(async () => button('fast').click())
    await act(async () => set(input('Alias name'), 'changed'))
    await act(async () => button('broken').click())
    expect(confirmDiscard).toHaveBeenCalledTimes(1)
    expect(input('Alias name').value).toBe('changed')
    await act(async () => button('New').click())
    expect(confirmDiscard).toHaveBeenCalledTimes(2)
  })
})
