import { randomUUID } from 'node:crypto'
import { assessProjection, type CompactionProjection } from '../harness/context/compaction-projection.ts'
import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotRequestOf,
  sourceDigest,
  type EffectiveCompactionSnapshot,
  type SnapshotIdentity,
  type SnapshotRequest,
} from '../harness/context/compaction-snapshot.ts'
import { validateCompletion } from '../harness/llm/completion.ts'
import type { ModelMessage, ModelRequest, StreamEvent, TokenUsage } from '../harness/llm/types.ts'
import type { SessionEvent } from '../harness/session/events.ts'
import type { CompactionSnapshotStore } from '../harness/storage/compaction-snapshot-store.ts'

/**
 * Capture of the exact request a compaction summary may be computed from.
 * A capture only describes what was SENT and how the stream ended; whether it
 * may become a snapshot is decided later, against the durable log.
 */

export interface CaptureOutcome {
  /** One settled stop completion, nothing after it, drained to the end without error. */
  readonly clean: boolean
  readonly usage?: TokenUsage
}

export interface PendingCapture {
  /** Allowlisted, frozen copy of the request: no signals, no host handles. */
  readonly request: SnapshotRequest
  readonly projection: CompactionProjection
  /** Wrap the provider stream; events pass through untouched. */
  tap(upstream: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent>
  outcome(): CaptureOutcome
}

const freezeDeep = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

/** Immutable copy of the wire-shaping request, taken at dispatch time. */
function copyRequest(request: ModelRequest): SnapshotRequest {
  return freezeDeep(structuredClone(snapshotRequestOf(request)))
}

export function captureStream(request: ModelRequest, projection: CompactionProjection): PendingCapture {
  const copy = copyRequest(request)
  let clean = false
  let usage: TokenUsage | undefined
  return {
    request: copy,
    projection: freezeDeep(structuredClone(projection)),
    tap(upstream) {
      return (async function* tapped(): AsyncGenerator<StreamEvent> {
        let completions = 0
        let valid = false
        let drained = false
        try {
          for await (const event of upstream) {
            if (event.type === 'completion') {
              completions++
              try {
                validateCompletion(event)
                valid = event.finishReason === 'stop'
              } catch {
                valid = false
              }
            } else if (event.type === 'usage') {
              usage = event.usage
            }
            yield event
          }
          drained = true
        } finally {
          // `finally` also runs when the consumer returns early or upstream throws:
          // only a fully drained stream with exactly one valid stop is clean.
          clean = drained && completions === 1 && valid
        }
      })()
    },
    outcome: () => ({ clean, ...(usage !== undefined ? { usage } : {}) }),
  }
}

export interface PromoteInput {
  readonly sessionId: string
  /** Durably committed events only. */
  readonly events: readonly SessionEvent[]
  readonly turnId: string
  readonly pending: PendingCapture
  /** The assistant answer that closed the turn. */
  readonly finalAnswer: ModelMessage
  readonly identity: SnapshotIdentity
  readonly store: CompactionSnapshotStore
  readonly newId?: () => string
}

/** The completed cutoff of a turn: its `turn/end` with reason `completed`, and nothing unresolved inside it. */
function completedCutoff(events: readonly SessionEvent[], turnId: string): number | undefined {
  const start = events.findLast((event) => event.type === 'turn/start' && event.turnId === turnId)
  if (start === undefined) return undefined
  const end = events.find((event) => event.type === 'turn/end' && event.turnId === turnId && event.seq > start.seq)
  if (end === undefined || end.type !== 'turn/end' || end.reason !== 'completed') return undefined
  for (const event of events) {
    if (event.seq <= start.seq || event.seq >= end.seq) continue
    // An abandoned step or an execution whose outcome is unknown means the request
    // that produced this turn is not the plain, settled history a summary may cover.
    if (event.type === 'step/abandoned' || event.type === 'execution/uncertain') return undefined
  }
  return end.seq
}

/** The closing assistant message of the turn, exactly as the log recorded it. */
function loggedFinalAnswer(events: readonly SessionEvent[], turnId: string, cutoff: number): Extract<SessionEvent, { type: 'assistant/message' }> | undefined {
  const start = events.findLast((event) => event.type === 'turn/start' && event.turnId === turnId)
  if (start === undefined) return undefined
  const answer = events.findLast((event) => event.seq > start.seq && event.seq < cutoff && event.type === 'assistant/message')
  if (answer?.type !== 'assistant/message' || answer.toolCalls !== undefined) return undefined
  return answer
}

interface BuildInput {
  readonly sessionId: string
  readonly events: readonly SessionEvent[]
  readonly turnId: string
  readonly request: SnapshotRequest
  readonly projection: CompactionProjection
  readonly finalAnswer: ModelMessage
  readonly identity: SnapshotIdentity
  readonly id: string
  readonly usage?: TokenUsage
}

function buildSnapshot(input: BuildInput): EffectiveCompactionSnapshot | undefined {
  const cutoff = completedCutoff(input.events, input.turnId)
  if (cutoff === undefined) return undefined
  const answer = loggedFinalAnswer(input.events, input.turnId, cutoff)
  if (answer === undefined || input.finalAnswer.role !== 'assistant' || input.finalAnswer.content !== answer.content) return undefined
  // The final answer is a source of its own: the request that preceded it never contained it.
  const projection: CompactionProjection = {
    ...input.projection,
    sources: input.projection.sources.some((source) => source.seq === answer.seq)
      ? input.projection.sources
      : [...input.projection.sources, { messageIndex: input.request.messages.length, seq: answer.seq, turnId: input.turnId }],
  }
  const verdict = assessProjection(input.events, cutoff, projection)
  if (!verdict.ok) return undefined
  return {
    id: input.id,
    v: SNAPSHOT_SCHEMA_VERSION,
    policyVersion: 1,
    sessionId: input.sessionId,
    cutoff,
    turnId: input.turnId,
    request: input.request,
    finalAnswer: input.finalAnswer,
    projection,
    sourceDigest: sourceDigest(input.events, cutoff),
    ...(projection.seed !== undefined ? { seedHash: projection.seed.hash } : {}),
    identity: input.identity,
    ...(input.usage !== undefined ? { inputEvidence: { inputTokens: input.usage.inputTokens, ...(input.usage.outputTokens !== undefined ? { outputTokens: input.usage.outputTokens } : {}) } } : {}),
  }
}

/**
 * Turn a cleanly drained capture into a persisted snapshot, but only once the
 * turn it belongs to is durably completed and its projection is eligible.
 * Returns undefined — never throws for "not eligible" — so a failed promotion
 * simply leaves compaction to the reconstruction path.
 */
export async function promoteCapture(input: PromoteInput): Promise<EffectiveCompactionSnapshot | undefined> {
  const outcome = input.pending.outcome()
  if (!outcome.clean) return undefined
  const snapshot = buildSnapshot({
    sessionId: input.sessionId,
    events: input.events,
    turnId: input.turnId,
    request: input.pending.request,
    projection: input.pending.projection,
    finalAnswer: input.finalAnswer,
    identity: input.identity,
    id: (input.newId ?? randomUUID)(),
    ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
  })
  if (snapshot === undefined) return undefined
  await input.store.put(snapshot)
  return snapshot
}

export interface ReconstructInput {
  readonly sessionId: string
  readonly events: readonly SessionEvent[]
  readonly turnId: string
  /** A request the ordinary context builder produced from the committed log. */
  readonly request: ModelRequest
  readonly projection: CompactionProjection
  readonly finalAnswer: ModelMessage
  readonly identity: SnapshotIdentity
  readonly newId?: () => string
}

/**
 * Rebuild a snapshot without a captured stream (restart, lost sidecar). It is
 * the same request the builder would send now, so it carries no cache claim —
 * the caller labels it `reconstructed`. Never invents coverage: an ineligible
 * projection yields undefined.
 */
export function reconstructSnapshot(input: ReconstructInput): EffectiveCompactionSnapshot | undefined {
  return buildSnapshot({
    sessionId: input.sessionId,
    events: input.events,
    turnId: input.turnId,
    request: copyRequest(input.request),
    projection: input.projection,
    finalAnswer: input.finalAnswer,
    identity: input.identity,
    id: (input.newId ?? randomUUID)(),
  })
}
