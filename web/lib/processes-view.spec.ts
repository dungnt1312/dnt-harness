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
  it('derives running and finished children', () => {
    const rows = subagentRows([
      ev('agent/child-spawn', { childSessionId: 'c1', definition: 'researcher' }),
      ev('agent/child-spawn', { childSessionId: 'c2', definition: 'coder' }),
      ev('agent/child-result', { childSessionId: 'c2', status: 'completed' }),
    ])
    expect(rows).toEqual([
      { childSessionId: 'c1', definition: 'researcher', running: true },
      { childSessionId: 'c2', definition: 'coder', running: false, status: 'completed' },
    ])
  })
})
