import { describe, expect, it, vi } from 'vitest'
import * as accounting from '../../src/harness/context/context-state.ts'
import type { ContextManifest } from '../../src/harness/context/builder.ts'
import { manifest, row, attempt } from '../fixtures/context-accounting.ts'

const assembled = (seq: number, id?: string) => row(seq, { type: 'context/manifest', turnId: 't', manifest: manifest(id) })
const compact = (seq: number, extra: Record<string, unknown> = {}) => row(seq, {
  type: 'compaction/end', trigger: 'manual', coversSeq: 1, summary: 'SUMMARY', summaryChars: 7, durationMs: 1,
  contextEffect: 'replaced', contextAfter: manifest(), ...extra,
})
const usage = { inputTokens: 120_000, cachedInputTokens: 110_000 }

describe('request-scoped context state', () => {
  it('exports the shared reducer', () => { expect(accounting.createContextReducer).toBeTypeOf('function') })
  it('attaches only matching usage and deduplicates uncertain/reconciled totals', () => {
    const r = accounting.createContextReducer<ContextManifest>('s')
    r.apply([assembled(1, 'a'), attempt(2, 'a', 'p1', usage)])
    expect(r.current()?.usage).toMatchObject({ last: usage, cacheableInputTokens: 120_000, cachedInputTokens: 110_000 })
    r.apply([assembled(3, 'b'), attempt(4, 'a', 'p1', usage, 'reconciled')])
    const current = r.current()!
    expect(accounting.isAvailableContext(current) && current.usage?.last).toBeUndefined()
    expect(r.request('a')?.usage?.last).toEqual(usage)
    expect(current.usage?.cacheableInputTokens).toBe(120_000)
    r.apply([attempt(5, 'b', 'p2', { inputTokens: 40_000, cachedInputTokens: 0 }, 'uncertain'),
      attempt(6, 'b', 'p2', { inputTokens: 40_000, cachedInputTokens: 0 }, 'reconciled')])
    expect(r.current()?.usage).toMatchObject({ cacheableInputTokens: 160_000, cachedInputTokens: 110_000 })
  })
  it('never resurrects request usage after compaction, including late first report', () => {
    const r = accounting.createContextReducer<ContextManifest>('s')
    r.apply([assembled(1, 'a'), compact(2), attempt(3, 'a', 'p1', usage)])
    const current = r.current()!
    expect(current.display).toMatchObject({ kind: 'post-compaction', compactionSeq: 2 })
    expect(accounting.isAvailableContext(current) && current.usage?.last).toBeUndefined()
    expect(r.request('a')?.usage?.last).toEqual(usage)
  })
  it('keeps failure/noop and noncompact mode unchanged, but legacy compact becomes unavailable', () => {
    const r = accounting.createContextReducer<ContextManifest>('s')
    r.apply([assembled(1, 'a')]); const before = r.current()
    r.apply([compact(2, { error: 'failed' })]); expect(r.current()).toBe(before)
    r.apply([compact(3, { contextEffect: 'unchanged', contextAfter: undefined })]); expect(r.current()).toBe(before)
    r.apply([compact(4, { contextEffect: undefined, contextAfter: undefined })])
    expect(r.current()).toMatchObject({ display: { kind: 'unavailable', reason: 'legacy-compaction' } })
    expect(r.current()).not.toHaveProperty('budget')
  })
  it('ignores unmatched, foreign and maintenance reports and preserves original manifests', () => {
    const original = manifest('a')
    const r = accounting.createContextReducer<ContextManifest>('s')
    r.apply([row(1, { type: 'context/manifest', turnId: 't', manifest: original })])
    const foreign = attempt(2, 'a', 'foreign', usage)
    if ('fact' in foreign) (foreign.fact as { attribution: { sessionId: string } }).attribution.sessionId = 'child'
    r.apply([foreign, attempt(3, 'missing', 'maintenance', usage)])
    expect(r.current()?.usage?.cacheableInputTokens).toBe(0)
    expect(original).not.toHaveProperty('usage')
    expect(r.request('a')?.usage?.last).toBeUndefined()
  })
  it('handles unreported cache separately, retains identity on chunks and matches replay', () => {
    const events = [assembled(1, 'a'), attempt(2, 'a', 'p1', { inputTokens: 500 })]
    const r = accounting.createContextReducer<ContextManifest>('s')
    r.apply(events); const before = r.current()
    expect(before?.usage).toMatchObject({ last: { inputTokens: 500 }, cacheableInputTokens: 0, cachedInputTokens: 0 })
    expect(r.apply([row(3, { type: 'assistant/chunk', delta: 'x' })])).toEqual([])
    expect(r.current()).toBe(before)
    expect(accounting.deriveContextState(events, 's')).toEqual(before)
  })
  it('keeps the first report for a repeated attemptId with different usage and warns statically', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = accounting.createContextReducer<ContextManifest>('s')
      r.apply([assembled(1, 'a'), attempt(2, 'a', 'p1', usage), attempt(3, 'a', 'p1', { inputTokens: 1, cachedInputTokens: 0 }, 'reconciled')])
      expect(r.current()?.usage).toMatchObject({ last: usage, cacheableInputTokens: 120_000, cachedInputTokens: 110_000 })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('conflicting usage for repeated attempt')
    } finally { warn.mockRestore() }
  })
  it('does not warn when a repeated attemptId carries the same usage in a different key order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = accounting.createContextReducer<ContextManifest>('s')
      r.apply([assembled(1, 'a'), attempt(2, 'a', 'p1', { inputTokens: 10, cachedInputTokens: 4 }),
        attempt(3, 'a', 'p1', { cachedInputTokens: 4, inputTokens: 10 }, 'reconciled')])
      expect(warn).not.toHaveBeenCalled()
      r.apply([attempt(4, 'a', 'p1', { inputTokens: 10, cachedInputTokens: 5 }, 'reconciled')])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally { warn.mockRestore() }
  })
  it('pins optional session identity and keeps legacy manifests estimated', () => {
    const r = accounting.createContextReducer<ContextManifest>()
    r.apply([assembled(1, 'a'), attempt(2, 'a', 'p1', usage)])
    expect(r.request('a')?.usage?.last).toEqual(usage)
    r.apply([assembled(3)])
    const current = r.current()!
    expect(accounting.isAvailableContext(current) && current.contextId).toBeUndefined()
    expect(accounting.isAvailableContext(current) && current.usage?.last).toBeUndefined()
  })
})
