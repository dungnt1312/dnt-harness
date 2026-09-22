// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../../lib/api.ts'
import { DangerousCommandsPanel } from './DangerousCommandsPanel.tsx'

const DEFAULT_CFG = {
  v: 1 as const,
  presets: { fsDestructive: 'deny' as const, gitDestructive: 'ask' as const, systemPriv: 'ask' as const, networkExfil: 'deny' as const, dbDestructive: 'ask' as const, resourceExhaust: 'deny' as const },
  customRules: [] as readonly never[],
}

const mockGet = vi.fn(async () => ({ config: { ...DEFAULT_CFG, presets: { ...DEFAULT_CFG.presets }, customRules: [] }, hash: 'hash-1' }))
const mockPut = vi.fn(async () => ({ config: { ...DEFAULT_CFG, presets: { ...DEFAULT_CFG.presets }, customRules: [] }, hash: 'hash-2' }))

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts')
  return {
    ...actual,
    getGuardConfig: (...args: unknown[]) => mockGet(...args),
    putGuardConfig: (...args: unknown[]) => mockPut(...args),
    getGlobalGuardConfig: vi.fn(async () => ({ config: DEFAULT_CFG, hash: 'h' })),
    putGlobalGuardConfig: vi.fn(async () => ({ config: DEFAULT_CFG, hash: 'h2' })),
  }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ config: { v: 1, presets: { ...DEFAULT_CFG.presets }, customRules: [] }, hash: 'hash-1' })
  mockPut.mockResolvedValue({ config: { v: 1, presets: { ...DEFAULT_CFG.presets }, customRules: [] }, hash: 'hash-2' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const buttonByText = (text: string): HTMLButtonElement => {
  const found = buttons().find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`no button containing "${text}"`)
  return found
}
const inputByLabel = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = [...document.body.querySelectorAll('label')].find((n) => n.textContent?.includes(label))?.control
  if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)) throw new Error(`no field "${label}"`)
  return found
}
const inputByPlaceholder = (ph: string): HTMLInputElement => {
  const found = document.body.querySelector<HTMLInputElement>(`input[placeholder="${ph}"]`) ?? document.body.querySelector<HTMLInputElement>(`input[placeholder*="${ph.slice(0, 8)}"]`)
  if (!found) throw new Error(`no input placeholder "${ph}"`)
  return found
}
function typeInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('DangerousCommandsPanel', () => {
  it('requires a workspace', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId={null} />))
    expect(document.body.textContent).toContain('Choose a workspace first')
  })

  it('toggles a preset and marks dirty', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws-1" />))
    await settle()
    await settle()
    // FS Destructive defaults to deny; flip to off via segmented control
    const offButtons = buttons().filter((b) => b.textContent === 'Off')
    expect(offButtons.length).toBeGreaterThan(0)
    await act(async () => offButtons[0]!.click())
    expect(document.body.textContent).toContain('Unsaved changes')
    const saveBtn = buttonByText('Save')
    expect(saveBtn.disabled).toBe(false)
  })

  it('adds a custom rule via dialog', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws-1" />))
    await settle()
    await settle()
    await act(async () => buttonByText('Add rule').click())
    await settle()
    const patternInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Pattern"]')
    expect(patternInput).not.toBeNull()
    await act(async () => typeInput(patternInput!, 'rm -rf ./tmp'))
    // Dialog has its own Add rule button; pick the last one (inside modal)
    const addBtns = buttons().filter((b) => b.textContent === 'Add rule')
    await act(async () => addBtns[addBtns.length - 1]!.click())
    // After closing dialog the rule appears in list
    await settle()
    expect(document.body.textContent).toContain('rm -rf ./tmp')
    expect(document.body.textContent).toContain('Unsaved changes')
  })

  it('validates regex live when isRegex on', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws-1" />))
    await settle()
    await settle()
    await act(async () => buttonByText('Add rule').click())
    await settle()
    const patternInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Pattern"]')!
    // Toggle Regex on
    const regexToggle = document.body.querySelector<HTMLInputElement>('input[aria-label="Regex"]') ?? document.body.querySelector('button[role="switch"]')
    // Switch component uses Radix; click the switch
    const switchEl = document.body.querySelector('button[role="switch"]')
    expect(switchEl).not.toBeNull()
    await act(async () => (switchEl as HTMLButtonElement).click())
    await act(async () => typeInput(patternInput, '['))
    expect(document.body.textContent).toMatch(/Invalid regular expression|invalid/i)
    await act(async () => typeInput(patternInput, '^rm\\s+-rf'))
    // Error should clear
    expect(document.body.textContent).not.toMatch(/Invalid regular expression/i)
  })

  it('test bar previews matches locally (no round-trip)', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws-1" />))
    await settle()
    await settle()
    const testInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Test command"]')!
    await act(async () => typeInput(testInput, 'rm -rf /'))
    await act(async () => buttonByText('Test').click())
    expect(document.body.textContent).toContain('Matched')
    expect(document.body.textContent).toMatch(/DENY/i)
    // No-match case
    await act(async () => typeInput(testInput, 'ls -la'))
    await act(async () => buttonByText('Test').click())
    expect(document.body.textContent).toContain('No match')
  })

  it('dirty/save flow calls putGuardConfig with expectedHash and handles 409', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws-1" />))
    await settle()
    await settle()
    const offButtons = buttons().filter((b) => b.textContent === 'Off')
    await act(async () => offButtons[0]!.click())
    // Save once succeeds
    await act(async () => buttonByText('Save').click())
    await settle()
    expect(mockPut).toHaveBeenCalledWith('ws-1', expect.any(Object), 'hash-1')

    // Simulate conflict on next save
    mockPut.mockRejectedValueOnce(new HttpError(409, 'conflict: dangerous-commands.json changed externally'))
    const askButtons = buttons().filter((b) => b.textContent === 'Ask')
    await act(async () => askButtons[0]!.click())
    await act(async () => buttonByText('Save').click())
    await settle()
    expect(document.body.textContent).toMatch(/changed on disk/i)
    expect(document.body.textContent).toContain('Reload server version')
    expect(document.body.textContent).toContain('Overwrite anyway')
  })

  it('cancel restores baseline and clears dirty', async () => {
    await act(async () => root.render(<DangerousCommandsPanel workspaceId="ws-1" />))
    await settle()
    await settle()
    const offButtons = buttons().filter((b) => b.textContent === 'Off')
    await act(async () => offButtons[0]!.click())
    expect(document.body.textContent).toContain('Unsaved changes')
    await act(async () => buttonByText('Cancel').click())
    expect(document.body.textContent).not.toContain('Unsaved changes')
    expect(buttonByText('Save').disabled).toBe(true)
  })
})
