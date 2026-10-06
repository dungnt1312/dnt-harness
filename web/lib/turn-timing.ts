/**
 * Per-turn wall-clock boundaries, projected from the durable log — the same
 * contract as `turnChanges()`: no request of its own, nothing inferred beyond
 * what the log recorded. `turn/start` stamps when the reader's message opened
 * the turn; `turn/end` stamps when the answer finished. The transcript renders
 * the start on the user bubble and the end plus span on the turn footer.
 */
import type { SseEvent } from './types.ts'

/** When one recorded turn opened and closed. */
export interface TurnTiming {
  /** Wall-clock time of the turn's `turn/start`, if stamped. */
  readonly startedAt?: number
  /** Wall-clock time of the turn's `turn/end`, if stamped. */
  readonly endedAt?: number
}

/**
 * Turn membership is positional, exactly like `projectItems()`: a boundary
 * belongs to the turn open at its position in the replay. Both stamps are
 * kept as recorded — whether they make a sensible span is the renderer's
 * call, so a skewed clock can shorten a label instead of inventing time.
 */
export function turnTimings(events: readonly SseEvent[]): ReadonlyMap<string, TurnTiming> {
  const timings = new Map<string, TurnTiming>()
  let openTurnId: string | undefined
  for (const event of events) {
    if (event.type === 'turn/start' && event.turnId !== undefined && event.turnId !== '') {
      openTurnId = event.turnId
      if (!timings.has(openTurnId)) {
        timings.set(openTurnId, { ...(event.timestamp !== undefined ? { startedAt: event.timestamp } : {}) })
      }
    } else if (event.type === 'turn/end') {
      const turnId = event.turnId !== undefined && event.turnId !== '' ? event.turnId : openTurnId
      if (turnId !== undefined) {
        const startedAt = timings.get(turnId)?.startedAt
        timings.set(turnId, {
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(event.timestamp !== undefined ? { endedAt: event.timestamp } : {}),
        })
      }
      openTurnId = undefined
    }
  }
  return timings
}
