import type { ModelMessage, ModelRequest, ToolSchema } from '../llm/types.ts'
import type { SessionEvent } from '../session/events.ts'
import { canonicalJson, sha256, sourceDigest } from './compaction-digest.ts'
import { assessProjection, type CompactionProjection, type Eligibility } from './compaction-projection.ts'

export { canonicalJson, sourceDigest }

/**
 * The exact, completed request a compaction summary is computed from, plus the
 * facts that make it verifiable against the durable log. Pure data and pure
 * functions: persistence lives in storage, authority stays in the log.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1

/** Request fields that shape the provider wire prefix; nothing host-only is ever kept. */
export interface SnapshotRequest {
  readonly model?: string
  readonly providerName?: string
  readonly thinkingLevel?: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ToolSchema[]
}

export interface SnapshotIdentity {
  readonly provider: string
  readonly model: string
  readonly thinkingLevel?: string
  readonly modeHash: string
  readonly grantsHash: string
  readonly providerGeneration: number
  readonly policyVersion: number
  readonly prefixHash: string
}

export interface EffectiveCompactionSnapshot {
  /** Host-generated random UUID; also the sidecar file name. */
  readonly id: string
  readonly v: 1
  readonly policyVersion: 1
  readonly sessionId: string
  readonly cutoff: number
  readonly turnId: string
  readonly request: SnapshotRequest
  /** The completed assistant answer that closes the cutoff turn. */
  readonly finalAnswer: ModelMessage
  readonly projection: CompactionProjection
  readonly sourceDigest: string
  readonly seedHash?: string
  readonly identity: SnapshotIdentity
  /** Provider-reported input size of `request`, when one was reported. */
  readonly inputEvidence?: { readonly inputTokens: number; readonly outputTokens?: number }
  /** Calibration ratio (`budget.measured.ratio`, ≥ 1) the builder assembled `request` under; reconstructed snapshots only. */
  readonly estimateRatio?: number
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'id', 'v', 'policyVersion', 'sessionId', 'cutoff', 'turnId', 'request', 'finalAnswer',
  'projection', 'sourceDigest', 'seedHash', 'identity', 'inputEvidence', 'estimateRatio',
])
const REQUEST_KEYS: ReadonlySet<string> = new Set(['model', 'providerName', 'thinkingLevel', 'messages', 'tools'])

/** Hash of the whole snapshot in canonical form; the durable reference carries it. */
export function snapshotHash(snapshot: EffectiveCompactionSnapshot): string {
  return sha256(canonicalJson(snapshot))
}

const refuse = (reason: string): Eligibility => ({ ok: false, reason })

function onlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

/** Pure check that a decoded snapshot is well formed, current for the log and eligible. */
export function validateSnapshot(snapshot: EffectiveCompactionSnapshot, events: readonly SessionEvent[]): Eligibility {
  const candidate = snapshot as unknown as Record<string, unknown> | null
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return refuse('unsupported-schema')
  if (candidate['v'] !== SNAPSHOT_SCHEMA_VERSION || candidate['policyVersion'] !== 1) return refuse('unsupported-schema')
  if (!onlyKeys(candidate, TOP_LEVEL_KEYS)) return refuse('unsupported-schema')
  const request = candidate['request'] as Record<string, unknown> | null
  if (request === null || typeof request !== 'object' || !onlyKeys(request, REQUEST_KEYS) || !Array.isArray(request['messages'])) return refuse('unsupported-schema')
  if (typeof snapshot.id !== 'string' || typeof snapshot.sessionId !== 'string' || !Number.isSafeInteger(snapshot.cutoff)) return refuse('unsupported-schema')
  if (snapshot.estimateRatio !== undefined && !(Number.isFinite(snapshot.estimateRatio) && snapshot.estimateRatio >= 1)) return refuse('unsupported-schema')
  if (snapshot.sourceDigest !== sourceDigest(events, snapshot.cutoff)) {
    // A cutoff that is not a completed boundary is the more useful reason.
    const eligible = assessProjection(events, snapshot.cutoff, snapshot.projection)
    if (!eligible.ok && eligible.reason === 'cutoff-not-completed') return eligible
    return refuse('source-digest-mismatch')
  }
  return assessProjection(events, snapshot.cutoff, snapshot.projection)
}

/** Drop everything host-only from a live request. */
export function snapshotRequestOf(request: ModelRequest): SnapshotRequest {
  return {
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.providerName !== undefined ? { providerName: request.providerName } : {}),
    ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
    messages: request.messages,
    ...(request.tools !== undefined ? { tools: request.tools } : {}),
  }
}
