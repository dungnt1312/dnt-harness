/**
 * The candidate manager: one background summary per session, generated from an
 * immutable snapshot while the conversation keeps going, adopted later (or
 * discarded). It never writes a checkpoint and never runs a hook — it only
 * produces a PreparedSummary and says whether that summary is still usable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../../src/harness/context/compaction-snapshot.ts'
import { ProviderError, type ModelCompletion, type ModelRequest, type StreamEvent, type StreamOptions, type TokenUsage } from '../../src/harness/llm/types.ts'
import { COMPACTION_HANDOFF_MARKER } from '../../src/web/compaction-generator.ts'
import { CompactionPrecompute, candidateOwner, type CandidateReport } from '../../src/web/compaction-precompute.ts'

const STOP: ModelCompletion = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
const identity: SnapshotIdentity = { provider: 'p', model: 'm', modeHash: 'mode', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' }

afterEach(() => vi.useRealTimers())

function snapshot(over: Partial<EffectiveCompactionSnapshot> = {}): EffectiveCompactionSnapshot {
  return {
    id: 'snap-1', v: 1, policyVersion: 1, sessionId: 's1', cutoff: 4, turnId: 't1',
    request: { model: 'm', providerName: 'p', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first' }] },
    finalAnswer: { role: 'assistant', content: 'a1' },
    projection: { v: 1, policyVersion: 1, history: 'compact', sources: [], losses: [] },
    sourceDigest: 'digest-4',
    identity,
    ...over,
  }
}

interface Call {
  request: ModelRequest
  options: StreamOptions | undefined
  finish(): void
  fail(error: unknown): void
  ended: boolean
  /** True once the stream has delivered everything it will before waiting (usage included). */
  waiting: boolean
}

/** A provider stream the test finishes, fails or lets time out by hand; it stops when its signal aborts. */
function controlled(mode: { usageFirst?: boolean; ignoreAbort?: 'uncertain' } = {}) {
  const calls: Call[] = []
  const stream = (request: ModelRequest, options?: StreamOptions): AsyncIterable<StreamEvent> => {
    const call: Call = { request, options, finish: () => {}, fail: () => {}, ended: false, waiting: false }
    calls.push(call)
    return (async function* (): AsyncIterable<StreamEvent> {
      try {
        if (mode.usageFirst === true) yield { type: 'usage', usage: { inputTokens: 700, outputTokens: 11 } }
        await new Promise<void>((resolve, reject) => {
          call.finish = resolve
          call.fail = reject
          call.waiting = true
          options?.signal?.addEventListener('abort', () => {
            if (mode.ignoreAbort === 'uncertain') {
              const error = new ProviderError('transport did not settle')
              error.transportSettled = false
              reject(error)
            } else reject(options.signal?.reason)
          }, { once: true })
        })
        yield { type: 'delta', delta: 'CANDIDATE SUMMARY' }
        yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 30 } }
        yield STOP
      } finally {
        call.ended = true
      }
    })()
  }
  return { calls, stream }
}

function rig(mode: Parameters<typeof controlled>[0] = {}, over: Partial<ConstructorParameters<typeof CompactionPrecompute>[0]> = {}) {
  const state = { identity: { ...identity } as SnapshotIdentity, seed: undefined as string | undefined, digest: 'digest-4', stillUncertain: true, assessment: undefined as 'no-gain' | 'no-fit' | undefined }
  const reports: CandidateReport[] = []
  const usage: TokenUsage[] = []
  const s = controlled(mode)
  const manager = new CompactionPrecompute({
    stream: s.stream,
    identity: () => state.identity,
    seedHash: () => state.seed,
    digestAt: () => state.digest,
    transportUncertain: () => state.stillUncertain,
    assess: () => state.assessment,
    nativeVision: () => true,
    limits: { compactionDeadlineMs: 5_000, compactionOutputTokens: 8_000 },
    recordUsage: (_sessionId, u) => usage.push(u),
    report: (r) => reports.push(r),
    ...over,
  })
  return { manager, state, reports, usage, s }
}

