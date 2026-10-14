import { isCompletedCompactionBoundary, recoverCanonicalCheckpoint } from '../harness/context/compaction.ts'
import { sourceDigest } from '../harness/context/compaction-digest.ts'
import { validateSnapshot, type EffectiveCompactionSnapshot, type SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import type { SessionEvent } from '../harness/session/events.ts'

/**
 * Which source a compaction summarizes from. Pure: it reads the durable log and
 * the candidates it is handed, and returns exactly one decision. There is no
 * "fold the raw transcript" outcome here — that is a slow recovery that must
 * be confirmed against the fingerprint this module computes.
 */

/** The legacy folder sends requests of about this many characters each. */
export const RAW_RECOVERY_CALL_ESTIMATE_CHARS = 200_000

/** What a caller must echo back to run the slow raw fold: bound to the exact source it was shown. */
export interface RecoveryConfirmation {
  readonly cutoff: number
  readonly sourceDigest: string
  readonly estimatedCalls: number
}

export type SourceChoice =
  | { readonly kind: 'snapshot'; readonly snapshot: EffectiveCompactionSnapshot; readonly path: 'exact' | 'reconstructed' }
  /** The newest closed turn is already covered by the checkpoint that stands. */
  | { readonly kind: 'noop'; readonly reason: 'already-compacted'; readonly cutoff: number }
  | { readonly kind: 'recovery-required'; readonly reason: 'no-eligible-snapshot'; readonly confirmation: RecoveryConfirmation }
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

/** Identity fields that decide whether a request prefix could be reused as-is. */
function sameIdentity(a: SnapshotIdentity, b: SnapshotIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.thinkingLevel === b.thinkingLevel
    && a.modeHash === b.modeHash && a.grantsHash === b.grantsHash && a.policyVersion === b.policyVersion
}

function usable(snapshot: EffectiveCompactionSnapshot | undefined, events: readonly SessionEvent[], standing: number, identity: SnapshotIdentity): snapshot is EffectiveCompactionSnapshot {
  if (snapshot === undefined) return false
  // A snapshot at or before the checkpoint that stands would summarize what is already summarized.
  if (snapshot.cutoff <= standing) return false
  if (!sameIdentity(snapshot.identity, identity)) return false
  return validateSnapshot(snapshot, events).ok
}

export function recoveryConfirmationFor(events: readonly SessionEvent[], cutoff: number): RecoveryConfirmation {
  const standing = recoverCanonicalCheckpoint(events.filter((event) => event.seq <= cutoff))?.coversSeq ?? 0
  let chars = 0
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.seq <= standing) continue
    if (event.type === 'user/message' || event.type === 'assistant/message') chars += event.content.length
    else if (event.type === 'tool/result') chars += event.output.length
    else if (event.type === 'tool/call') chars += JSON.stringify(event.call.args).length
  }
  return { cutoff, sourceDigest: sourceDigest(events, cutoff), estimatedCalls: Math.max(1, Math.ceil(chars / RAW_RECOVERY_CALL_ESTIMATE_CHARS)) }
}

export function chooseCompactionSource(input: ChooseInput): SourceChoice {
  const newest = newestClosedCutoff(input.events)
  if ('reason' in newest) return { kind: 'unavailable', reason: newest.reason }
  const standing = recoverCanonicalCheckpoint(input.events)?.coversSeq ?? 0
  if (standing >= newest.cutoff) return { kind: 'noop', reason: 'already-compacted', cutoff: standing }
  if (usable(input.exact, input.events, standing, input.identity)) return { kind: 'snapshot', snapshot: input.exact, path: 'exact' }
  if (usable(input.reconstructed, input.events, standing, input.identity)) return { kind: 'snapshot', snapshot: input.reconstructed, path: 'reconstructed' }
  return { kind: 'recovery-required', reason: 'no-eligible-snapshot', confirmation: recoveryConfirmationFor(input.events, newest.cutoff) }
}
