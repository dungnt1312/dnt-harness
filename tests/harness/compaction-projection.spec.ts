/**
 * Typed compaction projection: eligibility is decided from typed losses and
 * source provenance verified against the durable log — never from the
 * human-readable `manifest.omissions` strings.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import {
  assessProjection,
  compactionSeedHash,
  type CompactionProjection,
  type ProjectionLoss,
} from '../../src/harness/context/compaction-projection.ts'

type Row = { type: string; [key: string]: unknown }

function log(rows: Row[]): SessionEvent[] {
  return rows.map((row, index) => ({ seq: index + 1, timestamp: 1000 + index, ...row })) as unknown as SessionEvent[]
}

interface ParallelOptions {
  /** Name the assistant message recorded for call c1 (what the provider asked for). */
  requestedName?: string
  /** Name the effective tool/call recorded for call c1 (what actually ran). */
  effectiveName?: string
  c1Ok?: boolean
  c1Recovery?: boolean
  c1Outcome?: string
  /** Drop the result for c2 entirely (an unresolved call). */
  omitC2Result?: boolean
  /** Add an answer after the batch so the results count as read. */
  answered?: boolean
}

/** Turn 1 (parallel Read+Grep batch, answer) and turn 2 (plain), no checkpoint. Cutoff 13. */
function plainLog(options: ParallelOptions = {}): SessionEvent[] {
  const rows: Row[] = [
    { type: 'turn/start', turnId: 't1' }, // 1
    { type: 'user/message', turnId: 't1', content: 'q1' }, // 2
    {
      type: 'assistant/message', stepId: 's1', content: '',
      toolCalls: [{ id: 'c1', name: options.requestedName ?? 'Read', args: { path: 'requested' } }, { id: 'c2', name: 'Grep', args: { pattern: 'x' } }],
    }, // 3
    { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: options.effectiveName ?? options.requestedName ?? 'Read', args: { path: 'effective' } } }, // 4
    { type: 'tool/call', stepId: 's1', call: { id: 'c2', name: 'Grep', args: { pattern: 'x' } } }, // 5
    {
      type: 'tool/result', stepId: 's1', callId: 'c1', ok: options.c1Ok ?? true, output: 'one',
      ...(options.c1Recovery === true ? { recovery: true } : {}),
      ...(options.c1Outcome !== undefined ? { outcome: options.c1Outcome } : {}),
    }, // 6
    ...(options.omitC2Result === true ? [{ type: 'session/title', title: 'churn' }] : [{ type: 'tool/result', stepId: 's1', callId: 'c2', ok: true, output: 'two' }]), // 7
    ...(options.answered === false ? [{ type: 'session/title', title: 'churn' }] : [{ type: 'assistant/message', stepId: 's2', content: 'answer1' }]), // 8
    { type: 'turn/end', turnId: 't1', reason: 'completed' }, // 9
    { type: 'turn/start', turnId: 't2' }, // 10
    { type: 'user/message', turnId: 't2', content: 'q2' }, // 11
    { type: 'assistant/message', stepId: 's3', content: 'answer2' }, // 12
    { type: 'turn/end', turnId: 't2', reason: 'completed' }, // 13
  ]
  return log(rows)
}
const PLAIN_CUTOFF = 13

const SEED_SUMMARY = 'SEED SUMMARY of turn one'

/** Turn 1, a canonical checkpoint covering it (seq 9), then turn 2. Cutoff 15. */
function seededLog(): SessionEvent[] {
  return log([
    { type: 'turn/start', turnId: 't1' }, // 1
    { type: 'user/message', turnId: 't1', content: 'q1' }, // 2
    { type: 'assistant/message', stepId: 's1', content: 'a1' }, // 3
    { type: 'turn/end', turnId: 't1', reason: 'completed' }, // 4
    { type: 'compaction/start', trigger: 'automatic' }, // 5
    { type: 'compaction/end', trigger: 'automatic', coversSeq: 4, summaryChars: SEED_SUMMARY.length, durationMs: 1, summary: SEED_SUMMARY }, // 6
    { type: 'turn/start', turnId: 't2' }, // 7
    { type: 'user/message', turnId: 't2', content: 'q2' }, // 8
    {
      type: 'assistant/message', stepId: 's2', content: '',
      toolCalls: [{ id: 'd1', name: 'Read', args: { path: 'a' } }, { id: 'd2', name: 'Read', args: { path: 'b' } }],
    }, // 9
    { type: 'tool/result', stepId: 's2', callId: 'd1', ok: true, output: 'A' }, // 10
    { type: 'tool/result', stepId: 's2', callId: 'd2', ok: true, output: 'B' }, // 11
    { type: 'assistant/message', stepId: 's3', content: 'a2' }, // 12
    { type: 'turn/end', turnId: 't2', reason: 'completed' }, // 13
  ])
}
const SEEDED_CUTOFF = 13
const SEEDED_COVERS = 4