const signal = (): AbortSignal => new AbortController().signal
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const finishFirst = async (r: ReturnType<typeof rig>): Promise<void> => {
  await vi.waitFor(() => expect(r.s.calls.length).toBeGreaterThan(0))
  r.s.calls[0]!.finish()
  await flush()
}

describe('CompactionPrecompute: one job per session', () => {
  it('starts once per session and refuses a second start while the first is generating or ready', async () => {
    const r = rig()
    expect(await r.manager.start(snapshot(), signal())).toBe(true)
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(false)
    expect(await r.manager.start(snapshot({ sessionId: 's2' }), signal())).toBe(true)
    await finishFirst(r)
    expect(await r.manager.start(snapshot({ id: 'snap-3' }), signal())).toBe(false)
  })

  it('a ready candidate that is no longer worth adopting is replaced by a newer snapshot; one that still is stays', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    // Still good: a newer snapshot does not displace it, so a long session does not pay for a summary every turn.
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(false)
    expect(r.manager.pinned('s1')).toBe('snap-1')
    // The conversation grew past what it can serve: now the newer snapshot takes over.
    r.state.assessment = 'no-fit'
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(true)
    expect(r.manager.pinned('s1')).toBe('snap-2')
    expect(r.reports.find((report) => report.kind === 'discarded')).toMatchObject({ snapshotId: 'snap-1', reason: 'no-fit' })
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(2))
    r.s.calls[1]!.finish()
  })

  it('a ready candidate whose source or checkpoint changed is replaced too', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    r.state.seed = 'a-new-checkpoint'
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8, seedHash: 'a-new-checkpoint' }), signal())).toBe(true)
    expect(r.reports.find((report) => report.kind === 'discarded')).toMatchObject({ reason: 'seed-changed' })
  })

  it('a job that is still generating is never displaced by a newer snapshot', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    r.state.assessment = 'no-fit'
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(false)
    expect(r.manager.pinned('s1')).toBe('snap-1')
    r.s.calls[0]!.finish()
  })

  it('generates from the snapshot with the handoff prompt, as a LOW-priority request on its own attribution', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    const call = r.s.calls[0]!
    expect(String(call.request.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
    expect(call.options?.admissionPriority).toBe('low')
    expect(call.request.maxOutputTokens).toBe(8_000)
    call.finish()
  })

  it('summarises with the identity pair, not the model the capture was dispatched to (a slash-command turn)', async () => {
    const r = rig()
    const session = { ...identity, provider: 'alpha', model: 'gpt-5.6', thinkingLevel: 'high' }
    await r.manager.start(snapshot({ identity: session, request: { model: 'glm-4.7', providerName: 'alpha', thinkingLevel: 'low', messages: [{ role: 'user', content: 'first' }] } }), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    expect(r.s.calls[0]!.request).toMatchObject({ providerName: 'alpha', model: 'gpt-5.6', thinkingLevel: 'high' })
    r.s.calls[0]!.finish()
  })

  it('a non-native identity model receives no image parts; the stored snapshot is untouched', async () => {
    const image = { role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'image' as const, mediaType: 'image/png', base64: 'AAAA' }] }
    const stored = snapshot({ request: { model: 'm', providerName: 'p', messages: [{ role: 'system', content: 'sys' }, image] } })
    const text = rig({}, { nativeVision: () => false })
    await text.manager.start(stored, signal())
    await vi.waitFor(() => expect(text.s.calls).toHaveLength(1))
    const sent = JSON.stringify(text.s.calls[0]!.request.messages)
    expect(sent).not.toContain('"type":"image"')
    expect(sent).toContain('cannot see image pixels')
    expect(stored.request.messages[1]).toBe(image)
    text.s.calls[0]!.finish()
    const native = rig({}, { nativeVision: () => true })
    await native.manager.start(stored, signal())
    await vi.waitFor(() => expect(native.s.calls).toHaveLength(1))
    expect(native.s.calls[0]!.request.messages[1]).toEqual(image)
    native.s.calls[0]!.finish()
  })

  it('runs on an owner of its own: attributing it to the session would fence the very next chat turn', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    const attribution = r.s.calls[0]!.options?.attribution
    expect(attribution?.sessionId).toBe(candidateOwner('s1'))
    expect(attribution?.sessionId).not.toBe('s1')
    r.s.calls[0]!.finish()
  })

  it('pins its snapshot while generating or ready, and releases the pin once consumed', async () => {
    const r = rig()
    expect(r.manager.pinned('s1')).toBeUndefined()
    await r.manager.start(snapshot(), signal())
    expect(r.manager.pinned('s1')).toBe('snap-1')
    await finishFirst(r)
    expect(r.manager.pinned('s1')).toBe('snap-1')
    expect(await r.manager.takeReady('s1')).toBeDefined()
    expect(r.manager.pinned('s1')).toBeUndefined()
  })
})

