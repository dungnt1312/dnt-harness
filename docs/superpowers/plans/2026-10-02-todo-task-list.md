# Todo-Style Task List (TodoWrite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model a Claude-Code-style `TodoWrite` task list whose state lives entirely in the durable session log, surfaced as a Tasks section in the EnvironmentPanel plus a quiet transcript row.

**Architecture:** One stateless full-replacement tool (`TodoWrite`); the LAST successful call's arguments ARE the list, so the web derives everything from existing `tool/call`/`tool/result` events — no new event kinds, no registry, no GET API. UI: EnvironmentPanel Tasks section + collapsed-capsule chip, `tool-facts` digest row, TaskStatus `Working · <activeForm>`.

**Tech Stack:** TypeScript (Node 22, ESM `.ts` imports), vitest (jsdom for component specs), React 19.

**Spec:** `docs/superpowers/specs/2026-10-02-todo-task-list-design.md` (approved).

## Global Constraints

- **The working tree holds UNCOMMITTED work from a parallel session. Never `git add -A`, `git add .`, `git checkout`, `git stash`, or `git reset`.** Every commit step lists exact file paths — add only those.
- Tests import harness internals by relative path (`../../src/harness/...`) and web modules by relative path (`../../lib/...`), matching `tests/harness/memory-tools.spec.ts` and the web specs.
- Tool validation failures are thrown `Error`s — the tool pipeline catches them into `ok:false` `error: …` results the model sees; never let a raw exception escape a test expectation of a crash.
- Web tsconfig uses `exactOptionalPropertyTypes`: optional props/fields are added via conditional spread (`...(x !== undefined ? { x } : {})`), never explicit `undefined`.
- vitest run command: `npx vitest run <file>`; full suite `npm test`; typecheck `npm run typecheck`; web build `npm run build:web`.
- Tool name is exactly `TodoWrite` (capital T, capital W — Claude-compatible public name).
- Behavioral rules (exactly one `in_progress`, complete immediately, blocked → add unblock task) are PROMPT/DESCRIPTION guidance only — never enforced by validation.

---

### Task 1: The `TodoWrite` tool + registration in both bins

**Files:**
- Create: `src/harness/tools/todo.ts`
- Create: `tests/harness/todo-tools.spec.ts`
- Modify: `src/web/server.ts` (add one import near line 123 where `memoryTools` is imported, and one registration line right after the memory-tools loop at ~line 1217-1219)
- Modify: `src/bins/headless.ts` (import + one registration line after the `killShellTool` registration at ~line 146)

**Interfaces:**
- Consumes: `ToolDefinition` from `src/harness/tools/types.ts` (`name`, `description`, `parameters: { type: 'object', properties, required? }`, `requiresRoot?`, `execute(args, exec) => Promise<string>`).
- Produces: `todoWriteTool(): ToolDefinition` exported from `src/harness/tools/todo.ts`; registered under the name `'TodoWrite'`. Task 2 (modes) and Tasks 4–5 (web derive) rely on this exact name.

- [ ] **Step 1: Write the failing tests**

