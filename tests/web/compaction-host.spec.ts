/**
 * The foreground effective compaction: choose a source, summarize once,
 * adopt. Real Session + CheckpointStore + CompactionSnapshotStore; only the
 * model stream and the host's outer concerns (hooks, identity) are injected.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel, Session, type TurnId } from 'dnt-harness'
import { CheckpointStore, recoverCanonicalCheckpoint } from '../../src/harness/context/compaction.ts'
import { sourceDigest } from '../../src/harness/context/compaction-digest.ts'
import type { CompactionProjection } from '../../src/harness/context/compaction-projection.ts'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../../src/harness/context/compaction-snapshot.ts'
import type { ModelCompletion, ModelRequest, StreamEvent, TokenUsage } from '../../src/harness/llm/types.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import { CompactionSnapshotStore } from '../../src/harness/storage/compaction-snapshot-store.ts'
import { COMPACTION_HANDOFF_MARKER, type PreparedSummary } from '../../src/web/compaction-generator.ts'
import { CompactionHost, CompactionRefused, type HostDeps } from '../../src/web/compaction-host.ts'

const STOP: ModelCompletion = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
const T = (id: string): TurnId => id as TurnId

const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

const identity: SnapshotIdentity = { provider: 'p', model: 'm', modeHash: 'mode', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' }

function turn(session: Session, id: string, text: string, answer: string): void {
  session.append({ type: 'turn/start', turnId: T(id) })
  session.append({ type: 'user/message', turnId: T(id), content: text })
  session.append({ type: 'assistant/message', stepId: `s-${id}` as never, content: answer })
  session.append({ type: 'turn/end', turnId: T(id), reason: 'completed' })
}

function projectionFor(events: readonly SessionEvent[], cutoff: number): CompactionProjection {
  const sources: { messageIndex: number; seq: number; turnId: string }[] = []
  let turnId = ''
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.type === 'turn/start') turnId = event.turnId
    if (event.type === 'user/message' || event.type === 'assistant/message') sources.push({ messageIndex: sources.length + 1, seq: event.seq, turnId })
  }
  return { v: 1, policyVersion: 1, history: 'compact', sources, losses: [] }
}

function snapshotFor(session: Session, cutoff: number, over: Partial<EffectiveCompactionSnapshot> = {}): EffectiveCompactionSnapshot {
  const events = session.committedEvents
  return {
    id: 'snap-1', v: 1, policyVersion: 1, sessionId: session.id, cutoff, turnId: 't1',
    request: { model: 'm', providerName: 'p', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first' }] },
    finalAnswer: { role: 'assistant', content: 'a1' },
    projection: projectionFor(events, cutoff),
    sourceDigest: sourceDigest(events, cutoff),
    identity,
    ...over,
  }
}

/** A provider stream that, like a real one, stops when its signal aborts. */
function hangUntilAborted(_request: ModelRequest, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
  return (async function* (): AsyncIterable<StreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      const stop = (): void => reject(options?.signal?.reason ?? new Error('aborted'))
      if (options?.signal?.aborted === true) stop()
      else options?.signal?.addEventListener('abort', stop, { once: true })
    })
  })()
}

interface Rig {
  session: Session
  host: CompactionHost
  requests: ModelRequest[]
  checkpoints: CheckpointStore
  hooks: ReturnType<typeof vi.fn>
  legacy: ReturnType<typeof vi.fn>
  usage: TokenUsage[]
  setExact(snapshot: EffectiveCompactionSnapshot | undefined): void
  setReconstructed(snapshot: EffectiveCompactionSnapshot | undefined): void
  reconstruct: ReturnType<typeof vi.fn>
}

