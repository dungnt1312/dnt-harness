/**
 * Adopting a prepared summary: a checkpoint whose cutoff is OLDER than the
 * newest closed turn. The summary covers exactly its cutoff; everything after
 * it stays verbatim in context. Recovery trusts a proof written into the log,
 * never a sidecar or an in-memory flag.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel, Session, deriveMessages, type TurnId } from 'dnt-harness'
import {
  CheckpointStore,
  adoptPreparedCompaction,
  recoverCanonicalCheckpoint,
  type AdoptionOptions,
} from '../../src/harness/context/compaction.ts'
import { compactionSeedHash, sourceDigest } from '../../src/harness/context/compaction-digest.ts'
import type { PreparedSummary } from '../../src/web/compaction-generator.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { SessionStore } from '../../src/harness/storage/file-session-store.ts'

const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

const T = (id: string): TurnId => id as TurnId

function turn(session: Session, id: string, text: string, answer = `answer ${id}`): void {
  session.append({ type: 'turn/start', turnId: T(id) })
  session.append({ type: 'user/message', turnId: T(id), content: text })
  session.append({ type: 'assistant/message', stepId: `s-${id}` as never, content: answer })
  session.append({ type: 'turn/end', turnId: T(id), reason: 'completed' })
}

async function setup(): Promise<{ session: Session; checkpoints: CheckpointStore; home: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'compact-adoption-'))
  homes.push(home)
  const session = new Session(new Kernel().ctx)
  turn(session, 't1', 'first request') // seq 1-4, cutoff A = 4
  await session.durable()
  return { session, checkpoints: new CheckpointStore(home), home }
}

const CUTOFF_A = 4

function prepared(session: Session, over: Partial<PreparedSummary> = {}): PreparedSummary {
  return {
    snapshotId: 'snap-1',
    cutoff: CUTOFF_A,
    summary: 'SUMMARY OF TURN ONE',
    sourceDigest: sourceDigest(session.committedEvents, CUTOFF_A),
    identity: { provider: 'p', model: 'm', modeHash: 'mode', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' },
    generationMs: 1200,
    path: 'exact',
    ...over,
  }
}

function options(over: Partial<AdoptionOptions> = {}): AdoptionOptions {
  return {
    trigger: 'manual',
    signal: new AbortController().signal,
    validate: async () => {},
    measure: () => ({ tokensBefore: 1000, tokensAfter: 300 }),
    ...over,
  }
}

const endEvents = (session: Session): Extract<SessionEvent, { type: 'compaction/end' }>[] =>
  session.events.filter((event): event is Extract<SessionEvent, { type: 'compaction/end' }> => event.type === 'compaction/end')

describe('adoptPreparedCompaction', () => {
  it('awaits measurement and revalidates before publishing a success', async () => {
    const { session, checkpoints } = await setup()
    let release!: () => void; let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const measuring = new Promise<void>(resolve => { entered = resolve })
    let valid = true
    const pending = adoptPreparedCompaction(session, checkpoints, prepared(session), options({
      measure: async () => { entered(); await gate; return { tokensBefore: 10, tokensAfter: 5 } },
      validate: async () => { if (!valid) throw new Error('context revision changed') },
    }))
    const assertion = expect(pending).rejects.toThrow('context revision changed')
    await measuring
    expect(endEvents(session)).toHaveLength(0)
    valid = false; release()
    await assertion
    expect(endEvents(session).some(e => e.error === undefined)).toBe(false)
  })
  it('commits a checkpoint at the prepared cutoff, with a proof in both lifecycle events', async () => {
    const { session, checkpoints } = await setup()
    const checkpoint = await adoptPreparedCompaction(session, checkpoints, prepared(session), options())
    expect(checkpoint).toMatchObject({ v: 1, coversSeq: CUTOFF_A, summary: 'SUMMARY OF TURN ONE' })
    const start = session.events.find((event) => event.type === 'compaction/start')
    const end = endEvents(session)[0]!
    expect(start).toMatchObject({ trigger: 'manual', adoption: { v: 1, cutoff: CUTOFF_A } })
    expect(end).toMatchObject({ coversSeq: CUTOFF_A, summary: 'SUMMARY OF TURN ONE', adoption: { v: 1, cutoff: CUTOFF_A, sourceDigest: prepared(session).sourceDigest } })
    expect((start as { adoption: { transactionId: string } }).adoption.transactionId).toBe(end.adoption!.transactionId)
    expect(end.tokensBefore).toBe(1000)
    expect(end.tokensAfter).toBe(300)
    expect(await checkpoints.latest(session.id, session.committedEvents)).toEqual(checkpoint)
  })

  it('a turn that CLOSED after the cutoff survives verbatim and the checkpoint still covers only the cutoff', async () => {
    const { session, checkpoints } = await setup()
    const summary = prepared(session)
    // The conversation moves on while the summary was being prepared.
    turn(session, 't2', 'tail B request', 'tail B answer')
    await session.durable()
    const checkpoint = await adoptPreparedCompaction(session, checkpoints, summary, options())
    expect(checkpoint.coversSeq).toBe(CUTOFF_A)
    expect(recoverCanonicalCheckpoint(session.committedEvents)?.coversSeq).toBe(CUTOFF_A)
    const texts = deriveMessages(session.committedEvents).map((message) => String(message.content))
    expect(texts).toContain('tail B request')
    expect(texts).toContain('tail B answer')
  })

  it('refuses while a turn is open', async () => {
    const { session, checkpoints } = await setup()
    const summary = prepared(session)
    session.append({ type: 'turn/start', turnId: T('t2') })
    session.append({ type: 'user/message', turnId: T('t2'), content: 'still working' })
    await session.durable()
    await expect(adoptPreparedCompaction(session, checkpoints, summary, options())).rejects.toThrow(/open turn|completed exchange boundary/)
    expect(endEvents(session)).toHaveLength(0)
    expect(session.events.some((event) => event.type === 'compaction/start')).toBe(false)
  })

  it('refuses a stale source digest, a wrong cutoff and a cutoff that is not a closed turn', async () => {
    const { session, checkpoints } = await setup()
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session, { sourceDigest: 'stale' }), options())).rejects.toThrow(/digest/)
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session, { cutoff: 3 }), options())).rejects.toThrow(/boundary|digest/)
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session, { cutoff: 99 }), options())).rejects.toThrow(/boundary|digest/)
    expect(session.events.some((event) => event.type === 'compaction/start')).toBe(false)
  })

  it('refuses when the seed changed since preparation (another checkpoint was committed)', async () => {
    const { session, checkpoints } = await setup()
    const summary = prepared(session) // prepared against "no seed"
    await adoptPreparedCompaction(session, checkpoints, prepared(session, { snapshotId: 'other' }), options())
    const firstSeed = compactionSeedHash('SUMMARY OF TURN ONE')
    turn(session, 't2', 'second', 'second answer')
    await session.durable()
    // Turn 1 = seq 1-4, the adopted start/end = 5-6, turn 2 = 7-10. A candidate for
    // cutoff 10 prepared WITHOUT the checkpoint that now exists must be refused.
    const cutoff = session.committedEvents.findLast((event) => event.type === 'turn/end')!.seq
    expect(cutoff).toBe(10)
    await expect(adoptPreparedCompaction(session, checkpoints, { ...summary, cutoff, sourceDigest: sourceDigest(session.committedEvents, cutoff) }, options())).rejects.toThrow(/seed/)
    // The same candidate built ON TOP of the checkpoint that stands is adopted.
    const built = await adoptPreparedCompaction(session, checkpoints, { ...summary, cutoff, sourceDigest: sourceDigest(session.committedEvents, cutoff), seedHash: firstSeed, summary: 'SECOND SUMMARY' }, options())
    expect(built).toMatchObject({ coversSeq: cutoff, summary: 'SECOND SUMMARY' })
    // And a candidate claiming a seed that never stood is refused.
    turn(session, 't3', 'third', 'third answer')
    await session.durable()
    const later = session.committedEvents.findLast((event) => event.type === 'turn/end')!.seq
    await expect(adoptPreparedCompaction(session, checkpoints, { ...summary, cutoff: later, sourceDigest: sourceDigest(session.committedEvents, later), seedHash: 'never-stood' }, options())).rejects.toThrow(/seed/)
  })

  it('records an unchanged cutoff as a no-op: no lifecycle events, nothing written', async () => {
    const { session, checkpoints } = await setup()
    const first = await adoptPreparedCompaction(session, checkpoints, prepared(session), options())
    const before = session.events.length
    const validate = vi.fn(async () => {})
    const again = await adoptPreparedCompaction(session, checkpoints, prepared(session, { snapshotId: 'again' }), options({ validate }))
    expect(again).toEqual(first)
    expect(session.events).toHaveLength(before)
    expect(validate).not.toHaveBeenCalled()
  })

  it('writes a failed end, and no success, when the final validation rejects', async () => {
    const { session, checkpoints } = await setup()
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session), options({ validate: async () => { throw new Error('model changed') } }))).rejects.toThrow(/model changed/)
    const ends = endEvents(session)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ error: expect.stringContaining('model changed') })
    expect(ends[0]!.summary).toBeUndefined()
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toBeUndefined()
    expect(await checkpoints.latest(session.id)).toBeUndefined()
  })

  it('does not adopt a summary larger than the cap or empty', async () => {
    const { session, checkpoints } = await setup()
    for (const summary of ['', '   ', 'x'.repeat(24_001)]) {
      await expect(adoptPreparedCompaction(session, checkpoints, prepared(session, { summary }), options())).rejects.toThrow()
    }
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toBeUndefined()
  })

  it('serializes with other compaction transactions on the same session', async () => {
    const { session, checkpoints } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = adoptPreparedCompaction(session, checkpoints, prepared(session), options({ validate: () => gate }))
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session, { snapshotId: 'two' }), options())).rejects.toThrow(/in progress/)
    release()
    await first
  })

  it('a cancelled adoption before the commit leaves only a failed end', async () => {
    const { session, checkpoints } = await setup()
    const controller = new AbortController()
    const run = adoptPreparedCompaction(session, checkpoints, prepared(session), options({ signal: controller.signal, validate: async () => { controller.abort(new Error('stopped')) } }))
    await expect(run).rejects.toThrow(/stopped/)
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toBeUndefined()
    expect(endEvents(session)[0]).toMatchObject({ error: expect.stringContaining('stopped') })
  })
})

describe('restoration inside the adoption transaction', () => {
  const restoration = { body: 'RESTORED STATE', tokens: 4, sections: [{ kind: 'todo' as const, name: 'todo', status: 'included' as const, tokens: 4 }] }

  it('writes the restoration between the start and the success end, and it is durable with them', async () => {
    const { session, checkpoints } = await setup()
    await adoptPreparedCompaction(session, checkpoints, prepared(session), options({ restore: async () => restoration }))
    const types = session.events.map((event) => event.type).filter((type) => type.startsWith('compaction/'))
    expect(types).toEqual(['compaction/start', 'compaction/restoration', 'compaction/end'])
    expect(session.events.find((event) => event.type === 'compaction/restoration')).toMatchObject({ coversSeq: CUTOFF_A, body: 'RESTORED STATE', sections: restoration.sections })
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toMatchObject({ coversSeq: CUTOFF_A })
  })

  it('reads the restoration for the prepared cutoff, after the start barrier and before the final validation', async () => {
    const { session, checkpoints } = await setup()
    const order: string[] = []
    const restore = vi.fn(async (cutoff: number) => {
      order.push(`restore:${cutoff}:${session.events.some((event) => event.type === 'compaction/start') ? 'after-start' : 'before-start'}`)
      return restoration
    })
    await adoptPreparedCompaction(session, checkpoints, prepared(session), options({ restore, validate: async () => { order.push('validate') } }))
    expect(order).toEqual([`restore:${CUTOFF_A}:after-start`, 'validate'])
  })

  it('a restoration that cannot be built refuses the adoption: a failed end, no restoration, no checkpoint', async () => {
    const { session, checkpoints } = await setup()
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session), options({ restore: async () => { throw new Error('required state does not fit') } }))).rejects.toThrow(/does not fit/)
    expect(session.events.some((event) => event.type === 'compaction/restoration')).toBe(false)
    expect(endEvents(session)[0]).toMatchObject({ error: expect.stringContaining('does not fit') })
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toBeUndefined()
  })

  it('nothing to restore writes no restoration event', async () => {
    const { session, checkpoints } = await setup()
    await adoptPreparedCompaction(session, checkpoints, prepared(session), options({ restore: async () => undefined }))
    expect(session.events.some((event) => event.type === 'compaction/restoration')).toBe(false)
  })

  it('gives measurement the full wrapped-source restoration input', async () => {
    const { session, checkpoints } = await setup()
    const measure = vi.fn(() => ({ tokensBefore: 10, tokensAfter: 5 }))
    await adoptPreparedCompaction(session, checkpoints, prepared(session), options({ restore: async () => restoration, measure }))
    expect(measure).toHaveBeenCalledWith({ summary: 'SUMMARY OF TURN ONE', coversSeq: CUTOFF_A }, undefined, restoration)
  })

  it('a cancelled adoption does not leave a restoration behind that a later success could pick up', async () => {
    const { session, checkpoints } = await setup()
    const controller = new AbortController()
    await expect(adoptPreparedCompaction(session, checkpoints, prepared(session), options({ signal: controller.signal, restore: async () => { controller.abort(new Error('stopped')); return restoration } }))).rejects.toThrow(/stopped/)
    expect(session.events.some((event) => event.type === 'compaction/restoration')).toBe(false)
  })
})

describe('canonical recovery of an adopted checkpoint', () => {
  async function adopted(): Promise<{ session: Session; checkpoints: CheckpointStore }> {
    const { session, checkpoints } = await setup()
    const summary = prepared(session)
    turn(session, 't2', 'tail B', 'tail B answer')
    await session.durable()
    await adoptPreparedCompaction(session, checkpoints, summary, options())
    return { session, checkpoints }
  }

  /** Rewrite one field of the committed end, as a forger with write access to the log would. */
  const forge = (events: readonly SessionEvent[], patch: (end: Record<string, unknown>) => void): SessionEvent[] =>
    events.map((event) => {
      if (event.type !== 'compaction/end') return event
      const copy = structuredClone(event) as unknown as Record<string, unknown>
      patch(copy)
      return copy as unknown as SessionEvent
    })

  it('accepts the honest log', async () => {
    const { session } = await adopted()
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toMatchObject({ coversSeq: CUTOFF_A, summary: 'SUMMARY OF TURN ONE' })
  })

  it('rejects a forged proof: wrong transaction, digest or cutoff', async () => {
    const { session } = await adopted()
    const events = session.committedEvents
    expect(recoverCanonicalCheckpoint(forge(events, (end) => { (end['adoption'] as Record<string, unknown>)['transactionId'] = 'someone-else' }))).toBeUndefined()
    expect(recoverCanonicalCheckpoint(forge(events, (end) => { (end['adoption'] as Record<string, unknown>)['sourceDigest'] = 'forged' }))).toBeUndefined()
    expect(recoverCanonicalCheckpoint(forge(events, (end) => { (end['adoption'] as Record<string, unknown>)['cutoff'] = CUTOFF_A + 1 }))).toBeUndefined()
  })

  it('rejects an end with a turn that STARTED between the start event and the end event', async () => {
    const { session, checkpoints } = await setup()
    const summary = prepared(session)
    // Hold the transaction open and let a turn begin inside it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = adoptPreparedCompaction(session, checkpoints, summary, options({ validate: () => gate }))
    await vi.waitFor(() => expect(session.events.some((event) => event.type === 'compaction/start')).toBe(true))
    session.append({ type: 'turn/start', turnId: T('intruder') })
    release()
    await run.catch(() => {})
    expect(recoverCanonicalCheckpoint(session.events)).toBeUndefined()
  })

  it('recovery alone rejects a turn that started inside the transaction, even when the success end is already in the log', async () => {
    // The adoption path refuses this itself; recovery must not rely on that, because a
    // log can be damaged or written by something else. Splice a turn/start between the
    // honest start and end events and re-sequence.
    const { session } = await adopted()
    const events = session.committedEvents
    const startAt = events.findIndex((event) => event.type === 'compaction/start')
    const intruder = { type: 'turn/start', turnId: 'intruder', timestamp: 1 } as unknown as SessionEvent
    const spliced = [...events.slice(0, startAt + 1), intruder, ...events.slice(startAt + 1)].map((event, index) => ({ ...event, seq: index + 1 })) as SessionEvent[]
    expect(spliced.some((event) => event.type === 'compaction/end' && event.summary !== undefined)).toBe(true)
    expect(recoverCanonicalCheckpoint(spliced)).toBeUndefined()
  })

  it('recovery alone rejects an adoption whose seed proof does not match the checkpoint that stood at the cutoff', async () => {
    const { session, checkpoints } = await setup()
    await adoptPreparedCompaction(session, checkpoints, prepared(session), options())
    turn(session, 't2', 'second', 'second answer')
    await session.durable()
    const cutoff = session.committedEvents.findLast((event) => event.type === 'turn/end')!.seq
    await adoptPreparedCompaction(session, checkpoints, { ...prepared(session), cutoff, sourceDigest: sourceDigest(session.committedEvents, cutoff), seedHash: compactionSeedHash('SUMMARY OF TURN ONE'), summary: 'SECOND' }, options())
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toMatchObject({ coversSeq: cutoff, summary: 'SECOND' })
    // A proof claiming a different seed than the one that stood is a forgery.
    const forged = forge(session.committedEvents, (end) => {
      const adoption = end['adoption'] as Record<string, unknown> | undefined
      if (adoption !== undefined && end['coversSeq'] === cutoff) adoption['seedHash'] = compactionSeedHash('some other seed')
    })
    expect(recoverCanonicalCheckpoint(forged)?.coversSeq).toBe(CUTOFF_A) // falls back to the first honest checkpoint
    // And a proof that drops the seed entirely, as if nothing stood, is equally refused.
    const dropped = forge(session.committedEvents, (end) => {
      const adoption = end['adoption'] as Record<string, unknown> | undefined
      if (adoption !== undefined && end['coversSeq'] === cutoff) delete adoption['seedHash']
    })
    expect(recoverCanonicalCheckpoint(dropped)?.coversSeq).toBe(CUTOFF_A)
  })

  it('still recovers a legacy checkpoint that has no proof, under the old rules', async () => {
    const { session, checkpoints } = await setup()
    const { compactSession } = await import('../../src/harness/context/compaction.ts')
    await compactSession(session, checkpoints, async () => 'legacy summary')
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toMatchObject({ coversSeq: CUTOFF_A, summary: 'legacy summary' })
  })

  it('a legacy end is still refused when a turn was admitted after its cutoff', async () => {
    const { session } = await setup()
    session.append({ type: 'compaction/start', trigger: 'manual' })
    turn(session, 't2', 'sneaky', 'sneaky answer')
    session.append({ type: 'compaction/end', trigger: 'manual', coversSeq: CUTOFF_A, summaryChars: 1, durationMs: 1, summary: 'x' })
    await session.durable()
    expect(recoverCanonicalCheckpoint(session.committedEvents)).toBeUndefined()
  })
})

