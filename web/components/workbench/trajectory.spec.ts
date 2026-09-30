import { describe, expect, it } from 'vitest'
import type { SseEvent } from '../../lib/types.ts'
import { projectTrajectory, trajectoryMatches } from './trajectory.ts'

function event(partial: SseEvent): SseEvent {
  return partial
}

describe('projectTrajectory', () => {
  it('is empty when the log has no turns and no calls', () => {
    expect(projectTrajectory([])).toEqual({ turns: [], calls: [], extent: null })
    expect(projectTrajectory([event({ type: 'session/title', seq: 1, timestamp: 1, title: 'hi' })])).toEqual({ turns: [], calls: [], extent: null })
  })

  it('draws each tool call as its own mark inside the turn, even when calls overlap', () => {
    const trajectory = projectTrajectory([
      event({ type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' }),
      event({ type: 'user/message', seq: 2, timestamp: 1_010, turnId: 't1', content: 'read the readme' }),
      event({ type: 'step/start', seq: 3, timestamp: 1_100, turnId: 't1' }),
      event({ type: 'assistant/message', seq: 4, timestamp: 1_400, content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'README.md' } }], controls: { model: 'deepseek-v4' } }),
      event({ type: 'tool/call', seq: 5, timestamp: 1_420, call: { id: 'c1', name: 'Read', args: { path: 'README.md' } } }),
      event({ type: 'tool/result', seq: 6, timestamp: 1_900, callId: 'c1', ok: true, output: '# README\n' }),
      event({ type: 'step/start', seq: 7, timestamp: 1_900, turnId: 't1' }),
      event({ type: 'assistant/message', seq: 8, timestamp: 2_200, content: 'done', controls: { model: 'deepseek-v4' } }),
      event({ type: 'turn/end', seq: 9, timestamp: 2_200, turnId: 't1', reason: 'completed' }),
    ])

    expect(trajectory.turns).toHaveLength(1)
    const turn = trajectory.turns[0]!
    expect(turn).toMatchObject({ id: 't1', index: 1, outcome: 'completed', prompt: 'read the readme', model: 'deepseek-v4', start: 1_000, end: 2_200, calls: 1, failedCalls: 0 })
    expect(turn.segments).toEqual([{ kind: 'tool', start: 1_420, end: 1_900, callId: 'c1' }])
    // The model lane is the requests, separate from the tool lane.
    expect(turn.steps).toEqual([
      { index: 1, start: 1_000, end: 1_400, content: '', calls: 1 },
      { index: 2, start: 1_900, end: 2_200, content: 'done', calls: 0 },
    ])
    expect(trajectory.extent).toEqual({ start: 1_000, end: 2_200 })
  })

  it('keeps an unfinished turn running and a call without a result running with it', () => {
    const trajectory = projectTrajectory([
      event({ type: 'turn/start', seq: 1, timestamp: 100, turnId: 't1' }),
      event({ type: 'tool/call', seq: 2, timestamp: 150, call: { id: 'c1', name: 'Bash', args: { command: 'pnpm test' } } }),
    ])
    expect(trajectory.turns[0]).toMatchObject({ outcome: 'open', calls: 1 })
    expect(trajectory.turns[0]?.end).toBeUndefined()
    expect(trajectory.calls[0]).toMatchObject({ id: 'c1', name: 'Bash', target: 'pnpm test', state: 'running', start: 150 })
  })

  it('marks a call unknown once its turn closed without a result, and drops an orphan result', () => {
    const trajectory = projectTrajectory([
      event({ type: 'turn/start', seq: 1, timestamp: 100, turnId: 't1' }),
      event({ type: 'tool/call', seq: 2, timestamp: 120, call: { id: 'c1', name: 'Read', args: { path: 'a.ts' } } }),
      event({ type: 'turn/end', seq: 3, timestamp: 200, turnId: 't1', reason: 'interrupted' }),
      event({ type: 'tool/result', seq: 4, timestamp: 300, callId: 'missing', ok: true, output: 'nope' }),
    ])
    expect(trajectory.turns[0]).toMatchObject({ outcome: 'interrupted' })
    expect(trajectory.calls).toHaveLength(1)
    expect(trajectory.calls[0]).toMatchObject({ id: 'c1', state: 'unknown' })
    expect(trajectory.calls[0]?.end).toBeUndefined()
  })

  it('reads a failed call and a recovered result without inventing an outcome', () => {
    const trajectory = projectTrajectory([
      event({ type: 'turn/start', seq: 1, timestamp: 0, turnId: 't1' }),
      event({ type: 'tool/call', seq: 2, timestamp: 10, call: { id: 'bad', name: 'Bash', args: { command: 'npm test' } } }),
      event({ type: 'tool/result', seq: 3, timestamp: 40, callId: 'bad', ok: false, output: 'boom\n[exit code: 1]\n' }),
      event({ type: 'tool/call', seq: 4, timestamp: 50, call: { id: 'recovered', name: 'Read', args: { path: 'b.ts' } } }),
      event({ type: 'tool/result', seq: 5, timestamp: 60, callId: 'recovered', ok: true, output: 'partial', recovery: true }),
      event({ type: 'turn/end', seq: 6, timestamp: 70, turnId: 't1', reason: 'failed' }),
    ])
    expect(trajectory.turns[0]).toMatchObject({ outcome: 'failed', calls: 2, failedCalls: 1 })
    expect(trajectory.calls.map((call) => [call.id, call.state])).toEqual([['bad', 'failed'], ['recovered', 'unknown']])
    // A failed Bash reports the first line of its output; the exit marker is
    // only the digest when the result itself was recorded as ok.
    expect(trajectory.calls[0]?.digest).toBe('boom')
  })

  it('keeps the first result when the log repeats one', () => {
    const trajectory = projectTrajectory([
      event({ type: 'tool/call', seq: 1, timestamp: 10, call: { id: 'c1', name: 'Read', args: { path: 'a.ts' } } }),
      event({ type: 'tool/result', seq: 2, timestamp: 20, callId: 'c1', ok: true, output: 'first' }),
      event({ type: 'tool/result', seq: 3, timestamp: 30, callId: 'c1', ok: false, output: 'second' }),
    ])
    expect(trajectory.calls).toHaveLength(1)
    expect(trajectory.calls[0]).toMatchObject({ state: 'ok', end: 20 })
  })

  it('keeps a mark for every overlapping call, not just the last one', () => {
    const trajectory = projectTrajectory([
      event({ type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' }),
      event({ type: 'tool/call', seq: 2, timestamp: 1_100, call: { id: 'a', name: 'Read', args: { path: 'a.ts' } } }),
      event({ type: 'tool/call', seq: 3, timestamp: 1_200, call: { id: 'b', name: 'Read', args: { path: 'b.ts' } } }),
      event({ type: 'tool/result', seq: 4, timestamp: 4_000, callId: 'a', ok: true, output: 'a' }),
      event({ type: 'tool/result', seq: 5, timestamp: 4_500, callId: 'b', ok: true, output: 'b' }),
      event({ type: 'turn/end', seq: 6, timestamp: 5_000, turnId: 't1', reason: 'completed' }),
    ])
    expect(trajectory.turns[0]?.segments).toEqual([
      { kind: 'tool', start: 1_100, end: 4_000, callId: 'a' },
      { kind: 'tool', start: 1_200, end: 4_500, callId: 'b' },
    ])
  })

  it('filters by prompt, tool name and target, and matches nothing it was not given', () => {
    const trajectory = projectTrajectory([
      event({ type: 'turn/start', seq: 1, timestamp: 0, turnId: 't1' }),
      event({ type: 'user/message', seq: 2, timestamp: 1, turnId: 't1', content: 'check the workspace' }),
      event({ type: 'tool/call', seq: 3, timestamp: 2, call: { id: 'c1', name: 'Grep', args: { pattern: 'createProject', path: 'src' } } }),
      event({ type: 'tool/result', seq: 4, timestamp: 3, callId: 'c1', ok: true, output: 'src/app.ts:1' }),
      event({ type: 'turn/end', seq: 5, timestamp: 4, turnId: 't1', reason: 'completed' }),
    ])
    const turn = trajectory.turns[0]
    const call = trajectory.calls[0]
    expect(trajectoryMatches(turn, undefined, 'workspace')).toBe(true)
    expect(trajectoryMatches(turn, undefined, 'createProject')).toBe(false)
    expect(trajectoryMatches(turn, call, 'grep')).toBe(true)
    expect(trajectoryMatches(turn, call, 'src')).toBe(true)
    expect(trajectoryMatches(turn, call, '   ')).toBe(true)
    expect(trajectoryMatches(turn, call, 'not-in-the-log')).toBe(false)
  })
})
