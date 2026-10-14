/**
 * The limits the shipped web bin boots with. Embedded hosts keep the library defaults; only the
 * bin opts in, so these are tested where the bin reads them.
 */
import { describe, expect, it } from 'vitest'
import { resolveLimits } from '../../src/harness/limits.ts'
import { WEB_BIN_LIMITS } from '../../src/bins/web-limits.ts'

describe('web bin limits', () => {
  it('keeps the automatic compaction threshold unchanged', () => {
    expect(resolveLimits(WEB_BIN_LIMITS).automaticCompactionPressure).toBe(0.85)
  })

  it('turns the one-request compaction path on, and leaves background precompute off', () => {
    const limits = resolveLimits(WEB_BIN_LIMITS)
    expect(limits.compactionEffectiveEnabled).toBe(true)
    expect(limits.compactionPrecomputeEnabled).toBe(false)
  })

  it('does not change the library defaults other hosts embed', () => {
    const defaults = resolveLimits(undefined)
    expect(defaults.compactionEffectiveEnabled).toBe(false)
    expect(defaults.automaticCompactionPressure).toBe(0)
  })
})