Create `tests/harness/todo-tools.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { todoWriteTool } from '../../src/harness/tools/todo.ts'

const tool = todoWriteTool()
const run = (args: Record<string, unknown>): Promise<string> => tool.execute(args, { root: '' })

const item = (overrides: Partial<Record<string, string>> = {}): Record<string, string> => ({
  content: 'Run tests',
  status: 'pending',
  activeForm: 'Running tests',
  ...overrides,
})

describe('TodoWrite tool', () => {
  it('is a root-free Claude-compatible tool', () => {
    expect(tool.name).toBe('TodoWrite')
    expect(tool.requiresRoot).toBe(false)
    expect(tool.description).toContain('in_progress')
  })

  it('confirms a full list replacement with a receipt', async () => {
    const receipt = await run({
      todos: [item(), item({ content: 'Ship', status: 'completed', activeForm: 'Shipping' })],
    })
    expect(receipt).toBe('Todo list updated: 2 tasks (1 completed, 1 pending)')
  })

  it('counts statuses in fixed order, omits zero parts, pluralizes tasks', async () => {
    const receipt = await run({
      todos: [
        item({ status: 'completed', content: 'A', activeForm: 'Doing a' }),
        item({ status: 'in_progress', content: 'B', activeForm: 'Doing b' }),
        item({ content: 'C' }),
        item({ content: 'D' }),
      ],
    })
    expect(receipt).toBe('Todo list updated: 4 tasks (1 completed, 1 in progress, 2 pending)')
    const single = await run({ todos: [item({ status: 'in_progress', content: 'B', activeForm: 'Doing b' })] })
    expect(single).toBe('Todo list updated: 1 task (1 in progress)')
  })

  it('clears the list on an empty array', async () => {
    expect(await run({ todos: [] })).toBe('Todo list cleared')
  })

  it('rejects a non-array todos argument', async () => {
    await expect(run({ todos: 'nope' })).rejects.toThrow(/todos must be an array/)
    await expect(run({})).rejects.toThrow(/todos must be an array/)
  })

  it('rejects malformed items with one actionable message', async () => {
    await expect(run({ todos: [{ content: 'x' }] })).rejects.toThrow(/'content' and 'activeForm'/)
    await expect(run({ todos: [item({ status: 'done' })] })).rejects.toThrow(/pending, in_progress, or completed/)
    await expect(run({ todos: [item({ content: ' ' })] })).rejects.toThrow(/'content' and 'activeForm'/)
    await expect(run({ todos: [item({ activeForm: '' })] })).rejects.toThrow(/'content' and 'activeForm'/)
  })

  it('rejects more than 100 items', async () => {
    const todos = Array.from({ length: 101 }, () => item())
    await expect(run({ todos })).rejects.toThrow(/100 items/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harness/todo-tools.spec.ts`
Expected: FAIL — cannot resolve import `../../src/harness/tools/todo.ts`.

- [ ] **Step 3: Implement the tool**

Create `src/harness/tools/todo.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harness/todo-tools.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Register in both bins**

`src/web/server.ts` — add the import next to the other harness tool imports (near the `memoryTools` import at ~line 123):

```ts
import { todoWriteTool } from '../harness/tools/todo.ts'
```

Then immediately AFTER the memory-tools registration loop (the `for (const tool of memoryTools(memory)) { … }` block around line 1217), add:

```ts
  // Claude-style session task list: full-replacement tool, state IS the log.
  kernel.ctx.tools.register(todoWriteTool())
```

`src/bins/headless.ts` — add the import beside the other tool imports:

```ts
import { todoWriteTool } from '../harness/tools/todo.ts'
```

Then after `kernel.ctx.tools.register(killShellTool({ processes }))` (line ~146), add:

```ts
  kernel.ctx.tools.register(todoWriteTool())
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/harness/tools/todo.ts tests/harness/todo-tools.spec.ts src/web/server.ts src/bins/headless.ts
git commit -m "feat(tools): TodoWrite session task-list tool"
```

---

### Task 2: Mode exposure — all four bundled modes

**Files:**
- Create: `tests/harness/todo-mode-exposure.spec.ts`
- Modify: `src/harness/modes/bundled.ts` (4 `toolExposure` arrays, 4 `permissionDefaults` blocks, `KNOWN_MODE_TOOLS`)

**Interfaces:**
- Consumes: the tool name `'TodoWrite'` from Task 1.
- Produces: `TodoWrite` exposed and `'allow'` in every bundled mode; `KNOWN_MODE_TOOLS` contains `'TodoWrite'`. Later mode-editing UI and the exposure ceiling rely on this.

- [ ] **Step 1: Write the failing tests**

Create `tests/harness/todo-mode-exposure.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BUNDLED_MODES, KNOWN_MODE_TOOLS } from '../../src/harness/modes/bundled.ts'