describe('CompactionPrecompute: pending → ready', () => {
  it('has nothing to take while pending, then yields the prepared summary exactly once', async () => {
    const r = rig()
    await r.manager.start(snapshot({ seedHash: 'seed-a' }), signal())
    r.state.seed = 'seed-a'
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    expect(await r.manager.takeReady('s1')).toBeUndefined()
    r.s.calls[0]!.finish()
    await flush()
    const prepared = await r.manager.takeReady('s1')
    expect(prepared).toMatchObject({ snapshotId: 'snap-1', cutoff: 4, summary: 'CANDIDATE SUMMARY', sourceDigest: 'digest-4', seedHash: 'seed-a', path: 'exact' })
    expect(await r.manager.takeReady('s1')).toBeUndefined()
    expect(r.reports.map((report) => report.kind)).toEqual(['started', 'ready', 'reused'])
  })

  it('a normal append after the cutoff does not discard it: only the covered source matters', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    // The conversation moved on (turns after the cutoff); the digest THROUGH the cutoff is unchanged.
    expect(await r.manager.takeReady('s1')).toMatchObject({ cutoff: 4 })
  })

  it.each([
    ['the covered source was rewritten', (r: ReturnType<typeof rig>) => { r.state.digest = 'rewritten' }, 'source-changed'],
    ['a different checkpoint now stands', (r: ReturnType<typeof rig>) => { r.state.seed = 'another-seed' }, 'seed-changed'],
    ['the model changed', (r: ReturnType<typeof rig>) => { r.state.identity = { ...identity, model: 'other' } }, 'identity-changed'],
    ['the mode changed', (r: ReturnType<typeof rig>) => { r.state.identity = { ...identity, modeHash: 'other' } }, 'identity-changed'],
    ['the folder grants changed', (r: ReturnType<typeof rig>) => { r.state.identity = { ...identity, grantsHash: 'other' } }, 'identity-changed'],
    ['the provider generation changed', (r: ReturnType<typeof rig>) => { r.state.identity = { ...identity, providerGeneration: 2 } }, 'identity-changed'],
    ['the policy version changed', (r: ReturnType<typeof rig>) => { r.state.identity = { ...identity, policyVersion: 2 } }, 'identity-changed'],
  ])('is discarded, not handed out, when %s', async (_name, change, reason) => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    change(r)
    expect(await r.manager.takeReady('s1')).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason })
    expect(r.manager.pinned('s1')).toBeUndefined()
  })

  it.each([
    ['saves too little to be worth a checkpoint', 'no-gain' as const],
    ['would not fit once the tail that refilled is counted', 'no-fit' as const],
  ])('a still-valid candidate that %s is discarded before anything is written', async (_name, verdict) => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    r.state.assessment = verdict
    expect(await r.manager.takeReady('s1')).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason: verdict })
    expect(r.reports.some((report) => report.kind === 'reused')).toBe(false)
    expect(r.manager.pinned('s1')).toBeUndefined()
  })

  it('a prefix hash that moved on with later turns is NOT an identity change', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    r.state.identity = { ...identity, prefixHash: 'a-later-turns-prefix' }
    expect(await r.manager.takeReady('s1')).toBeDefined()
  })

  it('an async (builder-sized) no-fit verdict refuses the candidate; a source change during the await wins over it', async () => {
    let answer!: (verdict: 'no-fit' | undefined) => void
    const r = rig({}, { assess: () => new Promise((resolve) => { answer = resolve }) })
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    const taking = r.manager.takeReady('s1')
    // Claimed while the assessment awaits: nothing else can take it.
    expect(r.manager.pinned('s1')).toBeUndefined()
    answer('no-fit')
    expect(await taking).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason: 'no-fit' })

    await r.manager.start(snapshot({ id: 'snap-2' }), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(2))
    r.s.calls[1]!.finish()
    await flush()
    const again = r.manager.takeReady('s1')
    r.state.digest = 'rewritten'
    answer(undefined)
    expect(await again).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason: 'source-changed' })
  })

  it('start does not discard a job that was taken while its assessment awaited', async () => {
    let answer!: (verdict: 'no-fit' | undefined) => void
    const r = rig({}, { assess: () => new Promise((resolve) => { answer = resolve }) })
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    const starting = r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())
    const first = answer
    await r.manager.invalidate('s1', 'checkpoint-committed')
    first('no-fit')
    expect(await starting).toBe(false)
    expect(r.reports.filter((report) => report.kind === 'discarded')).toHaveLength(1)
  })
})

