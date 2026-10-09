import { describe, expect, it } from 'vitest'
import { BUNDLED_MODES, KNOWN_MODE_TOOLS } from '../../src/harness/modes/bundled.ts'

describe('image tool mode exposure', () => {
  it('sits inside the exposure ceiling', () => {
    expect(KNOWN_MODE_TOOLS).toEqual(expect.arrayContaining(['GenerateImage', 'EditImage', 'DescribeImage']))
  })

  it('exposes the read-like DescribeImage tool automatically in every bundled mode', () => {
    for (const mode of BUNDLED_MODES) {
      expect(mode.toolExposure, mode.id).toContain('DescribeImage')
      expect(mode.permissionDefaults['DescribeImage'], mode.id).toBe('allow')
    }
  })

  it('asks before a paid call except in Full access, and stays out of read-only Plan', () => {
    const expected: Record<string, string | undefined> = {
      'ask-before-changes': 'ask',
      'edit-automatically': 'ask',
      'full-access': 'allow',
      plan: undefined,
    }
    for (const mode of BUNDLED_MODES) {
      for (const tool of ['GenerateImage', 'EditImage']) {
        expect(mode.permissionDefaults[tool], `${mode.id} ${tool}`).toBe(expected[mode.id])
        expect(mode.toolExposure.includes(tool), `${mode.id} ${tool}`).toBe(expected[mode.id] !== undefined)
      }
    }
  })
})
