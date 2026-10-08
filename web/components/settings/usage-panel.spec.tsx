// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUsage } from '../../lib/api.ts'
import type { UsageDailyResponse } from '../../lib/types.ts'
import { UsagePanel } from './UsagePanel.tsx'

vi.mock('../../lib/api.ts', () => ({ fetchUsage: vi.fn() }))
const mocked = vi.mocked(fetchUsage)

const row = (date: string, model: string, input: number, output = 0) => ({ date, model, input, cached: 0, output, requests: 1 })
const FIXTURE: UsageDailyResponse = {
  today: '2026-10-08',
  longestSessionMs: (6 * 60 + 57) * 60_000,
  days: [
    row('2026-10-01', 'claude-opus-5-5', 900_000_000),
    row('2026-10-01', 'gpt-5.6-sol', 400_000_000),
    row('2026-10-02', 'grok-4.7', 200_000_000),
    row('2026-10-06', 'GLM-5.3-Flash', 300_000_000, 6_200_000),
    row('2026-10-07', 'GLM-5.3-Flash', 100_000_000),
    row('2026-09-10', 'old-model', 5),
  ],
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(): Promise<void> {
  await act(async () => { root.render(<UsagePanel />) })
}

const click = async (name: string): Promise<void> => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === name)
  if (button === undefined) throw new Error(`no button ${name}`)
  await act(async () => { button.click() })
}

describe('UsagePanel', () => {
  it('renders the five summary stats', async () => {
    mocked.mockResolvedValue(FIXTURE)
    await mount()
    const summary = host.querySelector('[aria-label="Usage summary"]')!.textContent
    expect(summary).toContain('Total tokens1.9B')
    expect(summary).toContain('Peak tokens1.3B')
    expect(summary).toContain('Longest session6 h 57 m')
    expect(summary).toContain('Current streak2 d')
    expect(summary).toContain('Longest streak2 d')
  })

  it('switches the heatmap aggregation', async () => {
    mocked.mockResolvedValue(FIXTURE)
    await mount()
    const levels = (): string[] => [...host.querySelectorAll('[data-testid="heat-cell"]')].map((c) => c.getAttribute('data-level')!)
    const daily = levels()
    // Five distinct active days in the fixture.
    expect(daily.filter((l) => l !== '0').length).toBe(5)
    await click('Weekly')
    expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe('Weekly')
    expect(levels().filter((l) => l !== '0').length).toBeGreaterThan(5)
    await click('Cumulative')
    expect(levels().filter((l) => l !== '0').length).toBeGreaterThan(20)
  })

  it('switches the trend range and toggles a series from the legend', async () => {
    mocked.mockResolvedValue(FIXTURE)
    await mount()
    expect(host.querySelectorAll('[data-testid="trend-tick"]')).toHaveLength(7)
    // Oct 2–8: grok-4.7 and GLM-5.3-Flash only.
    expect(host.querySelectorAll('[data-testid="trend-series"]')).toHaveLength(2)
    await click('Last 30 days')
    expect(host.querySelectorAll('[data-testid="trend-series"]')).toHaveLength(5)
    expect(host.querySelectorAll('[data-testid="trend-tick"]')).toHaveLength(6)
    await click('grok-4.7')
    expect(host.querySelectorAll('[data-testid="trend-series"]')).toHaveLength(4)
  })

  it('shows the empty state when nothing was recorded', async () => {
    mocked.mockResolvedValue({ today: '2026-10-08', longestSessionMs: 0, days: [] })
    await mount()
    expect(host.textContent).toContain('Usage is recorded from now on')
    expect(host.textContent).toContain('Longest session—')
  })

  it('offers a retry when loading fails', async () => {
    mocked.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(FIXTURE)
    await mount()
    expect(host.textContent).toContain('Could not load usage')
    await click('Retry')
    expect(host.textContent).toContain('Total tokens')
  })
})
