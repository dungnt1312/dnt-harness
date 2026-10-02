/**
 * The shared model catalog: exact-ID capabilities, the context-limit
 * resolution chain, and the documented thinking overrides.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_LIMIT,
  applyThinkingOverride,
  bareModelId,
  defaultThinkingLevel,
  formatContextLimit,
  getModelInfo,
  getReasoningCapability,
  isThinkingLevel,
  knownModelLimit,
  resolveContextLimit,
  supportsReasoningControl,
} from 'dnt-harness'

describe('model catalog metadata', () => {
  it('exact IDs return verified capabilities', () => {
    const glm = getModelInfo('glm-5.2')
    expect(glm?.contextTokens).toBe(1_000_000)
    expect(glm?.vision).toBe(false)
    expect(glm?.reasoning?.levels).toEqual(['high', 'max'])
    expect(getModelInfo('gpt-5.6-sol')?.contextTokens).toBe(1_048_576)
    expect(getModelInfo('gemini-2.5-pro')?.vision).toBe(true)
  })

  it('patterns cover dated/region variants and gateway namespaces', () => {
    expect(getModelInfo('GLM-5.2-2026-07-11')?.contextTokens).toBe(1_000_000)
    expect(getModelInfo('openai/gpt-5.6')?.contextTokens).toBe(1_048_576)
    expect(knownModelLimit('cliproxy/grok-4.5')).toBe(500_000)
    expect(bareModelId('cliproxy/grok-4.5')).toBe('grok-4.5')
  })

  it('unknown models claim nothing', () => {
    expect(getModelInfo('totally-unknown-llm')).toBeNull()
    expect(knownModelLimit('totally-unknown-llm')).toBeNull()
  })

  it('gpt/claude/gemini families default to vision for unknown releases', () => {
    // Family vision default (verified: every documented GPT-5.x / Claude /
    // Gemini model accepts images) — context still via the family heuristic.
    expect(getModelInfo('gpt-5.9-future')?.vision).toBe(true)
    expect(getModelInfo('gateway/claude-opus-4.8')?.vision).toBe(true)
    expect(getModelInfo('kiro-claude-haiku')?.vision).toBe(true)
    expect(getModelInfo('gemini-4-flash')?.vision).toBe(true)
    expect(getModelInfo('gpt-5.9-future')?.contextTokens).toBeUndefined()
    expect(resolveContextLimit('gateway/claude-opus-4.8')).toBe(1_048_576)
    // The one Claude SKU with the 200k window.
    expect(getModelInfo('claude-haiku-4.5')?.contextTokens).toBe(200_000)
    expect(getModelInfo('claude-haiku-4.5-20251001')?.vision).toBe(true)
    // GLM is not in the vision fallback — an unknown GLM stays honestly
    // 'unknown' rather than claiming (or denying) image input.
    expect(getModelInfo('glm-5.3-when-it-ships')?.vision).toBe('unknown')
  })
})

describe('context limit resolution', () => {
  it('catalog beats family heuristic beats default', () => {
    expect(resolveContextLimit('glm-5')).toBe(200_000) // catalog exact
    expect(resolveContextLimit('qwen3.7-max')).toBe(128_000) // heuristic
    expect(resolveContextLimit('totally-unknown-llm')).toBe(DEFAULT_CONTEXT_LIMIT) // 256k
    expect(DEFAULT_CONTEXT_LIMIT).toBe(256_000)
  })

  it('formats compact UI labels', () => {
    expect(formatContextLimit(200_000)).toBe('200k')
    expect(formatContextLimit(1_048_576)).toBe('1M')
    expect(formatContextLimit(153_600)).toBe('153.6k')
    expect(formatContextLimit(0)).toBe('')
  })
})

describe('reasoning capability', () => {
  it('the composer control only appears for transport-supported models', () => {
    expect(supportsReasoningControl('gpt-5.6')).toBe(true)
    expect(supportsReasoningControl('glm-5.2')).toBe(true)
    // Gemini 3.x needs an adapter the completions transport does not have.
    expect(supportsReasoningControl('gemini-3.6-flash')).toBe(false)
    // Always-on models expose no useful user control.
    expect(supportsReasoningControl('kimi-k2.7-code')).toBe(false)
    expect(supportsReasoningControl('no-such-model')).toBe(false)
  })

  it('default level prefers medium, then high, then the highest, else off', () => {
    expect(defaultThinkingLevel({ levels: ['low', 'medium', 'high'], canDisable: true })).toBe('medium')
    expect(defaultThinkingLevel({ levels: ['low', 'high'], canDisable: false })).toBe('high')
    expect(defaultThinkingLevel({ levels: ['high', 'max'], canDisable: true })).toBe('high')
    expect(defaultThinkingLevel({ levels: [], canDisable: false })).toBe('off')
  })

  it('validates thinking level values', () => {
    expect(isThinkingLevel('xhigh')).toBe(true)
    expect(isThinkingLevel('auto')).toBe(false)
    expect(isThinkingLevel(3)).toBe(false)
    expect(getReasoningCapability('grok-4.3')?.canDisable).toBe(true)
  })
})

describe('applyThinkingOverride', () => {
  const body = (): Record<string, unknown> => ({})

  it('gpt-5.6 maps off→none and effort levels directly', () => {
    const off = body()
    applyThinkingOverride(off, 'gpt-5.6-sol', 'off')
    expect(off).toEqual({ reasoning_effort: 'none' })
    const max = body()
    applyThinkingOverride(max, 'GPT-5.6', 'max')
    expect(max).toEqual({ reasoning_effort: 'max' })
  })

  it('glm hybrid control: off disables, high/max set effort', () => {
    const off = body()
    applyThinkingOverride(off, 'glm-5.2', 'off')
    expect(off).toEqual({ thinking: { type: 'disabled' } })
    const high = body()
    applyThinkingOverride(high, 'glm-5.2', 'high')
    expect(high).toEqual({ reasoning_effort: 'high' })
    const older = body()
    applyThinkingOverride(older, 'glm-4.7', 'off')
    expect(older).toEqual({ thinking: { type: 'disabled' } })
  })

  it('qwen hybrid toggle never fakes effort levels', () => {
    const on = body()
    applyThinkingOverride(on, 'qwen3.7-max', 'high')
    expect(on).toEqual({ enable_thinking: true })
    const off = body()
    applyThinkingOverride(off, 'qwen3.7-plus', 'off')
    expect(off).toEqual({ enable_thinking: false })
  })

  it('gateway claude maps effort to extended-thinking budgets', () => {
    const high = body()
    applyThinkingOverride(high, 'kiro-claude-sonnet', 'high')
    expect(high).toEqual({ thinking: { type: 'enabled', budget_tokens: 16_000 } })
    const off = body()
    applyThinkingOverride(off, 'claude-opus-5', 'off')
    expect(off).toEqual({ thinking: { type: 'disabled' } })
  })

  it('family fallbacks cover gateway aliases; unsupported pairs stay silent', () => {
    const deep = body()
    applyThinkingOverride(deep, 'custom-deepseek-v4-mini', 'low')
    expect(deep).toEqual({ reasoning_effort: 'low' })
    const grok = body()
    applyThinkingOverride(grok, 'my-grok-4.3-turbo', 'off')
    expect(grok).toEqual({ reasoning_effort: 'none' })
    const untouched = body()
    applyThinkingOverride(untouched, 'totally-unknown-llm', 'high')
    expect(untouched).toEqual({})
    const empty = body()
    applyThinkingOverride(empty, 'gpt-5.6', undefined)
    applyThinkingOverride(empty, 'gpt-5.6', 'auto')
    expect(empty).toEqual({})
  })
})
