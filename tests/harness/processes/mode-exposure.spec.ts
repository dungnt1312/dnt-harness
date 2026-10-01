import { describe, expect, it } from 'vitest'
import { BUNDLED_MODES } from '../../../src/harness/modes/bundled.ts'

describe('bundled modes expose the background process tools with Bash', () => {
  it.each(BUNDLED_MODES.map((mode) => [mode.id, mode] as const))('%s', (_id, mode) => {
    if (!mode.toolExposure.includes('Bash')) return
    expect(mode.toolExposure).toContain('BashOutput')
    expect(mode.toolExposure).toContain('KillShell')
    expect(mode.permissionDefaults?.BashOutput).toBe('allow')
    expect(mode.permissionDefaults?.KillShell).toBe('allow')
  })
})
