// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommitMessagePanel } from './CommitMessagePanel.tsx'
import type { ProviderSummary } from '../../lib/types.ts'

const getCommitMessageSettings = vi.fn(async () => ({ provider: null as string | null, model: null as string | null }))
const setCommitMessageSettings = vi.fn(async (value: { provider: string | null; model: string | null }) => value)

vi.mock('../../lib/api.ts', () => ({
  getCommitMessageSettings: () => getCommitMessageSettings(),
  setCommitMessageSettings: (value: { provider: string | null; model: string | null }) => setCommitMessageSettings(value),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROVIDERS: readonly ProviderSummary[] = [
  { id: 'p1', name: 'Provider One', baseUrl: 'https://x', enabled: true, keyMasked: '••••', models: ['fast-model', 'big-model'] },
  { id: 'p2', name: 'Provider Two', baseUrl: 'https://y', enabled: false, keyMasked: '••••', models: ['other'] },
]

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  getCommitMessageSettings.mockClear()
  setCommitMessageSettings.mockClear()
  getCommitMessageSettings.mockImplementation(async () => ({ provider: null, model: null }))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(): Promise<void> {
  await act(async () => root.render(<CommitMessagePanel providers={PROVIDERS} />))
  await act(async () => { await Promise.resolve() })
}

const section = (): HTMLElement => document.body.querySelector('section[aria-label="Commit message"]')!
const select = (label: string): HTMLElement | null => document.body.querySelector(`[aria-label="${label}"]`)
const save = (): HTMLButtonElement => [...section().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!

describe('CommitMessagePanel', () => {
  it('explains the Generate button and the fast-alias fallback', async () => {
    await mount()
    expect(section().textContent).toContain('Generate Commit Message')
    expect(section().textContent).toContain('"fast" model alias')
  })

  it('reads the stored pair on open and starts with Save off', async () => {
    getCommitMessageSettings.mockImplementation(async () => ({ provider: 'p1', model: 'fast-model' }))
    await mount()
    expect(getCommitMessageSettings).toHaveBeenCalledOnce()
    expect(select('Commit message provider')).not.toBeNull()
    expect(select('Commit message model')).not.toBeNull()
    expect(save().disabled).toBe(true)
  })

  it('an unset pair shows only the provider choice', async () => {
    await mount()
    expect(select('Commit message provider')).not.toBeNull()
    expect(select('Commit message model')).toBeNull()
  })
})
