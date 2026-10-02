import { describe, expect, it } from 'vitest'
import { turnChanges } from './turn-changes.ts'
import type { SseEvent, ToolCall } from './types.ts'

/** Minimal tool/call + tool/result pair, the way the wire projects them. */
function callPair(id: string, name: string, args: Record<string, unknown>, turnId: string, result?: { ok: boolean; output: string; recovery?: true }): SseEvent[] {
  const events: SseEvent[] = [
    { type: 'turn/start', seq: 1, timestamp: 1, turnId },
    { type: 'tool/call', seq: 2, timestamp: 2, turnId, stepId: 's1', call: { id, name, args } satisfies ToolCall },
  ]
  if (result !== undefined) events.push({ type: 'tool/result', seq: 3, timestamp: 3, turnId, stepId: 's1', callId: id, ...result })
  events.push({ type: 'turn/end', seq: 9, timestamp: 9, turnId, reason: 'completed' })
  return events
}

describe('turnChanges', () => {
  it('lists a landed Write as created and an Edit as modified', () => {
    const events = [
      ...callPair('c1', 'Write', { path: 'new.md', content: 'x' }, 't1', { ok: true, output: 'created new.md' }),
      ...callPair('c2', 'Edit', { path: 'src/a.ts', old: 'a', new: 'b' }, 't2', { ok: true, output: 'applied 1 replacement' }),
    ]
    const map = turnChanges(events)
    expect(map.get('t1')?.files).toEqual([{ path: 'new.md', status: 'created', lines: { added: 1 }, args: { path: 'new.md', content: 'x' } }])
    expect(map.get('t2')?.files).toEqual([{ path: 'src/a.ts', status: 'modified', lines: { added: 1, removed: 1 }, args: { path: 'src/a.ts', old: 'a', new: 'b' } }])
  })

  it('attributes by position: a call inside its turn, a late result to its call', () => {
    // The result is appended after the next turn opened — the callId, not
    // the position, decides where it lands.
    const events: SseEvent[] = [
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'tool/call', seq: 2, turnId: 't1', stepId: 's1', call: { id: 'c1', name: 'Write', args: { path: 'a.ts', content: 'x' } } },
      { type: 'turn/end', seq: 3, turnId: 't1', reason: 'completed' },
      { type: 'turn/start', seq: 4, turnId: 't2' },
      { type: 'tool/result', seq: 5, turnId: 't2', stepId: 's1', callId: 'c1', ok: true, output: 'created a.ts' },
      { type: 'turn/end', seq: 6, turnId: 't2', reason: 'completed' },
    ]
    const map = turnChanges(events)
    expect(map.get('t1')?.files).toEqual([{ path: 'a.ts', status: 'created', lines: { added: 1 }, args: { path: 'a.ts', content: 'x' } }])
    expect(map.has('t2')).toBe(false)
  })

  it('drops failed, denied and recovered results from files, keeping them uncertain', () => {
    const events = [
      ...callPair('c1', 'Write', { path: 'a.ts', content: 'x' }, 't1', { ok: false, output: 'conflict: a.ts changed after it was observed' }),
      ...callPair('c2', 'Edit', { path: 'b.ts', old: 'a', new: 'b' }, 't1', { ok: false, output: 'denied: not allowed by the mode' }),
      ...callPair('c3', 'Write', { path: 'c.ts', content: 'x' }, 't1', { ok: true, output: 'whatever', recovery: true }),
    ]
    const map = turnChanges(events)
    const turn = map.get('t1')
    expect(turn?.files).toEqual([])
    expect(turn?.uncertain).toEqual(['c1', 'c2', 'c3'])
  })

  it('never counts Read calls, and ignores calls outside any turn', () => {
    const events: SseEvent[] = [
      { type: 'turn/start', seq: 1, turnId: 't1' },
      { type: 'tool/call', seq: 2, turnId: 't1', stepId: 's1', call: { id: 'c0', name: 'Read', args: { path: 'a.ts' } } },
      { type: 'tool/result', seq: 3, turnId: 't1', stepId: 's1', callId: 'c0', ok: true, output: 'content' },
      { type: 'turn/end', seq: 4, turnId: 't1', reason: 'completed' },
      { type: 'tool/call', seq: 5, call: { id: 'c9', name: 'Write', args: { path: 'orphan.ts', content: 'x' } } },
      { type: 'tool/result', seq: 6, callId: 'c9', ok: true, output: 'created orphan.ts' },
    ]
    expect(turnChanges(events).size).toBe(0)
  })

  it('collapses repeat writes to one path, last landing wins', () => {
    const events = [
      ...callPair('c1', 'Write', { path: 'a.ts', content: 'one' }, 't1', { ok: true, output: 'created a.ts' }),
      ...callPair('c2', 'Edit', { path: 'a.ts', old: 'one', new: 'two' }, 't1', { ok: true, output: 'applied 1 replacement' }),
    ]
    const turn = turnChanges(events).get('t1')
    expect(turn?.files).toEqual([{ path: 'a.ts', status: 'modified', lines: { added: 1, removed: 1 }, args: { path: 'a.ts', old: 'one', new: 'two' } }])
    expect(turn?.ts).toBe(3)
  })

  it('skips calls outside any turn — no turn/start, no attribution', () => {
    const events: SseEvent[] = [
      { type: 'tool/call', seq: 1, stepId: 's1', call: { id: 'c1', name: 'Write', args: { path: 'a.ts', content: 'x' } } },
      { type: 'tool/result', seq: 2, stepId: 's1', callId: 'c1', ok: true, output: 'created a.ts' },
    ]
    expect(turnChanges(events).size).toBe(0)
  })

  it('is empty for a log with no mutating calls', () => {
    expect(turnChanges([{ type: 'user/message', seq: 1, turnId: 't1', content: 'hi' }]).size).toBe(0)
  })
})
