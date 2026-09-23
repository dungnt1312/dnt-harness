import type { SseEvent } from './types.ts'

/** Last durable turn boundary plus explicit compaction, not streaming token count. */
export function manifestRefreshKey(events: readonly Pick<SseEvent, 'seq' | 'type'>[], compactNonce: number): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'turn/end') return `${event.seq}:${compactNonce}`
  }
  return `0:${compactNonce}`
}
