---
phase: 3
title: "A free-form brief"
status: todo
priority: P1
effort: "3h"
dependencies: [0, 1]
---

# Phase 3: A free-form brief

## Overview

Let the root brief a child in prose. `TaskPacket`'s four fields force the root to
compress what it knows into `objective` / `constraints[]` / `references[]` /
`requiredResult`, which is a form, not a briefing. Add `prompt` as the primary path and
keep the four fields working for the HTTP route and the existing tests.

<!-- Updated: Validation Session 1 - durable events carry brief with legacy objective readers; SpawnError('packet') semantic validation; HTTP maps packet to 400; caller counts corrected to 13 + session-model -->

## Requirements

Functional:

- `TaskPacket` accepts `prompt`: free-form text the child receives as its brief.
- `prompt` **or** `objective` is required; both present means `prompt` is the brief and
  `objective` is ignored with a note in the spawn result.
- **The brief is durable.** `session/child-meta` and `agent/child-spawn` carry `brief`.
  One `normalizeBrief(packet)` helper selects the trimmed, non-empty `prompt` first and
  otherwise the trimmed, non-empty `objective`; both `renderPacket` and durable event
  writers use that exact normalized string. Readers and projectors accept legacy
  events that only have `objective`, so old logs keep projecting; writers always emit
  `brief`. Consumers to update in this phase:
  `src/harness/session/events.ts` (the event union at `events.ts:46-47` and its
  renderer switch), `web/lib/project.ts` (the `agent/child-spawn` projection at
  `project.ts:245`), `web/lib/types.ts`, `web/components/chat/MessageParts.tsx`
  (delegation row detail), and the browser fixtures that synthesize these events
  (`tests/browser/chat-workflows.e2e.ts` carries `objective:` in a fixture).
- `requiredResult` remains meaningful and is always rendered — it is the one field
  phase 1 and 2 made load-bearing (the child now knows its final message must match it).
- Packet semantics are validated in **one** place: `ChildExecutor.spawn` raises a typed
  `SpawnError('packet')` when neither `prompt` nor `objective` is non-empty (the
  `SpawnError` code union widens from `'capacity' | 'depth'` to include `'packet'`).
  The `Agent` tool and the HTTP route only parse shape; the tool surfaces the typed
  error as its normal tool failure, and the HTTP route maps `SpawnError('packet')` to
  **400** (its existing mapping sends `'capacity'` to 429 and other codes to 404).
- The `Agent` tool's schema documents `prompt` first; `objective`, `constraints`,
  `references` stay accepted and undocumented-as-primary.
- The HTTP route `POST /api/workspaces/:ws/agents/:name` (`src/web/server.ts:2145-2217`)
  keeps accepting the existing `task: { objective, constraints, references,
  requiredResult }` body unchanged, and additionally accepts
  `task: { prompt, requiredResult }`.
- The tool description tells the model to write a brief the way it would brief a
  colleague who cannot see the conversation.
- The Workbench spawn form in `AgentRunsPanel` makes `prompt` the primary field. A
  textarea labeled as the brief replaces the current required Objective input.
  `objective`, `constraints`, `references`, and `requiredResult` stay inside the existing
  "Task packet details" disclosure. Spawn enables when `prompt` or `objective` is
  non-empty. Submitting a prompt sends `task.prompt` (and `requiredResult` when set).
  Submitting only the structured fields keeps today's four-field body. This form does not
  gain an inherit control; that is phase 4 and defaults to off.

Non-functional:

- One renderer. `renderPacket` handles both shapes; no branch duplicated in the tool and
  the route.
- One validator. Spawn owns "prompt or objective"; the tool and the route stay thin.
- No change to the spawn lifecycle, capacity accounting, or model resolution.

## Architecture

`src/harness/agents/executor.ts`:

```ts
export interface TaskPacket {
  /** The brief, in prose. Preferred over the structured fields. */
  readonly prompt?: string
  readonly objective?: string
  readonly constraints?: readonly string[]
  readonly references?: readonly string[]
  readonly requiredResult: string
}
```

`objective` becomes optional. Add `normalizeBrief(packet): string | undefined`, which
returns a trimmed non-empty `prompt`, otherwise a trimmed non-empty `objective`, otherwise
`undefined`. `spawn` calls it once and raises `SpawnError('packet')` when it returns
`undefined` — the executor's existing typed spawn failure (`executor.ts:75-82`), whose
code union gains `'packet'`. The normalized string is then reused for rendering and both
durable events, so empty-string inputs cannot diverge across runtime and storage.

`renderPacket` (`executor.ts:524-536`) after phase 1 removed the definition block:

```ts
function renderPacket(packet: TaskPacket, brief: string): string {
  if (packet.prompt?.trim() === brief) {
    return [brief, '## Required result', packet.requiredResult].join('\n\n')
  }
  return [
    '## Task', brief,
    ...(packet.constraints?.length ? ['## Constraints', ...packet.constraints.map((c) => `- ${c}`)] : []),
    ...(packet.references?.length ? ['## References', ...packet.references.map((r) => `- ${r}`)] : []),
    '## Required result', packet.requiredResult,
  ].join('\n\n')
}
```

Note the second change: empty `constraints` / `references` no longer emit a bare heading
or the `- (none)` filler the current renderer produces (`executor.ts:531-532`). A child
should not receive empty sections.

The `definition` parameter drops from the signature — phase 1 removed its only use.

`src/web/agent-delegation.ts`:

- `PARAMETERS.properties.prompt` added, described as the primary brief.
- `objective`'s description marked as the alternative structured form.
- The tool-boundary check at `agent-delegation.ts:235-236` becomes a shape check only;
  the "prompt or objective" semantic lives in `spawn`'s `SpawnError('packet')`.
- `spawn`'s JSON result adds `note` when both were supplied.
- `describe()` gains one sentence: brief the child as you would a colleague who cannot
  see this conversation; name the files and the facts it needs.

`src/web/server.ts` — the POST agents route (`server.ts:2145-2217`): accept `prompt`
from the body alongside the existing fields; extend the `SpawnError` mapping there
(`server.ts:2202-2203`) so `'packet'` returns 400 while `'capacity'` keeps 429 and the
rest keep 404. No other change.

The durable events: `session/child-meta` and `agent/child-spawn` append the same
normalized `brief` returned by `normalizeBrief` (both events currently carry `objective`,
`executor.ts:244` and `executor.ts:253`). Readers use `event.brief ?? event.objective`
so logs written before this phase keep projecting.

## Related Code Files

- Modify: `src/harness/agents/executor.ts` — `TaskPacket`, `renderPacket`,
  `SpawnError('packet')`, the durable event payloads
- Modify: `src/harness/session/events.ts` — `session/child-meta` / `agent/child-spawn`
  gain `brief` (optional on read, emitted by writers)
- Modify: `web/lib/project.ts` — the `agent/child-spawn` projection reads
  `brief ?? objective`
- Modify: `web/lib/types.ts`, `web/components/chat/MessageParts.tsx` — delegation row
  detail follows the projection
- Modify: `src/web/agent-delegation.ts` — schema, shape check, description, spawn result
  note
- Modify: `src/web/server.ts` — the POST agents route body and the `SpawnError` → 400
  mapping
- Modify: `web/components/workbench/AgentRunsPanel.tsx` — the human spawn form gets a
  prompt textarea alongside the structured fields
- Modify: `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts`,
  `tests/web/server-session-model.spec.ts` (route caller)
- Modify: `tests/browser/chat-workflows.e2e.ts` — the fixture `agent/child-spawn` gains
  `brief` (or the fixture helper emits both shapes)
- Modify: `docs/capabilities.md`, `docs/web.md` — the brief shapes

## Implementation Steps

1. Widen `TaskPacket`; make `objective`, `constraints`, `references` optional. Typecheck
   and fix every construction site the compiler names.
2. Add `normalizeBrief`; use it once in `spawn`, raise `SpawnError('packet')` when it
   returns `undefined`, and pass the normalized string to `renderPacket` and durable
   event writers. Widen the error-code union; the tool and HTTP keep shape checks only.
3. Rewrite `renderPacket` for both shapes, drop the `definition` parameter, accept the
   normalized brief, and remove the empty-section filler.
4. Add normalized `brief` to the `session/child-meta` and `agent/child-spawn` payloads and
   the `brief ?? objective` read path; update the projection, types, delegation detail,
   and fixtures.
5. Add `prompt` to the tool schema and the description sentence.
6. Accept `prompt` in the HTTP route body and map `SpawnError('packet')` to 400.
7. Make the panel's primary field the prompt textarea. Move Objective into the
   disclosure. Enable Spawn when prompt or objective is non-empty, and send `task.prompt`
   when the brief is filled.
8. Extend the specs; the existing four-field call sites must stay green untouched.
9. Update `docs/capabilities.md` and `docs/web.md`.

## Success Criteria

- [ ] `Agent({action:'spawn', definition:'explorer', prompt:'…'})` spawns and the child's
      first user message is that prose plus the required-result section.
- [ ] A spawn with neither `prompt` nor `objective` fails with a `SpawnError('packet')`
      whose message names both fields; the tool and an HTTP POST both surface it
      (the route as 400).
- [ ] A spawn with both uses `prompt` and says so in the result `note`.
- [ ] All 13 existing `task: { objective… }` HTTP calls in `tests/web/server-g4.spec.ts`
      and the one in `tests/web/server-session-model.spec.ts` pass without edits.
- [ ] A packet with empty `constraints` and `references` renders no `## Constraints`
      heading and no `- (none)` line.
- [ ] The HTTP route accepts `task: { prompt, requiredResult }` and returns 202.
- [ ] New durable child logs carry `brief`; a log written before this phase (only
      `objective`) still projects and renders in the delegation detail.
- [ ] The panel's spawn form submits a prose brief without filling Objective, and still
      submits the four-field packet from the disclosure.
- [ ] `npm run typecheck` and the g4 harness + web suites pass.

## Risk Assessment

**Two brief shapes is two code paths to keep honest.** *Signal:* a fix applied to one
shape and not the other. *Response:* one renderer, one validation site — the phase is
written so there is no second place to forget. If a third shape is ever proposed, deprecate
the structured form instead.

**Making `objective` optional breaks a caller the compiler misses** (a JSON body, a test
fixture). *Signal:* a runtime `undefined` in a rendered brief. *Response:* the renderer
falls back to `''` and the spawn validation rejects before rendering, so the failure is a
readable tool error, not a malformed prompt.

**The model keeps using the structured form out of habit** because the description still
lists it. *Signal:* spawns with `objective` and no `prompt` after the change. *Response:*
acceptable — both work. If the structured form measurably produces worse briefs, drop it
from the tool schema in a follow-up and keep it only on the HTTP route.