const isContent = (event: SessionEvent): boolean => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'

/** Fixture-generated source mapping: every content event after `after` through `cutoff`, indices after one system message. */
function sourcesFor(events: readonly SessionEvent[], cutoff: number, after = 0, retained: readonly number[] = []): CompactionProjection['sources'] {
  const rows: { seq: number; turnId: string }[] = []
  let turnId = ''
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.type === 'turn/start') turnId = event.turnId
    if (isContent(event) && (event.seq > after || retained.includes(event.seq))) rows.push({ seq: event.seq, turnId })
  }
  return rows.map((row, index) => ({ messageIndex: index + 1, ...row }))
}

function plainProjection(events: readonly SessionEvent[], cutoff = PLAIN_CUTOFF): CompactionProjection {
  return { v: 1, policyVersion: 1, history: 'compact', sources: sourcesFor(events, cutoff), losses: [] }
}

function seededProjection(events: readonly SessionEvent[], retained: readonly number[] = [2]): CompactionProjection {
  return {
    v: 1, policyVersion: 1, history: 'compact',
    seed: { coversSeq: SEEDED_COVERS, hash: compactionSeedHash(SEED_SUMMARY) },
    sources: sourcesFor(events, SEEDED_CUTOFF, SEEDED_COVERS, retained),
    losses: [],
  }
}

const clear = (seq: number, callId: string, policyVersion: unknown = 1): ProjectionLoss =>
  ({ kind: 'tool-result-cleared', seq, callId, policyVersion } as ProjectionLoss)

describe('assessProjection: coverage', () => {
  it('accepts a projection representing every content event through the completed cutoff', () => {
    const events = plainLog()
    expect(assessProjection(events, PLAIN_CUTOFF, plainProjection(events))).toEqual({ ok: true })
  })

  it('refuses an uncovered turn (no seed requires every turn from the start)', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    const withoutFirstTurn = { ...projection, sources: projection.sources.filter((source) => source.turnId !== 't1') }
    expect(assessProjection(events, PLAIN_CUTOFF, withoutFirstTurn)).toEqual({ ok: false, reason: 'uncovered-history' })
  })

  it('refuses when the cutoff final answer is not represented yet', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    const withoutLast = { ...projection, sources: projection.sources.filter((source) => source.seq !== 12) }
    expect(assessProjection(events, PLAIN_CUTOFF, withoutLast)).toEqual({ ok: false, reason: 'uncovered-history' })
  })

  it('ignores metadata-only event churn between content events', () => {
    const noisy = log([
      { type: 'session/title', title: 'x' },
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'context/manifest', turnId: 't1', manifest: {} },
      { type: 'hook/run', event: 'PreToolUse', matcher: '*', exitCode: 0, durationMs: 1, decision: 'allow' },
      { type: 'assistant/chunk', stepId: 's1', delta: 'ans' },
      { type: 'assistant/message', stepId: 's1', content: 'ans' },
      { type: 'session/pinned', pinned: true },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
    ])
    expect(assessProjection(noisy, 9, plainProjection(noisy, 9))).toEqual({ ok: true })
  })

  it('refuses a cutoff that is not a completed turn boundary', () => {
    const events = plainLog()
    expect(assessProjection(events, 12, plainProjection(events, 12))).toEqual({ ok: false, reason: 'cutoff-not-completed' })
    expect(assessProjection(events, 999, plainProjection(events))).toEqual({ ok: false, reason: 'cutoff-not-completed' })
  })

  it('refuses malformed source mappings', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    const wrongTurn = { ...projection, sources: projection.sources.map((source, index) => (index === 0 ? { ...source, turnId: 'forged' } : source)) }
    expect(assessProjection(events, PLAIN_CUTOFF, wrongTurn)).toEqual({ ok: false, reason: 'invalid-sources' })
    const duplicate = { ...projection, sources: [...projection.sources, { messageIndex: 99, seq: 2, turnId: 't1' }] }
    expect(assessProjection(events, PLAIN_CUTOFF, duplicate)).toEqual({ ok: false, reason: 'invalid-sources' })
    const phantom = { ...projection, sources: [...projection.sources, { messageIndex: 99, seq: 4, turnId: 't1' }] }
    expect(assessProjection(events, PLAIN_CUTOFF, phantom)).toEqual({ ok: false, reason: 'invalid-sources' })
    const reordered = { ...projection, sources: [...projection.sources].reverse() }
    expect(assessProjection(events, PLAIN_CUTOFF, reordered)).toEqual({ ok: false, reason: 'invalid-sources' })
  })

  it('refuses a source beyond the cutoff', () => {
    const events = plainLog()
    const projection = plainProjection(events, 9)
    const beyond = { ...projection, sources: [...projection.sources, { messageIndex: 99, seq: 11, turnId: 't2' }] }
    expect(assessProjection(events, 9, beyond)).toEqual({ ok: false, reason: 'invalid-sources' })
  })
})

