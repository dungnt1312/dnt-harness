/**
 * Microcompact: a long single-turn run (a subagent) can never shed whole
 * completed turns, so old tool results are cleared from the REQUEST — never
 * from the log — under context pressure, newest kept, unanswered batch safe.
 */
import { describe, expect, it } from 'vitest'
import {
  buildContext,
  BUNDLED_MODES,
  CLEARED_TOOL_RESULT,
  ContextBudgetError,
  DEFAULT_BUDGET,
  DEFAULT_MODE_ID,
  MICROCOMPACT_KEEP_RECENT,
  type SessionEvent,
} from 'dnt-harness'

type EventRow = { type: string; [key: string]: unknown }

function eventsOf(rows: EventRow[]): SessionEvent[] {
  return rows.map((row, index) => ({ seq: index + 1, timestamp: index, ...row })) as unknown as SessionEvent[]
}

const MODE = (() => {
  const found = BUNDLED_MODES.find((mode) => mode.id === DEFAULT_MODE_ID)
  if (found === undefined) throw new Error('no default mode')
  return { definition: found, source: 'bundled' as const }
})()

/** One open turn: the brief, then `count` Read steps of `size` chars each. */
function longRun(count: number, size: number, tool = 'Read', tail: 'answered' | 'unanswered' = 'answered'): SessionEvent[] {
  const rows: EventRow[] = [
    { type: 'turn/start', turnId: 't' },
    { type: 'user/message', turnId: 't', content: 'brief' },
  ]
  for (let i = 0; i < count; i++) {
    rows.push({ type: 'assistant/message', stepId: `s${i}`, content: '', toolCalls: [{ id: `c${i}`, name: tool, args: { path: `f${i}` } }] })
    rows.push({ type: 'tool/result', stepId: `s${i}`, callId: `c${i}`, ok: true, output: `${i}:`.padEnd(size, 'x') })
  }
  if (tail === 'answered') rows.push({ type: 'assistant/message', stepId: 'last', content: 'thinking' })
  return eventsOf(rows)
}

function build(events: SessionEvent[], contextLimitTokens: number) {
  return buildContext({
    events,
    mode: MODE,
    modeRevision: 1,
    model: undefined,
    providerName: undefined,
    schemas: [],
    activeSkills: [],
    pinnedMemory: [],
    budget: { ...DEFAULT_BUDGET, contextLimitTokens, outputReserveTokens: 512, marginTokens: 256 },
  })
}

const toolBodies = (assembled: ReturnType<typeof build>): string[] =>
  assembled.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))

