import { describe, expect, it } from 'vitest'
import { processRows, subagentRows } from './processes-view.ts'
import type { SseEvent } from './types.ts'

const ev = (type: string, fields: Record<string, unknown>): SseEvent => ({ type, seq: 0, ...fields }) as SseEvent

describe('processRows', () => {
  it('starts running and settles on exit', () => {
    const rows = processRows([
      ev('process/start', { processId: 'p1', command: 'npm run dev', cwd: 'C:/x' }),
      ev('process/exit', { processId: 'p1', exitCode: 0, termination: 'exited', durationMs: 50 }),
    ])
    expect(rows).toEqual([{ id: 'p1', command: 'npm run dev', status: 'exited', exitCode: 0, startedAt: 0, durationMs: 50 }])
  })

  it('keeps running rows without exit', () => {
    const rows = processRows([ev('process/start', { processId: 'p2', command: 'sleep 5', cwd: 'C:/x' })])
    expect(rows[0]?.status).toBe('running')
  })

  it('later start with same id wins (restart replay safety)', () => {
    const rows = processRows([ev('process/start', { processId: 'p1', command: 'a', cwd: 'x' }), ev('process/start', { processId: 'p1', command: 'b', cwd: 'x' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.command).toBe('b')
  })
})

describe('subagentRows', () => {
  it('derives running and finished children, newest dispatch first', () => {
    const rows = subagentRows([
      ev('agent/child-spawn', { childSessionId: 'c1', definition: 'researcher', brief: 'Map the auth modules\nmore detail', timestamp: 1_000 }),
      ev('agent/child-spawn', { childSessionId: 'c2', definition: 'coder', timestamp: 2_000 }),
      ev('agent/child-result', { childSessionId: 'c2', status: 'completed', timestamp: 3_000 }),
    ])
    expect(rows).toEqual([
      { childSessionId: 'c2', definition: 'coder', brief: '', running: false, status: 'completed', dispatchedAt: 2_000, endedAt: 3_000 },
      { childSessionId: 'c1', definition: 'researcher', brief: 'Map the auth modules', running: true, dispatchedAt: 1_000 },
    ])
  })

  it('keeps spawn order for legacy events without timestamps', () => {
    const rows = subagentRows([
      ev('agent/child-spawn', { childSessionId: 'c1', definition: 'researcher' }),
      ev('agent/child-spawn', { childSessionId: 'c2', definition: 'coder' }),
    ])
    expect(rows.map((row) => row.childSessionId)).toEqual(['c1', 'c2'])
  })

  it('reads the legacy objective as the brief and keeps an endedAt-less row running-clean', () => {
    const rows = subagentRows([
      ev('agent/child-spawn', { childSessionId: 'c1', definition: 'reviewer', objective: '## Audit the run\nsecond line' }),
      ev('agent/child-result', { childSessionId: 'c1', status: 'failed' }),
    ])
    expect(rows[0]?.brief).toBe('Audit the run')
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.endedAt).toBeUndefined()
  })
})