describe('assessProjection: history mode and versions', () => {
  it('refuses none/recent history as if it were the whole conversation', () => {
    const events = plainLog()
    for (const history of ['none', 'recent'] as const) {
      expect(assessProjection(events, PLAIN_CUTOFF, { ...plainProjection(events), history })).toEqual({ ok: false, reason: 'history-not-compact' })
    }
  })

  it('refuses an invalid history mode or unknown schema/policy version', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, history: 'bogus' } as unknown as CompactionProjection)).toEqual({ ok: false, reason: 'invalid-projection' })
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, v: 2 } as unknown as CompactionProjection)).toEqual({ ok: false, reason: 'invalid-projection' })
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, policyVersion: 2 } as unknown as CompactionProjection)).toEqual({ ok: false, reason: 'invalid-projection' })
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, losses: undefined } as unknown as CompactionProjection)).toEqual({ ok: false, reason: 'invalid-projection' })
  })
})

describe('assessProjection: typed losses', () => {
  it('refuses a dropped uncovered history range', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    expect(assessProjection(events, PLAIN_CUTOFF, {
      ...projection,
      losses: [{ kind: 'uncovered-history-dropped', fromSeq: 1, throughSeq: PLAIN_CUTOFF }],
    })).toEqual({ ok: false, reason: 'uncovered-history-dropped' })
  })

  it('refuses unknown losses, including forged kinds, always', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, losses: [{ kind: 'unknown', reason: 'who knows' }] })).toEqual({ ok: false, reason: 'unknown' })
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, losses: [{ kind: 'mystery' } as unknown as ProjectionLoss] })).toEqual({ ok: false, reason: 'unknown' })
  })

  it('allows regenerable sections from the known section sources only', () => {
    const events = plainLog()
    const projection = plainProjection(events)
    for (const source of ['skill-catalog', 'skill:review', 'memory:m1']) {
      expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, losses: [{ kind: 'regenerable-section', source, hash: 'abc' }] })).toEqual({ ok: true })
    }
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, losses: [{ kind: 'regenerable-section', source: 'parent-context', hash: 'abc' }] })).toEqual({ ok: false, reason: 'unknown' })
    expect(assessProjection(events, PLAIN_CUTOFF, { ...projection, losses: [{ kind: 'regenerable-section', source: 'skill-catalog', hash: '' }] })).toEqual({ ok: false, reason: 'unknown' })
  })

  it('accepts a verified clear of a pure-read result the model already read', () => {
    const events = plainLog()
    const projection = { ...plainProjection(events), losses: [clear(6, 'c1'), clear(7, 'c2')] }
    expect(assessProjection(events, PLAIN_CUTOFF, projection)).toEqual({ ok: true })
  })

  it('refuses forged or unsafe clears', () => {
    const unsafe = { ok: false, reason: 'unsafe-tool-result-clear' }
    const events = plainLog()
    const base = plainProjection(events)
    const run = (loss: ProjectionLoss, over: SessionEvent[] = events): unknown => assessProjection(over, PLAIN_CUTOFF, { ...plainProjection(over), losses: [loss] })
    // forged: no such result / wrong seq / wrong call id / unknown policy version
    expect(run(clear(6, 'nope'))).toEqual(unsafe)
    expect(run(clear(7, 'c1'))).toEqual(unsafe)
    expect(run(clear(5, 'c1'))).toEqual(unsafe)
    expect(run(clear(6, 'c1', 2))).toEqual(unsafe)
    expect(assessProjection(events, PLAIN_CUTOFF, { ...base, losses: [clear(6, 'c1'), clear(6, 'nope')] })).toEqual(unsafe)
    // error / recovery / indeterminate results are never reproducible evidence
    expect(run(clear(6, 'c1'), plainLog({ c1Ok: false }))).toEqual(unsafe)
    expect(run(clear(6, 'c1'), plainLog({ c1Recovery: true }))).toEqual(unsafe)
    expect(run(clear(6, 'c1'), plainLog({ c1Outcome: 'indeterminate' }))).toEqual(unsafe)
    // tools whose output is a deliverable or whose effect cannot be told from the name
    for (const name of ['Write', 'Edit', 'mcp__srv__lookup', 'Agent', 'Skill', 'AskUserQuestion', 'TodoWrite']) {
      expect(run(clear(6, 'c1'), plainLog({ requestedName: name }))).toEqual(unsafe)
    }
  })

  it('accepts a verified clear of a successful Bash or BashOutput result the model already read', () => {
    for (const name of ['Bash', 'BashOutput']) {
      const events = plainLog({ requestedName: name })
      expect(assessProjection(events, PLAIN_CUTOFF, { ...plainProjection(events), losses: [clear(6, 'c1')] })).toEqual({ ok: true })
    }
  })

  it('judges a clear by the EFFECTIVE tool call, not the provider-requested one', () => {
    const unsafe = { ok: false, reason: 'unsafe-tool-result-clear' }
    // Requested Read, but the authorized call that actually ran is Write.
    const rewritten = plainLog({ requestedName: 'Read', effectiveName: 'Write' })
    expect(assessProjection(rewritten, PLAIN_CUTOFF, { ...plainProjection(rewritten), losses: [clear(6, 'c1')] })).toEqual(unsafe)
    // Requested Write, effective Read: the effective identity governs.
    const downgraded = plainLog({ requestedName: 'Write', effectiveName: 'Read' })
    expect(assessProjection(downgraded, PLAIN_CUTOFF, { ...plainProjection(downgraded), losses: [clear(6, 'c1')] })).toEqual({ ok: true })
  })

  it('refuses clearing a result the model never read (no later assistant message)', () => {
    const events = plainLog({ answered: false })
    // Without the turn-1 answer, cutoff 9 has no assistant message after the batch.
    expect(assessProjection(events, 9, { ...plainProjection(events, 9), losses: [clear(6, 'c1')] })).toEqual({ ok: false, reason: 'unsafe-tool-result-clear' })
  })
})

