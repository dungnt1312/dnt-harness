import { describe, expect, it } from 'vitest'
import { buildContext, DEFAULT_BUDGET, messageText } from 'dnt-harness'
import type { SessionEvent, ModeDefinition } from 'dnt-harness'
import { DEFAULT_LIMITS, resolveLimits } from '../../src/harness/limits.ts'

const mode: ModeDefinition = {
  id: 'compact-reliability', name: 'Compact reliability', instructions: '',
  sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false },
  toolExposure: [], permissionDefaults: {},
}
const log = (rows: Record<string, unknown>[]): SessionEvent[] => rows.map((row, i) => ({ ...row, seq: i + 1, timestamp: i + 1 }) as SessionEvent)
const events = log([
  { type: 'turn/start', turnId: 'covered' },
  { type: 'user/message', turnId: 'covered', content: 'COVERED REQUEST' },
  { type: 'assistant/message', stepId: 's', content: '', toolCalls: [{ id: 'requested', name: 'Read', args: { path: 'old' } }] },
  { type: 'tool/call', stepId: 's', call: { id: 'effective', name: 'Grep', args: { pattern: 'new' } } },
  { type: 'tool/result', stepId: 's', callId: 'effective', ok: true, output: 'effective result' },
  { type: 'turn/end', turnId: 'covered', reason: 'completed' },
  { type: 'compaction/start', trigger: 'manual' },
  { type: 'compaction/end', trigger: 'manual', coversSeq: 6, summary: 'SUMMARY', summaryChars: 7, durationMs: 1 },
  { type: 'turn/start', turnId: 'open' },
  { type: 'user/message', turnId: 'open', content: 'OPEN TASK' },
])
const base = (overrides: Partial<Parameters<typeof buildContext>[0]> = {}): Parameters<typeof buildContext>[0] => ({
  events, mode: { definition: mode, source: 'workspace' }, modeRevision: 1, model: 'test', providerName: 'test',
  schemas: [], activeSkills: [], pinnedMemory: [], budget: DEFAULT_BUDGET, ...overrides,
})
const text = (result: ReturnType<typeof buildContext>): string => result.messages.map(m => messageText(m.content)).join('\n')