async function rig(options: { summary?: string; stream?: (request: ModelRequest, options?: { signal?: AbortSignal }) => AsyncIterable<StreamEvent>; effective?: boolean; model?: boolean } = {}): Promise<Rig> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'compaction-host-'))
  homes.push(home)
  const session = new Session(new Kernel().ctx)
  turn(session, 't1', 'first', 'a1')
  await session.durable()
  const requests: ModelRequest[] = []
  const usage: TokenUsage[] = []
  let exact: EffectiveCompactionSnapshot | undefined = snapshotFor(session, 4)
  let reconstructed: EffectiveCompactionSnapshot | undefined
  const hooks = vi.fn(async (): Promise<string | undefined> => undefined)
  const reconstruct = vi.fn(async (): Promise<EffectiveCompactionSnapshot | undefined> => reconstructed)
  const checkpoints = new CheckpointStore(home)
  // The proven fold, as the server owns it (seed, attachments, extractive cap). The host must call
  // it as-is rather than build a summarizer of its own.
  const legacy = vi.fn(async (trigger: 'manual' | 'automatic', signal: AbortSignal) => {
    const { compactSession } = await import('../../src/harness/context/compaction.ts')
    const { createCompactionSummarizer } = await import('../../src/web/llm-summarizer.ts')
    const summarizer = createCompactionSummarizer((request, streamOptions) => (options.stream ?? ((r: ModelRequest) => {
      requests.push(r)
      return (async function* (): AsyncIterable<StreamEvent> { yield { type: 'delta', delta: 'LEGACY SUMMARY' }; yield STOP })()
    }))(request, streamOptions), options.model === false ? undefined : { providerName: 'p', model: 'm' })
    const checkpoint = await compactSession(session, checkpoints, summarizer, { trigger, signal })
    return { coversSeq: checkpoint.coversSeq, summary: checkpoint.summary }
  })
  const deps: HostDeps = {
    session: () => session,
    checkpoints,
    snapshotStore: new CompactionSnapshotStore((id) => path.join(home, id, 'snapshots')),
    stream: (request, streamOptions) => {
      requests.push(request)
      if (options.stream !== undefined) return options.stream(request, streamOptions)
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { type: 'delta', delta: options.summary ?? 'HANDOFF SUMMARY' }
        yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 30 } }
        yield STOP
      })()
    },
    exactSnapshot: () => exact,
    reconstruct,
    identity: () => identity,
    hasModel: () => options.model ?? true,
    preCompact: hooks,
    legacyCompact: legacy,
    limits: { compactionEffectiveEnabled: options.effective ?? true, compactionDeadlineMs: 5_000, compactionOutputTokens: 8_000, compactionCandidateWaitMs: 15_000 },
    contextWindowTokens: () => 200_000,
    nativeVision: () => true,
    measure: () => ({ tokensBefore: 5_000, tokensAfter: 1_000 }),
    recordUsage: (u) => usage.push(u),
  }
  const host = new CompactionHost(deps)
  return { session, host, requests, checkpoints, hooks, legacy, usage, reconstruct, setExact: (s) => { exact = s }, setReconstructed: (s) => { reconstructed = s } }
}

