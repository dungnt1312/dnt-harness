import type { Context } from '../../kernel/context.ts'
import { DEFAULT_LIMITS, resolveLimits, type HarnessLimits } from '../limits.ts'
import type { LimitsReader, LimitsSnapshot } from './types.ts'

function isLimitsReader(value: unknown): value is LimitsReader {
  return value !== null && typeof value === 'object' && typeof (value as { read?: unknown }).read === 'function'
}

function freezeSnapshot(values: HarnessLimits): LimitsSnapshot {
  return Object.freeze({ revision: 0, values: Object.freeze({ ...values }) })
}

/** Library-default snapshot shared by every context without any limits service. */
const DEFAULT_SNAPSHOT = freezeSnapshot(DEFAULT_LIMITS)
/** Legacy static limits objects never change after mount, so one snapshot each suffices. */
const legacySnapshots = new WeakMap<object, LimitsSnapshot>()

/**
 * Capture the current limits snapshot at an operation boundary. Prefers the
 * host-mounted `limits-reader`; without one, resolves the legacy static
 * `limits` service (or library defaults) as a frozen revision-0 snapshot so
 * hosts that never mount the reader keep their startup behavior. Repeated
 * fallback reads return the same snapshot. A mounted reader lacking `read()`
 * is a wiring error and throws rather than silently falling back.
 */
export function readLimits(ctx: Context): LimitsSnapshot {
  const reader = ctx.get('limits-reader')
  if (reader !== undefined) {
    if (!isLimitsReader(reader)) throw new TypeError("'limits-reader' service does not implement read()")
    return reader.read()
  }
  const legacy = ctx.get('limits')
  if (legacy === null || typeof legacy !== 'object') return DEFAULT_SNAPSHOT
  let snapshot = legacySnapshots.get(legacy)
  if (snapshot === undefined) {
    snapshot = freezeSnapshot(resolveLimits(legacy as Partial<HarnessLimits>))
    legacySnapshots.set(legacy, snapshot)
  }
  return snapshot
}
