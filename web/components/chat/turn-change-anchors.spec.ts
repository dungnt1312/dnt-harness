import { describe, expect, it } from 'vitest'
import { turnChangeAnchors } from './Transcript.tsx'
import type { ViewItem } from '../../lib/project.ts'
import type { TurnChanges } from '../../lib/turn-changes.ts'

const user = (content: string): ViewItem => ({ kind: 'user', content })
const answer = (turnId: string, content: string, turnOpen = false): ViewItem =>
  ({ kind: 'assistant', content, live: false, thinking: [], thinkingLive: false, turnId, turnOpen })
const edit = (id: string): ViewItem => ({ kind: 'tool', call: { id, name: 'Edit', args: { path: 'a.ts', old: 'a', new: 'b' } }, result: { ok: true, output: 'edited a.ts' } })

const CHANGED: TurnChanges = { files: [{ path: 'a.ts', status: 'modified', lines: { added: 1, removed: 1 }, edits: [] }] }

describe('turnChangeAnchors', () => {
  it('anchors after the turn\'s last row, even when the turn ends on a tool with no answer text', () => {
    const items = [user('go'), answer('t1', ''), edit('c1'), user('next'), answer('t2', 'done')]
    const anchors = turnChangeAnchors(items, new Map([['t1', CHANGED]]))
    expect(anchors).toEqual([{ turnId: 't1', index: 2, changes: CHANGED, live: false }])
  })

  it('anchors after the final answer of a closed turn', () => {
    const items = [user('go'), answer('t1', ''), edit('c1'), answer('t1', 'all set')]
    expect(turnChangeAnchors(items, new Map([['t1', CHANGED]]))[0]).toMatchObject({ index: 3, live: false })
  })

  it('marks the open turn live, at the tail', () => {
    const items = [user('go'), answer('t1', '', true), edit('c1')]
    expect(turnChangeAnchors(items, new Map([['t1', CHANGED]]))).toEqual([{ turnId: 't1', index: 2, changes: CHANGED, live: true }])
  })

  it('a queued message does not end the running turn', () => {
    const items = [user('go'), answer('t1', '', true), edit('c1'), { kind: 'user', content: 'later', queued: true } as ViewItem]
    expect(turnChangeAnchors(items, new Map([['t1', CHANGED]]))[0]).toMatchObject({ index: 2, live: true })
  })

  it('turns without changes get no anchor', () => {
    const items = [user('go'), answer('t1', 'hi')]
    expect(turnChangeAnchors(items, new Map())).toEqual([])
  })
})