describe('CompactionHost.compact: the effective path', () => {
  it('summarizes once from the exact snapshot and adopts it, with path and timings', async () => {
    const r = await rig()
    const result = await r.host.compact({ trigger: 'manual' })
    expect(r.requests).toHaveLength(1)
    expect(String(r.requests[0]!.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
    expect(result).toMatchObject({ kind: 'compacted', coversSeq: 4, summary: 'HANDOFF SUMMARY', path: 'exact' })
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toMatchObject({ coversSeq: 4, summary: 'HANDOFF SUMMARY' })
    expect(r.usage).toEqual([{ inputTokens: 900, outputTokens: 30 }])
    const end = r.session.events.findLast((event) => event.type === 'compaction/end')!
    expect(end).toMatchObject({ tokensBefore: 5_000, tokensAfter: 1_000 })
  })

  it('uses the reconstructed snapshot when there is no exact one, and labels it', async () => {
    const r = await rig()
    r.setExact(undefined)
    r.setReconstructed(snapshotFor(r.session, 4, { id: 'rec' }))
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'reconstructed' })
    expect(r.reconstruct).toHaveBeenCalledTimes(1)
    expect(r.legacy).not.toHaveBeenCalled()
  })

  it('never rebuilds from the log while the exact snapshot is usable', async () => {
    const r = await rig()
    r.setReconstructed(snapshotFor(r.session, 4, { id: 'rec' }))
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'exact' })
    expect(r.reconstruct).not.toHaveBeenCalled()
  })

  it('folds when the log cannot be rebuilt into a snapshot either', async () => {
    const r = await rig()
    r.setExact(undefined)
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'recovery' })
    expect(r.reconstruct).toHaveBeenCalledTimes(1)
    expect(r.legacy).toHaveBeenCalledTimes(1)
  })

  it('runs PreCompact once, before generation, and a block stops everything', async () => {
    const r = await rig()
    const order: string[] = []
    r.hooks.mockImplementation(async () => { order.push('hook'); return undefined })
    const original = r.host.deps.stream
    r.host.deps = { ...r.host.deps, stream: (request, options) => { order.push('model'); return original(request, options) } }
    await r.host.compact({ trigger: 'manual' })
    expect(order).toEqual(['hook', 'model'])
    expect(r.hooks).toHaveBeenCalledTimes(1)

    const blocked = await rig()
    blocked.hooks.mockResolvedValue('PreCompact hook stopped compaction: nope')
    await expect(blocked.host.compact({ trigger: 'manual' })).rejects.toThrow(/PreCompact hook stopped compaction: nope/)
    expect(blocked.requests).toHaveLength(0)
    expect(blocked.session.events.some((event) => event.type === 'compaction/start')).toBe(false)
  })

  it('is a no-op, with no model call and no hook, when the newest closed turn is already compacted', async () => {
    const r = await rig()
    await r.host.compact({ trigger: 'manual' })
    r.requests.length = 0
    r.hooks.mockClear()
    const before = r.session.events.length
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'noop' })
    expect(r.requests).toHaveLength(0)
    expect(r.hooks).not.toHaveBeenCalled()
    expect(r.session.events).toHaveLength(before)
  })

  it('refuses to run while a turn is open', async () => {
    const r = await rig()
    r.session.append({ type: 'turn/start', turnId: T('t2') })
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(CompactionRefused)
    expect(r.requests).toHaveLength(0)
  })

  it('after a model or thinking switch it still uses the snapshot, summarizing with the model selected now', async () => {
    const r = await rig()
    const now = { ...identity, provider: 'p2', model: 'm2', thinkingLevel: 'high' }
    r.host.deps = { ...r.host.deps, identity: () => now }
    const result = await r.host.compact({ trigger: 'manual' })
    expect(result).toMatchObject({ kind: 'compacted', path: 'exact' })
    expect(r.legacy).not.toHaveBeenCalled()
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0]).toMatchObject({ model: 'm2', providerName: 'p2', thinkingLevel: 'high' })
  })

  it('stamps an unstamped snapshot request with the current identity even when nothing switched', async () => {
    const r = await rig()
    const now = { ...identity, thinkingLevel: 'low' }
    r.setExact(snapshotFor(r.session, 4, { identity: now, request: { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first' }] } }))
    r.host.deps = { ...r.host.deps, identity: () => now }
    await r.host.compact({ trigger: 'manual' })
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0]).toMatchObject({ model: 'm', providerName: 'p', thinkingLevel: 'low' })
  })

  it('a reconstructed snapshot is sized with the builder estimate, without the unmeasured margin', async () => {
    // ~45k tokens of prefix: with the 1.2 margin it would not fit a 60k window beside 8k of output.
    const big = (session: Session, id: string): EffectiveCompactionSnapshot => snapshotFor(session, 4, { id, request: { model: 'm', providerName: 'p', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u'.repeat(180_000) }] } })
    const r = await rig()
    r.host.deps = { ...r.host.deps, contextWindowTokens: () => 60_000 }
    r.setExact(undefined)
    r.setReconstructed(big(r.session, 'rec'))
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'reconstructed' })
    expect(r.legacy).not.toHaveBeenCalled()

    // An exact capture without a provider report keeps the margin: the same size is folded.
    const exact = await rig()
    exact.host.deps = { ...exact.host.deps, contextWindowTokens: () => 60_000 }
    exact.setExact(big(exact.session, 'snap-1'))
    expect(await exact.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'recovery' })
  })

  it('a snapshot too large for the current window is never sent: the transcript is folded in pieces instead', async () => {
    const r = await rig()
    r.setExact(snapshotFor(r.session, 4, { inputEvidence: { inputTokens: 199_000 } }))
    const result = await r.host.compact({ trigger: 'manual' })
    expect(result).toMatchObject({ kind: 'compacted', path: 'recovery' })
    expect(r.legacy).toHaveBeenCalledTimes(1)
    expect(r.requests.every((request) => !String(request.messages.at(-1)!.content).includes(COMPACTION_HANDOFF_MARKER))).toBe(true)
  })

  it('a non-native target gets the handoff without image parts and no tool mention; the stored snapshot is untouched', async () => {
    const image = { role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'image' as const, mediaType: 'image/png', base64: 'AAAA' }] }
    const withImage = (session: Session): EffectiveCompactionSnapshot => snapshotFor(session, 4, { request: { model: 'm', providerName: 'p', messages: [{ role: 'system', content: 'sys' }, image] } })
    const text = await rig()
    const stored = withImage(text.session)
    text.setExact(stored)
    text.host.deps = { ...text.host.deps, nativeVision: () => false }
    await text.host.compact({ trigger: 'manual' })
    const sent = JSON.stringify(text.requests[0]!.messages)
    expect(sent).not.toContain('"type":"image"')
    expect(sent).not.toContain('AAAA')
    expect(sent).not.toContain('DescribeImage')
    expect(sent).toContain('cannot see image pixels')
    expect(stored.request.messages[1]).toBe(image)

    const native = await rig()
    native.setExact(withImage(native.session))
    await native.host.compact({ trigger: 'manual' })
    expect(native.requests[0]!.messages[1]).toEqual(image)
  })
})

