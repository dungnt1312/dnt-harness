import { describe, expect, it } from 'vitest'
import { BUNDLED_MODES, KNOWN_MODE_TOOLS } from '../../src/harness/modes/bundled.ts'

describe('TodoWrite mode exposure', () => {
  it('is exposed and auto-allowed in every bundled mode', () => {
    for (const mode of BUNDLED_MODES) {
      expect(mode.toolExposure, mode.id).toContain('TodoWrite')
      expect(mode.permissionDefaults['TodoWrite'], mode.id).toBe('allow')
    }
  })

  it('stays inside the exposure ceiling', () => {
    expect(KNOWN_MODE_TOOLS).toContain('TodoWrite')
  })
})
