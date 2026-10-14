/**
 * Choosing how a compaction gets its summary. The decision is pure: given the
 * durable log, the newest snapshot (if any) and what the builder can rebuild,
 * return the one source to summarize from — or a typed reason it cannot.
 * Never "fold the raw transcript" as a fallback; that is a separate,
 * explicitly confirmed recovery.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { CompactionProjection } from '../../src/harness/context/compaction-projection.ts'
import { compactionSeedHash, sourceDigest } from '../../src/harness/context/compaction-digest.ts'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../../src/harness/context/compaction-snapshot.ts'
import {
  RAW_RECOVERY_CALL_ESTIMATE_CHARS,
  chooseCompactionSource,
  recoveryConfirmationFor,
  type SourceChoice,
} from '../../src/web/compaction-source.ts'

type Row = { type: string; [key: string]: unknown }
const log = (rows: Row[]): SessionEvent[] => rows.map((row, index) => ({ seq: index + 1, timestamp: 1000 + index, ...row })) as unknown as SessionEvent[]

function turnRows(turn: string, text: string, answer: string): Row[] {
  return [
    { type: 'turn/start', turnId: turn },
    { type: 'user/message', turnId: turn, content: text },
    { type: 'assistant/message', stepId: `s-${turn}`, content: answer },
    { type: 'turn/end', turnId: turn, reason: 'completed' },
  ]
}

const identity: SnapshotIdentity = { provider: 'p', model: 'm', modeHash: 'mode', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' }

function snapshotFor(events: readonly SessionEvent[], cutoff: number, over: Partial<EffectiveCompactionSnapshot> = {}): EffectiveCompactionSnapshot {
  const sources: { messageIndex: number; seq: number; turnId: string }[] = []
  let turnId = ''
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.type === 'turn/start') turnId = event.turnId
    if (event.type === 'user/message' || event.type === 'assistant/message') sources.push({ messageIndex: sources.length + 1, seq: event.seq, turnId })
  }
  const projection: CompactionProjection = { v: 1, policyVersion: 1, history: 'compact', sources, losses: [] }
  return {
    id: 'snap', v: 1, policyVersion: 1, sessionId: 's', cutoff, turnId, projection,
    request: { messages: [{ role: 'user', content: 'q' }] },
    finalAnswer: { role: 'assistant', content: 'a' },
    sourceDigest: sourceDigest(events, cutoff),
    identity,
    ...over,
  }
}

const events = log([...turnRows('t1', 'first', 'a1'), ...turnRows('t2', 'second', 'a2')]) // cutoff 8

describe('chooseCompactionSource', () => {
  it('prefers an exact snapshot that covers the newest closed turn', () => {
    const choice = chooseCompactionSource({ events, exact: snapshotFor(events, 8), identity })
    expect(choice).toMatchObject({ kind: 'snapshot', path: 'exact' })
    expect((choice as Extract<SourceChoice, { kind: 'snapshot' }>).snapshot.cutoff).toBe(8)
  })

  it('accepts an exact snapshot for an OLDER closed cutoff (turns after it stay verbatim)', () => {
    const older = snapshotFor(events, 4)
    const choice = chooseCompactionSource({ events, exact: older, identity })
    expect(choice).toMatchObject({ kind: 'snapshot', path: 'exact' })
  })

  it('falls back to the reconstructed snapshot when there is no exact one', () => {
    const choice = chooseCompactionSource({ events, reconstructed: snapshotFor(events, 8), identity })
    expect(choice).toMatchObject({ kind: 'snapshot', path: 'reconstructed' })
  })

  it('rejects an exact snapshot whose identity no longer matches and uses the reconstruction instead', () => {
    const stale = snapshotFor(events, 8, { identity: { ...identity, model: 'other' } })
    const choice = chooseCompactionSource({ events, exact: stale, reconstructed: snapshotFor(events, 8), identity })
    expect(choice).toMatchObject({ kind: 'snapshot', path: 'reconstructed' })
  })

  it('rejects a snapshot whose log changed underneath it', () => {
    const stale = snapshotFor(events, 8, { sourceDigest: 'stale' })
    expect(chooseCompactionSource({ events, exact: stale, identity })).toMatchObject({ kind: 'recovery-required', reason: 'no-eligible-snapshot' })
  })

  it('never prefers a snapshot older than the checkpoint that already stands', () => {
    const withCheckpoint = log([
      ...turnRows('t1', 'first', 'a1'),
      { type: 'compaction/start', trigger: 'manual' },
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summaryChars: 1, durationMs: 1, summary: 'S' },
      ...turnRows('t2', 'second', 'a2'),
    ])
    // Turn t2 closed AFTER the checkpoint (cutoff 4), so there is work to do, but the
    // snapshot at cutoff 4 would only re-summarize what the checkpoint already holds.
    const choice = chooseCompactionSource({ events: withCheckpoint, exact: snapshotFor(withCheckpoint, 4), identity })
    expect(choice).toMatchObject({ kind: 'recovery-required', reason: 'no-eligible-snapshot' })
    // The same log with a snapshot that DOES cover the new turn is chosen.
    const newest = withCheckpoint.findLast((event) => event.type === 'turn/end')!.seq
    expect(chooseCompactionSource({ events: withCheckpoint, exact: snapshotFor(withCheckpoint, newest, { projection: { v: 1, policyVersion: 1, history: 'compact', seed: { coversSeq: 4, hash: compactionSeedHash('S') }, sources: snapshotFor(withCheckpoint, newest).projection.sources.filter((source) => source.seq > 6), losses: [] } }), identity })).toMatchObject({ kind: 'snapshot', path: 'exact' })
  })

  it('reports nothing to do when the newest closed turn is already the checkpoint', () => {
    const done = log([
      ...turnRows('t1', 'first', 'a1'),
      { type: 'compaction/start', trigger: 'manual' },
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summaryChars: 1, durationMs: 1, summary: 'S' },
    ])
    expect(chooseCompactionSource({ events: done, identity })).toMatchObject({ kind: 'noop' })
  })

  it('asks for confirmed recovery, never silently folds the raw transcript', () => {
    const choice = chooseCompactionSource({ events, identity })
    expect(choice).toMatchObject({ kind: 'recovery-required', reason: 'no-eligible-snapshot' })
    expect((choice as Extract<SourceChoice, { kind: 'recovery-required' }>).confirmation).toEqual(recoveryConfirmationFor(events, 8))
  })

  it('refuses while a turn is open', () => {
    const open = log([...turnRows('t1', 'first', 'a1'), { type: 'turn/start', turnId: 't2' }, { type: 'user/message', turnId: 't2', content: 'busy' }])
    expect(chooseCompactionSource({ events: open, identity })).toMatchObject({ kind: 'unavailable', reason: 'open-turn' })
  })

  it('refuses a log with no completed turn at all', () => {
    expect(chooseCompactionSource({ events: log([{ type: 'session/title', title: 'x' }]), identity })).toMatchObject({ kind: 'unavailable', reason: 'no-completed-turn' })
  })
})

describe('recoveryConfirmationFor', () => {
  it('fingerprints the cutoff and the source, and estimates the raw folding cost', () => {
    const confirmation = recoveryConfirmationFor(events, 8)
    expect(confirmation).toMatchObject({ cutoff: 8, sourceDigest: sourceDigest(events, 8) })
    expect(confirmation.estimatedCalls).toBeGreaterThanOrEqual(1)
  })

  it('estimates calls from the chunk size the legacy folder actually uses', () => {
    const big = log([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q'.repeat(RAW_RECOVERY_CALL_ESTIMATE_CHARS * 3) },
      { type: 'assistant/message', stepId: 's', content: 'a' },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
    ])
    expect(recoveryConfirmationFor(big, 4).estimatedCalls).toBeGreaterThanOrEqual(3)
  })

  it('changes when the covered source changes, so a stale confirmation cannot be replayed', () => {
    const edited = log([...turnRows('t1', 'FIRST EDITED', 'a1'), ...turnRows('t2', 'second', 'a2')])
    expect(recoveryConfirmationFor(edited, 8).sourceDigest).not.toBe(recoveryConfirmationFor(events, 8).sourceDigest)
  })
})