describe('CompactionHost.compact: progress', () => {
  it('reports generating just before the model request and applying just before the adoption, in that order', async () => {
    const r = await rig()
    const order: string[] = []
    const original = r.host.deps.stream
    r.host.deps = {
      ...r.host.deps,
      stream: (request, options) => { order.push('model'); return original(request, options) },
      progress: (stage) => { order.push(stage) },
    }
    await r.host.compact({ trigger: 'manual' })
    expect(order).toEqual(['generating', 'model', 'applying'])
  })

  it('does not claim to be generating when nothing is generated: a candidate goes straight to applying; a no-op reports nothing', async () => {
    const r = await rig()
    const stages: string[] = []
    r.host.deps = { ...r.host.deps, progress: (stage) => { stages.push(stage) } }
    await r.host.compact({ trigger: 'manual' })
    stages.length = 0
    await r.host.compact({ trigger: 'manual' })
    expect(stages).toEqual([])
  })

  it('a block from PreCompact reports neither stage: the model is never asked and nothing is applied', async () => {
    const r = await rig()
    const stages: string[] = []
    r.host.deps = { ...r.host.deps, progress: (stage) => { stages.push(stage) } }
    r.hooks.mockResolvedValue('PreCompact hook stopped compaction: no')
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow()
    expect(stages).toEqual([])
  })

  it('a progress callback that throws never breaks the compaction', async () => {
    const r = await rig()
    r.host.deps = { ...r.host.deps, progress: () => { throw new Error('observer exploded') } }
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted' })
  })
})

describe('CompactionHost.compact: restoration', () => {
  const restored = { body: 'RESTORED STATE', tokens: 40, sections: [{ kind: 'todo' as const, name: 'todo', status: 'included' as const, tokens: 40 }] }

  it('restores state for the adopted cutoff and writes it inside the transaction', async () => {
    const r = await rig()
    const restore = vi.fn(async () => restored)
    r.host.deps = { ...r.host.deps, restore }
    await r.host.compact({ trigger: 'manual' })
    expect(restore).toHaveBeenCalledWith(4, expect.any(AbortSignal))
    expect(r.session.events.find((event) => event.type === 'compaction/restoration')).toMatchObject({ coversSeq: 4, body: 'RESTORED STATE' })
  })

  it('a restoration that does not fit refuses the compaction after the single handoff request, leaving history alone', async () => {
    const r = await rig()
    r.host.deps = { ...r.host.deps, restore: async () => { throw new Error('required state does not fit') } }
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/does not fit/)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toBeUndefined()
    expect(r.session.events.some((event) => event.type === 'compaction/restoration')).toBe(false)
  })

  it('the legacy and recovery paths do not restore: they keep exactly the behavior they had', async () => {
    const legacy = await rig({ effective: false })
    const restore = vi.fn(async () => restored)
    legacy.host.deps = { ...legacy.host.deps, restore }
    await legacy.host.compact({ trigger: 'manual' })
    expect(restore).not.toHaveBeenCalled()
  })
})

