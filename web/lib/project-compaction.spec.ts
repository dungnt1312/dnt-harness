/**
 * The compaction lifecycle in the transcript projection: a start opens a
 * running row, the end settles it in place (with the summary), a dangling
 * start the log moves past reads as interrupted, and a failed end keeps the
 * error.
 */
import { describe, expect, it } from 'vitest'
import { isCompactionRunning, projectItems, shareProjectedItems, type ViewItem } from './project.ts'
import type { SseEvent } from './types.ts'

let seq = 0
const event = (row: Omit<SseEvent, 'seq'>): SseEvent => ({ seq: ++seq, ...row })

const base = event({ type: 'turn/end', reason: 'completed' })

const compactionItems = (events: readonly SseEvent[]): readonly Extract<ViewItem, { kind: 'compaction' }>[] =>
  projectItems([base, ...events]).filter((item): item is Extract<ViewItem, { kind: 'compaction' }> => item.kind === 'compaction')

describe('compaction lifecycle projection', () => {
  it('a running start renders live; the end settles it in place with the summary', () => {
    const start = event({ type: 'compaction/start', trigger: 'manual', model: 'GLM-x' })
    const running = compactionItems([start])
    expect(running).toHaveLength(1)
    expect(running[0]?.status).toBe('running')
    expect(running[0]?.trigger).toBe('manual')
    expect(running[0]?.model).toBe('GLM-x')

    const end = event({ type: 'compaction/end', trigger: 'manual', model: 'GLM-x', coversSeq: 12, summaryChars: 525, durationMs: 3400, summary: 'THE SUMMARY', tokensBefore: 90_000, tokensAfter: 30_000 })
    const done = compactionItems([start, end])
    expect(done).toHaveLength(1)
    expect(done[0]?.status).toBe('completed')
    expect(done[0]?.coversSeq).toBe(12)
    expect(done[0]?.summaryChars).toBe(525)
    expect(done[0]?.durationMs).toBe(3400)
    expect(done[0]?.summary).toBe('THE SUMMARY')
    expect(done[0]?.tokensBefore).toBe(90_000)
    expect(done[0]?.tokensAfter).toBe(30_000)
  })

  it('a dangling start with nothing after it stays running; log movement makes it interrupted', () => {
    const dangling = compactionItems([event({ type: 'compaction/start', trigger: 'automatic' })])
    expect(dangling[0]?.status).toBe('running')

    const crashed = compactionItems([
      event({ type: 'compaction/start', trigger: 'automatic' }),
      event({ type: 'turn/start', turnId: 't-next' }),
    ])
    expect(crashed[0]?.status).toBe('interrupted')
  })

  it('a failed end carries the error and no summary', () => {
    const items = compactionItems([
      event({ type: 'compaction/start', trigger: 'manual' }),
      event({ type: 'compaction/end', trigger: 'manual', coversSeq: 8, summaryChars: 0, durationMs: 120, error: 'summarizer exploded' }),
    ])
    expect(items[0]?.status).toBe('failed')
    expect(items[0]?.error).toBe('summarizer exploded')
    expect(items[0]?.summary).toBeUndefined()
  })

  it('a second start closes the first as interrupted, and both ends settle their own generation', () => {
    const items = compactionItems([
      event({ type: 'compaction/start', trigger: 'manual' }),
      event({ type: 'compaction/start', trigger: 'automatic', model: 'm2' }),
      event({ type: 'compaction/end', trigger: 'automatic', model: 'm2', coversSeq: 9, summaryChars: 30, durationMs: 10, summary: 'S2' }),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]?.status).toBe('interrupted')
    expect(items[1]?.status).toBe('completed')
    expect(items[1]?.model).toBe('m2')
  })

  describe('job progress (compaction/job)', () => {
    const job = (stage: string, extra: Record<string, unknown> = {}, timestamp?: number): SseEvent =>
      event({ type: 'compaction/job', stage, trigger: 'manual', ...(timestamp !== undefined ? { timestamp } : {}), ...extra } as Omit<SseEvent, 'seq'>)

    it('is ONE row from preparing to the end: the stage advances in place and the canonical start/end attach to it', () => {
      const events = [
        job('preparing', {}, 1_000),
        job('generating', {}, 1_200),
        job('applying', {}, 9_000),
        event({ type: 'compaction/start', trigger: 'manual', model: 'm' }),
        event({ type: 'compaction/restoration', coversSeq: 4, sections: [] }),
        event({ type: 'compaction/end', trigger: 'manual', model: 'm', coversSeq: 4, summaryChars: 10, durationMs: 8_000, summary: 'S', tokensBefore: 9_000, tokensAfter: 2_000 }),
        job('ended', { outcome: 'compacted', path: 'exact' }),
      ]
      const rows = compactionItems(events)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'completed', coversSeq: 4, summary: 'S', tokensAfter: 2_000, model: 'm', path: 'exact' })
    })

    it('while it runs, the row says which stage it is in and when it began', () => {
      const rows = compactionItems([job('preparing', {}, 1_000), job('generating', {}, 1_200)])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'running', stage: 'generating', startedAt: 1_000, trigger: 'manual' })
    })

    it('the time before any summary exists shows as running too, not as nothing', () => {
      const rows = compactionItems([job('preparing', {}, 5_000)])
      expect(rows[0]).toMatchObject({ status: 'running', stage: 'preparing', startedAt: 5_000 })
    })

    it('events that happen DURING a compaction do not make it look interrupted', () => {
      const rows = compactionItems([
        job('preparing'),
        event({ type: 'hook/run', event: 'PreCompact', matcher: '', exitCode: 0, durationMs: 5, decision: 'allow' } as Omit<SseEvent, 'seq'>),
        job('generating'),
        event({ type: 'model/attempt', fact: { state: 'start' } } as unknown as Omit<SseEvent, 'seq'>),
        event({ type: 'input/queued', inputId: 'i1' } as Omit<SseEvent, 'seq'>),
        event({ type: 'context/snapshot', snapshotId: 's', hash: 'h', cutoff: 3 } as Omit<SseEvent, 'seq'>),
      ])
      expect(rows[0]?.status).toBe('running')
    })

    it('a turn that starts while the row is still running means it never finished', () => {
      const rows = compactionItems([job('preparing'), job('generating'), event({ type: 'turn/start', turnId: 't-next' })])
      expect(rows[0]?.status).toBe('interrupted')
    })

    it.each([
      ['cancelled', { outcome: 'cancelled' }, 'cancelled'],
      ['failed', { outcome: 'failed', error: 'provider transport failure' }, 'failed'],
      ['noop', { outcome: 'noop' }, 'noop'],
      ['needs-recovery', { outcome: 'needs-recovery' }, 'needs-recovery'],
    ])('ending as %s closes the row with that status when no canonical end was written', (_name, extra, status) => {
      const rows = compactionItems([job('preparing'), job('generating'), job('ended', extra)])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe(status)
    })

    it('a job end never overwrites what the canonical end already settled: a completed row stays completed with its facts', () => {
      const rows = compactionItems([
        job('preparing', {}, 1_000),
        event({ type: 'compaction/start', trigger: 'manual', model: 'm' }),
        event({ type: 'compaction/end', trigger: 'manual', model: 'm', coversSeq: 7, summaryChars: 3, durationMs: 50, summary: 'S' }),
        // A (contradictory) job end must not turn a settled success into something else.
        job('ended', { outcome: 'failed', error: 'late' }),
      ])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'completed', coversSeq: 7, summary: 'S' })
      expect(rows[0]?.error).toBeUndefined()
    })

    it('a failed canonical end keeps its own error when the job end reports another', () => {
      const rows = compactionItems([
        job('preparing'),
        event({ type: 'compaction/start', trigger: 'manual' }),
        event({ type: 'compaction/end', trigger: 'manual', coversSeq: 7, summaryChars: 0, durationMs: 5, error: 'model changed' }),
        job('ended', { outcome: 'failed', error: 'a different message' }),
      ])
      expect(rows[0]).toMatchObject({ status: 'failed', error: 'model changed' })
    })

    it('carries fold progress while it runs and the request count after it ends; old events without them still project', () => {
      const running = compactionItems([job('preparing'), job('generating', { progress: { done: 2, total: 4 } })])
      expect(running[0]).toMatchObject({ status: 'running', stage: 'generating', progress: { done: 2, total: 4 } })
      const done = compactionItems([job('preparing'), job('generating', { progress: { done: 4, total: 4 } }), job('ended', { outcome: 'failed', error: 'x', requests: 3, usage: { input: 1, cached: 0, output: 2 } })])
      expect(done[0]).toMatchObject({ status: 'failed', requests: 3 })
      expect(done[0]).not.toHaveProperty('progress')
      const old = compactionItems([job('preparing'), job('generating'), job('ended', { outcome: 'compacted' })])
      expect(old[0]).not.toHaveProperty('requests')
      expect(old[0]).not.toHaveProperty('progress')
    })

    it('a failure carries its reason onto the row', () => {
      const rows = compactionItems([job('preparing'), job('ended', { outcome: 'failed', error: 'provider transport failure' })])
      expect(rows[0]?.error).toBe('provider transport failure')
    })

    it('a second compaction starts a second row, after the first one ended', () => {
      const rows = compactionItems([
        job('preparing'), job('ended', { outcome: 'cancelled' }),
        job('preparing'), job('generating'),
      ])
      expect(rows.map((row) => row.status)).toEqual(['cancelled', 'running'])
    })

    it('a legacy log with no job events still projects exactly as before', () => {
      const rows = compactionItems([
        event({ type: 'compaction/start', trigger: 'manual' }),
        event({ type: 'compaction/end', trigger: 'manual', coversSeq: 3, summaryChars: 4, durationMs: 9, summary: 'old' }),
      ])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'completed', summary: 'old' })
      expect(rows[0]?.stage).toBeUndefined()
    })

    it('a row ended by a job is projection-stable across re-renders', () => {
      const events = [job('preparing'), job('generating'), job('ended', { outcome: 'cancelled' })]
      const first = projectItems([base, ...events])
      const second = projectItems([base, ...events])
      expect(shareProjectedItems(first, second)).toBe(first)
    })
  })

  describe('isCompactionRunning', () => {
    const job = (stage: string): SseEvent => event({ type: 'compaction/job', stage, trigger: 'manual' } as Omit<SseEvent, 'seq'>)

    it('is true from the first stage until the job ends', () => {
      expect(isCompactionRunning([base, job('preparing')])).toBe(true)
      expect(isCompactionRunning([base, job('preparing'), job('generating'), job('applying')])).toBe(true)
      expect(isCompactionRunning([base, job('preparing'), job('generating'), job('ended')])).toBe(false)
    })

    it('is false for a session that never compacted, and for a legacy compaction that has no job events', () => {
      expect(isCompactionRunning([base])).toBe(false)
      expect(isCompactionRunning([base, event({ type: 'compaction/start', trigger: 'manual' })])).toBe(false)
    })

    it('only the newest job counts: an old ended one does not hide a new running one, nor the reverse', () => {
      expect(isCompactionRunning([base, job('preparing'), job('ended'), job('preparing')])).toBe(true)
      expect(isCompactionRunning([base, job('preparing'), job('preparing'), job('ended')])).toBe(false)
    })

    it('a turn that started after the job means it is not running any more (a crash left it dangling)', () => {
      expect(isCompactionRunning([base, job('preparing'), event({ type: 'turn/start', turnId: 't2' })])).toBe(false)
    })
  })

  it('a settled compaction row is projection-stable across re-renders', () => {
    const events = [
      event({ type: 'compaction/start', trigger: 'manual' }),
      event({ type: 'compaction/end', trigger: 'manual', coversSeq: 12, summaryChars: 5, durationMs: 1, summary: 'S' }),
    ]
    const first = projectItems([base, ...events])
    const second = projectItems([base, ...events])
    expect(shareProjectedItems(first, second)).toBe(first)
  })
})