describe('durability ordering', () => {
  function deferredStore() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const flush = vi.fn(async () => {})
    return { backing: { append: vi.fn(async () => {}), flush } as unknown as SessionStore, flush, gate, release }
  }

  it('does not publish the cache or report success until the end is durable', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'compact-adoption-dur-'))
    homes.push(home)
    const base = new Session(new Kernel().ctx)
    turn(base, 't1', 'first request')
    await base.durable()
    const deferred = deferredStore()
    const session = new Session(new Kernel().ctx, { store: deferred.backing })
    session.adoptHistory(base.events)
    const checkpoints = new CheckpointStore(home)
    const save = vi.spyOn(checkpoints, 'save')
    // Two barriers: the start, then the end. Hold only the end.
    deferred.flush.mockImplementationOnce(async () => {}).mockImplementationOnce(() => deferred.gate)
    let settled = false
    const run = adoptPreparedCompaction(session, checkpoints, prepared(base), options()).then((value) => { settled = true; return value })
    await vi.waitFor(() => expect(deferred.flush).toHaveBeenCalledTimes(2))
    expect(session.events.at(-1)?.type).toBe('compaction/end')
    expect(settled).toBe(false)
    expect(save).not.toHaveBeenCalled()
    deferred.release()
    await run
    expect(settled).toBe(true)
  })

  it('a stop that arrives after the end is appended cannot undo the success and skips only the cache', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'compact-adoption-stop-'))
    homes.push(home)
    const base = new Session(new Kernel().ctx)
    turn(base, 't1', 'first request')
    await base.durable()
    const deferred = deferredStore()
    const session = new Session(new Kernel().ctx, { store: deferred.backing })
    session.adoptHistory(base.events)
    const checkpoints = new CheckpointStore(home)
    const save = vi.spyOn(checkpoints, 'save')
    deferred.flush.mockImplementationOnce(async () => {}).mockImplementationOnce(() => deferred.gate)
    const controller = new AbortController()
    const run = adoptPreparedCompaction(session, checkpoints, prepared(base), options({ signal: controller.signal }))
    await vi.waitFor(() => expect(deferred.flush).toHaveBeenCalledTimes(2))
    controller.abort(new Error('late stop'))
    deferred.release()
    const checkpoint = await run
    expect(checkpoint.summary).toBe('SUMMARY OF TURN ONE')
    expect(save).not.toHaveBeenCalled()
    expect(endEvents(session).filter((end) => end.error !== undefined)).toHaveLength(0)
  })
})
