import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, resolveLimits, isValidLimit, type HarnessLimits } from '../../src/harness/limits.ts'
import { LIMIT_FIELDS, WEB_LIMIT_DEFAULTS, parseLimitOverrides, type LimitField, type LimitKey } from '../../src/harness/limits-config.ts'
import { MAX_TIMER_MS } from '../../src/harness/processes/shutdown.ts'

const KEYS = Object.keys(DEFAULT_LIMITS) as LimitKey[]
/** The six keys that historically accept whole numbers only; mirrored here on purpose so metadata drift is caught. */
const INTEGER_KEYS: readonly LimitKey[] = ['streamFirstEventMs', 'streamIdleMs', 'logicalRequestMs', 'stepRetries', 'stepRetryBaseMs', 'compactionTailTurns']
/** The only keys where 0 is an accepted value ("off switch"). */
const ZERO_KEYS: readonly LimitKey[] = ['automaticCompactionPressure', 'compactionTailTurns']
/** Independent component-owned copy matrix pinned by the plan contract (group/unit per field). */
const META: Record<LimitKey, { group: LimitField['group']; unit: LimitField['unit'] }> = {
  streamFirstEventMs: { group: 'requests', unit: 'ms' },
  streamIdleMs: { group: 'requests', unit: 'ms' },
  logicalRequestMs: { group: 'requests', unit: 'ms' },
  stepRetries: { group: 'requests', unit: 'count' },
  stepRetryBaseMs: { group: 'requests', unit: 'ms' },
  delegationJoinMs: { group: 'requests', unit: 'ms' },
  toolTimeoutMs: { group: 'tools', unit: 'ms' },
  bashMaxWaitMs: { group: 'tools', unit: 'ms' },
  subagentBackgroundBashMaxMs: { group: 'tools', unit: 'ms' },
  approvalExpiryMs: { group: 'tools', unit: 'ms' },
  questionExpiryMs: { group: 'tools', unit: 'ms' },
  toolOutputLimit: { group: 'context', unit: 'chars' },
  maxPendingInputs: { group: 'admission', unit: 'count' },
  automaticCompactionPressure: { group: 'context', unit: 'ratio' },
  compactionTailTurns: { group: 'context', unit: 'count' },
  maxAttachmentBytes: { group: 'admission', unit: 'bytes' },
  maxAttachmentsPerMessage: { group: 'admission', unit: 'count' },
  attachmentTextLimit: { group: 'context', unit: 'bytes' },
}
/** Every value class the strict parser and the shared predicate must agree on. */
const TABLE_VALUES: unknown[] = [undefined, null, NaN, Infinity, -Infinity, -1, 0, 0.5, MAX_TIMER_MS, MAX_TIMER_MS + 1]

describe('limits schema metadata', () => {
  it('covers every DEFAULT_LIMITS key exactly', () => {
    expect(LIMIT_FIELDS.map(f => f.key).sort()).toEqual(KEYS.slice().sort())
    // The plan text says 17 fields, but baseline cb6e177 already merged questionExpiryMs
    // (ask-user questions), so the baseline carries 18 limits; key-set equality governs.
    expect(LIMIT_FIELDS).toHaveLength(KEYS.length)
    expect(LIMIT_FIELDS).toHaveLength(18)
  })
  it('pins component-owned metadata per field', () => {
    expect(new Set(LIMIT_FIELDS.map(f => f.key)).size).toBe(LIMIT_FIELDS.length)
    for (const field of LIMIT_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0)
      expect(field.hint.length).toBeGreaterThan(0)
      expect(field.applies).toBe('next-operation')
      expect(field.minimum).toBe(0)
      expect(field.maximum).toBe(MAX_TIMER_MS)
      expect(field.group).toBe(META[field.key].group)
      expect(field.unit).toBe(META[field.key].unit)
      expect(field.integer).toBe(INTEGER_KEYS.includes(field.key))
      expect(field.exclusiveMinimum).toBe(!ZERO_KEYS.includes(field.key))
    }
  })
  it('documents the stepRetries clamp and byte-sliced attachment text', () => {
    const retries = LIMIT_FIELDS.find(f => f.key === 'stepRetries')!
    expect(retries.hint).toMatch(/total attempts to 4/)
    expect(retries.hint).toMatch(/at most 3/)
    const text = LIMIT_FIELDS.find(f => f.key === 'attachmentTextLimit')!
    expect(text.unit).toBe('bytes')
    expect(text.hint).toMatch(/bytes/)
    const output = LIMIT_FIELDS.find(f => f.key === 'toolOutputLimit')!
    expect(output.unit).toBe('chars')
    expect(output.hint).toMatch(/characters/)
  })
})

describe('WEB_LIMIT_DEFAULTS', () => {
  it('carries only the web compaction pressure default', () => {
    expect(WEB_LIMIT_DEFAULTS).toEqual({ automaticCompactionPressure: 0.85 })
    const asPartial: Readonly<Partial<HarnessLimits>> = WEB_LIMIT_DEFAULTS
    expect(asPartial).toBeTruthy()
  })
})