describe('assessProjection: seed + delta', () => {
  it('accepts seed plus a fully represented delta, with bounded retained covered messages', () => {
    const events = seededLog()
    expect(assessProjection(events, SEEDED_CUTOFF, seededProjection(events))).toEqual({ ok: true })
    expect(assessProjection(events, SEEDED_CUTOFF, seededProjection(events, []))).toEqual({ ok: true })
  })

  it('refuses a delta turn that is not represented', () => {
    const events = seededLog()
    const projection = seededProjection(events)
    const missingUser = { ...projection, sources: projection.sources.filter((source) => source.seq !== 8) }
    expect(assessProjection(events, SEEDED_CUTOFF, missingUser)).toEqual({ ok: false, reason: 'uncovered-history' })
    const noDelta = { ...projection, sources: projection.sources.filter((source) => source.seq <= SEEDED_COVERS) }
    expect(assessProjection(events, SEEDED_CUTOFF, noDelta)).toEqual({ ok: false, reason: 'uncovered-history' })
  })

  it('refuses a missing prior seed when the log holds a canonical checkpoint', () => {
    const events = seededLog()
    // Everything after the checkpoint is represented, but the seed itself is absent.
    const { seed: _seed, ...withoutSeed } = seededProjection(events)
    expect(assessProjection(events, SEEDED_CUTOFF, withoutSeed)).toEqual({ ok: false, reason: 'missing-prior-seed' })
  })

  it('refuses a seed that is not the canonical checkpoint', () => {
    const events = seededLog()
    const projection = seededProjection(events)
    const mismatch = { reason: 'seed-mismatch', ok: false }
    expect(assessProjection(events, SEEDED_CUTOFF, { ...projection, seed: { coversSeq: SEEDED_COVERS, hash: compactionSeedHash('forged summary') } })).toEqual(mismatch)
    expect(assessProjection(events, SEEDED_CUTOFF, { ...projection, seed: { coversSeq: 1, hash: compactionSeedHash(SEED_SUMMARY) } })).toEqual(mismatch)
    expect(assessProjection(events, SEEDED_CUTOFF, { ...projection, seed: { coversSeq: 99, hash: compactionSeedHash(SEED_SUMMARY) } })).toEqual(mismatch)
    // A seed claimed on a log that has no checkpoint at all.
    const plain = plainLog()
    expect(assessProjection(plain, PLAIN_CUTOFF, { ...plainProjection(plain), seed: { coversSeq: 9, hash: compactionSeedHash(SEED_SUMMARY) } })).toEqual(mismatch)
  })

  it('a dangling or failed compaction does not count as a prior seed', () => {
    const events = log([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'assistant/message', stepId: 's1', content: 'a' },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'compaction/start', trigger: 'automatic' },
      { type: 'compaction/end', trigger: 'automatic', coversSeq: 4, summaryChars: 0, durationMs: 1, error: 'boom' },
    ])
    expect(assessProjection(events, 4, plainProjection(events, 4))).toEqual({ ok: true })
  })
})

