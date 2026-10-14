import type { SessionEvent } from '../session/events.ts'
import type { ToolCall } from '../llm/types.ts'
import { isCompletedCompactionBoundary, recoverCanonicalCheckpoint } from './compaction.ts'
import { compactionSeedHash } from './compaction-digest.ts'

export { compactionSeedHash }

/**
 * Typed provenance of one assembled request, for compaction eligibility.
 * Policy is decided from these facts and the durable log — never from the
 * human-readable `manifest.omissions` strings, which stay UI-only.
 */

/** Version of the clear-safety policy below; a loss carrying another version is refused. */
export const COMPACTION_POLICY_VERSION = 1

/** What the request lost relative to the canonical conversation. */
export type ProjectionLoss =
  | { kind: 'tool-result-cleared'; seq: number; callId: string; policyVersion: 1 }
  | { kind: 'uncovered-history-dropped'; fromSeq: number; throughSeq: number }
  | { kind: 'regenerable-section'; source: string; hash: string }
  | { kind: 'unknown'; reason: string }

export interface CompactionProjection {
  v: 1
  policyVersion: 1
  history: 'none' | 'recent' | 'compact'
  /** The checkpoint summary the request carried, when any. */
  seed?: { coversSeq: number; hash: string }
  /** Which log event produced each history message of the request (index into `messages`). */
  sources: readonly { messageIndex: number; seq: number; turnId: string }[]
  losses: readonly ProjectionLoss[]
}

export type Eligibility = { ok: true } | { ok: false; reason: string }

/**
 * Tools whose SUCCESSFUL, already-read output may be hidden from a compaction
 * source. Read/Glob/Grep are reproducible reads. Bash/BashOutput are reports
 * of what a command printed: the effect (a file written, a test run) is
 * already represented by the call arguments and the assistant's following
 * words, which stay in the source — Claude Code and ZCode clear them the same
 * way. A failed or indeterminate result never qualifies (checked separately).
 *
 * Write/Edit results are the only record of what was applied, and an `mcp__`
 * name says nothing about what a server did: neither is a safe clear.
 * Agent/Skill/AskUserQuestion/TodoWrite hold deliverables or state and are
 * not candidates at all.
 */
const SAFE_CLEAR_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'Bash', 'BashOutput'])

export function isSafeToClearTool(name: string): boolean {
  return SAFE_CLEAR_TOOLS.has(name)
}

/**
 * A result whose recorded outcome is a plain success. Uses the durable event
 * metadata (`ok`, `recovery`, `outcome`) — never the message text — so an
 * error or an unknown outcome is never mistaken for reproducible output.
 */
export function isSuccessfulToolResult(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  return event.ok === true && event.recovery !== true && (event.outcome === undefined || event.outcome === 'success')
}

const refuse = (reason: string): Eligibility => ({ ok: false, reason })
const HISTORY_MODES: ReadonlySet<unknown> = new Set(['none', 'recent', 'compact'])
const REGENERABLE_SOURCE = /^(?:skill-catalog|skill:.+|memory:.+)$/

type ToolResultEvent = Extract<SessionEvent, { type: 'tool/result' }>
type AssistantEvent = Extract<SessionEvent, { type: 'assistant/message' }>

interface ContentEvent {
  readonly event: SessionEvent
  readonly turnId: string
}

function validShape(projection: CompactionProjection): boolean {
  const candidate = projection as unknown as Record<string, unknown> | null
  if (candidate === null || typeof candidate !== 'object') return false
  if (candidate.v !== 1 || candidate.policyVersion !== COMPACTION_POLICY_VERSION) return false
  if (!HISTORY_MODES.has(candidate.history)) return false
  if (!Array.isArray(candidate.sources) || !Array.isArray(candidate.losses)) return false
  const seed = candidate.seed as { coversSeq?: unknown; hash?: unknown } | undefined
  if (seed !== undefined && (seed === null || typeof seed !== 'object' || !Number.isSafeInteger(seed.coversSeq) || typeof seed.hash !== 'string')) return false
  return true
}

/**
 * Whether a compaction summary of the log through `cutoff` may be computed
 * from this request. Fail-closed: only a completed durable cutoff, the exact
 * canonical seed, every content event after the seed represented (paired
 * tool calls/results included), and only verifiable typed losses pass.
 * Metadata-only events (titles, manifests, hooks, chunks…) never matter.
 *
 * Final answers of the cutoff turn are represented only once the host adds
 * them (capture promotion); an unpromoted final request is ineligible here.
 */
