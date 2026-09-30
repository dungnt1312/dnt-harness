/**
 * The compaction lifecycle in the transcript projection: a start opens a
 * running row, the end settles it in place (with the summary), a dangling
 * start the log moves past reads as interrupted, and a failed end keeps the
 * error.
 */
import { describe, expect, it } from 'vitest'
import { projectItems, shareProjectedItems, type ViewItem } from './project.ts'
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

    const end = event({ type: 'compaction/end', trigger: 'manual', model: 'GLM-x', coversSeq: 12, summaryChars: 525, durationMs: 3400, summary: 'THE SUMMARY' })
    const done = compactionItems([start, end])
    expect(done).toHaveLength(1)
    expect(done[0]?.status).toBe('completed')
    expect(done[0]?.coversSeq).toBe(12)
    expect(done[0]?.summaryChars).toBe(525)
    expect(done[0]?.durationMs).toBe(3400)
    expect(done[0]?.summary).toBe('THE SUMMARY')
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
