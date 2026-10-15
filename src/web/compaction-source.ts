import { isCompletedCompactionBoundary, recoverCanonicalCheckpoint } from '../harness/context/compaction.ts'
import { compactionSeedHash } from '../harness/context/compaction-digest.ts'
import { validateSnapshot, type EffectiveCompactionSnapshot, type SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import type { SessionEvent } from '../harness/session/events.ts'

/**
 * Which source a compaction summarizes from. Pure: it reads the durable log and
 * the candidates it is handed, and returns exactly one decision. With no usable
 * snapshot the decision is to fold the shortened transcript: slower, never asked.
 */

export type SourceChoice =
  | { readonly kind: 'snapshot'; readonly snapshot: EffectiveCompactionSnapshot; readonly path: 'exact' | 'reconstructed' }
  /** The newest closed turn is already covered by the checkpoint that stands. */
  | { readonly kind: 'noop'; readonly reason: 'already-compacted'; readonly cutoff: number }
  | { readonly kind: 'fold'; readonly reason: 'no-eligible-snapshot'; readonly cutoff: number }
  | { readonly kind: 'unavailable'; readonly reason: 'open-turn' | 'no-completed-turn' }

export interface ChooseInput {
  /** Durably committed events. */
  readonly events: readonly SessionEvent[]
  /** The newest captured-and-persisted snapshot, if any. */
  readonly exact?: EffectiveCompactionSnapshot | undefined
  /** A snapshot rebuilt from the committed log with the ordinary context builder, if any. */
  readonly reconstructed?: EffectiveCompactionSnapshot | undefined
  /** What a snapshot must have been built for: provider, model, mode, grants, policy. */
  readonly identity: SnapshotIdentity
}

/** Newest turn/end of a log whose turns are all closed, or why there is none. */
function newestClosedCutoff(events: readonly SessionEvent[]): { cutoff: number } | { reason: 'open-turn' | 'no-completed-turn' } {
  let open = false
  let cutoff = 0
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') { open = false; cutoff = event.seq }
  }
  if (open) return { reason: 'open-turn' }
  if (cutoff === 0 || !isCompletedCompactionBoundary(events, cutoff)) return { reason: 'no-completed-turn' }
  return { cutoff }
}

/**
 * Identity fields that decide whether a snapshot still describes what the session may see.
 * Provider, model and thinking level are not among them: they change who writes the summary
 * and what the prompt cache holds, not what is summarized, so the host sends the snapshot to
 * the model selected now.
 */
function sameIdentity(a: SnapshotIdentity, b: SnapshotIdentity): boolean {
  return a.modeHash === b.modeHash && a.grantsHash === b.grantsHash && a.policyVersion === b.policyVersion
}

function usable(snapshot: EffectiveCompactionSnapshot | undefined, events: readonly SessionEvent[], standing: number, standingSeed: string | undefined, identity: SnapshotIdentity): snapshot is EffectiveCompactionSnapshot {
  if (snapshot === undefined) return false
  // A snapshot at or before the checkpoint that stands would summarize what is already summarized.
  if (snapshot.cutoff <= standing) return false
  // Adoption's rule: built on exactly the checkpoint that stands now. A cutoff before that
  // checkpoint's own compaction events was seeded by an older one; refuse before any model call.
  if (snapshot.seedHash !== standingSeed) return false
  if (!sameIdentity(snapshot.identity, identity)) return false
  return validateSnapshot(snapshot, events).ok
}

export function chooseCompactionSource(input: ChooseInput): SourceChoice {
  const newest = newestClosedCutoff(input.events)
  if ('reason' in newest) return { kind: 'unavailable', reason: newest.reason }
  const checkpoint = recoverCanonicalCheckpoint(input.events)
  const standing = checkpoint?.coversSeq ?? 0
  const seed = checkpoint === undefined ? undefined : compactionSeedHash(checkpoint.summary)
  if (standing >= newest.cutoff) return { kind: 'noop', reason: 'already-compacted', cutoff: standing }
  if (usable(input.exact, input.events, standing, seed, input.identity)) return { kind: 'snapshot', snapshot: input.exact, path: 'exact' }
  if (usable(input.reconstructed, input.events, standing, seed, input.identity)) return { kind: 'snapshot', snapshot: input.reconstructed, path: 'reconstructed' }
  return { kind: 'fold', reason: 'no-eligible-snapshot', cutoff: newest.cutoff }
}