export function assessProjection(
  events: readonly SessionEvent[],
  cutoff: number,
  projection: CompactionProjection,
): Eligibility {
  if (!validShape(projection)) return refuse('invalid-projection')
  if (projection.history !== 'compact') return refuse('history-not-compact')
  if (!isCompletedCompactionBoundary(events, cutoff)) return refuse('cutoff-not-completed')

  const prefix = events.filter((event) => event.seq <= cutoff)

  // ── seed: exactly the canonical checkpoint of the prefix, or none ──
  const canonical = recoverCanonicalCheckpoint(prefix)
  if (canonical === undefined) {
    if (projection.seed !== undefined) return refuse('seed-mismatch')
  } else if (projection.seed === undefined) {
    return refuse('missing-prior-seed')
  } else if (projection.seed.coversSeq !== canonical.coversSeq || projection.seed.hash !== compactionSeedHash(canonical.summary)) {
    return refuse('seed-mismatch')
  }
  const coversSeq = canonical?.coversSeq ?? 0

  // ── content events of the log (what `deriveDatedMessages` projects) ──
  const content: ContentEvent[] = []
  let turnId = ''
  for (const event of prefix) {
    if (event.type === 'turn/start') turnId = event.turnId
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') content.push({ event, turnId })
  }
  const contentBySeq = new Map(content.map((entry) => [entry.event.seq, entry]))

  // ── sources: ordered, real, correctly attributed; covered ones are bounded retention ──
  let previousIndex = -1
  let previousSeq = 0
  const sourceSeqs = new Set<number>()
  for (const source of projection.sources) {
    if (source === null || typeof source !== 'object' || !Number.isSafeInteger(source.messageIndex) || source.messageIndex <= previousIndex
      || !Number.isSafeInteger(source.seq) || source.seq <= previousSeq || typeof source.turnId !== 'string') return refuse('invalid-sources')
    const entry = contentBySeq.get(source.seq)
    if (entry === undefined || entry.turnId !== source.turnId) return refuse('invalid-sources')
    // Only bounded retained user words / final answers may sit beside the seed.
    if (source.seq <= coversSeq && !(entry.event.type === 'user/message' || (entry.event.type === 'assistant/message' && entry.event.toolCalls === undefined))) return refuse('invalid-sources')
    previousIndex = source.messageIndex
    previousSeq = source.seq
    sourceSeqs.add(source.seq)
  }

  // ── losses: typed, each verified; nothing unknown passes ──
  const verifier = createClearVerifier(prefix)
  for (const loss of projection.losses) {
    const kind = (loss as { kind?: unknown } | null)?.kind
    if (kind === 'uncovered-history-dropped') return refuse('uncovered-history-dropped')
    if (kind === 'tool-result-cleared') {
      if (!verifier(loss as Extract<ProjectionLoss, { kind: 'tool-result-cleared' }>, sourceSeqs)) return refuse('unsafe-tool-result-clear')
      continue
    }
    if (kind === 'regenerable-section') {
      const section = loss as Extract<ProjectionLoss, { kind: 'regenerable-section' }>
      if (typeof section.source === 'string' && REGENERABLE_SOURCE.test(section.source) && typeof section.hash === 'string' && section.hash !== '') continue
    }
    return refuse('unknown')
  }

  // ── coverage: every content event after the seed is represented ──
  for (const entry of content) {
    if (entry.event.seq > coversSeq && !sourceSeqs.has(entry.event.seq)) return refuse('uncovered-history')
  }

  // ── pairing and outcome: no unresolved call, orphan result or unknown outcome in the delta ──
  const calls = new Set<string>()
  const results = new Map<string, ToolResultEvent>()
  for (const { event } of content) {
    if (event.seq <= coversSeq) continue
    if (event.type === 'assistant/message') for (const call of event.toolCalls ?? []) calls.add(call.id)
    else if (event.type === 'tool/result') results.set(event.callId, event)
  }
  for (const id of calls) if (!results.has(id)) return refuse('unresolved-tool-call')
  for (const [id, result] of results) {
    if (!calls.has(id)) return refuse('unresolved-tool-call')
    if (result.recovery === true || result.outcome === 'indeterminate' || result.outcome === 'audit_fault') return refuse('indeterminate-tool-result')
  }
  return { ok: true }
}

/**
 * Builds a verifier for `tool-result-cleared` losses against the durable log.
 * A clear is safe only when the cleared result is an existing, successful,
 * already-read result of a side-effect-free read tool. The tool is the
 * EFFECTIVE call (the durable `tool/call` an authorization hook may have
 * rewritten), matched exactly the way model history projects it.
 */
function createClearVerifier(prefix: readonly SessionEvent[]): (loss: Extract<ProjectionLoss, { kind: 'tool-result-cleared' }>, sourceSeqs: ReadonlySet<number>) => boolean {
  const resultBySeq = new Map<number, ToolResultEvent>()
  const assistantsByStep = new Map<string, AssistantEvent[]>()
  const effectiveByStep = new Map<string, ToolCall[]>()
  let lastAssistantSeq = 0
  for (const event of prefix) {
    if (event.type === 'tool/result') resultBySeq.set(event.seq, event)
    else if (event.type === 'assistant/message') {
      lastAssistantSeq = event.seq
      assistantsByStep.set(event.stepId, [...(assistantsByStep.get(event.stepId) ?? []), event])
    } else if (event.type === 'tool/call') {
      effectiveByStep.set(event.stepId, [...(effectiveByStep.get(event.stepId) ?? []), event.call])
    }
  }
  return (loss, sourceSeqs) => {
    if (loss.policyVersion !== COMPACTION_POLICY_VERSION || !Number.isSafeInteger(loss.seq) || typeof loss.callId !== 'string') return false
    if (!sourceSeqs.has(loss.seq)) return false
    const result = resultBySeq.get(loss.seq)
    if (result === undefined || result.callId !== loss.callId || !isSuccessfulToolResult(result)) return false
    // The model must have read it: an assistant message follows the result.
    if (lastAssistantSeq <= result.seq) return false
    const assistants = assistantsByStep.get(result.stepId)
    if (assistants === undefined || assistants.length !== 1) return false
    const requested = assistants[0]!.toolCalls ?? []
    const index = requested.findIndex((call) => call.id === loss.callId)
    if (index < 0) return false
    const effective = effectiveByStep.get(result.stepId)?.[index] ?? requested[index]!
    return effective.id === loss.callId && isSafeToClearTool(effective.name)
  }
}
