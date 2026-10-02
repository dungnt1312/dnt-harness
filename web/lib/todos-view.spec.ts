import { describe, expect, it } from 'vitest'
import { todosFromEvents } from './todos-view.ts'
import type { SseEvent } from './types.ts'

let seq = 0
const ev = (fields: Record<string, unknown>): SseEvent => ({ type: 'x', seq: ++seq, ...fields }) as SseEvent
const todoCall = (id: string, todos: unknown): SseEvent =>
  ev({ type: 'tool/call', call: { id, name: 'TodoWrite', args: { todos } } })
const result = (callId: string, ok: boolean, extra: Record<string, unknown> = {}): SseEvent =>
  ev({ type: 'tool/result', callId, ok, output: '', ...extra })

const item = { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' }

describe('todosFromEvents', () => {
  it('returns an empty view without calls', () => {
    expect(todosFromEvents([])).toEqual({ todos: [] })
  })

  it('adopts the list of the last successful call', () => {
    const events = [
      todoCall('c1', [item]),
      result('c1', true),
      todoCall('c2', [
        { ...item, status: 'completed' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ]),
      result('c2', true),
    ]
    const view = todosFromEvents(events)
    expect(view.todos).toHaveLength(2)
    expect(view.todos[0]?.status).toBe('completed')
    expect(view.active).toBeUndefined()
  })

  it('keeps the previous list while a newer call has no result yet', () => {
    const events = [todoCall('c1', [item]), result('c1', true), todoCall('c2', [])]
    expect(todosFromEvents(events).todos).toHaveLength(1)
  })

  it('ignores failed and recovery-synthesized results', () => {
    expect(todosFromEvents([todoCall('c1', [item]), result('c1', false, { output: 'error: bad' })]).todos).toEqual([])
    expect(todosFromEvents([todoCall('c2', [item]), result('c2', true, { recovery: true })]).todos).toEqual([])
  })

  it('names the first in_progress item as active', () => {
    const events = [
      todoCall('c1', [
        { content: 'A', status: 'in_progress', activeForm: 'Doing a' },
        { content: 'B', status: 'in_progress', activeForm: 'Doing b' },
      ]),
      result('c1', true),
    ]
    expect(todosFromEvents(events).active?.content).toBe('A')
  })

  it('drops malformed items instead of crashing', () => {
    const events = [todoCall('c1', [item, { content: '' }, 'junk', null]), result('c1', true)]
    expect(todosFromEvents(events).todos).toEqual([item])
  })

  it('ignores other tools entirely', () => {
    const events = [
      ev({ type: 'tool/call', call: { id: 'b1', name: 'Bash', args: { command: 'ls' } } }),
      result('b1', true),
    ]
    expect(todosFromEvents(events).todos).toEqual([])
  })
})
