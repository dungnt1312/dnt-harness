import { isValidContextId, isValidTokenUsage } from '../../src/harness/context/context-metrics.ts'
import type { SseEvent } from './types.ts'

/**
 * Events that change what the context meter shows. `context/manifest` is
 * recorded the moment a request is assembled, before the model answers, so the
 * meter fills as soon as the user sends. `step/end`/`step/abandoned` mark the
 * point where the provider has reported that request's real prompt count, and
 * `turn/end` closes the turn. `compaction/end` shrinks the window without any
 * request, so automatic compaction refreshes the meter too. Streaming chunks never change the key.
 */
const REFRESH_TYPES: ReadonlySet<string> = new Set(['context/manifest', 'step/end', 'step/abandoned', 'turn/end', 'compaction/end'])
const ATTEMPT_TYPES: ReadonlySet<string> = new Set(['model/attempt', 'execution/uncertain', 'execution/reconciled'])

/** A terminal attempt fact that carries a valid measurement for a known request. */
const isMeasurement = (event: Pick<SseEvent, 'type' | 'fact'>): boolean => {
  const fact = event.fact
  return ATTEMPT_TYPES.has(event.type) && fact !== undefined && fact.state !== 'start'
    && isValidContextId(fact.contextId) && isValidTokenUsage(fact.usage)
}

/** Last request/step/turn boundary, measurement or explicit compaction, not streaming token count. */
export function manifestRefreshKey(events: readonly Pick<SseEvent, 'seq' | 'type' | 'fact'>[], compactNonce: number): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event !== undefined && (REFRESH_TYPES.has(event.type) || isMeasurement(event))) return `${event.seq}:${compactNonce}`
  }
  return `0:${compactNonce}`
}