describe('microcompact', () => {
  it('a long open turn that overflows the budget completes by clearing old tool results, newest kept', () => {
    // 30 results x ~4k tokens = ~120k tokens against a ~30k budget: before
    // microcompact this was a ContextBudgetError with nothing left to drop.
    const assembled = build(longRun(30, 16_000), 30_000)
    const bodies = toolBodies(assembled)
    expect(bodies).toHaveLength(30)
    expect(assembled.manifest.budget.usedTokens).toBeLessThanOrEqual(assembled.manifest.budget.availableTokens)
    expect(bodies.slice(-1)[0]).toMatch(/^29:/)
    expect(bodies.filter((body) => body === CLEARED_TOOL_RESULT).length).toBeGreaterThan(20)
    expect(assembled.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(true)
  })

  it('keeps the newest results verbatim when pressure alone triggers it', () => {
    // ~7 results x 4k tokens ~= 28k of a 30k budget: over the 85% pressure
    // line but not over budget, so only the oldest beyond the keep window go.
    const assembled = build(longRun(7, 16_000), 30_000)
    const bodies = toolBodies(assembled)
    expect(bodies.filter((body) => body === CLEARED_TOOL_RESULT)).toHaveLength(7 - MICROCOMPACT_KEEP_RECENT)
    expect(bodies.slice(-MICROCOMPACT_KEEP_RECENT).every((body) => body !== CLEARED_TOOL_RESULT)).toBe(true)
  })

  it('does nothing while the request is comfortably under budget', () => {
    const assembled = build(longRun(12, 400), 200_000)
    expect(toolBodies(assembled).every((body) => body !== CLEARED_TOOL_RESULT)).toBe(true)
    expect(assembled.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(false)
  })

  it('never clears the unanswered batch the model has not read yet', () => {
    const assembled = build(longRun(12, 16_000, 'Read', 'unanswered'), 40_000)
    // The last tool message follows the last assistant message: still unread.
    expect(toolBodies(assembled).slice(-1)[0]).toMatch(/^11:/)
  })

  it('never clears results of tools that are not reproducible by re-running (Agent)', () => {
    const assembled = build(longRun(12, 16_000, 'Agent'), 200_000)
    expect(toolBodies(assembled).every((body) => body !== CLEARED_TOOL_RESULT)).toBe(true)
  })

  it('a request that cannot fit even with the newest result alone still fails loudly', () => {
    expect(() => build(longRun(2, 400_000), 30_000)).toThrow(ContextBudgetError)
  })

  it('does not rewrite the durable log — only the request', () => {
    const events = longRun(30, 16_000)
    const before = JSON.stringify(events)
    build(events, 30_000)
    expect(JSON.stringify(events)).toBe(before)
  })
})

describe('typed compaction projection from the builder', () => {
  const clearedLosses = (assembled: ReturnType<typeof build>) => assembled.compactionProjection.losses.filter((loss) => loss.kind === 'tool-result-cleared')

  it('maps every history source to its actual message index, after section drops and trims', () => {
    const assembled = build(longRun(12, 400), 200_000)
    const { sources } = assembled.compactionProjection
    expect(sources.length).toBeGreaterThan(0)
    // Index 0 is the system message; history follows lower-trust blocks, so the
    // mapping must point at the real positions, not at history-relative ones.
    expect(sources[0]!.messageIndex).toBeGreaterThan(0)
    for (const source of sources) {
      const message = assembled.messages[source.messageIndex]!
      const event = eventsOfLongRun().find((candidate) => candidate.seq === source.seq)!
      expect(message.role).toBe(event.type === 'user/message' ? 'user' : event.type === 'tool/result' ? 'tool' : 'assistant')
      expect(source.turnId).toBe('t')
    }
    expect(sources.map((source) => source.messageIndex)).toEqual(sources.map((_, index) => sources[0]!.messageIndex + index))
    expect(assembled.compactionProjection.history).toBe('compact')
    expect(assembled.compactionProjection.losses).toEqual([])
  })

  it('records one typed clear per cleared Read result, with call id, seq and policy version', () => {
    const events = longRun(7, 16_000)
    const assembled = build(events, 30_000)
    const cleared = clearedLosses(assembled)
    expect(cleared).toHaveLength(7 - MICROCOMPACT_KEEP_RECENT)
    const clearedIds = assembled.messages.flatMap((message) => (message.role === 'tool' && message.content === CLEARED_TOOL_RESULT ? [message.toolCallId] : []))
    expect(cleared.map((loss) => (loss as { callId: string }).callId)).toEqual(clearedIds)
    for (const loss of cleared) {
      const { seq, callId } = loss as { seq: number; callId: string }
      expect(events.find((event) => event.seq === seq)).toMatchObject({ type: 'tool/result', callId })
      expect(loss).toMatchObject({ policyVersion: 1 })
    }
    // The old display string stays for UI compatibility.
    expect(assembled.manifest.omissions.some((line) => line.startsWith('tool-results:'))).toBe(true)
  })

  it('types a successful, already-read Bash or BashOutput clear as safe (its output is a report, not a deliverable)', () => {
    for (const tool of ['Bash', 'BashOutput']) {
      const assembled = build(longRun(7, 16_000, tool), 30_000)
      expect(clearedLosses(assembled)).toHaveLength(7 - MICROCOMPACT_KEEP_RECENT)
      expect(assembled.compactionProjection.losses.filter((loss) => loss.kind === 'unknown')).toEqual([])
    }
  })

  it('never types a Write, Edit, MCP or errored clear as a safe clear: unknown loss instead', () => {
    for (const tool of ['Write', 'Edit', 'mcp__srv__lookup']) {
      const assembled = build(longRun(7, 16_000, tool), 30_000)
      expect(clearedLosses(assembled)).toEqual([])
      expect(assembled.compactionProjection.losses.filter((loss) => loss.kind === 'unknown')).toHaveLength(7 - MICROCOMPACT_KEEP_RECENT)
    }
    // A failed Bash is still evidence of a problem, never a safe clear.
    const failedBash = longRun(7, 16_000, 'Bash').map((event) => (event.type === 'tool/result' && event.callId === 'c0' ? { ...event, ok: false } : event)) as SessionEvent[]
    expect(clearedLosses(build(failedBash, 30_000))).toHaveLength(7 - MICROCOMPACT_KEEP_RECENT - 1)
    // Event metadata, not message text: a failed Read stays unknown even though its text looks fine.
    const failing = longRun(7, 16_000).map((event) => (event.type === 'tool/result' && event.callId === 'c0' ? { ...event, ok: false } : event)) as SessionEvent[]
    const assembled = build(failing, 30_000)
    expect(clearedLosses(assembled)).toHaveLength(7 - MICROCOMPACT_KEEP_RECENT - 1)
    expect(assembled.compactionProjection.losses.filter((loss) => loss.kind === 'unknown')).toHaveLength(1)
  })

  it('never clears the unread batch, so it never appears among the losses', () => {
    const assembled = build(longRun(12, 16_000, 'Read', 'unanswered'), 40_000)
    const lastSeq = assembled.compactionProjection.sources.at(-1)!.seq
    expect(clearedLosses(assembled).every((loss) => (loss as { seq: number }).seq < lastSeq)).toBe(true)
    expect(assembled.compactionProjection.losses.filter((loss) => loss.kind === 'unknown')).toEqual([])
  })

  it('types a dropped completed uncovered turn and the regenerable sections dropped for budget', () => {
    const rows: EventRow[] = []
    for (let turn = 1; turn <= 3; turn++) {
      rows.push({ type: 'turn/start', turnId: `t${turn}` }, { type: 'user/message', turnId: `t${turn}`, content: `q${turn} `.padEnd(8_000, 'x') })
      rows.push({ type: 'assistant/message', stepId: `s${turn}`, content: 'a' }, { type: 'turn/end', turnId: `t${turn}`, reason: 'completed' })
    }
    rows.push({ type: 'turn/start', turnId: 't4' }, { type: 'user/message', turnId: 't4', content: 'now' })
    const assembled = buildContext({
      events: eventsOf(rows),
      mode: MODE,
      modeRevision: 1,
      model: undefined,
      providerName: undefined,
      schemas: [],
      activeSkills: [{ name: 'review', instructions: 'S'.repeat(2_000), hash: 'h1' }],
      skillCatalog: [{ name: 'review', description: 'review code' }],
      pinnedMemory: [{ id: 'm1', title: 'm', body: 'M'.repeat(2_000), hash: 'h2' }],
      budget: { ...DEFAULT_BUDGET, contextLimitTokens: 3_000, outputReserveTokens: 256, marginTokens: 128 },
    })
    const { losses, sources } = assembled.compactionProjection
    expect(losses.filter((loss) => loss.kind === 'regenerable-section').map((loss) => (loss as { source: string }).source).sort()).toEqual(['memory:m1', 'skill-catalog', 'skill:review'])
    const dropped = losses.filter((loss) => loss.kind === 'uncovered-history-dropped') as { fromSeq: number; throughSeq: number }[]
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped[0]!.fromSeq).toBe(1)
    // What the request lost is exactly what the sources no longer carry.
    expect(sources.every((source) => source.seq > dropped.at(-1)!.throughSeq)).toBe(true)
    expect(assembled.manifest.omissions.some((line) => line.startsWith('history: dropped oldest'))).toBe(true)
  })

  it('carries the seed identity (structural hash) beside covered retained messages', () => {
    const rows: EventRow[] = [
      { type: 'turn/start', turnId: 't1' }, { type: 'user/message', turnId: 't1', content: 'q1' },
      { type: 'assistant/message', stepId: 's1', content: 'a1' }, { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'turn/start', turnId: 't2' }, { type: 'user/message', turnId: 't2', content: 'q2' },
    ]
    const assembled = buildContext({
      events: eventsOf(rows), mode: MODE, modeRevision: 1, model: undefined, providerName: undefined, schemas: [], activeSkills: [], pinnedMemory: [],
      budget: DEFAULT_BUDGET, compaction: { summary: 'SEED', coversSeq: 4 },
    })
    // Not canonical in the log, so the builder ignores it: no seed claimed.
    expect(assembled.compactionProjection.seed).toBeUndefined()
    const canonicalRows = [
      ...rows.slice(0, 4),
      { type: 'compaction/start', trigger: 'manual' }, { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summaryChars: 4, durationMs: 1, summary: 'SEED' },
      ...rows.slice(4),
    ]
    const seeded = buildContext({
      events: eventsOf(canonicalRows), mode: MODE, modeRevision: 1, model: undefined, providerName: undefined, schemas: [], activeSkills: [], pinnedMemory: [],
      budget: DEFAULT_BUDGET, compaction: { summary: 'SEED', coversSeq: 4 },
    })
    expect(seeded.compactionProjection.seed).toEqual({ coversSeq: 4, hash: seeded.manifest.history.checkpointHash })
    // Retained covered messages (typed user words + the covered turn's final answer) map to their real seq/turn.
    expect(seeded.compactionProjection.sources.map((source) => [source.seq, source.turnId])).toEqual([[2, 't1'], [3, 't1'], [8, 't2']])
    expect(seeded.compactionProjection.sources.map((source) => seeded.messages[source.messageIndex]!.role)).toEqual(['user', 'assistant', 'user'])
  })
})

function eventsOfLongRun(): SessionEvent[] {
  return longRun(12, 400)
}
