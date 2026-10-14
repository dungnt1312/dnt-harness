import type { CompactionProjection } from '../harness/context/compaction-projection.ts'
import { canonicalJson, sha256 } from '../harness/context/compaction-digest.ts'
import { snapshotRequestOf, type EffectiveCompactionSnapshot, type SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import type { ModelRequest, StreamEvent } from '../harness/llm/types.ts'
import { captureStream, type PendingCapture } from './compaction-capture.ts'

/**
 * Per-session capture state for the web host. The server forwards three
 * things into it — a request being dispatched, its stream, and the end of a
 * turn — and reads two out: the newest cleanly finished capture of a turn, and
 * the snapshot a session currently holds. No IO, no server types.
 */

interface Armed {
  readonly turnId: string
  readonly capture: PendingCapture
  /** True once its stream was claimed; a later stream of the same turn cannot take it over. */
  claimed: boolean
}

export class CaptureRegistry {
  private readonly armed = new Map<string, Armed>()
  private readonly snapshots = new Map<string, EffectiveCompactionSnapshot>()

  /**
   * A root request is about to be sent. It supersedes whatever was armed before:
   * only the LAST step of a turn can stand for the turn, so an earlier clean
   * step must not survive a newer one that has not finished.
   */
  arm(sessionId: string, turnId: string, request: ModelRequest, projection: CompactionProjection): void {
    this.armed.set(sessionId, { turnId, capture: captureStream(request, projection), claimed: false })
  }

  /** Wrap a stream; only the first stream after arming is the armed request's. Everything else passes through. */
  tap(sessionId: string, turnId: string, upstream: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
    const armed = this.armed.get(sessionId)
    if (armed === undefined || armed.turnId !== turnId || armed.claimed) return upstream
    armed.claimed = true
    return armed.capture.tap(upstream)
  }

  /** The armed capture of this turn, if its stream finished cleanly. */
  cleanFor(sessionId: string, turnId: string): PendingCapture | undefined {
    const armed = this.armed.get(sessionId)
    if (armed === undefined || armed.turnId !== turnId || !armed.claimed) return undefined
    return armed.capture.outcome().clean ? armed.capture : undefined
  }

  /** Hold the snapshot a session just promoted. */
  keep(sessionId: string, snapshot: EffectiveCompactionSnapshot): void {
    this.snapshots.set(sessionId, snapshot)
  }

  snapshotOf(sessionId: string): EffectiveCompactionSnapshot | undefined {
    return this.snapshots.get(sessionId)
  }

  forget(sessionId: string): void {
    this.armed.delete(sessionId)
    this.snapshots.delete(sessionId)
  }
}

/** Hash of the wire prefix of a request: system, tools, messages and their order. Host handles never take part. */
export function requestPrefixHash(request: ModelRequest): string {
  return sha256(canonicalJson(snapshotRequestOf(request)))
}

export interface IdentityInput {
  readonly provider: string
  readonly model: string
  readonly thinkingLevel?: string | undefined
  readonly modeId: string
  readonly modeRevision: number
  readonly grants: readonly { readonly path: string; readonly access: 'read' | 'write' }[]
  readonly providerGeneration: number
}

/**
 * What a snapshot must have been built for. Mode and grants are carried only as
 * hashes: the identity is stored beside the snapshot and must hold no path or
 * secret of its own.
 */
export function identityOf(input: IdentityInput, prefixHash: string): SnapshotIdentity {
  const grants = [...input.grants].map((grant) => `${grant.access}:${grant.path}`).sort()
  return {
    provider: input.provider,
    model: input.model,
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    modeHash: sha256(`${input.modeId}@${input.modeRevision}`),
    grantsHash: sha256(canonicalJson(grants)),
    providerGeneration: input.providerGeneration,
    policyVersion: 1,
    prefixHash,
  }
}
