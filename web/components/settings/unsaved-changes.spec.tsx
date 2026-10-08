// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGuardConfig, getSystemPrompts } from '../../lib/api.ts'
import { SETTINGS_TAB_STORAGE_KEY, SettingsModal } from './SettingsModal.tsx'
import { SystemPromptsPanel } from './SystemPromptsPanel.tsx'
import { DangerousCommandsPanel } from './DangerousCommandsPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  getSystemPrompts: vi.fn(async () => ({
    base: { text: 'BASE', overridden: false },
    child: { text: 'CHILD', overridden: false },
    defaults: { base: 'BASE', child: 'CHILD' },
    hash: 'h0',
  })),
  putSystemPrompts: vi.fn(),
  getGuardConfig: vi.fn(async () => ({ config: { v: 1, presets: {}, customRules: [] }, hash: 'g0' })),
  putGuardConfig: vi.fn(),
  listSecrets: vi.fn(async () => []),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  listMemory: vi.fn(async () => ({ entries: [] })),
  listAgentDefinitions: vi.fn(async () => []),
  listChildren: vi.fn(async () => []),
  listModeFiles: vi.fn(async () => []),
  listModes: vi.fn(async () => ({ modes: [], selected: 'ask-before-changes', revision: 1 })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => { for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve() }) }
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
const tab = (name: string): HTMLElement => {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent?.trim() === name)
  if (found === undefined) throw new Error(`no tab "${name}"`)
  return found
}
/** Radix tabs activate on mousedown (left button). */
const pressTab = async (name: string): Promise<void> => {
  await act(async () => { tab(name).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })
  await settle()
}
const textareas = (): HTMLTextAreaElement[] => [...document.body.querySelectorAll('textarea')]
function type(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const dialogTitled = (title: string): boolean => [...document.body.querySelectorAll('[role="dialog"]')].some((node) => node.getAttribute('aria-label') === title)

const renderModal = async (onDismiss = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
  await act(async () => root.render(
    <SettingsModal open initialTab="prompts" workspaceId="ws" providers={[]} activeProvider="" onDismiss={onDismiss} onRefresh={async () => {}} />,
  ))
  await settle()
  return onDismiss
}

describe('Settings unsaved-change guard', () => {
  it('switches tabs freely while a workspace panel is clean', async () => {
    await renderModal()
    await pressTab('Secrets')
    expect(dialogTitled('Discard unsaved changes?')).toBe(false)
    expect(tab('Secrets').getAttribute('data-state')).toBe('active')
  })

  it('asks before a tab switch drops an unsaved workspace-panel draft, and keeps it on cancel', async () => {
    await renderModal()
    await act(async () => type(textareas()[0]!, 'EDITED BASE'))
    await pressTab('Secrets')
    expect(dialogTitled('Discard unsaved changes?')).toBe(true)
    // Cancel: still on System Prompts with the edit intact.
    const dialog = [...document.body.querySelectorAll('[role="dialog"]')].find((node) => node.getAttribute('aria-label') === 'Discard unsaved changes?')!
    const cancel = [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Cancel')!
    await act(async () => cancel.click())
    expect(dialogTitled('Discard unsaved changes?')).toBe(false)
    expect(tab('System Prompts').getAttribute('data-state')).toBe('active')
    expect(textareas()[0]!.value).toBe('EDITED BASE')
    // Confirm: the switch happens.
    await pressTab('Secrets')
    await act(async () => button('Discard changes').click())
    await settle()
    expect(tab('Secrets').getAttribute('data-state')).toBe('active')
  })

  it('asks before closing Settings over an unsaved workspace-panel draft', async () => {
    const onDismiss = await renderModal()
    await act(async () => type(textareas()[0]!, 'EDITED BASE'))
    await act(async () => button('Close settings').click())
    expect(onDismiss).not.toHaveBeenCalled()
    expect(dialogTitled('Discard unsaved changes?')).toBe(true)
    await act(async () => button('Discard changes').click())
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('Settings remembers its tab', () => {
  const render = async (props: { open: boolean, initialTab?: 'prompts' }): Promise<void> => {
    await act(async () => root.render(
      <SettingsModal {...props} workspaceId="ws" providers={[]} activeProvider="" onDismiss={() => {}} onRefresh={async () => {}} />,
    ))
    await settle()
  }

  beforeEach(() => window.localStorage.clear())

  it('reopens on the tab it last showed when no tab is requested', async () => {
    await render({ open: true })
    expect(tab('Providers').getAttribute('data-state')).toBe('active')
    await pressTab('Secrets')
    await render({ open: false })
    await render({ open: true })
    expect(tab('Secrets').getAttribute('data-state')).toBe('active')
  })

  it('lets an explicit deep link win over the remembered tab', async () => {
    window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'secrets')
    await render({ open: true, initialTab: 'prompts' })
    expect(tab('System Prompts').getAttribute('data-state')).toBe('active')
  })

  it('ignores an unknown stored tab', async () => {
    window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'bogus')
    await render({ open: true })
    expect(tab('Providers').getAttribute('data-state')).toBe('active')
  })
})

describe('load failures', () => {
  it('System Prompts shows the error with Retry instead of loading forever', async () => {
    vi.mocked(getSystemPrompts).mockRejectedValueOnce(new Error('HTTP 500: boom'))
    await act(async () => root.render(<SystemPromptsPanel workspaceId="ws" />))
    await settle()
    expect(document.body.textContent).toContain('Could not load system prompts.')
    expect(document.body.textContent).not.toContain('Loading system prompts…')
    await act(async () => button('Retry').click())
    await settle()
    expect(getSystemPrompts).toHaveBeenCalledTimes(2)
    expect(textareas()[0]!.value).toBe('BASE')
  })

  it('Dangerous Commands shows the error with Retry instead of loading forever', async () => {
    vi.mocked(getGuardConfig).mockRejectedValueOnce(new Error('HTTP 500: boom'))
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws" />))
    await settle()
    expect(document.body.textContent).toContain('Could not load the guard configuration.')
    await act(async () => button('Retry').click())
    await settle()
    expect(getGuardConfig).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('Could not load')
  })
})