describe('CompactionHost.compact: a precomputed candidate', () => {
  function candidateFor(session: Session, over: Partial<PreparedSummary> = {}): PreparedSummary {
    return { snapshotId: 'cand', cutoff: 4, summary: 'CANDIDATE SUMMARY', sourceDigest: sourceDigest(session.committedEvents, 4), identity, generationMs: 90_000, path: 'exact', ...over }
  }

  /** Turn t1 is the candidate's cutoff (4); turn t2 closed while it was being written. */
  async function withCandidate(candidate?: (session: Session) => PreparedSummary | undefined, effective = true) {
    const r = await rig({ effective })
    const prepared = candidate?.(r.session) ?? candidateFor(r.session)
    turn(r.session, 't2', 'second question', 'a2')
    await r.session.durable()
    r.setExact(snapshotFor(r.session, 8, { id: 'newest' }))
    const candidates = {
      takeReady: vi.fn(),
      waitPending: vi.fn(async (): Promise<PreparedSummary | undefined> => prepared),
      invalidate: vi.fn(async () => {}),
      blocked: vi.fn((): boolean => false),
    }
    r.host.deps = { ...r.host.deps, candidates, limits: { ...r.host.deps.limits, compactionCandidateWaitMs: 15_000 } }
    return { ...r, candidates, prepared }
  }

  it('adopts it with no model call, keeps the turn that closed after it, and runs the hook exactly once', async () => {
    const r = await withCandidate()
    const result = await r.host.compact({ trigger: 'manual' })
    expect(result).toMatchObject({ kind: 'compacted', coversSeq: 4, summary: 'CANDIDATE SUMMARY', path: 'exact', reused: true })
    expect(r.requests).toHaveLength(0)
    expect(r.hooks).toHaveBeenCalledTimes(1)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toMatchObject({ coversSeq: 4, summary: 'CANDIDATE SUMMARY' })
    // The checkpoint covers turn one only; turn two is still verbatim history.
    expect(r.session.committedEvents.filter((event) => event.type === 'turn/end').at(-1)!.seq).toBeGreaterThan(4)
    const end = r.session.events.findLast((event) => event.type === 'compaction/end')!
    expect(end).toMatchObject({ durationMs: 90_000 })
  })

  it('waits for a pending candidate for the configured time, on the compaction signal', async () => {
    const r = await withCandidate()
    await r.host.compact({ trigger: 'manual' })
    expect(r.candidates.waitPending).toHaveBeenCalledWith(r.session.id, 15_000, expect.any(AbortSignal))
  })

  it('without a candidate it generates exactly as before, from the newest snapshot', async () => {
    const r = await withCandidate()
    r.candidates.waitPending.mockResolvedValue(undefined)
    const result = await r.host.compact({ trigger: 'manual' })
    expect(r.requests).toHaveLength(1)
    expect(result).toMatchObject({ kind: 'compacted', coversSeq: 8, summary: 'HANDOFF SUMMARY' })
    expect((result as { reused?: boolean }).reused).toBeUndefined()
  })

  it('serves a session that has no exact snapshot at all: the candidate is the source, so no recovery is asked for', async () => {
    const r = await withCandidate()
    r.setExact(undefined)
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', coversSeq: 4, reused: true })
  })

  it('an automatic compaction uses it too', async () => {
    const r = await withCandidate()
    expect(await r.host.compact({ trigger: 'automatic' })).toMatchObject({ kind: 'compacted', reused: true })
    expect(r.requests).toHaveLength(0)
  })

  it('a block from the PreCompact hook leaves history untouched and spends no model call', async () => {
    const r = await withCandidate()
    r.hooks.mockResolvedValue('PreCompact hook stopped compaction: no')
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/PreCompact hook stopped compaction: no/)
    expect(r.requests).toHaveLength(0)
    expect(r.session.events.some((event) => event.type === 'compaction/start')).toBe(false)
  })

  it('a candidate that was prepared on a different seed is refused by the adoption, leaving a failed end and no checkpoint', async () => {
    const r = await withCandidate((session) => candidateFor(session, { seedHash: 'a-seed-that-never-stood' }))
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/seed/)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toBeUndefined()
    expect(r.requests).toHaveLength(0)
  })

  it('when the identity changed while it waited the adoption refuses; nothing stale is installed', async () => {
    const r = await withCandidate()
    r.host.deps = { ...r.host.deps, identity: () => ({ ...identity, model: 'switched' }) }
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/identity changed/)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toBeUndefined()
  })

  it('a transport that did not settle after the wait stops the compaction: no hook, no model call, no overlap', async () => {
    const r = await withCandidate()
    r.candidates.waitPending.mockRejectedValue(Object.assign(new Error('compaction candidate transport did not settle after cancellation'), { transportSettled: false }))
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/did not settle/)
    expect(r.requests).toHaveLength(0)
    expect(r.hooks).not.toHaveBeenCalled()
  })

  it('while an earlier candidate request may still be running at the provider, no new summary is generated and nothing is held', async () => {
    const r = await withCandidate()
    r.candidates.waitPending.mockResolvedValue(undefined)
    r.candidates.blocked.mockReturnValue(true)
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/has not settled/)
    expect(r.requests).toHaveLength(0)
    expect(r.hooks).not.toHaveBeenCalled()
    expect(r.session.events.some((event) => event.type === 'compaction/start')).toBe(false)
    // Once the provider reports it settled, compaction proceeds as usual.
    r.candidates.blocked.mockReturnValue(false)
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted' })
  })

  it('a no-op never waits for a candidate: nothing is newer than the checkpoint that stands', async () => {
    const r = await withCandidate()
    r.candidates.waitPending.mockResolvedValue(undefined)
    await r.host.compact({ trigger: 'manual' })
    r.candidates.waitPending.mockClear()
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'noop' })
    expect(r.candidates.waitPending).not.toHaveBeenCalled()
  })

  it('with no candidate and no snapshot it folds after asking the candidates once', async () => {
    const r = await withCandidate()
    r.setExact(undefined)
    r.candidates.waitPending.mockResolvedValue(undefined)
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'recovery' })
    expect(r.candidates.waitPending).toHaveBeenCalledTimes(1)
    expect(r.legacy).toHaveBeenCalledTimes(1)
  })

  it('whatever committed, other candidates of the session are dropped afterwards', async () => {
    const r = await withCandidate()
    await r.host.compact({ trigger: 'manual' })
    expect(r.candidates.invalidate).toHaveBeenCalledWith(r.session.id, 'checkpoint-committed')
  })

  it('a rollout switched off never touches candidates', async () => {
    const r = await withCandidate(undefined, false)
    await r.host.compact({ trigger: 'manual' })
    expect(r.candidates.waitPending).not.toHaveBeenCalled()
  })
})

