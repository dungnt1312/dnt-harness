import { describe, expect, it } from 'vitest'
import { NO_AGENT_WRITES, trackAgentWrites } from './agent-writes.ts'
import type { SseEvent } from './types.ts'

const call = (seq: number, id: string, name: string, path: string): SseEvent => ({ type: 'tool/call', seq, call: { id, name, args: { path } } })
const result = (seq: number, callId: string, ok = true): SseEvent => ({ type: 'tool/result', seq, callId, ok, output: '' })

describe('trackAgentWrites', () => {
  it('tracks patch destinations and deleted/moved sources even on partial failure', () => {
    const start: SseEvent = { type: 'tool/call', seq: 1, call: { id: 'p', name: 'ApplyPatch', args: { patch_text: '' } } }
    const output = JSON.stringify({ tool: 'ApplyPatch', files: [{ path: 'a', movePath: 'b', type: 'move', edits: [] }, { path: 'gone', type: 'delete', edits: [] }], error: 'disk full' })
    const events: SseEvent[] = [start, { type: 'tool/result', seq: 2, callId: 'p', ok: false, output: `error: Error: ${output}` }]
    const running = trackAgentWrites(NO_AGENT_WRITES, [start], 's', '/repo')
    expect(trackAgentWrites(running, events, 's', '/repo').writes).toEqual({ a: 2, b: 2, gone: 2 })
    expect(trackAgentWrites(NO_AGENT_WRITES, [events[1]!], 's', '/repo').writes).toEqual({})
  })
  it('records the seq of a landed Edit or Write under its project-relative path', () => {
    const events = [call(1, 'a', 'Edit', '/repo/src/a.ts'), result(2, 'a'), call(3, 'b', 'write', 'src/b.ts'), result(4, 'b')]
    expect(trackAgentWrites(NO_AGENT_WRITES, events, 's1', '/repo').writes).toEqual({ 'src/a.ts': 2, 'src/b.ts': 4 })
  })

  it('ignores a failed write, reads, and paths outside the project', () => {
    const events = [call(1, 'a', 'Edit', '/repo/src/a.ts'), result(2, 'a', false), call(3, 'r', 'Read', '/repo/src/r.ts'), result(4, 'r'), call(5, 'o', 'Write', '/elsewhere/x.ts'), result(6, 'o')]
    expect(trackAgentWrites(NO_AGENT_WRITES, events, 's1', '/repo').writes).toEqual({})
  })

  it('waits for the result: a call still running has not written yet', () => {
    const running = trackAgentWrites(NO_AGENT_WRITES, [call(1, 'a', 'Edit', 'src/a.ts')], 's1', '/repo')
    expect(running.writes).toEqual({})
    const landed = trackAgentWrites(running, [call(1, 'a', 'Edit', 'src/a.ts'), result(2, 'a')], 's1', '/repo')
    expect(landed.writes).toEqual({ 'src/a.ts': 2 })
    expect(landed.pending.size).toBe(0)
  })

  it('reads only the new tail and keeps the same object when nothing arrived', () => {
    const events = [call(1, 'a', 'Edit', 'src/a.ts'), result(2, 'a')]
    const first = trackAgentWrites(NO_AGENT_WRITES, events, 's1', '/repo')
    expect(trackAgentWrites(first, events, 's1', '/repo')).toBe(first)
    const next = trackAgentWrites(first, [...events, call(3, 'b', 'Edit', 'src/a.ts'), result(4, 'b')], 's1', '/repo')
    expect(next.writes).toEqual({ 'src/a.ts': 4 })
    expect(next.scanned).toBe(4)
  })

  it('keeps the writes map unchanged when the new events carry no write', () => {
    const first = trackAgentWrites(NO_AGENT_WRITES, [call(1, 'a', 'Edit', 'src/a.ts'), result(2, 'a')], 's1', '/repo')
    const next = trackAgentWrites(first, [call(1, 'a', 'Edit', 'src/a.ts'), result(2, 'a'), { type: 'assistant/message', seq: 3, content: 'ok' }], 's1', '/repo')
    expect(next.writes).toBe(first.writes)
  })

  it('starts over for another session, another project, or a log that shrank', () => {
    const log = [call(1, 'a', 'Edit', '/repo/src/a.ts'), result(2, 'a')]
    const first = trackAgentWrites(NO_AGENT_WRITES, log, 's1', '/repo')
    expect(first.writes).toEqual({ 'src/a.ts': 2 })
    expect(trackAgentWrites(first, [], 's2', '/repo').writes).toEqual({})
    // The same log read against another project root: the file is outside it.
    expect(trackAgentWrites(first, log, 's1', '/other').writes).toEqual({})
    expect(trackAgentWrites(first, [call(1, 'x', 'Edit', '/repo/src/z.ts')], 's1', '/repo').writes).toEqual({})
  })

  it('tracks nothing without a project root', () => {
    expect(trackAgentWrites(NO_AGENT_WRITES, [call(1, 'a', 'Edit', 'src/a.ts'), result(2, 'a')], 's1', null).writes).toEqual({})
  })
})
