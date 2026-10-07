import type { Context } from '../../kernel/context.ts'
import { resolveLimits, type HarnessLimits } from '../limits.ts'
import type { LimitsReader, LimitsSnapshot } from './types.ts'

function isLimitsReader(value: unknown): value is LimitsReader {
  return value !== null && typeof value === 'object' && typeof (value as { read?: unknown }).read === 'function'
}

/**
 * Capture the current limits snapshot at an operation boundary. Prefers the
 * host-mounted `limits-reader`; without one, resolves the legacy static
 * `limits` service (or library defaults) as a frozen revision-0 snapshot so
 * hosts that never mount the reader keep their startup behavior.
 */
export function readLimits(ctx: Context): LimitsSnapshot {
  const reader = ctx.get('limits-reader')
  if (isLimitsReader(reader)) return reader.read()
  const legacy = ctx.get('limits') as Partial<HarnessLimits> | undefined
  return Object.freeze({ revision: 0, values: Object.freeze({ ...resolveLimits(legacy ?? undefined) }) })
}
