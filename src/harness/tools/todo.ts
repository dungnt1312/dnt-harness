import type { ToolDefinition } from './types.ts'

/**
 * The Claude-Code-style session task list: ONE full-replacement tool whose
 * entire state is the durable log. Each call carries the complete list, so
 * the last successful `tool/call`+`tool/result` pair IS the current list and
 * the web derives the visible checklist from the events it already has — no
 * registry, no extra event kinds, no GET.
 *
 * Behavioral rules (exactly one in_progress, complete immediately, blocked →
 * add an unblock task) live in the description and the base prompt as
 * guidance; the tool validates SHAPE only, exactly like Claude Code. A
 * validation failure throws: the pipeline catches it into a failed
 * `ToolResult` the model can read and correct.
 */
const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])
/** Beyond this the list is a transcript, not a task list. */
const MAX_TODO_ITEMS = 100

interface ParsedTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly activeForm: string
}

function parseTodos(args: Record<string, unknown>): readonly ParsedTodo[] {
  const raw = args['todos']
  if (!Array.isArray(raw)) {
    throw new Error("argument 'todos' must be an array of { content, status, activeForm } items")
  }
  if (raw.length > MAX_TODO_ITEMS) {
    throw new Error(`'todos' is limited to ${MAX_TODO_ITEMS} items; split the work into smaller lists`)
  }
  return raw.map((entry) => {
    const item = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    const content = typeof item['content'] === 'string' ? item['content'].trim() : ''
    const activeForm = typeof item['activeForm'] === 'string' ? item['activeForm'].trim() : ''
    const status = item['status']
    if (content === '' || activeForm === '') {
      throw new Error("every todo needs non-empty 'content' and 'activeForm' strings and a 'status' of pending, in_progress, or completed")
    }
    if (typeof status !== 'string' || !STATUSES.has(status)) {
      throw new Error("every todo needs a 'status' of pending, in_progress, or completed")
    }
    return { content, status: status as ParsedTodo['status'], activeForm }
  })
}

function receipt(todos: readonly ParsedTodo[]): string {
  if (todos.length === 0) return 'Todo list cleared'
  const counts = { completed: 0, in_progress: 0, pending: 0 }
  for (const todo of todos) counts[todo.status] += 1
  const parts = [
    ...(counts.completed > 0 ? [`${counts.completed} completed`] : []),
    ...(counts.in_progress > 0 ? [`${counts.in_progress} in progress`] : []),
    ...(counts.pending > 0 ? [`${counts.pending} pending`] : []),
  ]
  const tasks = `${todos.length} ${todos.length === 1 ? 'task' : 'tasks'}`
  return `Todo list updated: ${tasks} (${parts.join(', ')})`
}

export function todoWriteTool(): ToolDefinition {
  return {
    name: 'TodoWrite',
    description: [
      'Create and manage a structured task list for the current coding session so the user can watch progress.',
      'Use it for complex multi-step work (three or more distinct steps), when the user provides several tasks, or asks for a todo list; skip it for a single trivial action.',
      'Rules: every call replaces the WHOLE list; keep exactly one task in_progress at a time; mark a task completed IMMEDIATELY after finishing it (never batch completions); if blocked or errored, keep the item in_progress and add a new item describing what must be resolved; remove items that are no longer relevant.',
      "Each item needs content (imperative, e.g. 'Run tests'), status, and activeForm (present-continuous, e.g. 'Running tests').",
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The COMPLETE task list; every call replaces the previous list. An empty array clears it.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: "Imperative task description, e.g. 'Run tests'" },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: "Present-continuous form shown while the task runs, e.g. 'Running tests'" },
            },
            required: ['content', 'status', 'activeForm'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(args) {
      return receipt(parseTodos(args))
    },
  }
}