describe('CompactionHost.compact: when the effective path cannot run', () => {
  it('with no usable snapshot a manual compaction just runs the fold — it never asks the user first', async () => {
    const r = await rig()
    r.setExact(undefined)
    const result = await r.host.compact({ trigger: 'manual' })
    expect(result).toMatchObject({ kind: 'compacted', path: 'recovery', coversSeq: 4 })
    expect(r.legacy).toHaveBeenCalledTimes(1)
    expect(r.hooks).toHaveBeenCalledTimes(1)
    // The legacy folder's own prompt, not the handoff.
    expect(String(r.requests[0]!.messages[0]!.content)).not.toContain(COMPACTION_HANDOFF_MARKER)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toMatchObject({ coversSeq: 4 })
  })

  it('an automatic compaction with no usable snapshot runs the fold too', async () => {
    const r = await rig()
    r.setExact(undefined)
    expect(await r.host.compact({ trigger: 'automatic' })).toMatchObject({ kind: 'compacted', path: 'recovery' })
    expect(r.legacy).toHaveBeenCalledWith('automatic', expect.any(AbortSignal))
  })

  it('a stale snapshot (the log changed under it) falls back to the fold instead of failing', async () => {
    const r = await rig()
    r.setExact(snapshotFor(r.session, 4, { sourceDigest: 'stale' }))
    expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'recovery' })
  })

  it('with the rollout switch off it keeps the legacy behavior: no snapshot is consulted', async () => {
    const r = await rig({ effective: false })
    const result = await r.host.compact({ trigger: 'manual' })
    expect(result).toMatchObject({ kind: 'compacted', path: 'legacy' })
    expect(String(r.requests[0]!.messages[0]!.content)).not.toContain(COMPACTION_HANDOFF_MARKER)
  })

  it('with no model configured it uses only the extractive path, and never the handoff', async () => {
    const r = await rig({ model: false })
    const result = await r.host.compact({ trigger: 'manual' })
    expect(result).toMatchObject({ kind: 'compacted', path: 'legacy' })
    expect(r.requests).toHaveLength(0)
  })
})

