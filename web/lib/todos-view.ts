/**
 * The session's TodoWrite task list, derived from the durable event stream.
 * The tool is full-replacement, so the LAST successful call's arguments ARE
 * the current list — no extra events and no GET: the SSE snapshot rehydrates
 * it for free after a restart. A failed, denied, or recovery-synthesized
 * result never changes the list.
 */
import type { SseEvent } from './types.ts'

export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly activeForm: string
}

export interface TodoView {
  readonly todos: readonly TodoItem[]
  /** The first in_progress item, if any — the TaskStatus line reads it. */
  readonly active?: TodoItem
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])

/** Tolerant client-side shape check: garbage items drop, never crash. */
function parseTodos(args: unknown): readonly TodoItem[] {
  if (!Array.isArray(args)) return []
  const todos: TodoItem[] = []
  for (const entry of args) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const content = typeof item['content'] === 'string' ? item['content'] : ''
    const activeForm = typeof item['activeForm'] === 'string' ? item['activeForm'] : ''
    const status = item['status']
    if (content === '' || activeForm === '' || typeof status !== 'string' || !STATUSES.has(status)) continue
    todos.push({ content, activeForm, status: status as TodoItem['status'] })
  }
  return todos
}

export function todosFromEvents(events: readonly SseEvent[]): TodoView {
  // Pair every TodoWrite call with its result by call id; a result that is
  // ok (and not a recovery record) adopts that call's list.
  const candidates = new Map<string, readonly TodoItem[]>()
  let todos: readonly TodoItem[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && event.call?.name === 'TodoWrite' && event.call.id !== '') {
      candidates.set(event.call.id, parseTodos(event.call.args['todos']))
    } else if (event.type === 'tool/result' && event.callId !== undefined) {
      const candidate = candidates.get(event.callId)
      if (candidate === undefined) continue
      candidates.delete(event.callId)
      if (event.ok === true && event.recovery !== true) todos = candidate
    }
  }
  const active = todos.find((todo) => todo.status === 'in_progress')
  return { todos, ...(active !== undefined ? { active } : {}) }
}
