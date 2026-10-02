# Web UI Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dnt-harness web client into a complete product-grade UX/UI (editor-dark Zed style) with stop/delete/rename/thinking support on the backend, keeping the stateless render-from-event-stream architecture.

**Architecture:** Backend first (event vocabulary + stop + REST changes, all covered by existing/new tests), then a full client rewrite under `web/` (components/hooks/lib split), then polish (highlight.js, toasts, hotkeys, mobile drawer), then verify + docs.

**Tech Stack:** TypeScript 5.9, React 19, Vite 6, Vitest 3, hand-written CSS, highlight.js (new dep). Node >= 22.19.

## Global Constraints

- Keep React 19 + Vite + handwritten CSS; no CSS framework/component library. Only new dep: `highlight.js`.
- Dark Zed-style theme only; typed tokens in `web/styles/tokens.css`.
- Client is stateless over the log: new data flows through session events; no client-side model state.
- UI copy Vietnamese with English microcopy for tool/model labels.
- Invariants: model-visible means logged; raw chunks never re-enter history; denied/failing tool = result not exception.
- Domain facts must be close to their events: `assistant/chunk.thinking` is a durable event; `turn/end reason: 'stopped'` is durable.

---

### Task 1: Session event vocabulary + LLM thinking

**Files:**
- Modify: `src/harness/session/events.ts` (chunk field + 'stopped' reason)
- Modify: `src/harness/llm/types.ts` (delta thinking flag)
- Modify: `src/harness/llm/deepseek.ts` (reasoning_content → thinking delta)
- Modify: `src/harness/llm/mock.ts` (script steps may include thinking)
- Test: `tests/harness/llm.spec.ts`, `tests/web/server.spec.ts`

- [ ] Step 1: events.ts — add `readonly thinking?: boolean` to `assistant/chunk`; add `'stopped'` to `TurnEndReason`.
- [ ] Step 2: llm/types.ts — delta event: `{ type: 'delta'; delta: string; thinking?: true }`. Keep `toolCalls` unchanged.
- [ ] Step 3: deepseek.ts — define `StreamChoice.delta.reasoning_content?: string`; yield thinking deltas for it; regular content unchanged.
- [ ] Step 4: mock.ts — `MockScriptStep` gains optional `thinking?: string`; stream thinking first (word deltas, `thinking: true`), then content, then toolCalls.
- [ ] Step 5: Run `npm test` (existing suite must stay green — no switch breaks since fields are optional).

### Task 2: Agent.stop()

**Files:**
- Modify: `src/harness/agent/agent.ts`
- Test: `tests/harness/agent-loop.spec.ts`

- [ ] Step 1: Add `AbortController` per `run()`; new `stop()` method; expose `get busy(): boolean` (status running).
- [ ] Step 2: In `step()`'s chunk loop, after each awaited stream event: `if (this.abortController.signal.aborted)` → throw a private `StopRequested` error. Also check before first chunk.
- [ ] Step 3: In `turn()`, catch `StopRequested` → append `turn/end: 'stopped'` and return (no rethrow). `run()` finally resets status and controller.
- [ ] Step 4: Test: slow recorder provider + agent; assert log ends `turn/end: { reason: 'stopped' }` and no throw.

### Task 3: SessionsService.delete + web REST

**Files:**
- Modify: `src/harness/session/service.ts` (`delete(id)`)
- Modify: `src/web/server.ts` (SessionEntry.customTitle, DELETE/PATCH/stop routes, titleOf override, findSession)
- Test: `tests/web/server.spec.ts`

- [ ] Step 1: `delete(id)` removes from map.
- [ ] Step 2: Server — `SessionEntry.customTitle?`; listing returns `title: customTitle ?? derived`; add routes:
  - `DELETE /api/sessions/:id` → 200 `{ deleted: true }` (404 unknown)
  - `PATCH /api/sessions/:id` body `{ title }` → 200 `{ id, title }` (trimmed; empty = reset to derived; non-string → 400)
  - `POST /api/sessions/:id/stop` → 202 `{ stopped: true }` (404 unknown)
- [ ] Step 3: Tests: delete → 404 on events + gone from listing; patch title + reset; stop on a running slow provider yields `turn/end: stopped`.

### Task 4: Client types + projection

**Files:**
- Modify: `web/types.ts`, `web/lib/project.ts` (from `web/project.ts`)
- Test: `npm run typecheck` + `npx vitest run` (server tests import dnt-harness types only)

- [ ] Step 1: `SseEvent` — `thinking?: boolean` on chunk-shaped events; `SessionListing` unchanged.
- [ ] Step 2: `project.ts` — ViewItem assistant gains `thinkingLines: string[]` + `thinkingLive: boolean`; tool item `doneAt?: number`; export `isTurnRunning(events)` (open turn/start without turn/end).

### Task 5: Client structure + hooks

**Files:**
- Create: `web/components/…`, `web/hooks/…`, `web/styles/…`, `web/lib/api.ts`, `web/lib/format.ts`
- Rewrite: `web/App.tsx`
- Modify: `web/main.tsx`, `package.json` (highlight.js dep)

- [ ] Step 1: Split at the borders specified in the design doc (layout/session/chat/composer/common components; useSessionStream, useAutoScroll, useHotkeys, useIsRunning hooks; api + format libs).
- [ ] Step 2: `App.tsx` owns sessions/current/events list via `useSessionStream`; toasts via `ToastHost`; Ctrl/Cmd+K new session; Esc closes dialogs.
- [ ] Step 3: Sidebar: brand, new session, filter input, SessionRow hover actions (rename inline + delete confirm), footer status.
- [ ] Step 4: Composer: autosize, Enter/Shift+Enter, Stop button when `isTurnRunning`, disabled while connecting.
- [ ] Step 5: Transcript: ThinkingPanel (collapse), user bubble, assistant message with hover actions (copy, resend), ToolCardWide (expand, duration, verdict), StatusLine, JumpToBottom on scroll-up.
- [ ] Step 6: ApprovalBar above composer; toasts for API/SSE errors replacing the error bar.

### Task 6: CSS system

**Files:**
- Create: `web/styles/tokens.css`, `base.css`, `layout.css`, `sidebar.css`, `chat.css`, `composer.css`, `components.css`
- Delete `web/App.css` (imports removed).
- Modify `web/Markdown.tsx` → syntax highlight (hljs core + ts/tsx/js/json/bash/yaml/css/md) with custom token colors, copy button preserved; mobile drawer (<760px).

- [ ] Step 1: tokens (palette from existing App.css: bg `#141517`, elevated `#1a1b1e`, accent `#5c7cfa`, ok `#4cc38a`, bad `#f47067`, amber `#d29922`) + spacing scale + radii + fonts.
- [ ] Step 2: shell/layout grid; sidebar drawer on mobile behind hamburger; chat pane layout (header/toolbar/transcript/composer).
- [ ] Step 3: all component styles (bubbles, thinking, tool cards, approvals, toasts, code blocks/hljs theme, buttons, focus rings); `prefers-reduced-motion` respect.
- [ ] Step 4: build check `npm run build:web` + `npm run typecheck` clean.

### Task 7: Verification + docs

- [ ] Step 1: `npm test` (all suites), `npm run typecheck`, `npm run build:web` all green.
- [ ] Step 2: Update `docs/web.md` (new endpoints, thinking field) and `README.md` status line.
