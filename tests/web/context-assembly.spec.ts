import { describe, expect, it } from 'vitest'
import * as budget from '../../src/harness/context/budget.ts'
import { resolveContextLimit } from '../../src/harness/llm/model-catalog.ts'
import * as assembly from '../../src/web/context-assembly.ts'
import { BUNDLED_MODES, DEFAULT_MODE_ID } from '../../src/index.ts'

describe('shared assembly preparation', () => {
  it('holds preview prefix privately until commit and reuses it for dispatch', async () => {
    let current: assembly.PrefixSnapshot | undefined
    let reads = 0
    const scope = { sessionId: 's' as never, workspaceId: 'w' as never }
    const mode = { definition: BUNDLED_MODES.find(m => m.id === DEFAULT_MODE_ID)!, source: 'bundled' as const }
    const deps: assembly.ContextAssemblyDeps = {
      resolve: async () => ({ input: { mode, modeRevision: 1, model: 'scripted', providerName: 'scripted', schemas: [], budget: budget.DEFAULT_BUDGET },
        controls: { model: 'scripted', provider: 'scripted', nativeVision: true }, revision: 'r', prefixKey: 'p:4' }),
      catalog: async () => { reads++; return [{ name: 'x', description: 'x' }] },
      memory: async () => [], skills: async () => [], attachments: async () => undefined,
      prefix: () => ({ ...(current !== undefined ? { current } : {}), install: value => { current = value } }),
      validate: async () => {},
    }
    const preview = await assembly.prepareContextAssembly({ scope, events: [], signal: new AbortController().signal, purpose: 'preview' }, deps)
    expect(current).toBeUndefined()
    preview.commitPrefix()
    expect(current?.key).toBe('p:4')
    await assembly.prepareContextAssembly({ scope, events: [], signal: new AbortController().signal, purpose: 'dispatch' }, deps)
    expect(reads).toBe(1)
  })
})

describe('shared model context budget', () => {
  it('respects operator override while preserving reply reserve and margin', () => {
    expect(budget.resolveModelBudget({ model: 'scripted', contextTokens: 32_768 })).toMatchObject({
      contextLimitTokens: 32_768, outputReserveTokens: 4_096, marginTokens: 1_024, windowSource: 'override',
    })
  })
  it.each([NaN,0,-1])('ignores invalid override %s and reports fallback provenance', contextTokens => {
    expect(budget.resolveModelBudget({ model: 'scripted', contextTokens })).toMatchObject({
      contextLimitTokens: 256_000, windowSource: 'fallback',
    })
  })
  it('preserves catalog family limits for namespaced models', () => {
    expect(budget.resolveModelBudget({ model: 'cliproxy/claude-sonnet-5-5' }).contextLimitTokens).toBe(resolveContextLimit('cliproxy/claude-sonnet-5-5'))
    expect(budget.resolveModelBudget({ model: 'cliproxy/claude-sonnet-5-5' }).windowSource).not.toBe('fallback')
  })
})
