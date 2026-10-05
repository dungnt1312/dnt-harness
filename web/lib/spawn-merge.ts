/**
 * One delegation spawns one row: the tool call that launched a child and the
 * delegation row that tracks it are the same act, so the call row gives way.
 *
 * Both sides must survive the log's restart recovery: a spawn call whose
 * result never recorded (the host died mid-spawn) keeps its row — its digest
 * is the only trace that something was attempted — and a delegation projected
 * from a legacy log without its spawn call loses nothing. A call for an Agent
 * action that answers without a delegation row (wait, cancel, reconcile,
 * catalog, list) is never merged, nor is a spawn that ended in an error the
 * delegation row cannot show.
 */
import type { SseEvent } from './types.ts'

/**
 * The call ids whose tool row is absorbed by the delegation row that tracks
 * the same child: a spawn call whose recorded result answered with a child
 * session id the parent's log confirms as spawned. A spawn whose result
 * never recorded, or whose child was never spawned, keeps its row.
 */
export function hiddenSpawnCalls(events: readonly SseEvent[]): ReadonlySet<string> {
  const hidden = new Set<string>()
  const spawnCalls = new Set<string>()
  const childOfCall = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.call !== undefined && event.call.name.toLowerCase() === 'agent') {
      const action = typeof event.call.args['action'] === 'string' ? event.call.args['action'] : 'spawn'
      if (action === 'spawn') spawnCalls.add(event.call.id)
    }
    if (event.type === 'tool/result' && event.ok === true && event.callId !== undefined && spawnCalls.has(event.callId)) {
      let childId: unknown
      try { childId = JSON.parse(event.output ?? '')['childSessionId'] } catch { childId = undefined }
      if (typeof childId === 'string' && childId !== '') childOfCall.set(event.callId, childId)
    }
  }
  if (childOfCall.size === 0) return hidden
  const callOfChild = new Map([...childOfCall].map(([callId, childId]) => [childId, callId]))
  for (const event of events) {
    if (event.type !== 'agent/child-spawn') continue
    const callId = event.childSessionId === undefined ? undefined : callOfChild.get(event.childSessionId)
    if (callId !== undefined) hidden.add(callId)
  }
  return hidden
}
