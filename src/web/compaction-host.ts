import { adoptPreparedCompaction, type AdoptionOptions, type CheckpointStore, type Restored } from '../harness/context/compaction.ts'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import type { HarnessLimits } from '../harness/limits.ts'
import type { ModelRequest, StreamEvent, StreamOptions, TokenUsage } from '../harness/llm/types.ts'
import type { SessionEvent } from '../harness/session/events.ts'
import type { Session } from '../harness/session/session.ts'
import type { CompactionSnapshotStore } from '../harness/storage/compaction-snapshot-store.ts'
import { assertFitsWindow, generateCompaction, type PreparedSummary } from './compaction-generator.ts'
import type { CompactionPrecompute } from './compaction-precompute.ts'
import { chooseCompactionSource, recoveryConfirmationFor, type RecoveryConfirmation } from './compaction-source.ts'

/**
 * Foreground compaction for one session: pick a source, summarize once, adopt.
 * Everything that touches the outside world — the model stream, hooks, the
 * identity a snapshot must match — is injected, so the decisions here are
 * testable against a real Session without a server.
 */

/** A compaction that was refused before it started; nothing was written. */
export class CompactionRefused extends Error {
  constructor(message: string, readonly reason: 'open-turn' | 'no-completed-turn' | 'closing' | 'busy') {
    super(message)
    this.name = 'CompactionRefused'
  }
}

function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

export interface HostDeps {
  /** The session being compacted. */
  readonly session: () => Session
  readonly checkpoints: CheckpointStore
  readonly snapshotStore: CompactionSnapshotStore
  readonly stream: (request: ModelRequest, options?: StreamOptions) => AsyncIterable<StreamEvent>
  /** The newest captured, persisted snapshot for this session, if the host still holds one. */
  readonly exactSnapshot: () => EffectiveCompactionSnapshot | undefined
  /** A snapshot rebuilt from the committed log with the ordinary context builder, if possible. */
  readonly reconstruct: () => EffectiveCompactionSnapshot | undefined
  /** What a snapshot must have been built for right now: provider, model, mode, grants, policy. */
  readonly identity: () => SnapshotIdentity
  /** False when no model resolves: only the bounded extractive summary is possible. */
  readonly hasModel: () => boolean
  /**
   * The proven raw-transcript fold, exactly as the server runs it today (seed,
   * attachments, extractive cap, cache-aware prefix). Used for the rollout-off
   * path, for a session with no model, and for a CONFIRMED recovery. The host
   * does not rebuild it: only the server knows those inputs.
   */
  readonly legacyCompact: (trigger: 'manual' | 'automatic', signal: AbortSignal) => Promise<{ readonly coversSeq: number; readonly summary: string }>
  /** Runs PreCompact; returns the blocking reason, or undefined to proceed. */
  readonly preCompact: (trigger: 'manual' | 'auto', signal: AbortSignal) => Promise<string | undefined>
  readonly limits: Pick<HarnessLimits, 'compactionEffectiveEnabled' | 'compactionDeadlineMs' | 'compactionOutputTokens'> & Partial<Pick<HarnessLimits, 'compactionCandidateWaitMs'>>
  /** Background candidates of this session; absent when precompute is off. */
  readonly candidates?: Pick<CompactionPrecompute, 'waitPending' | 'invalidate' | 'blocked'>
  readonly contextWindowTokens: () => number | undefined
  readonly measure: NonNullable<AdoptionOptions['measure']>
  /**
   * Bounded state to restore beside an adopted summary (task list, running work,
   * skills, current files). Only the effective path uses it; the legacy and
   * recovery folds keep their behavior. A throw refuses the adoption.
   */
  readonly restore?: (cutoff: number, signal: AbortSignal) => Promise<Restored | undefined>
  readonly recordUsage: (usage: TokenUsage) => void
  /**
   * Stage reports for the UI: `generating` just before a model request is made, `applying` just
   * before the summary is adopted. Not called for a no-op, a hook block or the legacy fold.
   */
  readonly progress?: (stage: 'generating' | 'applying') => void
}

