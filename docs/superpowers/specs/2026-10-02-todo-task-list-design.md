# Todo-Style Task List (TodoWrite) — Design

Date: 2026-10-02
Status: Approved (brainstorming session, design approved by user)
Reference: Claude Code `TodoWrite` tool description and [todo tracking docs](https://code.claude.com/docs/en/agent-sdk/todo-tracking)

## Problem

mini-dsh has no way for the model to maintain a visible task list while working
through multi-step requests. Claude Code keeps a written todo list the user can
watch update in real time; the model uses it to plan complex work and stay on
track. The EnvironmentPanel spec (2026-10-01) listed "plan/task section" as an
explicit follow-up waiting for a data source — this design is that follow-up.

## Decisions (from the brainstorming dialogue)

1. **Model**: TodoWrite-style, NOT the newer Task tools. One tool, full-list
   replacement per call, per-session state. No dependencies, no cross-session
   sharing (those are the Tasks system; YAGNI for v1).
2. **UI surface**: the EnvironmentPanel gets a Tasks section — not a transcript
   card, not a workbench tab.
3. **Transcript behavior**: quiet. The tool renders as the standard one-line
   tool row with a purpose-built digest; no checklist card. The active item's
   `activeForm` shows on the TaskStatus line while working.
4. **State flow**: derive from existing durable `tool/call` events. No new
   event kind, no registry, no changes to `src/harness/session/events.ts`.

## Architecture

```
TodoWrite tool (stateless, per-session)
        │  writes the full list; state IS the durable log
        ▼
tool/call + tool/result events (already durable)  ──SSE snapshot──▶  web
        │                                                            │
        │                                                todos-view.ts (derive)
        │                                                            ▼
Model sees its own calls in history        EnvironmentPanel Tasks section
via deriveMessages() — no injection        + capsule chip + TaskStatus activeForm
```

There is deliberately no second store: the full list rides in every call's
arguments, the log is already durable, and the SSE snapshot already rehydrates
it after a restart. Anything the model needs to remember it re-reads from its
own history, exactly like Claude Code does.

## Backend: the `TodoWrite` tool

- New file `src/harness/tools/todo.ts` — factory `todoWriteTool(): ToolDefinition`,
  stateless. Registered in `src/web/server.ts` (beside the memory tools) and
  `src/bins/headless.ts`.
- Schema (Claude-exact):

  ```json
  { "todos": [ { "content": "Run tests", "status": "pending", "activeForm": "Running tests" } ] }
  ```

  - `content` — imperative task description.
  - `status` — `pending | in_progress | completed`.
  - `activeForm` — present-continuous form shown while the task runs.
  - All three fields required per item; `todos` required (an empty array clears
    the list, matching Claude's "remove tasks that are no longer relevant").
- **Full replacement semantics**: every call replaces the whole list.
- Validation (tool-level, `ok:false` output — never throws):
  - `todos` must be an array; each item an object with the three fields.
  - `status` must be one of the three enum values.
  - `content`/`activeForm` must be non-empty strings.
  - Hard cap 100 items; a longer list fails with an actionable message.
- Success receipt the model sees:

  `Todo list updated: 7 tasks (2 completed, 1 in progress, 4 pending)`
  (`Todo list cleared` for an empty array; singular/plural aware).
- `requiresRoot: false` — the tool touches no workspace path. Root sessions and
  subagents both get it; each session's list is its own (a child's list never
  appears in the root's panel).
- **Behavioral rules are prompt guidance, not enforcement**: the harness does
  not reject two `in_progress` items or a skipped item, mirroring Claude Code.
  The tool description carries the rules (see System prompt below).

## Mode exposure

In `src/harness/modes/bundled.ts`:

- Add `'TodoWrite'` to the `toolExposure` list of **all four bundled modes** —
  it has no workspace side effect, so even Plan mode may track planning steps.
- Add `TodoWrite: 'allow'` to every mode's `permissionDefaults` (same reasoning
  as `BashOutput`/`KillShell`: touches only the session's own state).
- Add `'TodoWrite'` to `KNOWN_MODE_TOOLS` (the exposure ceiling).
- Custom workspace modes are NOT auto-granted the tool (consistent with how
  `BashOutput`/`KillShell` shipped).

## Web: deriving the list

- New module `web/lib/todos-view.ts`:

  ```ts
  todosFromEvents(events: readonly SseEvent[]): { todos: readonly TodoItem[]; active?: TodoItem }
  ```

  - Scan events in order; for every `tool/call` named `TodoWrite`, find the
    paired `tool/result` by `callId`. The current list comes from the LAST call
    whose result exists and is `ok:true` (a failed/denied call changes nothing).
    Parse `args.todos` of that call.
  - `active` is the first item with `status: 'in_progress'`, if any.
  - No GET API: the SSE snapshot already carries full history from connection
    open, so reopen/restart rehydrates for free.
- `SseEvent.type` is already a plain `string` pass-through, so no web type
  changes are needed for this.

## EnvironmentPanel UI

- New **Tasks** section (below Subagents), rendered only when a list exists:
  - Header row: `Tasks` label + counter `<completed>/<total>` (e.g. `2/7`;
    `Done` when every item is completed).
  - Item rows in list order: spinner for `in_progress`, check icon + faint text
    for `completed`, empty circle for `pending` — the same visual idioms as
    `ProcessLine`/`SubagentLine`. Text is the item's `content`.
- **Collapsed capsule**: a small `<completed>/<total>` chip (e.g. `2/7`)
  appears when a list exists and is not fully completed — same slot as the
  process/subagent chips.
  The panel does NOT auto-expand because of tasks; the chip is the glance, the
  section is the detail. This is deliberately quieter than the process/subagent
  auto-open (tasks are not "live infrastructure", they are progress).
- Clearing the list (empty `todos` array) removes the section and the chip.

## Transcript row + TaskStatus

- `web/lib/tool-facts.ts` gains a `todowrite` case: target `7 tasks`, digest
  `2 done · 1 in progress` (a failed call keeps the standard error excerpt).
  The row stays a standard one-line tool row — no custom card.
- **TaskStatus** (`web/components/chat/TaskStatus.tsx`): while the phase is
  `running` and a todo item is `in_progress`, the line reads
  `Working · <activeForm>` (e.g. `Working · Running tests`). The EnvironmentPanel
  header's `Working·<elapsed>` timer is unchanged.

## System prompt

- `DEFAULT_BASE_SYSTEM` (`src/harness/context/builder.ts`) gains a short
  TodoWrite guidance block, Claude-style:
  - Use for complex multi-step tasks (3+ distinct steps) or explicit user
    requests; skip for trivial single-step work.
  - Exactly one item `in_progress` at any time; mark `completed` immediately
    when done (never batch).
  - Blocked or errored: keep the item `in_progress` and add a new item naming
    what must be resolved. Remove items that are no longer relevant.
- Per-workspace prompt overrides replace the whole base prompt, so overridden
  workspaces do not see this guidance until their owner adds it — accepted.

## Error handling

- Validation failure → `ok:false` with the specific reason; the model corrects
  and retries. List state unchanged (only successful calls matter to the UI).
- Mode/policy denial → the standard `denied:` row; list unchanged.
- Server restart mid-turn → nothing to lose: state is the log; the panel
  rehydrates from the snapshot.
- Compaction may summarize older tool calls away, so the model can lose sight
  of an old list — accepted for v1 (Claude Code has the same property without
  its task-reminder injection). Follow-up option: re-inject the current list
  into context after a compaction checkpoint.

## Testing

- **vitest backend** (`tests/harness/`): tool validation (happy path, each
  invalid shape, cap 100, empty-array clear, receipt wording), registration in
  both bins, mode exposure — `TodoWrite` allowed and exposed in all four
  bundled modes, `KNOWN_MODE_TOOLS` updated.
- **vitest web**: `todos-view.spec.tsx` (no calls → empty; failed call then ok
  call → last-ok-wins; multiple ok calls → last wins; call without result yet
  → previous list stands); `environment-panel.spec.tsx` (section renders rows
  and counter, chip on capsule, no auto-expand, clear removes section);
  `tool-facts` spec gains the `todowrite` case; TaskStatus activeForm spec.
- **Live verification** on :3082 per the existing recipe: run a turn that uses
  TodoWrite (test session, project-scoped scratch), watch the Tasks section,
  the capsule chip, and the `Working · <activeForm>` line.

## Out of scope (explicit follow-ups)

- Task tools (`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`), dependencies,
  cross-session shared lists, per-owner assignment.
- User-side todo editing in the panel (manual add/check/clear).
- Context re-injection of the list after compaction.
- Surfacing child sessions' todo lists anywhere.
