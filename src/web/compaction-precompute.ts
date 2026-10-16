/**
 * Candidate manager: one background compaction summary per session.
 *
 * A candidate is generated from an immutable snapshot while the conversation
 * keeps going. It is NOT a checkpoint: this module never writes one, never runs
 * a hook and never touches the session log. It produces a `PreparedSummary` and
 * answers one question — is that summary still usable? — by re-checking, at the
 * moment someone asks, that the covered source, the standing checkpoint and the
 * model/mode/grants/provider/policy identity are all what they were when the
 * generation started. Anything appended AFTER the cutoff is irrelevant.
 *
 * Ownership rules the rest of the system relies on:
 * - a job owns its snapshot (`pinned`) until it is consumed or discarded;
 * - cancelling means "abort, then wait for the stream to really end" — a caller
 *   is never told the slot is free while the transport may still be running;
 * - if the transport never settles, the session is `blocked` for new speculation
 *   until the host says it has, instead of pretending the abort freed it.
 */
import { randomUUID } from 'node:crypto'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import type { HarnessLimits } from '../harness/limits.ts'
import { ProviderError, type ModelRequest, type StreamEvent, type StreamOptions, type TokenUsage } from '../harness/llm/types.ts'
import { generateCompaction, type PreparedSummary } from './compaction-generator.ts'
import { handoffSnapshot } from './compaction-host.ts'

export type CandidateReport =
  | { readonly kind: 'started'; readonly sessionId: string; readonly snapshotId: string; readonly cutoff: number }
  | { readonly kind: 'ready'; readonly sessionId: string; readonly snapshotId: string; readonly cutoff: number; readonly generationMs: number }
  | { readonly kind: 'reused'; readonly sessionId: string; readonly snapshotId: string; readonly cutoff: number }
  | { readonly kind: 'discarded'; readonly sessionId: string; readonly snapshotId: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly sessionId: string; readonly snapshotId: string; readonly reason: string }

export interface PrecomputeDeps {
  readonly stream: (request: ModelRequest, options?: StreamOptions) => AsyncIterable<StreamEvent>
  /** The identity the session would compact under right now. */
  readonly identity: (sessionId: string) => SnapshotIdentity
  /** Hash of the checkpoint that stands now (undefined for none). */
  readonly seedHash: (sessionId: string) => string | undefined
  /** Digest of the committed source through `cutoff`, as it is now. */
  readonly digestAt: (sessionId: string, cutoff: number) => string
  /** True while the provider still holds an unsettled candidate request of this session. */
  readonly transportUncertain: (sessionId: string) => boolean
  /**
   * Last-moment worth check on a still-valid candidate, against the conversation as it
   * is NOW (the tail may have refilled since the summary was written): `no-fit` when the
   * next request would not fit, `no-gain` when it saves less than the minimum. May await
   * (the host sizes the next request with the context builder); the manager re-checks after.
   */
  readonly assess: (sessionId: string, prepared: PreparedSummary) => 'no-gain' | 'no-fit' | undefined | Promise<'no-gain' | 'no-fit' | undefined>
  /** Whether the session's model sees image pixels; a text-only one gets the handoff without images. */
  readonly nativeVision: (sessionId: string) => boolean
  readonly limits: Pick<HarnessLimits, 'compactionDeadlineMs' | 'compactionOutputTokens'>
  /** Usage the provider reported for one candidate attempt, attributed to the session it served. */
  readonly recordUsage: (sessionId: string, usage: TokenUsage) => void
  readonly report: (report: CandidateReport) => void
}

/**
 * The provider-ownership id a candidate request runs under. It must differ from the
 * session's own id: the LLM service fences a session while one of its requests is in
 * flight, and a background summary may not block the user's next chat turn.
 */
export const candidateOwner = (sessionId: string): string => `${sessionId}#candidate`

type Phase = 'generating' | 'ready' | 'ended'

interface Job {
  readonly snapshot: EffectiveCompactionSnapshot
  readonly controller: AbortController
  phase: Phase
  prepared?: PreparedSummary
  /** Resolves when the generation has finished, one way or the other — the stream really ended. */
  readonly settled: Promise<void>
  /** Why it ended without a candidate, when it did not fail on its own. */
  cancelReason?: string
  transportUnsettled?: boolean
}

/** Identity fields that make a summary unusable. `prefixHash` is deliberately not one: later turns move it. */
function identityDiffers(was: SnapshotIdentity, now: SnapshotIdentity): boolean {
  return was.provider !== now.provider || was.model !== now.model || was.thinkingLevel !== now.thinkingLevel
    || was.modeHash !== now.modeHash || was.grantsHash !== now.grantsHash
    || was.providerGeneration !== now.providerGeneration || was.policyVersion !== now.policyVersion
}

