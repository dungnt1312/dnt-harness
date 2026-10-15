// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { contextFill } from '../../lib/format.ts'
import { ContextMeter, formatTokens } from './ContextMeter.tsx'
import type { ContextManifestView, ContextStatus, ContextView } from '../../lib/api.ts'

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

async function openMeter(manifest: ContextView | null, status?: ContextStatus): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ContextMeter manifest={manifest} {...(status !== undefined ? { status } : {})} />))
  const trigger = host.querySelector<HTMLButtonElement>('button')!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

it('labels a post-compaction estimate independently from the last request', async () => {
  const panel = await openMeter({ ...MANIFEST, display: { kind: 'post-compaction', compactionSeq: 40, coversSeq: 30 } })
  expect(panel.textContent).toContain('After compaction')
  expect(panel.textContent).toContain('estimated')
})

it('does not show a zero count when the current context is unavailable', async () => {
  const panel = await openMeter({ display: { kind: 'unavailable', reason: 'legacy-compaction' }, usage: { cacheableInputTokens: 0, cachedInputTokens: 0 } })
  expect(panel.textContent).toContain('Context estimate unavailable')
  expect(panel.textContent).not.toContain('0 /')
})

it('says loading or unavailable instead of "no request" or a zero count', async () => {
  const loading = await openMeter(null, 'loading')
  expect(loading.textContent).toContain('Loading context')
  expect(loading.textContent).not.toContain('No recorded request')
  await act(async () => root!.unmount())
  root = undefined
  host.remove()
  // A stale value never shows through a non-ready status.
  const failed = await openMeter(MANIFEST, 'error')
  expect(failed.textContent).toContain('Context unavailable')
  expect(failed.textContent).not.toContain('100K / 1M')
})

it('shows the measured request: its model, basis and estimate total beside the reported one', async () => {
  const panel = await openMeter({ ...MANIFEST, model: 'glm-measured', usage: { last: { inputTokens: 139_100 }, cacheableInputTokens: 0, cachedInputTokens: 0 } })
  expect(panel.textContent).toContain('Last requestreported')
  expect(panel.textContent).toContain('Modelglm-measured')
  expect(panel.textContent).toContain('Estimate total100K')
  await act(async () => root!.unmount())
  root = undefined
  host.remove()
  const estimated = await openMeter(MANIFEST)
  expect(estimated.textContent).toContain('Last requestestimated')
  expect(estimated.textContent).not.toContain('Estimate total')
})

it('shows the auto-compact trigger only when the host reports a policy', async () => {
  const withPolicy = await openMeter({ ...MANIFEST, budget: { ...MANIFEST.budget, preTrimTokens: 850_000 }, policy: { automaticCompactionPressure: 0.85 } })
  expect(withPolicy.textContent).toContain('Auto-compact trigger: 85% of input budget · auto-compacts at 85%')
  await act(async () => root!.unmount())
  root = undefined
  host.remove()
  const without = await openMeter(MANIFEST)
  expect(without.textContent).not.toContain('Auto-compact')
})

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
  expect(panel.textContent).toContain('Estimated source tokens (chars/4)')
  expect(panel.textContent).toContain('Session average cache hit rate99%')
})

it('trigger draws a fill arc, and a dashed ring (no arc) before any request', async () => {
  await openMeter(MANIFEST)
  const filled = host.querySelector('button')!
  expect(filled.querySelectorAll('circle')).toHaveLength(2)
  await act(async () => root!.unmount())
  host.remove()
  await openMeter(null)
  const empty = host.querySelector('button')!
  expect(empty.querySelectorAll('circle')).toHaveLength(1)
  expect(empty.querySelector('circle')!.getAttribute('stroke-dasharray')).not.toBeNull()
})

it('marks an estimate and says when no request has run yet', async () => {
  const estimated = await openMeter(MANIFEST)
  expect(estimated.textContent).toContain('100K / 1M')
  expect(estimated.textContent).not.toContain('~')
  expect(estimated.textContent).toContain('Session average cache hit rate—')
  await act(async () => root!.unmount())
  root = undefined
  host.remove()
  const empty = await openMeter(null)
  expect(empty.textContent).toContain('No recorded request context for this conversation.')
})