describe('CompactionHost: legacy delegation', () => {
  it('a recovery calls the server legacy body once, with the hook run exactly once and before it', async () => {
    const r = await rig()
    r.setExact(undefined)
    const order: string[] = []
    r.hooks.mockImplementation(async () => { order.push('hook'); return undefined })
    r.legacy.mockImplementationOnce(async () => { order.push('legacy'); return { coversSeq: 4, summary: 'RECOVERED' } })
    const result = await r.host.compact({ trigger: 'manual' })
    expect(order).toEqual(['hook', 'legacy'])
    expect(r.legacy).toHaveBeenCalledTimes(1)
    expect(r.legacy.mock.calls[0]![0]).toBe('manual')
    expect(r.legacy.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(result).toMatchObject({ kind: 'compacted', path: 'recovery', coversSeq: 4, summary: 'RECOVERED' })
  })

  it('rollout off and no-model both delegate to it and never touch the effective path', async () => {
    for (const options of [{ effective: false }, { model: false }]) {
      const r = await rig(options)
      expect(await r.host.compact({ trigger: 'manual' })).toMatchObject({ kind: 'compacted', path: 'legacy' })
      expect(r.legacy).toHaveBeenCalledTimes(1)
      expect(r.hooks).toHaveBeenCalledTimes(1)
    }
  })

  it('the effective path never calls it', async () => {
    const r = await rig()
    await r.host.compact({ trigger: 'manual' })
    expect(r.legacy).not.toHaveBeenCalled()
  })

  it('a block from PreCompact stops the legacy path too', async () => {
    const r = await rig({ effective: false })
    r.hooks.mockResolvedValue('PreCompact hook stopped compaction: no')
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/stopped compaction: no/)
    expect(r.legacy).not.toHaveBeenCalled()
  })
})

describe('CompactionHost.compact: failure and ownership', () => {
  it('a provider failure appends a failed end, no checkpoint, and does not fall back to folding', async () => {
    const r = await rig({ stream: () => (async function* (): AsyncIterable<StreamEvent> { throw new Error('gateway down') })() })
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/gateway down/)
    expect(r.requests).toHaveLength(1)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toBeUndefined()
    expect(await r.checkpoints.latest(r.session.id)).toBeUndefined()
  })

  it('records the usage of an attempt whose answer was rejected', async () => {
    const r = await rig({ stream: () => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: 'delta', delta: 'x'.repeat(24_001) }
      yield { type: 'usage', usage: { inputTokens: 700, outputTokens: 800 } }
      yield STOP
    })() })
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow()
    expect(r.usage.length).toBeGreaterThanOrEqual(1)
    expect(r.usage[0]).toEqual({ inputTokens: 700, outputTokens: 800 })
  })

  it('conflicts with a compaction already running on the same session', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const r = await rig({ stream: () => (async function* (): AsyncIterable<StreamEvent> { await gate; yield { type: 'delta', delta: 'S' }; yield STOP })() })
    const first = r.host.compact({ trigger: 'manual' })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1))
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/in progress|already/)
    expect(r.host.busy).toBe(true)
    release()
    await first
    expect(r.host.busy).toBe(false)
  })

  it('cancel() aborts a running compaction, releases ownership and writes no success', async () => {
    const r = await rig({ stream: hangUntilAborted })
    const run = r.host.compact({ trigger: 'manual' })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1))
    r.host.cancel()
    await expect(run).rejects.toThrow()
    expect(r.host.busy).toBe(false)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toBeUndefined()
  })

  it('close() cancels what is running and refuses new work', async () => {
    const r = await rig({ stream: hangUntilAborted })
    const run = r.host.compact({ trigger: 'manual' }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(r.requests).toHaveLength(1))
    await r.host.close()
    expect(await run).toBeInstanceOf(Error)
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/closing|closed/)
  })

  it('a model change between summarizing and adopting refuses the adoption', async () => {
    const r = await rig()
    let calls = 0
    r.host.deps = { ...r.host.deps, identity: () => (++calls <= 1 ? identity : { ...identity, model: 'switched' }) }
    await expect(r.host.compact({ trigger: 'manual' })).rejects.toThrow(/identity|changed/)
    expect(recoverCanonicalCheckpoint(r.session.committedEvents)).toBeUndefined()
  })
})