describe('CompactionPrecompute: failure and deadline', () => {
  it('a stalled job fails at the deadline, keeps the reported usage, and the same snapshot+identity is not retried in a loop', async () => {
    vi.useFakeTimers()
    const r = rig({ usageFirst: true })
    await r.manager.start(snapshot(), signal())
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await r.manager.takeReady('s1')).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('deadline') })
    expect(r.usage).toEqual([{ inputTokens: 700, outputTokens: 11 }])
    expect(await r.manager.start(snapshot(), signal())).toBe(false)
    // New source (a different snapshot) or a changed identity is a fresh chance.
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(true)
  })

  it('a changed identity is a fresh chance after a failure on the same snapshot', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    r.s.calls[0]!.fail(new Error('provider 500'))
    await flush()
    expect(await r.manager.start(snapshot(), signal())).toBe(false)
    r.state.identity = { ...identity, model: 'other' }
    expect(await r.manager.start(snapshot({ identity: r.state.identity }), signal())).toBe(true)
  })

  it('a failing job never throws at the caller and never leaves an unhandled rejection', async () => {
    const r = rig()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      expect(() => r.manager.start(snapshot(), signal())).not.toThrow()
      await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
      r.s.calls[0]!.fail(new Error('boom'))
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
})

describe('CompactionPrecompute: stopping a job', () => {
  it('the parent signal (Stop, delete, shutdown) cancels the stream', async () => {
    const r = rig()
    const parent = new AbortController()
    await r.manager.start(snapshot(), parent.signal)
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    parent.abort(new Error('session deleted'))
    await vi.waitFor(() => expect(r.s.calls[0]!.ended).toBe(true))
    expect(r.manager.pinned('s1')).toBeUndefined()
  })

  it('invalidate while generating aborts the stream, waits until it has settled, and still records the usage it reported', async () => {
    const r = rig({ usageFirst: true })
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls[0]?.waiting).toBe(true))
    await r.manager.invalidate('s1', 'model-changed')
    expect(r.s.calls[0]!.ended).toBe(true)
    expect(r.usage).toEqual([{ inputTokens: 700, outputTokens: 11 }])
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason: 'model-changed' })
    expect(r.manager.pinned('s1')).toBeUndefined()
    // An invalidation is not a failure: the same snapshot may be generated again.
    expect(await r.manager.start(snapshot(), signal())).toBe(true)
  })

  it('invalidate on a ready candidate discards it', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    await r.manager.invalidate('s1', 'checkpoint-committed')
    expect(await r.manager.takeReady('s1')).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason: 'checkpoint-committed' })
  })

  it('invalidate with nothing running is a no-op', async () => {
    const r = rig()
    await expect(r.manager.invalidate('s1', 'whatever')).resolves.toBeUndefined()
    expect(r.reports).toEqual([])
  })

  it('close cancels every job, waits for all streams to end, and refuses new starts', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await r.manager.start(snapshot({ sessionId: 's2' }), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(2))
    await r.manager.close()
    expect(r.s.calls.every((call) => call.ended)).toBe(true)
    expect(await r.manager.start(snapshot({ sessionId: 's3' }), signal())).toBe(false)
  })
})

