import { describe, expect, it } from 'vitest'
import { describeRoleModel, ModelAliasError, resolveChildModel } from '../../src/web/agent-delegation.ts'
import type { ModelAlias } from '../../src/web/provider-store.ts'

const alias = (thinkingLevel: ModelAlias['thinkingLevel'] = 'high'): ModelAlias => ({ name: 'fast', provider: 'p2', model: 'gpt-5', thinkingLevel, revision: 1 })
const deps = (entry: ModelAlias | null = alias()) => ({
  parent: { provider: 'p1', model: 'sonnet-4', thinkingLevel: 'medium' },
  providers: ['p1', 'p2'],
  modelsOf: (provider: string) => provider === 'p1' ? ['sonnet-4', 'fast'] : ['gpt-5'],
  validate: (provider: string, model: string) => { if (provider !== 'p1' && provider !== 'p2') throw new Error('disabled provider'); if (!((provider === 'p1' ? ['sonnet-4', 'fast'] : ['gpt-5']).includes(model))) throw new Error('removed model') },
  alias: (name: string) => name === entry?.name ? entry : undefined,
})

describe('global model aliases', () => {
  it('resolves explicit alias before role and bare models', () => {
    expect(resolveChildModel(' fast ', 'sonnet', deps())).toEqual({ provider: 'p2', model: 'gpt-5', thinkingLevel: 'high' })
    expect(resolveChildModel(undefined, 'fast', deps())).toEqual({ provider: 'p2', model: 'gpt-5', thinkingLevel: 'high' })
    expect(resolveChildModel('p1:fast', undefined, deps())).toEqual({ provider: 'p1', model: 'fast', thinkingLevel: 'medium' })
  })

  it('keeps null thinking instead of inheriting parent thinking', () => {
    expect(resolveChildModel('fast', undefined, deps(alias(null)))).toEqual({ provider: 'p2', model: 'gpt-5', thinkingLevel: null })
  })

  it('fails closed and role display is blocking for an invalid present alias', () => {
    const broken = { ...alias(), provider: 'missing' }
    expect(() => resolveChildModel(undefined, 'fast', deps(broken))).toThrow(ModelAliasError)
    expect(describeRoleModel('fast', deps(broken))).toMatchObject({ alias: 'fast', inherit: false, blocked: true })
  })

  it('deletion restores legacy bare-model semantics', () => {
    expect(resolveChildModel('fast', undefined, deps(null))).toEqual({ provider: 'p1', model: 'fast', thinkingLevel: 'medium' })
  })
})
