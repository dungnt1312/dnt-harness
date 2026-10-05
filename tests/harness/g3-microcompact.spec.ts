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