describe('TodoWrite mode exposure', () => {
  it('is exposed and auto-allowed in every bundled mode', () => {
    for (const mode of BUNDLED_MODES) {
      expect(mode.toolExposure, mode.id).toContain('TodoWrite')
      expect(mode.permissionDefaults['TodoWrite'], mode.id).toBe('allow')
    }
  })

  it('stays inside the exposure ceiling', () => {
    expect(KNOWN_MODE_TOOLS).toContain('TodoWrite')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/harness/todo-mode-exposure.spec.ts`
Expected: FAIL — `TodoWrite` not in the exposure lists.

- [ ] **Step 3: Edit `src/harness/modes/bundled.ts`**

In EACH of the four `toolExposure` arrays (ask-before-changes, edit-automatically, plan, full-access) append `'TodoWrite'` as the last entry, e.g. ask-before-changes becomes:

```ts
    toolExposure: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent', 'MemorySearch', 'MemoryRead', 'TodoWrite'],
```

(Do the same for the other three arrays — plan mode's array is the short one: `['Read', 'Glob', 'Grep', 'Skill', 'Agent', 'MemorySearch', 'MemoryRead', 'TodoWrite']`.)

In EACH of the four `permissionDefaults` blocks add one line — with a comment only in the FIRST (ask-before-changes), the others plain:

```ts
      // The session task list touches no workspace state, so it never asks.
      TodoWrite: 'allow',
```

In `KNOWN_MODE_TOOLS` append `'TodoWrite'`:

```ts
export const KNOWN_MODE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent',
  'MemorySearch', 'MemoryRead', 'MemoryCreate', 'MemoryUpdate', 'MemoryForget', 'TodoWrite',
]
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/harness/todo-mode-exposure.spec.ts tests/harness/modes.spec.ts tests/harness/g3-context.spec.ts`
Expected: PASS — including the pre-existing mode specs (no regression in exposure/permission snapshots).

- [ ] **Step 5: Commit**

```bash
git add src/harness/modes/bundled.ts tests/harness/todo-mode-exposure.spec.ts
git commit -m "feat(modes): expose TodoWrite in every bundled mode"
```

---

### Task 3: Web derivation — `todos-view.ts`

**Files:**
- Create: `web/lib/todos-view.ts`
- Create: `web/lib/todos-view.spec.ts`

**Interfaces:**
- Consumes: `SseEvent`/`ToolCall` from `web/lib/types.ts` (`tool/call` events carry `call: { id, name, args }`; `tool/result` carries `callId`, `ok`, `recovery?`).
- Produces (used by Tasks 4 and 5):

```ts
interface TodoItem { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed'; readonly activeForm: string }
interface TodoView { readonly todos: readonly TodoItem[]; readonly active?: TodoItem }
function todosFromEvents(events: readonly SseEvent[]): TodoView
```

- [ ] **Step 1: Write the failing tests**

Create `web/lib/todos-view.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/lib/todos-view.spec.ts`
Expected: FAIL — module `./todos-view.ts` not found.

- [ ] **Step 3: Implement**

Create `web/lib/todos-view.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run web/lib/todos-view.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/todos-view.ts web/lib/todos-view.spec.ts
git commit -m "feat(web): derive the session todo list from the durable log"
```

---

### Task 4: EnvironmentPanel Tasks section + capsule chip

**Files:**
- Modify: `web/components/chat/EnvironmentPanel.tsx`
- Modify: `web/components/chat/environment-panel.spec.tsx` (append tests)

**Interfaces:**
- Consumes: `todosFromEvents` from Task 3 (exact signature above).
- Produces: `section[aria-label="Tasks"]` with a `<completed>/<total>` counter, rows per item; a capsule chip marked `data-todo-chip` when collapsed. No new props — the panel already receives `events`.

- [ ] **Step 1: Write the failing tests**

Append to `web/components/chat/environment-panel.spec.tsx` (reuse the existing `ev`, `base`, `render` helpers):

```tsx
const todoEvents = [
  ev('tool/call', { call: { id: 'c1', name: 'TodoWrite', args: { todos: [
    { content: 'Research', status: 'completed', activeForm: 'Researching' },
    { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' },
    { content: 'Test', status: 'pending', activeForm: 'Testing' },
  ] } } }),
  ev('tool/result', { callId: 'c1', ok: true, output: 'Todo list updated: 3 tasks (1 completed, 1 in progress, 1 pending)' }),
]

it('shows the Tasks section with counter and item rows', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: todoEvents })
  const section = host.querySelector('section[aria-label="Tasks"]')
  expect(section).not.toBeNull()
  expect(section?.textContent).toContain('1/3')
  expect(section?.textContent).toContain('Research')
  expect(section?.textContent).toContain('Implement')
  expect(section?.textContent).toContain('Test')
})

it('stays collapsed for tasks and shows the capsule chip instead', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: todoEvents })
  // No auto-open: the collapse button is still the collapsed one.
  expect(host.querySelector('button[aria-label="Expand environment"]')).not.toBeNull()
  expect(host.querySelector('[data-todo-chip]')?.textContent).toContain('1/3')
})

