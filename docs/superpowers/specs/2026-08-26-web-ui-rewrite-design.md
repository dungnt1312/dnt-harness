# dnt-harness web UI rewrite — design

Date: 2026-08-26 · Status: approved

## Goal

Turn the current workable-but-bare web client into a complete, product-grade
UX/UI while keeping the "editor-dark, Zed/VS Code spirit" visual direction and
the stateless render-from-event-stream architecture. Client and backend may
both change; the session log stays the single source of truth.

## Constraints

- Keep React 19 + Vite + hand-written CSS (no CSS framework, no component
  library). New dependency: `highlight.js` (syntax highlighting only).
- Keep the Zed-style dark theme as the only theme (no light mode).
- UI copy stays Vietnamese with English microcopy for tool/label names.
- The client holds no model state: everything visible is projected from the
  durable session events. New backend fields must flow through the log.
- The three harness invariants are untouched: model-visible means logged;
  raw chunks never re-enter history; a denied/failing tool is a result, not
  an exception.

## Backend changes

### 1. Session event vocabulary (`src/harness/session/events.ts`)

- `assistant/chunk` gains an optional `thinking?: boolean` field: thinking
  deltas are logged but never enter model history (`deriveMessages` ignores
  them, like `assistant/chunk` itself).
- `TurnEndReason` gains `'stopped'` — a user-initiated stop closes the turn
  durably with this reason (a lift of `run()` returning, not a failure).

### 2. LLM seam (`src/harness/llm/types.ts`)

`StreamEvent` delta union gains `{ type: 'delta'; delta: string; thinking?: true }`.
- `DeepSeekProvider`: map `delta.reasoning_content` to thinking deltas;
  internal history never receives them.

### 3. Agent stop (`src/harness/agent/agent.ts`)

- `Agent` creates an `AbortController` per `run()` and exposes `stop()`;
  the step's chunk loop checks `signal.aborted` between chunks and stops the
  turn with `turn/end: 'stopped'` (no exception propagates).
- A stop while idle is a no-op; the tool pipeline is unaffected (in-flight
  approval questions stay unanswered until the UI dismisses them).

### 4. Sessions service (`src/harness/session/service.ts`)

- `delete(id)` — removes a session; `get` after delete throws (existing
  fail-loud behavior).

### 5. Web API (`src/web/server.ts`)

| Method | Route | Body | Returns |
|---|---|---|---|
| `DELETE` | `/api/sessions/:id` | — | `{ deleted: true }` / 404 |
| `PATCH` | `/api/sessions/:id` | `{ title }` | `{ id, title }` / 400 / 404 |
| `POST` | `/api/sessions/:id/stop` | — | `{ stopped: true }` / 404 |

- `SessionEntry` gains `customTitle?: string`; listing uses it over the
  derived title. `PATCH` resets to derived when `title` is empty.

## Client rewrite (`web/`)

```
web/
├── index.html / main.tsx        — entry
├── App.tsx                      — shell: sidebar + chat pane; owns sessions/current/events
├── styles/                      — tokens.css (vars), base.css (reset, scrollbars, focus),
│                                  layout.css, sidebar.css, chat.css, composer.css,
│                                  components.css (tool cards, approvals, toasts, code blocks)
├── components/
│   ├── layout/   Sidebar (brand, new session, search, SessionList, footer status)
│   ├── session/  SessionList, SessionRow (hover actions: rename, delete), NewSessionBtn
│   ├── chat/     ChatHeader (title, model select, folder, conn status),
│   │             Transcript, UserBubble, AssistantMessage (thinking panel, copy,
│   │             tool call chips), ThinkingPanel, ToolCardWide (expandable, duration),
│   │             StatusLine, JumpToBottom, ApprovalBar
│   ├── composer/ Composer (autosize, Enter/Shift+Enter, stop button), StopButton
│   └── common/   Icon (inline SVG set), Spinner, Toast + ToastHost, ConfirmDialog,
│                 Kbd, Tooltip(optional)
├── hooks/        useSessionStream (SSE + snapshot, seenSeq), useAutoScroll,
│                useHotkeys (Ctrl/Cmd+K new session, Esc dismiss), useIsRunning
└── lib/
    ├── api.ts    — typed fetch wrappers + new delete/rename/stop
    ├── types.ts  — SseEvent extension (thinking), envelope, listing, meta
    ├── project.ts — events → ViewItem (thinking accumulation, tool durations)
    └── format.ts — time, duration, args summary helpers
```

### View projection additions (`project.ts`)

- Assistant item accumulates `thinking` lines; `assistant/message` finalizes
  (thinking stays collapsed until the user expands).
- Tool item records `ts` (call) and `doneAt` (result) → duration chip.
- `isTurnRunning(events)` — last `turn/start` has no matching `turn/end`
  (derived from the log; the Stop button and spinner read this).

### UX features

- Thinking panel: collapsible, mono, dim; spinner while live.
- Tool cards: header summary (glyph, name, args, verdict + duration) with
  expand/collapse output; failed shown red; pending spinner.
- Message actions (hover): copy assistant text, resend last user message
  (via existing message API), show timestamps.
- Composer: autosize (max 160px), Enter send / Shift+Enter newline, disabled
  while not connected, Stop button replaces Send while a turn runs.
- Session list: filter input, hover rename (inline prompt) + delete
  (confirm dialog), active indicator, event count.
- Toasts (bottom-right) for API errors and SSE errors; no blocking bars.
- Keyboard: Ctrl/Cmd+K → new session, Esc → close dialog / cancel editing.
- Code blocks: highlight.js (core + ts/tsx/js/jsx/json/bash/yaml/css/md
  languages), custom dark token theme matching the palette; copy preserved.
- Mobile (<760px): sidebar becomes an overlay drawer behind a hamburger;
  toolbar collapses to model select only; transcript width shrinks.

## Testing

- `tests/web/server.spec.ts`:
  - DELETE then 404 on events/stop; PATCH title listed; empty title resets.
  - stop: slow-streaming recorder provider → POST stop → `turn/end: stopped`;
  - thinking: mock step with thinking content → `assistant/chunk.thinking`
    frames observed.
- Existing kernel/harness tests stay green (events union extension only adds
  optional fields and one reason variant; `assertNever` switches compile).
- Client: typecheck + `vite build` (no component test infra in repo).

## Docs

- `docs/web.md`: document the three new endpoints and the thinking
  event field; `README.md` status note.
