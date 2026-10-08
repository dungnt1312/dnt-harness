import type { SseEvent } from './types.ts'

/**
 * Events that change what the context meter shows. `context/manifest` is
 * recorded the moment a request is assembled, before the model answers, so the
 * meter fills as soon as the user sends. `step/end`/`step/abandoned` mark the
 * point where the provider has reported that request's real prompt count, and
 * `turn/end` closes the turn. Streaming chunks never change the key.
 */
const REFRESH_TYPES: ReadonlySet<string> = new Set(['context/manifest', 'step/end', 'step/abandoned', 'turn/end'])

/** Last request/step/turn boundary plus explicit compaction, not streaming token count. */
export function manifestRefreshKey(events: readonly Pick<SseEvent, 'seq' | 'type'>[], compactNonce: number): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event !== undefined && REFRESH_TYPES.has(event.type)) return `${event.seq}:${compactNonce}`
  }
  return `0:${compactNonce}`
}
