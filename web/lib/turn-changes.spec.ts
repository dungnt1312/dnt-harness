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

/** Several calls inside ONE turn. */
function oneTurn(turnId: string, calls: ReadonlyArray<[string, string, Record<string, unknown>, string]>): SseEvent[] {
  const events: SseEvent[] = [{ type: 'turn/start', seq: 1, timestamp: 1, turnId }]
  calls.forEach(([id, name, args, output], index) => {
    events.push({ type: 'tool/call', seq: 10 + index * 2, turnId, stepId: 's1', call: { id, name, args } })
    events.push({ type: 'tool/result', seq: 11 + index * 2, timestamp: 11 + index * 2, turnId, stepId: 's1', callId: id, ok: true, output })
  })
  events.push({ type: 'turn/end', seq: 99, turnId, reason: 'completed' })
  return events
}

describe('turnChanges', () => {
  it('lists a landed Write as created and an Edit as modified, with the recorded calls', () => {
    const events = [
      ...callPair('c1', 'Write', { path: 'new.md', content: 'x' }, 't1', { ok: true, output: 'created new.md (1 lines)' }),
      ...callPair('c2', 'Edit', { path: 'src/a.ts', old: 'a', new: 'b' }, 't2', { ok: true, output: 'edited src/a.ts' }),
    ]
    const map = turnChanges(events)
    expect(map.get('t1')?.files).toEqual([{ path: 'new.md', status: 'created', lines: { added: 1 }, edits: [{ kind: 'write', content: 'x', created: true }] }])
    expect(map.get('t2')?.files).toEqual([{ path: 'src/a.ts', status: 'modified', lines: { added: 1, removed: 1 }, edits: [{ kind: 'edit', old: 'a', new: 'b', output: 'edited src/a.ts' }] }])
  })

  it('counts an Edit by its line diff: context lines it carried are not changes', () => {
    const turn = turnChanges(oneTurn('t1', [
      ['c1', 'Edit', { path: 'a.ts', old: 'keep\nold\nkeep2', new: 'keep\nnew\nkeep2' }, 'edited a.ts'],
    ])).get('t1')
    expect(turn?.files[0]?.lines).toEqual({ added: 1, removed: 1 })
  })

  it('multiplies a replaceAll Edit by the places it changed', () => {
    const turn = turnChanges(oneTurn('t1', [
      ['c1', 'Edit', { path: 'a.ts', old: 'foo', new: 'bar', replaceAll: true }, 'edited a.ts: replaced 3 occurrences'],
    ])).get('t1')
    expect(turn?.files[0]?.lines).toEqual({ added: 3, removed: 3 })
  })

  it('merges several calls on one file: counts add up and every call is kept in order', () => {
    const turn = turnChanges(oneTurn('t1', [
      ['c1', 'Edit', { path: 'a.ts', old: 'one', new: 'two' }, 'edited a.ts'],
      ['c2', 'Edit', { path: 'a.ts', old: 'x', new: 'y\nz' }, 'edited a.ts'],
    ])).get('t1')
    expect(turn?.files).toHaveLength(1)
    expect(turn?.files[0]?.lines).toEqual({ added: 3, removed: 2 })
    expect(turn?.files[0]?.edits.map((edit) => edit.kind === 'edit' ? edit.new : '')).toEqual(['two', 'y\nz'])
  })

  it('a file the turn created stays created through later edits, with its net size', () => {
    const turn = turnChanges(oneTurn('t1', [
      ['c1', 'Write', { path: 'a.ts', content: 'l1\nl2\nl3' }, 'created a.ts (3 lines)'],
      ['c2', 'Edit', { path: 'a.ts', old: 'l2', new: 'L2' }, 'edited a.ts'],
    ])).get('t1')
    expect(turn?.files[0]).toMatchObject({ status: 'created', lines: { added: 3 } })
    expect(turn?.files[0]?.overwrote).toBeUndefined()
  })

  it('an Edit with an empty old that created the file is created', () => {
    const turn = turnChanges(oneTurn('t1', [
      ['c1', 'Edit', { path: 'n.md', old: '', new: 'a\nb' }, 'created n.md (2 lines)'],
    ])).get('t1')
    expect(turn?.files[0]).toMatchObject({ status: 'created', lines: { added: 2 } })
  })

  it('a Write over an existing file is "overwrote" and states no counts', () => {
    const turn = turnChanges(oneTurn('t1', [
      ['c1', 'Write', { path: 'a.ts', content: 'x\ny\nz' }, 'overwrote a.ts (6 bytes written)'],
    ])).get('t1')
    expect(turn?.files[0]).toMatchObject({ status: 'modified', overwrote: true })
    expect(turn?.files[0]?.lines).toBeUndefined()
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
    expect(map.get('t1')?.files.map((file) => file.path)).toEqual(['a.ts'])
    expect(map.has('t2')).toBe(false)
  })

  it('drops failed, denied and recovered results: a turn whose writes never landed has no entry', () => {
    const events = [
      ...callPair('c1', 'Write', { path: 'a.ts', content: 'x' }, 't1', { ok: false, output: 'conflict: a.ts changed after it was observed' }),
      ...callPair('c2', 'Edit', { path: 'b.ts', old: 'a', new: 'b' }, 't1', { ok: false, output: 'denied: not allowed by the mode' }),
      ...callPair('c3', 'Write', { path: 'c.ts', content: 'x' }, 't1', { ok: true, output: 'whatever', recovery: true }),
    ]
    expect(turnChanges(events).has('t1')).toBe(false)
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

  it('is empty for a log with no mutating calls', () => {
    expect(turnChanges([{ type: 'user/message', seq: 1, turnId: 't1', content: 'hi' }]).size).toBe(0)
  })
})
