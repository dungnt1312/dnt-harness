import { describe, expect, it } from 'vitest'
import { assertHardContainmentAvailable, containmentCapability, minimalStdioEnv } from 'dnt-harness'

describe('stdio process policy', () => {
  it('drops ambient secrets and does not claim a hard sandbox', async () => {
    const previous = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'sekret'
    try {
      const env = minimalStdioEnv({ FIXTURE_ENV: 'kept' })
      expect(env['OPENAI_API_KEY']).toBeUndefined()
      expect(env['FIXTURE_ENV']).toBe('kept')
      expect(env['PATH'] ?? env['Path']).toBeTruthy()
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY']
      else process.env['OPENAI_API_KEY'] = previous
    }
    const report = await containmentCapability()
    expect(report.level === 'hard' || report.level === 'best_effort').toBe(true)
    if (report.level !== 'hard') await expect(assertHardContainmentAvailable()).rejects.toThrow(/containment_unavailable/)
  })
})
