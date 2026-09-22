import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, PRESET_IDS } from '../../src/harness/guard/defaults.ts'

describe('guard defaults', () => {
  it('has 6 presets with correct defaults', () => {
    expect(PRESET_IDS).toHaveLength(6)
    expect(DEFAULT_CONFIG.presets.fsDestructive).toBe('deny')
    expect(DEFAULT_CONFIG.presets.gitDestructive).toBe('ask')
    expect(DEFAULT_CONFIG.presets.systemPriv).toBe('ask')
    expect(DEFAULT_CONFIG.presets.networkExfil).toBe('deny')
    expect(DEFAULT_CONFIG.presets.dbDestructive).toBe('ask')
    expect(DEFAULT_CONFIG.presets.resourceExhaust).toBe('deny')
  })
  it('has v:1 and empty customRules', () => {
    expect(DEFAULT_CONFIG.v).toBe(1)
    expect(DEFAULT_CONFIG.customRules).toEqual([])
  })
})