describe('parseLimitOverrides', () => {
  it('accepts zero pressure and zero tail', () => {
    expect(parseLimitOverrides({ automaticCompactionPressure: 0, compactionTailTurns: 0 })).toEqual({ automaticCompactionPressure: 0, compactionTailTurns: 0 })
  })
  it('normalises negative zero to zero on zero-capable keys', () => {
    const parsed = parseLimitOverrides({ compactionTailTurns: -0, automaticCompactionPressure: -0 })
    expect(Object.is(parsed.compactionTailTurns, 0)).toBe(true)
    expect(Object.is(parsed.automaticCompactionPressure, 0)).toBe(true)
  })
  it('rejects zero stepRetries, fractional streamIdleMs and unknown keys', () => {
    expect(() => parseLimitOverrides({ stepRetries: 0 })).toThrow()
    expect(() => parseLimitOverrides({ streamIdleMs: 1.5 })).toThrow()
    expect(() => parseLimitOverrides({ maxSubagents: 4 })).toThrow()
  })
  it('accepts legacy fractions on permissive keys', () => {
    expect(parseLimitOverrides({ toolTimeoutMs: 1.5 })).toEqual({ toolTimeoutMs: 1.5 })
    const overrides: Partial<HarnessLimits> = parseLimitOverrides({ delegationJoinMs: 0.25 })
    expect(overrides).toEqual({ delegationJoinMs: 0.25 })
  })
  it('accepts only plain objects', () => {
    expect(() => parseLimitOverrides(null)).toThrow()
    expect(() => parseLimitOverrides(undefined)).toThrow()
    expect(() => parseLimitOverrides([['toolTimeoutMs', 5]])).toThrow()
    expect(() => parseLimitOverrides(42)).toThrow()
    expect(() => parseLimitOverrides('toolTimeoutMs')).toThrow()
    class Spoof { toolTimeoutMs = 5 }
    expect(() => parseLimitOverrides(new Spoof())).toThrow()
    expect(parseLimitOverrides({})).toEqual({})
  })
  it('rejects the whole object when any value is invalid', () => {
    expect(() => parseLimitOverrides({ toolTimeoutMs: 1.5, streamIdleMs: 0 })).toThrow()
    expect(() => parseLimitOverrides({ maxPendingInputs: 7, maxSubagents: 2 })).toThrow()
  })
  it('returns a detached sparse object holding exactly the given keys', () => {
    const input = { toolTimeoutMs: 1.5, maxPendingInputs: 7 }
    const result = parseLimitOverrides(input)
    expect(Object.keys(result).sort()).toEqual(['maxPendingInputs', 'toolTimeoutMs'])
    expect(result).not.toBe(input)
    const mutableCopy = result as { -readonly [K in LimitKey]?: number }
    mutableCopy.toolTimeoutMs = 9
    expect(input.toolTimeoutMs).toBe(1.5)
  })
})

describe('isValidLimit', () => {
  it('narrows unknown values to number', () => {
    const value: unknown = 300_000
    if (isValidLimit('toolTimeoutMs', value)) {
      const ms: number = value
      expect(ms).toBe(300_000)
    } else throw new Error('expected a valid limit')
  })
  it('accepts zero only for pressure and tail', () => {
    for (const key of KEYS) expect(isValidLimit(key, 0)).toBe(ZERO_KEYS.includes(key))
  })
  it('accepts fractions only on non-integer keys', () => {
    for (const key of KEYS) expect(isValidLimit(key, 0.5)).toBe(!INTEGER_KEYS.includes(key))
  })
  it('accepts MAX_TIMER_MS everywhere and rejects overflow everywhere', () => {
    for (const key of KEYS) {
      expect(isValidLimit(key, MAX_TIMER_MS)).toBe(true)
      expect(isValidLimit(key, MAX_TIMER_MS + 1)).toBe(false)
      expect(parseLimitOverrides({ [key]: MAX_TIMER_MS } as unknown as Partial<HarnessLimits>)).toEqual({ [key]: MAX_TIMER_MS })
      expect(() => parseLimitOverrides({ [key]: MAX_TIMER_MS + 1 } as unknown as Partial<HarnessLimits>)).toThrow()
    }
  })
  it('rejects non-numeric and non-finite values for every key', () => {
    for (const key of KEYS) {
      expect(isValidLimit(key, undefined)).toBe(false)
      expect(isValidLimit(key, null)).toBe(false)
      expect(isValidLimit(key, NaN)).toBe(false)
      expect(isValidLimit(key, Infinity)).toBe(false)
      expect(isValidLimit(key, -Infinity)).toBe(false)
      expect(isValidLimit(key, -1)).toBe(false)
      expect(isValidLimit(key, '120000')).toBe(false)
    }
  })
})

describe('strict parser equals shared predicate with legacy fallback', () => {
  it.each(KEYS)('%s', key => {
    for (const value of TABLE_VALUES) {
      const input = { [key]: value } as unknown as Partial<HarnessLimits>
      const accepted = isValidLimit(key, value)
      if (accepted) {
        expect(parseLimitOverrides(input)).toEqual({ [key]: value })
      } else {
        expect(() => parseLimitOverrides(input)).toThrow()
      }
      // Programmatic resolveLimits keeps its permissive fallback: rejected values
      // stay at defaults, accepted values apply.
      const merged = resolveLimits(input)
      expect(merged[key]).toBe(accepted ? (value as number) : DEFAULT_LIMITS[key])
      expect(merged).toEqual(accepted ? { ...DEFAULT_LIMITS, [key]: value as number } : DEFAULT_LIMITS)
    }
  })
  it('rejected programmatic overrides leave DEFAULT_LIMITS untouched', () => {
    const rejected = { stepRetries: 0, streamIdleMs: 1.5, maxSubagents: 4, toolTimeoutMs: NaN } as unknown as Partial<HarnessLimits>
    expect(resolveLimits(rejected)).toEqual(DEFAULT_LIMITS)
  })
})

describe('public exports', () => {
  it('re-exports the limits schema surface from src/index.ts', async () => {
    const barrel = await import('../../src/index.ts')
    expect(typeof barrel.isValidLimit).toBe('function')
    expect(typeof barrel.parseLimitOverrides).toBe('function')
    expect(Array.isArray(barrel.LIMIT_FIELDS)).toBe(true)
    expect(barrel.WEB_LIMIT_DEFAULTS).toEqual({ automaticCompactionPressure: 0.85 })
  })
})
