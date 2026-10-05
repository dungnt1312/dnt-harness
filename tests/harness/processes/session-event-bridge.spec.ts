import { describe, expect, it } from 'vitest'
import { createProcessSessionEventBridge } from '../../../src/harness/processes/session-event-bridge.ts'
import type { ProcessRecord } from '../../../src/harness/processes/registry.ts'

const record = { sessionId: 'child', id: 'proc_test', command: 'echo ok', cwd: '/tmp', startedAt: 1, endedAt: 2, status: 'exited', exitCode: 0 } as ProcessRecord

describe('canonical process event bridge', () => {
  it('writes start before exit to child session and flushes durability', async () => {
    const events: unknown[] = []; let flushed = 0
    const bridge = createProcessSessionEventBridge({ has: () => true, load: async () => ({ append: e => events.push(e), durable: async () => { flushed++ } }) })
    bridge.onStart(record); bridge.onExit(record)
    await bridge.flush(record.sessionId)
    expect(events).toMatchObject([{ type: 'process/start' }, { type: 'process/exit' }])
    expect(flushed).toBeGreaterThan(0)
  })
  it('does not recreate a deleted session', async () => {
    let loads = 0
    const bridge = createProcessSessionEventBridge({ has: () => false, load: async () => { loads++; throw new Error('deleted') } })
    bridge.onStart(record); await bridge.flush(record.sessionId)
    expect(loads).toBe(0)
  })
  it('surfaces a persistence error through flush', async () => {
    const bridge = createProcessSessionEventBridge({ has: () => true, load: async () => ({ append: () => {}, durable: async () => { throw new Error('disk') } }) })
    bridge.onStart(record)
    await expect(bridge.flush(record.sessionId)).rejects.toThrow('disk')
  })
})

it('deletion while canonical load is pending prevents a queued append', async () => {
  let exists = true
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const events: unknown[] = []
  const bridge = createProcessSessionEventBridge({ has: () => exists, load: async () => { await gate; return { append: e => events.push(e), durable: async () => {} } } })
  bridge.onStart(record)
  await Promise.resolve()
  exists = false; release()
  await bridge.flush(record.sessionId)
  expect(events).toEqual([])
})