export interface CompactRequest {
  readonly trigger: 'manual' | 'automatic'
  /** Echo of the fingerprint a previous `recovery-required` answer returned. Manual only. */
  readonly recovery?: RecoveryConfirmation
  readonly signal?: AbortSignal
}

export type CompactOutcome =
  | { readonly kind: 'compacted'; readonly coversSeq: number; readonly summary: string; readonly path: 'exact' | 'reconstructed' | 'recovery' | 'legacy'; readonly generationMs?: number; readonly reused?: true }
  | { readonly kind: 'noop'; readonly coversSeq: number }
  | { readonly kind: 'recovery-required'; readonly confirmation: RecoveryConfirmation }

export class CompactionHost {
  private running: AbortController | undefined
  private closed = false

  /** Mutable so a host can swap an injected collaborator (tests, config reload) without rebuilding. */
  constructor(public deps: HostDeps) {}

  /** True while a compaction owns the session. */
  get busy(): boolean {
    return this.running !== undefined
  }

  /** Abort what is running, if anything. */
  cancel(): void {
    this.running?.abort(new Error('compaction cancelled'))
  }

  async close(): Promise<void> {
    this.closed = true
    this.cancel()
  }

  async compact(request: CompactRequest): Promise<CompactOutcome> {
    if (this.closed) throw new CompactionRefused('compaction host is closing', 'closing')
    if (this.running !== undefined) throw new CompactionRefused('compaction already in progress', 'busy')
    const controller = new AbortController()
    this.running = controller
    const signal = request.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, request.signal])
    try {
      return await this.run(request, signal)
    } finally {
      this.running = undefined
    }
  }

  private async run(request: CompactRequest, signal: AbortSignal): Promise<CompactOutcome> {
    const { deps } = this
    const session = deps.session()
    // A turn that was just admitted is in the live log before it is durable. It
    // must stop compaction BEFORE any hook or model call, not at adoption.
    if (hasOpenTurn(session.events)) throw new CompactionRefused('compaction requires a completed exchange boundary (no open turn)', 'open-turn')
    const events = session.committedEvents
    if (!deps.limits.compactionEffectiveEnabled || !deps.hasModel()) return this.legacy(request, signal, 'legacy')

    const choice = chooseCompactionSource({ events, exact: deps.exactSnapshot(), reconstructed: deps.reconstruct(), identity: deps.identity() })
    if (choice.kind === 'unavailable') {
      throw new CompactionRefused(choice.reason === 'open-turn' ? 'compaction requires a completed exchange boundary (no open turn)' : 'nothing to compact yet', choice.reason)
    }
    if (choice.kind === 'noop') return { kind: 'noop', coversSeq: choice.cutoff }

    // A candidate written in the background is the better source whenever there is one:
    // it costs no model call now, and it can stand in for a snapshot a restart lost. A
    // confirmed slow recovery is a different operation and never looks at candidates.
    if (request.recovery === undefined) {
      // An earlier candidate whose aborted transport has not settled still holds provider
      // capacity. Starting another request now would overlap it, so refuse instead.
      if (deps.candidates?.blocked(session.id) === true) throw new Error('compaction candidate transport has not settled; try again shortly')
      const candidate = await this.candidate(session, signal)
      signal.throwIfAborted()
      if (candidate !== undefined) {
        const blocked = await deps.preCompact(request.trigger === 'automatic' ? 'auto' : 'manual', signal)
        signal.throwIfAborted()
        if (blocked !== undefined) throw new Error(blocked)
        return this.adopt(session, candidate, request, signal, true)
      }
    }

    if (choice.kind === 'recovery-required') {
      if (request.recovery === undefined) return { kind: 'recovery-required', confirmation: choice.confirmation }
      if (request.trigger === 'automatic') throw new Error('an automatic compaction never runs a confirmed recovery')
      const current = recoveryConfirmationFor(events, choice.confirmation.cutoff)
      if (request.recovery.cutoff !== current.cutoff || request.recovery.sourceDigest !== current.sourceDigest) {
        throw new Error('recovery confirmation does not match the current source; ask again')
      }
      return this.legacy(request, signal, 'recovery')
    }

    // A recovery confirmation is only meaningful when recovery was actually required.
    if (request.recovery !== undefined && request.trigger === 'automatic') throw new Error('an automatic compaction never runs a confirmed recovery')
    const { snapshot, path } = choice
    assertFitsWindow(snapshot, { ...(deps.contextWindowTokens() !== undefined ? { contextWindowTokens: deps.contextWindowTokens()! } : {}), outputTokens: deps.limits.compactionOutputTokens })

    const blocked = await deps.preCompact(request.trigger === 'automatic' ? 'auto' : 'manual', signal)
    signal.throwIfAborted()
    if (blocked !== undefined) throw new Error(blocked)

    this.report('generating')
    const prepared = await generateCompaction(snapshot, {
      stream: deps.stream,
      signal,
      deadlineAt: Date.now() + deps.limits.compactionDeadlineMs,
      maxOutputTokens: deps.limits.compactionOutputTokens,
      recordUsage: deps.recordUsage,
      path,
    })
    return this.adopt(session, prepared, request, signal)
  }

  /** Adopt a prepared summary under the compaction transaction, then drop the session's other candidates. */
  private async adopt(session: Session, prepared: PreparedSummary, request: CompactRequest, signal: AbortSignal, reused = false): Promise<CompactOutcome> {
    const { deps } = this
    this.report('applying')
    const checkpoint = await adoptPreparedCompaction(session, deps.checkpoints, {
      summary: prepared.summary,
      cutoff: prepared.cutoff,
      sourceDigest: prepared.sourceDigest,
      ...(prepared.seedHash !== undefined ? { seedHash: prepared.seedHash } : {}),
      model: prepared.identity.model,
      generationMs: prepared.generationMs,
    }, {
      trigger: request.trigger,
      signal,
      validate: async () => {
        const now = deps.identity()
        const was = prepared.identity
        if (now.provider !== was.provider || now.model !== was.model || now.thinkingLevel !== was.thinkingLevel || now.modeHash !== was.modeHash || now.grantsHash !== was.grantsHash || now.policyVersion !== was.policyVersion) {
          throw new Error('compaction identity changed while the summary was being written')
        }
      },
      measure: deps.measure,
      ...(deps.restore !== undefined ? { restore: (cutoff: number) => deps.restore!(cutoff, signal) } : {}),
    })
    // A new checkpoint stands: any candidate built on the old one is now unusable.
    await deps.candidates?.invalidate(session.id, 'checkpoint-committed')
    return { kind: 'compacted', coversSeq: checkpoint.coversSeq, summary: checkpoint.summary, path: prepared.path, generationMs: prepared.generationMs, ...(reused ? { reused: true as const } : {}) }
  }

  /**
   * A candidate written in the background: the finished one, or the one that finishes
   * within the wait. Past the wait the manager aborts it and returns only after its
   * stream has ended, so this request never overlaps it; a transport that did not
   * settle rejects and stops the compaction.
   */
  private async candidate(session: Session, signal: AbortSignal): Promise<PreparedSummary | undefined> {
    const { deps } = this
    if (deps.candidates === undefined) return undefined
    return deps.candidates.waitPending(session.id, deps.limits.compactionCandidateWaitMs ?? 0, signal)
  }

  /** Telemetry only: an observer that throws cannot change what the compaction does. */
  private report(stage: 'generating' | 'applying'): void {
    try { this.deps.progress?.(stage) } catch { /* the observer is not part of the compaction */ }
  }

  /** Hook once, then the server's proven fold. */
  private async legacy(request: CompactRequest, signal: AbortSignal, path: 'legacy' | 'recovery'): Promise<CompactOutcome> {
    const { deps } = this
    const blocked = await deps.preCompact(request.trigger === 'automatic' ? 'auto' : 'manual', signal)
    signal.throwIfAborted()
    if (blocked !== undefined) throw new Error(blocked)
    const checkpoint = await deps.legacyCompact(request.trigger, signal)
    return { kind: 'compacted', coversSeq: checkpoint.coversSeq, summary: checkpoint.summary, path }
  }
}