const identityKey = (identity: SnapshotIdentity): string =>
  [identity.provider, identity.model, identity.thinkingLevel ?? '', identity.modeHash, identity.grantsHash, identity.providerGeneration, identity.policyVersion].join('|')

export class CompactionPrecompute {
  private readonly jobs = new Map<string, Job>()
  /** The last snapshot+identity that failed on its own, per session: not retried until one of them changes. */
  private readonly failedKeys = new Map<string, string>()
  /** Sessions whose aborted transport has not settled. */
  private readonly unsettled = new Set<string>()
  private closed = false

  constructor(readonly deps: PrecomputeDeps) {}

  /** The snapshot id a live job holds, or undefined. */
  pinned(sessionId: string): string | undefined {
    const job = this.jobs.get(sessionId)
    return job === undefined ? undefined : job.snapshot.id
  }

  /** True while an aborted request of this session may still be running at the provider. */
  blocked(sessionId: string): boolean {
    if (!this.unsettled.has(sessionId)) return false
    if (this.deps.transportUncertain(sessionId)) return true
    this.unsettled.delete(sessionId)
    return false
  }

  /** Starts a background generation. False when a usable one already exists, the session is blocked, the snapshot could never be adopted, or this exact attempt already failed. */
  async start(snapshot: EffectiveCompactionSnapshot, parent: AbortSignal): Promise<boolean> {
    const sessionId = snapshot.sessionId
    if (this.closed || this.blocked(sessionId)) return false
    // Built on another seed than the checkpoint standing now (e.g. cut before that checkpoint's own
    // compaction events): adoption would refuse it, so never pay for it or let it displace a job.
    if (this.deps.seedHash(sessionId) !== snapshot.seedHash) return false
    const existing = this.jobs.get(sessionId)
    if (existing !== undefined) {
      // A job still generating is never displaced. A finished one stays only while it can still be
      // adopted; once the source, checkpoint or identity moved on, or the conversation grew past what
      // it can serve, it would otherwise hold the slot forever and the session would get no new candidate.
      if (existing.phase !== 'ready' || existing.prepared === undefined) return false
      const reason = await this.verdict(existing, existing.prepared)
      // Someone else took, replaced or stopped the job while the assessment awaited.
      if (reason === undefined || this.jobs.get(sessionId) !== existing || this.closed || parent.aborted || this.blocked(sessionId)) return false
      this.jobs.delete(sessionId)
      this.deps.report({ kind: 'discarded', sessionId, snapshotId: existing.snapshot.id, reason })
    }
    if (this.failedKeys.get(sessionId) === `${snapshot.id}|${identityKey(snapshot.identity)}`) return false
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, parent])
    let finished!: () => void
    const settled = new Promise<void>((resolve) => { finished = resolve })
    const job: Job = { snapshot, controller, phase: 'generating', settled }
    this.jobs.set(sessionId, job)
    this.deps.report({ kind: 'started', sessionId, snapshotId: snapshot.id, cutoff: snapshot.cutoff })
    void this.run(job, signal, parent).finally(finished)
    return true
  }

  private async run(job: Job, signal: AbortSignal, parent: AbortSignal): Promise<void> {
    const { snapshot } = job
    const sessionId = snapshot.sessionId
    try {
      // A capture from a slash-command turn names the command's model; the summary, its checkpoint,
      // usage and fit check all belong to the session pair the identity names, as in the foreground.
      const prepared = await generateCompaction(handoffSnapshot(snapshot, snapshot.identity, this.deps.nativeVision(sessionId)), {
        stream: (request, options) => this.deps.stream(request, {
          ...options,
          admissionPriority: 'low',
          attribution: { sessionId: candidateOwner(sessionId), turnId: `candidate:${snapshot.id}`, stepId: randomUUID() },
        }),
        signal,
        deadlineAt: Date.now() + this.deps.limits.compactionDeadlineMs,
        maxOutputTokens: this.deps.limits.compactionOutputTokens,
        recordUsage: (usage) => this.deps.recordUsage(sessionId, usage),
        path: 'exact',
      })
      if (this.jobs.get(sessionId) !== job || signal.aborted) return
      job.prepared = prepared
      job.phase = 'ready'
      this.deps.report({ kind: 'ready', sessionId, snapshotId: snapshot.id, cutoff: snapshot.cutoff, generationMs: prepared.generationMs })
    } catch (error) {
      job.phase = 'ended'
      if (error instanceof ProviderError && !error.transportSettled) {
        job.transportUnsettled = true
        this.unsettled.add(sessionId)
      }
      const cancelled = job.cancelReason !== undefined || parent.aborted
      if (this.jobs.get(sessionId) === job) this.jobs.delete(sessionId)
      if (!cancelled) {
        this.failedKeys.set(sessionId, `${snapshot.id}|${identityKey(snapshot.identity)}`)
        this.deps.report({ kind: 'failed', sessionId, snapshotId: snapshot.id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Is the candidate still usable? A reason string when it is not. */
  private staleness(job: Job): string | undefined {
    const { snapshot } = job
    if (this.deps.digestAt(snapshot.sessionId, snapshot.cutoff) !== snapshot.sourceDigest) return 'source-changed'
    if (this.deps.seedHash(snapshot.sessionId) !== snapshot.seedHash) return 'seed-changed'
    if (identityDiffers(snapshot.identity, this.deps.identity(snapshot.sessionId))) return 'identity-changed'
    return undefined
  }

  /** Staleness, then the host's worth check; staleness again because the source may move while the check awaits. */
  private async verdict(job: Job, prepared: PreparedSummary): Promise<string | undefined> {
    const stale = this.staleness(job)
    if (stale !== undefined) return stale
    const assessed = await Promise.resolve(this.deps.assess(job.snapshot.sessionId, prepared)).catch(() => 'no-fit' as const)
    return this.staleness(job) ?? assessed
  }

  /** The ready candidate, exactly once, if it is still valid; otherwise it is discarded. */
  async takeReady(sessionId: string): Promise<PreparedSummary | undefined> {
    const job = this.jobs.get(sessionId)
    if (job === undefined || job.phase !== 'ready' || job.prepared === undefined) return undefined
    // Claimed before the await: nobody else can take or displace it meanwhile.
    this.jobs.delete(sessionId)
    const reason = await this.verdict(job, job.prepared)
    if (reason !== undefined) {
      this.deps.report({ kind: 'discarded', sessionId, snapshotId: job.snapshot.id, reason })
      return undefined
    }
    this.deps.report({ kind: 'reused', sessionId, snapshotId: job.snapshot.id, cutoff: job.snapshot.cutoff })
    return job.prepared
  }

  /** Abort the job and wait until its stream has really ended. Marks the session blocked if the transport did not settle. */
  private async stop(sessionId: string, reason: string): Promise<void> {
    const job = this.jobs.get(sessionId)
    if (job === undefined) return
    job.cancelReason = reason
    if (job.phase !== 'generating') {
      this.jobs.delete(sessionId)
      this.deps.report({ kind: 'discarded', sessionId, snapshotId: job.snapshot.id, reason })
      return
    }
    job.controller.abort(new Error(`compaction candidate cancelled: ${reason}`))
    await job.settled
    if (this.jobs.get(sessionId) === job) this.jobs.delete(sessionId)
    this.deps.report({ kind: 'discarded', sessionId, snapshotId: job.snapshot.id, reason })
    if (job.transportUnsettled) {
      const error = new ProviderError('compaction candidate transport did not settle after cancellation')
      error.transportSettled = false
      throw error
    }
  }

  async invalidate(sessionId: string, reason: string): Promise<void> {
    await this.stop(sessionId, reason).catch(() => {})
  }

  /**
   * For a manual compaction that finds a candidate: the finished one, or the one that
   * finishes within `waitMs`. Past the wait the job is cancelled and this returns only
   * after its stream has ended, so the foreground request never overlaps it. Rejects
   * with `transportSettled: false` when the aborted transport did not settle.
   */
  async waitPending(sessionId: string, waitMs: number, caller: AbortSignal): Promise<PreparedSummary | undefined> {
    const job = this.jobs.get(sessionId)
    if (job === undefined) return undefined
    if (job.phase === 'generating') {
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        job.settled.then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), waitMs) }),
        new Promise<'stopped'>((resolve) => {
          if (caller.aborted) resolve('stopped')
          else caller.addEventListener('abort', () => resolve('stopped'), { once: true })
        }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
      if (outcome === 'stopped') {
        await this.stop(sessionId, 'stopped').catch(() => {})
        caller.throwIfAborted()
      }
      if (outcome === 'timeout') {
        await this.stop(sessionId, 'wait-expired')
        return undefined
      }
    }
    const prepared = await this.takeReady(sessionId)
    caller.throwIfAborted()
    return prepared
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.jobs.keys()].map((sessionId) => this.stop(sessionId, 'closing').catch(() => {})))
  }
}
