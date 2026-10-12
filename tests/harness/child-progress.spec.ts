import { describe, expect, it } from 'vitest'
import { describeProgress } from '../../src/harness/agents/child-progress.ts'

const limits = { streamFirstEventMs: 600_000, streamIdleMs: 300_000, bashMaxWaitMs: 600_000 }
const MIN = 60_000
let seq = 0
const ev = (timestamp: number, body: Record<string, unknown>) => ({ v: 1, seq: ++seq, timestamp, ...body }) as never

describe('describeProgress', () => {
  it('a child with no work yet is active from its start', () => {
    const p = describeProgress([], 0, 30_000, limits)
    expect(p).toMatchObject({ elapsedMs: 30_000, steps: 0, toolCalls: 0, lastActivity: { kind: 'start', sinceMs: 30_000 }, health: 'active' })
  })

  it('counts steps and tool calls and names an open tool', () => {
    const events = [
      ev(1_000, { type: 'step/start', turnId: 't', stepId: 's1' }),
      ev(2_000, { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Grep', args: {} } }),
      ev(3_000, { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: '' }),
      ev(4_000, { type: 'step/start', turnId: 't', stepId: 's2' }),
      ev(5_000, { type: 'tool/call', stepId: 's2', call: { id: 'c2', name: 'Bash', args: {} } }),
    ]
    const p = describeProgress(events, 0, 5_000 + 4 * MIN, limits)
    expect(p.steps).toBe(2)
    expect(p.toolCalls).toBe(2)
    // A long tool is bounded by its own limits, not the stream idle limit.
    expect(p.lastActivity).toEqual({ kind: 'tool', name: 'Bash', sinceMs: 4 * MIN })
    expect(p.health).toBe('active')
  })

  it('a model request waiting for its first token is judged against the first-event limit', () => {
    const events = [ev(0, { type: 'model/attempt', fact: { state: 'start' } })]
    expect(describeProgress(events, 0, 4 * MIN, limits).health).toBe('active')
    expect(describeProgress(events, 0, 6 * MIN, limits)).toMatchObject({ lastActivity: { kind: 'model', sinceMs: 6 * MIN }, health: 'slow' })
    expect(describeProgress(events, 0, 11 * MIN, limits).health).toBe('stalled')
  })

  it('a streaming model request is judged from its last chunk against the idle limit', () => {
    const events = [
      ev(0, { type: 'model/attempt', fact: { state: 'start' } }),
      ev(10 * MIN, { type: 'assistant/chunk', stepId: 's', delta: 'x' }),
    ]
    expect(describeProgress(events, 0, 11 * MIN, limits)).toMatchObject({ lastActivity: { kind: 'model', sinceMs: MIN }, health: 'active' })
    expect(describeProgress(events, 0, 13 * MIN, limits).health).toBe('slow')
    expect(describeProgress(events, 0, 16 * MIN, limits).health).toBe('stalled')
  })

  it('a closed model attempt no longer counts as model activity', () => {
    const events = [
      ev(0, { type: 'model/attempt', fact: { state: 'start' } }),
      ev(MIN, { type: 'model/attempt', fact: { state: 'end' } }),
    ]
    expect(describeProgress(events, 0, 2 * MIN, limits).lastActivity).toEqual({ kind: 'start', sinceMs: MIN })
  })

  it('an undecided approval wins over everything else', () => {
    const events = [
      ev(0, { type: 'tool/call', stepId: 's', call: { id: 'c', name: 'Bash', args: {} } }),
      ev(MIN, { type: 'approval/request', approvalId: 'a1', call: { id: 'c', name: 'Bash', args: {} } }),
    ]
    expect(describeProgress(events, 0, 20 * MIN, limits)).toMatchObject({ lastActivity: { kind: 'approval', name: 'Bash' }, health: 'awaiting-approval' })
    const decided = [...events, ev(2 * MIN, { type: 'approval/decision', approvalId: 'a1', decision: 'allow' })]
    expect(describeProgress(decided, 0, 3 * MIN, limits).health).toBe('active')
  })
})