describe('CompactionPrecompute.waitPending: the manual compaction meets a candidate', () => {
  it('returns the candidate that finishes inside the wait', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    const waiting = r.manager.waitPending('s1', 15_000, signal())
    r.s.calls[0]!.finish()
    expect(await waiting).toMatchObject({ summary: 'CANDIDATE SUMMARY', cutoff: 4 })
    expect(r.reports.at(-1)).toMatchObject({ kind: 'reused' })
  })

  it('returns a ready candidate immediately and nothing when no job exists', async () => {
    const r = rig()
    expect(await r.manager.waitPending('s1', 15_000, signal())).toBeUndefined()
    await r.manager.start(snapshot(), signal())
    await finishFirst(r)
    expect(await r.manager.waitPending('s1', 15_000, signal())).toBeDefined()
  })

  it('past the wait it aborts the job and returns only once the stream has really ended, so nothing overlaps', async () => {
    vi.useFakeTimers()
    // The job's own deadline is far away: this test is about the wait, not the deadline.
    const r = rig({}, { limits: { compactionDeadlineMs: 600_000, compactionOutputTokens: 8_000 } })
    await r.manager.start(snapshot(), signal())
    await vi.advanceTimersByTimeAsync(0)
    expect(r.s.calls).toHaveLength(1)
    const waiting = r.manager.waitPending('s1', 15_000, signal())
    let result: unknown = 'pending'
    void waiting.then((value) => { result = value })
    await vi.advanceTimersByTimeAsync(14_000)
    expect(result).toBe('pending')
    expect(r.s.calls[0]!.options?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_001)
    await waiting
    expect(result).toBeUndefined()
    expect(r.s.calls[0]!.options?.signal?.aborted).toBe(true)
    expect(r.s.calls[0]!.ended).toBe(true)
    expect(r.manager.pinned('s1')).toBeUndefined()
    // A wait that ran out is not a failure: the same snapshot may be tried again later.
    expect(await r.manager.start(snapshot(), signal())).toBe(true)
  })

  it('when the aborted transport never settles it throws and blocks a successor, instead of pretending the abort freed the slot', async () => {
    vi.useFakeTimers()
    const r = rig({ ignoreAbort: 'uncertain' }, { limits: { compactionDeadlineMs: 600_000, compactionOutputTokens: 8_000 } })
    await r.manager.start(snapshot(), signal())
    await vi.advanceTimersByTimeAsync(0)
    const waiting = r.manager.waitPending('s1', 1_000, signal())
    const assertion = expect(waiting).rejects.toMatchObject({ transportSettled: false })
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
    expect(r.manager.blocked('s1')).toBe(true)
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(false)
    // Once the host reports the transport settled, the session may speculate again.
    r.state.stillUncertain = false
    expect(r.manager.blocked('s1')).toBe(false)
    expect(await r.manager.start(snapshot({ id: 'snap-2', cutoff: 8 }), signal())).toBe(true)
  })

  it('Stop while waiting cancels the candidate too and rejects with the stop reason', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    const stop = new AbortController()
    const waiting = r.manager.waitPending('s1', 15_000, stop.signal)
    stop.abort(new Error('user stopped'))
    await expect(waiting).rejects.toThrow(/user stopped/)
    expect(r.s.calls[0]!.ended).toBe(true)
    expect(r.manager.pinned('s1')).toBeUndefined()
  })

  it('a stale candidate that finishes during the wait is discarded, not returned', async () => {
    const r = rig()
    await r.manager.start(snapshot(), signal())
    await vi.waitFor(() => expect(r.s.calls).toHaveLength(1))
    const waiting = r.manager.waitPending('s1', 15_000, signal())
    r.state.seed = 'a-new-checkpoint'
    r.s.calls[0]!.finish()
    expect(await waiting).toBeUndefined()
    expect(r.reports.at(-1)).toMatchObject({ kind: 'discarded', reason: 'seed-changed' })
  })
})
