// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { contextFill } from '../../lib/format.ts'
import { ContextMeter, formatTokens } from './ContextMeter.tsx'
import type { ContextManifestView } from '../../lib/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
})

const MANIFEST: ContextManifestView = {
  modeId: 'default',
  modeRevision: 1,
  budget: { availableTokens: 994_880, usedTokens: 100_000, contextLimitTokens: 1_000_000, estimated: true },
  breakdown: { messages: 65_000, systemTools: 15_000, mcpTools: 14_000, metaContext: 2_000, skills: 2_000, systemPrompt: 2_000 },
  history: { setting: 'recent', includedTurns: 3, omittedTurns: 0 },
  sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 },
  omissions: [],
}

async function openMeter(manifest: ContextManifestView | null): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ContextMeter manifest={manifest} />))
  const trigger = host.querySelector<HTMLButtonElement>('button')!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

it('formats token counts compactly', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(139_100)).toBe('139.1K')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(1_500_000)).toBe('1.5M')
})

it('prefers the provider-reported prompt size over the estimate', () => {
  expect(contextFill(MANIFEST)).toMatchObject({ used: 100_000, estimated: true, cacheHitRate: undefined })
  const reported = contextFill({ ...MANIFEST, usage: { last: { inputTokens: 139_100, cachedInputTokens: 130_000 }, cacheableInputTokens: 400_000, cachedInputTokens: 396_000 } })
  expect(reported).toMatchObject({ used: 139_100, limit: 1_000_000, estimated: false })
  expect(reported.cacheHitRate).toBeCloseTo(0.99)
})

it('shows token counts per source, not percentages', async () => {
  const panel = await openMeter({ ...MANIFEST, usage: { last: { inputTokens: 139_100 }, cacheableInputTokens: 400_000, cachedInputTokens: 396_000 } })
  expect(panel.textContent).toContain('139.1K / 1M')
  expect(panel.textContent).toContain('Messages65K')
  expect(panel.textContent).toContain('Skills2K')
  expect(panel.textContent).toContain('MCP tools14K')
  expect(panel.textContent).toContain('Estimated tokens (chars/4)')
  expect(panel.textContent).toContain('Average cache hit rate99%')
})

it('marks an estimate and says when no request has run yet', async () => {
  const estimated = await openMeter(MANIFEST)
  expect(estimated.textContent).toContain('100K / 1M')
  expect(estimated.textContent).not.toContain('~')
  expect(estimated.textContent).toContain('Average cache hit rate—')
  await act(async () => root!.unmount())
  root = undefined
  host.remove()
  const empty = await openMeter(null)
  expect(empty.textContent).toContain('No recorded request context for this conversation.')
})
