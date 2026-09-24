import { describe, expect, it } from 'vitest'
import { effectiveThinking, expressibleThinkingLevel } from './model-info.ts'

describe('expressible thinking levels', () => {
  it('keeps a level only where the model documents it', () => {
    expect(expressibleThinkingLevel('glm-5.2', 'max')).toBe('max')
    expect(expressibleThinkingLevel('glm-5.2', 'off')).toBe('off')
    // glm-5.1 documents no explicit level, only a disable request.
    expect(expressibleThinkingLevel('glm-5.1', 'max')).toBeUndefined()
    expect(expressibleThinkingLevel('glm-5.1', 'off')).toBe('off')
    // grok-4.5 cannot disable thinking, so `off` is not a real request.
    expect(expressibleThinkingLevel('grok-4.5', 'off')).toBeUndefined()
    expect(expressibleThinkingLevel('grok-4.5', 'xhigh')).toBe('xhigh')
  })

  it('drops anything for a model with no usable control, or an unknown level', () => {
    expect(expressibleThinkingLevel('totally-unknown-llm', 'high')).toBeUndefined()
    expect(expressibleThinkingLevel('kimi-k2.7-code', 'high')).toBeUndefined()
    expect(expressibleThinkingLevel('glm-5.2', 'ultra')).toBeUndefined()
    expect(expressibleThinkingLevel('glm-5.2', null)).toBeUndefined()
    expect(expressibleThinkingLevel('glm-5.2', undefined)).toBeUndefined()
  })
})

describe('effective thinking across a model switch', () => {
  it('stops claiming an override the new model does not document', () => {
    // The saved level is Max on both sides of the switch; only the first
    // model can express it, so only the first request may claim it.
    expect(effectiveThinking('gpt-5.6', 'max', undefined)).toEqual({ level: 'max', fromOverride: true })
    expect(effectiveThinking('glm-5.1', 'max', undefined)).toEqual({ level: 'off', fromOverride: false, ignoredOverride: 'max' })
    expect(effectiveThinking('gemini-2.5-flash', 'max', undefined)).toEqual({ level: 'medium', fromOverride: false, ignoredOverride: 'max' })
  })

  it('reports a saved disable request as ignored where the model cannot disable', () => {
    expect(effectiveThinking('grok-4.5', 'off', undefined)).toEqual({ level: 'medium', fromOverride: false, ignoredOverride: 'off' })
  })

  it('shows an expressible per-model default instead of the catalog default', () => {
    expect(effectiveThinking('glm-5.2', null, { thinkingLevel: 'max' })).toEqual({ level: 'max', fromOverride: false })
    // A configured level the model does not document is not a request.
    expect(effectiveThinking('gemini-2.5-flash', null, { thinkingLevel: 'xhigh' })).toEqual({ level: 'medium', fromOverride: false })
  })

  it('prefers a usable override over the model default, and reports nothing to ignore otherwise', () => {
    expect(effectiveThinking('glm-5.2', 'high', { thinkingLevel: 'max' })).toEqual({ level: 'high', fromOverride: true })
    expect(effectiveThinking('glm-5.2', null, undefined)).toEqual({ level: 'high', fromOverride: false })
    expect(effectiveThinking('totally-unknown-llm', 'high', undefined)).toBeNull()
  })
})