describe('compaction context reliability', () => {
  it('accepts zero-capable limits without enabling automatic compaction by default', () => {
    expect(resolveLimits({ compactionRetainTokens: 0 }).compactionRetainTokens).toBe(0)
    expect(resolveLimits({ automaticCompactionPressure: 0 }).automaticCompactionPressure).toBe(0)
    expect(DEFAULT_LIMITS.automaticCompactionPressure).toBe(0)
    expect(DEFAULT_LIMITS.compactionRetainTokens).toBe(20_000)
  })
  it.each([-1, 1.5, NaN, Infinity])('rejects invalid integer retain budget %s', value => {
    expect(resolveLimits({ compactionRetainTokens: value }).compactionRetainTokens).toBe(20_000)
  })
  it('uses effective tools in uncompacted history', () => {
    const result = buildContext(base())
    expect(result.messages.find(m => m.role === 'assistant')?.toolCalls).toEqual([{ id: 'effective', name: 'Grep', args: { pattern: 'new' } }])
    expect(result.messages.find(m => m.role === 'tool')?.toolCallId).toBe('effective')
  })
  it('a checkpoint retains the covered user request but never covered tool traffic', () => {
    const result = buildContext(base({ compaction: { summary: 'SUMMARY', coversSeq: 6 } }))
    expect(text(result)).toContain('COVERED REQUEST')
    expect(text(result)).not.toContain('effective result')
    expect(result.messages.some(m => m.role === 'tool' || m.toolCalls !== undefined)).toBe(false)
  })
  it('rejects invented summaries even at a valid completed boundary', () => {
    const result = buildContext(base({ compaction: { summary: 'INVENTED', coversSeq: 6 }, compactionRetainTokens: 0 }))
    expect(text(result)).toContain('COVERED REQUEST')
    expect(text(result)).not.toContain('INVENTED')
    expect(result.manifest.history.compactedThroughSeq).toBeUndefined()
  })
  it('a zero retain budget keeps no covered message while preserving the open task', () => {
    const result = buildContext(base({ compaction: { summary: 'SUMMARY', coversSeq: 6 }, compactionRetainTokens: resolveLimits({ compactionRetainTokens: 0 }).compactionRetainTokens }))
    expect(text(result)).not.toContain('COVERED REQUEST')
    expect(text(result)).toContain('OPEN TASK')
  })
  it.each([0, -1, 5, 7, 8, 100, 6.5, NaN, Infinity])('ignores unchecked invalid coverage %s', coversSeq => {
    const result = buildContext(base({ compaction: { summary: 'INVALID SUMMARY', coversSeq }, compactionRetainTokens: 0 }))
    expect(text(result)).toContain('COVERED REQUEST')
    expect(text(result)).not.toContain('INVALID SUMMARY')
    expect(result.manifest.history.compactedThroughSeq).toBeUndefined()
    expect(result.manifest.omissions.some(o => o.includes('invalid checkpoint'))).toBe(true)
  })
  it.each([{ name: 'empty', summary: '' }, { name: 'blank', summary: '   ' }, { name: 'oversized', summary: 'x'.repeat(24_001) }])('ignores $name summary', ({ summary }) => {
    const result = buildContext(base({ compaction: { summary, coversSeq: 6 }, compactionRetainTokens: 0 }))
    expect(text(result)).toContain('COVERED REQUEST')
    expect(result.sections.some(s => s.kind === 'compaction')).toBe(false)
  })
  it('host-attested checkpoints skip canonical re-derivation but still need a completed boundary', () => {
    // Attested: accepted at a valid boundary.
    const ok = buildContext(base({ compaction: { summary: 'SUMMARY', coversSeq: 6, verifiedAgainst: 'committed-log' }, compactionRetainTokens: 0 }))
    expect(ok.manifest.history.compactedThroughSeq).toBe(6)
    expect(text(ok)).not.toContain('COVERED REQUEST')
    // Attested but not on a completed boundary, or beyond the log: ignored with an omission.
    for (const coversSeq of [5, 7, 100]) {
      const bad = buildContext(base({ compaction: { summary: 'SUMMARY', coversSeq, verifiedAgainst: 'committed-log' }, compactionRetainTokens: 0 }))
      expect(bad.manifest.history.compactedThroughSeq).toBeUndefined()
      expect(bad.manifest.omissions.some(o => o.includes('invalid checkpoint'))).toBe(true)
    }
    // Attested but invalid summary: ignored.
    for (const summary of ['', '   ', 'x'.repeat(24_001)]) {
      const bad = buildContext(base({ compaction: { summary, coversSeq: 6, verifiedAgainst: 'committed-log' }, compactionRetainTokens: 0 }))
      expect(bad.manifest.history.compactedThroughSeq).toBeUndefined()
    }
    // The attestation is what skips re-derivation: the builder trusts the
    // host's committed-log check (an unattested caller is still re-checked).
    const attested = buildContext(base({ compaction: { summary: 'HOST VERIFIED', coversSeq: 6, verifiedAgainst: 'committed-log' }, compactionRetainTokens: 0 }))
    expect(text(attested)).toContain('HOST VERIFIED')
    const unattested = buildContext(base({ compaction: { summary: 'HOST VERIFIED', coversSeq: 6 }, compactionRetainTokens: 0 }))
    expect(text(unattested)).not.toContain('HOST VERIFIED')
  })
  it('rejects a turn/end without its matching start', () => {
    const mismatched = events.map(e => e.type === 'turn/end' ? { ...e, turnId: 'other' as typeof e.turnId } : e)
    const result = buildContext(base({ events: mismatched, compaction: { summary: 'INVALID SUMMARY', coversSeq: 6 }, compactionRetainTokens: 0 }))
    expect(text(result)).toContain('COVERED REQUEST')
    expect(result.manifest.history.compactedThroughSeq).toBeUndefined()
  })
  it('fits oversized covered duplication by dropping a whole covered turn explicitly', () => {
    const oversized = events.map(e => e.type === 'user/message' && e.turnId === 'covered' ? { ...e, content: 'x'.repeat(20_000) } : e)
    const result = buildContext(base({ events: oversized, compaction: { summary: 'SUMMARY', coversSeq: 6 }, budget: { contextLimitTokens: 1200, outputReserveTokens: 100, marginTokens: 100 } }))
    expect(text(result)).toContain('OPEN TASK')
    expect(result.messages.some(m => m.role === 'assistant' || m.role === 'tool')).toBe(false)
    expect(result.manifest.omissions.some(o => o.includes('compaction tail dropped') && o.includes('seq 6'))).toBe(true)
    expect(result.manifest.budget.preTrimTokens).toBeGreaterThan(result.manifest.budget.availableTokens)
    expect(result.manifest.budget.usedTokens).toBeLessThanOrEqual(result.manifest.budget.availableTokens)
  })
  it('captures pre-trim pressure before microcompaction clears tool results', () => {
    const rows: Record<string, unknown>[] = [{ type: 'turn/start', turnId: 'open' }, { type: 'user/message', turnId: 'open', content: 'OPEN TASK' }]
    for (let i = 0; i < 8; i++) rows.push(
      { type: 'assistant/message', stepId: `s${i}`, content: '', toolCalls: [{ id: `c${i}`, name: 'Read', args: {} }] },
      { type: 'tool/result', stepId: `s${i}`, callId: `c${i}`, ok: true, output: 'x'.repeat(4000) },
    )
    rows.push({ type: 'assistant/message', stepId: 'final', content: 'continue' })
    const result = buildContext(base({ events: log(rows), budget: { contextLimitTokens: 6500, outputReserveTokens: 100, marginTokens: 100 } }))
    expect(result.manifest.budget.preTrimTokens).toBeGreaterThan(result.manifest.budget.usedTokens)
    expect(result.manifest.budget.preTrimTokens).toBeGreaterThan(result.manifest.budget.availableTokens)
    expect(result.manifest.omissions.some(o => o.includes('tool-results: cleared'))).toBe(true)
  })
})