describe('assessProjection: tool-call / result pairing', () => {
  it('accepts paired parallel results all represented', () => {
    const events = seededLog()
    const projection = seededProjection(events)
    expect(projection.sources.filter((source) => source.seq === 10 || source.seq === 11)).toHaveLength(2)
    expect(assessProjection(events, SEEDED_CUTOFF, projection)).toEqual({ ok: true })
  })

  it('refuses a parallel batch with one result unrepresented (split pair)', () => {
    const events = seededLog()
    const projection = seededProjection(events)
    const split = { ...projection, sources: projection.sources.filter((source) => source.seq !== 11) }
    expect(assessProjection(events, SEEDED_CUTOFF, split)).toEqual({ ok: false, reason: 'uncovered-history' })
  })

  it('refuses a call with no durable result (unresolved)', () => {
    const events = plainLog({ omitC2Result: true })
    expect(assessProjection(events, PLAIN_CUTOFF, plainProjection(events))).toEqual({ ok: false, reason: 'unresolved-tool-call' })
  })

  it('refuses an orphan result with no matching call', () => {
    const events = log([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'tool/result', stepId: 's1', callId: 'ghost', ok: true, output: 'x' },
      { type: 'assistant/message', stepId: 's2', content: 'a' },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
    ])
    expect(assessProjection(events, 5, plainProjection(events, 5))).toEqual({ ok: false, reason: 'unresolved-tool-call' })
  })

  it('refuses an indeterminate (recovery or MCP indeterminate) result in the covered delta', () => {
    for (const options of [{ c1Recovery: true }, { c1Outcome: 'indeterminate' }, { c1Outcome: 'audit_fault' }] as const) {
      const events = plainLog(options)
      expect(assessProjection(events, PLAIN_CUTOFF, plainProjection(events))).toEqual({ ok: false, reason: 'indeterminate-tool-result' })
    }
  })
})
