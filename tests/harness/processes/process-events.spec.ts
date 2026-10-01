import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../../src/harness/session/events.ts'

describe('process session events', () => {
  it('process/start carries identity and process/exit carries the termination contract', () => {
    // Complete literals including the host-stamped fields: these only
    // type-check once the union carries the two process event types.
    const start: SessionEvent = { type: 'process/start', processId: 'proc_1', command: 'npm run dev', cwd: 'C:/repo', seq: 1, timestamp: 100 }
    const exit: SessionEvent = { type: 'process/exit', processId: 'proc_1', exitCode: 0, termination: 'exited', durationMs: 1200, seq: 2, timestamp: 200 }
    expect((start as { command?: string }).command).toBe('npm run dev')
    expect((exit as { termination?: string }).termination).toBe('exited')
  })
})