it('omits the Tasks section and chip when there is no list or after clearing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
  await render({ ...base, events: [] })
  expect(host.querySelector('section[aria-label="Tasks"]')).toBeNull()
  expect(host.querySelector('[data-todo-chip]')).toBeNull()

  const cleared = [
    ev('tool/call', { call: { id: 'c1', name: 'TodoWrite', args: { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing a' }] } } }),
    ev('tool/result', { callId: 'c1', ok: true, output: 'Todo list updated: 1 task (1 completed)' }),
    ev('tool/call', { call: { id: 'c2', name: 'TodoWrite', args: { todos: [] } } }),
    ev('tool/result', { callId: 'c2', ok: true, output: 'Todo list cleared' }),
  ]
  await render({ ...base, events: cleared })
  expect(host.querySelector('section[aria-label="Tasks"]')).toBeNull()
  expect(host.querySelector('[data-todo-chip]')).toBeNull()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/components/chat/environment-panel.spec.tsx`
Expected: FAIL — no `section[aria-label="Tasks"]`, no `[data-todo-chip]`.

- [ ] **Step 3: Implement the panel changes**

In `web/components/chat/EnvironmentPanel.tsx`:

1. Add the import beside `processes-view`:

```ts
import { todosFromEvents } from '../../lib/todos-view.ts'
```

2. In the component state (the `useState` at ~line 76), add a `tasksOpen: true` field — and the same field in the scope-reset `setState` call (~line 109). Both objects currently list `processesOpen: true, subagentsOpen: true, endedOpen: false`; insert `tasksOpen: true` after `subagentsOpen: true` in BOTH.

3. Derive the view beside the other memos (~line 83):

```ts
  const todo = useMemo(() => todosFromEvents(events), [events])
  const todoDone = useMemo(() => todo.todos.filter((item) => item.status === 'completed').length, [todo])
  const todoAllDone = todo.todos.length > 0 && todoDone === todo.todos.length
```

4. In the COLLAPSED branch (inside the `{!expanded ? … }` span with the git line and the process/subagent chips, after the `runningAgents` chip block), add:

```tsx
              {!todoAllDone && todo.todos.length > 0 ? (
                <span data-todo-chip className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] font-medium leading-[14px] text-fg-muted" title={`${todoDone}/${todo.todos.length} tasks completed`}>
                  <Icon name="check" size={9} />
                  {todoDone}/{todo.todos.length}
                </span>
              ) : null}
```

5. In the EXPANDED branch, after the Subagents `</section>` and before the closing `</div>`, add the Tasks section (same disclosure idiom as the other sections):

```tsx
            {todo.todos.length > 0 ? (
              <section aria-label="Tasks" className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={state.tasksOpen}
                  onClick={() => setState((prev) => ({ ...prev, tasksOpen: !prev.tasksOpen }))}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
                >
                  <Icon name="check" size={14} className="shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg-muted">Tasks</span>
                  <span className={cn('shrink-0 whitespace-nowrap text-[12px]', todoAllDone ? 'text-ok' : 'text-fg-faint')}>
                    {todoAllDone ? 'Done' : `${todoDone}/${todo.todos.length}`}
                  </span>
                  <Icon name="chevron" size={13} className={cn('shrink-0 text-fg-faint transition-transform', state.tasksOpen ? '' : 'rotate-180')} />
                </button>
                {state.tasksOpen ? (
                  <div className="flex flex-col gap-0.5 pb-1">
                    {todo.todos.map((item, index) => (
                      <div key={index} className="flex items-center gap-2 rounded-lg py-1 pl-2.5 pr-1.5 text-[13px]">
                        {item.status === 'in_progress' ? (
                          <Spinner size={11} />
                        ) : item.status === 'completed' ? (
                          <Icon name="check" size={11} className="shrink-0 text-ok" />
                        ) : (
                          <span className="inline-block size-[11px] shrink-0 rounded-full border border-line" aria-hidden />
                        )}
                        <span className={cn('min-w-0 flex-1 truncate', item.status === 'completed' ? 'text-fg-faint' : 'text-fg')} title={item.status === 'in_progress' ? item.activeForm : item.content}>
                          {item.content}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run web/components/chat/environment-panel.spec.tsx`
Expected: PASS — new tests pass, pre-existing panel tests unaffected (tasks never drive auto-open).

- [ ] **Step 5: Commit**

```bash
git add web/components/chat/EnvironmentPanel.tsx web/components/chat/environment-panel.spec.tsx
git commit -m "feat(web): Tasks section and capsule chip in the environment panel"
```

---

### Task 5: Transcript digest + TaskStatus `Working · <activeForm>`

**Files:**
- Modify: `web/lib/tool-facts.ts` (add a `todowrite` case in the `switch (builtin)`)
- Modify: `web/lib/tool-render.spec.tsx` (append tests)
- Modify: `web/components/chat/TaskStatus.tsx`
- Modify: `web/components/chat/task-status-performance.spec.tsx` (append test)

**Interfaces:**
- Consumes: `todosFromEvents` from Task 3; the `'TodoWrite'` tool name from Task 1 (matched lowercased as `'todowrite'`, the established `builtin` convention in `tool-facts.ts`).
- Produces: tool row with target `7 tasks` and digest `2 done · 1 in progress`; TaskStatus line `Working · <activeForm>` while an item is in_progress.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/tool-render.spec.tsx` (it already imports `toolFacts`; a `row` helper exists there building `ToolItem`s):

```tsx
describe('todowrite rows', () => {
  const todos = [
    { content: 'A', status: 'completed', activeForm: 'Doing a' },
    { content: 'B', status: 'completed', activeForm: 'Doing b' },
    { content: 'C', status: 'in_progress', activeForm: 'Doing c' },
    { content: 'D', status: 'pending', activeForm: 'Doing d' },
  ]

  it('targets the task count and digests progress', () => {
    const running = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, undefined)
    expect(running.target).toBe('4 tasks')
    expect(running.digest).toBeUndefined()

    const done = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, { ok: true, output: 'Todo list updated: 4 tasks (2 completed, 1 in progress, 1 pending)' })
    expect(done.target).toBe('4 tasks')
    expect(done.digest).toBe('2 done · 1 in progress')
  })

  it('keeps the failure excerpt on a failed call', () => {
    const failed = toolFacts({ id: 't1', name: 'TodoWrite', args: { todos } }, { ok: false, output: 'error: every todo needs non-empty …' })
    expect(failed.digestFailed).toBe(true)
  })
})
```

Append to `web/components/chat/task-status-performance.spec.tsx` (reuse that file's existing render helpers and the `ev`-style event builder it uses — adapt names to what the file already has):

```tsx
it('reads Working · <activeForm> while a todo item is in progress', async () => {
  const events = [
    ev('turn/start', { turnId: 't1' }),
    ev('tool/call', { call: { id: 'c1', name: 'TodoWrite', args: { todos: [{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' }] } } }),
    ev('tool/result', { callId: 'c1', ok: true, output: 'Todo list updated: 1 task (1 in progress)' }),
  ]
  await renderStatus({ events, pending: 0, sending: false, connected: true })
  expect(host.textContent).toContain('Working · Running tests')
})
```

(If the file's helpers differ — e.g. it mounts `TaskStatus` directly with `createRoot` — keep its conventions; the assertion is `host.textContent` contains `Working · Running tests` while a `turn/start` is open and the successful TodoWrite names an in-progress item. Without the todo events, the line must still read exactly `Working`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/lib/tool-render.spec.tsx web/components/chat/task-status-performance.spec.tsx`
Expected: FAIL — target is `todos` (generic `toolTarget` fallback), TaskStatus shows plain `Working`.

- [ ] **Step 3: Implement**

`web/lib/tool-facts.ts` — add a case between `'bash'` and `default:` in `switch (builtin)`:

```ts
    case 'todowrite': {
      const todos = Array.isArray(args['todos']) ? (args['todos'] as unknown[]) : []
      fullTarget = `${todos.length} ${todos.length === 1 ? 'task' : 'tasks'}`
      target = fullTarget
      path = undefined
      if (result !== undefined) {
        if (failed) digest = excerpt(result.output)
        else {
          const completed = todos.filter((entry) => (entry as Record<string, unknown> | null)?.['status'] === 'completed').length
          const inProgress = todos.filter((entry) => (entry as Record<string, unknown> | null)?.['status'] === 'in_progress').length
          digest = `${completed} done${inProgress > 0 ? ` · ${inProgress} in progress` : ''}`
        }
      }
      break
    }
```

Note: `args` is `Record<string, unknown>` and `path` was already assigned from `argPath(args)` (always `undefined` for TodoWrite); `path = undefined` keeps the "no file to open" invariant explicit like the Glob/Grep cases.

`web/components/chat/TaskStatus.tsx`:

1. Add the import:

```ts
import { todosFromEvents } from '../../lib/todos-view.ts'
```

2. Derive beside the other memos:

```ts
  const todo = useMemo(() => todosFromEvents(events), [events])
```

3. Replace the phase label render `{LABELS[phase]}` inside the `<strong>` with a computed label defined just above the `return`:

```ts
  const phaseLabel = phase === 'running' && todo.active !== undefined ? `Working · ${todo.active.activeForm}` : LABELS[phase]
```

and in the JSX:

```tsx
          <strong className={busy ? 'font-medium text-shimmer' : 'font-medium text-fg'}>{phaseLabel}</strong>
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run web/lib/tool-render.spec.tsx web/components/chat/task-status-performance.spec.tsx web/lib/todos-view.spec.ts web/components/chat/environment-panel.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/tool-facts.ts web/lib/tool-render.spec.tsx web/components/chat/TaskStatus.tsx web/components/chat/task-status-performance.spec.tsx
git commit -m "feat(web): quiet TodoWrite row digest and Working · activeForm"
```

---

### Task 6: Base prompt guidance

**Files:**
- Modify: `src/harness/context/builder.ts` (only the `DEFAULT_BASE_SYSTEM` constant, ~line 232)
- Create: `tests/harness/base-prompt-guidance.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_BASE_SYSTEM` carries the TodoWrite guidance (workspaces with a prompt override replace it wholesale — accepted per spec).

- [ ] **Step 1: Write the failing test**

Create `tests/harness/base-prompt-guidance.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_SYSTEM } from '../../src/harness/context/builder.ts'

describe('default base prompt', () => {
  it('carries the TodoWrite guidance', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('TodoWrite')
    expect(DEFAULT_BASE_SYSTEM).toContain('in_progress')
    expect(DEFAULT_BASE_SYSTEM).toContain('completed immediately')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/harness/base-prompt-guidance.spec.ts`
Expected: FAIL — no `TodoWrite` in the constant.

- [ ] **Step 3: Edit the constant**

In `src/harness/context/builder.ts` replace:

```ts
export const DEFAULT_BASE_SYSTEM = 'You are dnt-harness, a local coding assistant. Answer helpfully and precisely.'
```

with:

```ts
export const DEFAULT_BASE_SYSTEM = [
  'You are dnt-harness, a local coding assistant. Answer helpfully and precisely.',
  'For complex multi-step work (three or more distinct steps), maintain a task list with the TodoWrite tool: keep exactly one task in_progress at a time, mark tasks completed immediately when they finish, and if work is blocked add a task naming what must be resolved first.',
].join(' ')
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/harness/base-prompt-guidance.spec.ts tests/web/server-system-prompts.spec.ts`
Expected: PASS — the system-prompts spec compares against the `DEFAULT_BASE_SYSTEM` symbol, so it follows the new text automatically.

- [ ] **Step 5: Commit**

```bash
git add src/harness/context/builder.ts tests/harness/base-prompt-guidance.spec.ts
git commit -m "feat(prompts): TodoWrite guidance in the default base prompt"
```

---

### Task 7: Full verification (main thread — NOT a subagent task)

**Files:** none created; verification only.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green. Known unrelated failures per project memory (Windows Bash escaped-descendant tests, intermittent MCP stdio EPIPE) may fail — if and only if a failure matches those documented flaky suites, note it and move on; anything else must be fixed before proceeding.

- [ ] **Step 2: Typecheck and web build**

Run: `npm run typecheck && npm run build:web`
Expected: no errors; `web-dist/` rebuilt.

- [ ] **Step 3: Restart PM2 and live-verify on :3082**

`server.ts` changed, so the PM2 process MUST restart (web build alone is not enough):

```bash
pm2 restart dnt-harness
```

Then, per the live-verify recipe (project-scoped scratch session on :3082 — a legacy `/api/sessions` folder route grants no Bash root):

1. Create a scratch session bound to a test project.
2. Send a prompt that pushes the model through 3+ steps (e.g. "Use TodoWrite to plan and work through: add a scratch file, list the folder, delete it — keep the todo list updated as you go").
3. Verify in the UI:
   - The transcript shows ONE quiet `TodoWrite` row per call with `N tasks` + `x done · y in progress`.
   - The EnvironmentPanel (top-right) shows the Tasks section with the counter and rows; the spinner sits on the in-progress item.
   - While collapsed, the capsule shows the `n/m` chip.
   - The TaskStatus line reads `Working · <activeForm>` during the turn.
4. Capture screenshots for the report.

- [ ] **Step 4: Update docs + memory (main thread)**

- Add a short "TodoWrite task list" section to `docs/capabilities.md` (or `docs/harness.md` if that is where session tools are documented): the tool, the derive-from-log contract, per-session scope, and the compaction caveat.
- Commit docs:

```bash
git add docs/capabilities.md
git commit -m "docs: TodoWrite task list contract"
```

- Update the memory file `dnt-harness-todo-task-list-design.md` to "shipped" status with the commit range.

---

## Self-Review Notes (resolved during planning)

- **Spec coverage:** tool + validation + receipt (Task 1); registration both bins (Task 1); mode exposure + ceiling (Task 2); derive module (Task 3); panel section + chip + no auto-expand + clear (Task 4); quiet row + activeForm (Task 5); base prompt (Task 6); full-suite + live verify + docs (Task 7). Out-of-scope items are listed in the spec and intentionally absent.
- **Type consistency:** `TodoItem`/`TodoView`/`todosFromEvents` named identically in Tasks 3, 4, 5; the tool name string `'TodoWrite'` is matched lowercased as `'todowrite'` in `tool-facts.ts` per that file's existing `builtin` convention.
- **Validation-through-pipeline:** the tool throws for invalid shape; `ToolsService.gate` catches into `ok:false` `error: …` — the tests exercise `execute` directly, so `rejects.toThrow` is the correct assertion form.
