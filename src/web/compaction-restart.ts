import type { EffectiveCompactionSnapshot } from '../harness/context/compaction-snapshot.ts'
import type { SessionEvent } from '../harness/session/events.ts'
import type { CompactionSnapshotStore } from '../harness/storage/compaction-snapshot-store.ts'

/**
 * Recovering the snapshot a session held before a restart. The in-memory
 * capture is gone; what remains is the durable `context/snapshot` reference in
 * the log and the sidecar it names. The log is the authority: a reference is
 * only a pointer, and the store re-checks the hash and re-validates the
 * snapshot against the committed events before handing it back.
 */

export interface NewestReference {
  readonly id: string
  readonly hash: string
  readonly cutoff: number
}

/** The last `context/snapshot` reference in a log, if any. */
export function newestSnapshotReference(events: readonly SessionEvent[]): NewestReference | undefined {
  const event = events.findLast((candidate) => candidate.type === 'context/snapshot')
  if (event?.type !== 'context/snapshot') return undefined
  return { id: event.snapshotId, hash: event.hash, cutoff: event.cutoff }
}

/**
 * The snapshot the newest reference names, or undefined when there is none,
 * the sidecar is missing/corrupt/tampered, or the covered log no longer
 * matches. Undefined is never an error: the caller then asks for recovery
 * instead of summarizing from something it cannot verify.
 */
export async function loadReferencedSnapshot(store: CompactionSnapshotStore, sessionId: string, events: readonly SessionEvent[]): Promise<EffectiveCompactionSnapshot | undefined> {
  const reference = newestSnapshotReference(events)
  if (reference === undefined) return undefined
  return await store.load(sessionId, { id: reference.id, hash: reference.hash }, events)
}
