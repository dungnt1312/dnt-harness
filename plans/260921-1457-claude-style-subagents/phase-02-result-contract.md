---
phase: 2
title: "The result contract"
status: todo
priority: P1
effort: "3h"
dependencies: [0, 1]
---

# Phase 2: The result contract

## Overview

The parent receives the child's **answer** — its final message — or an honest statement
that there was none. Stop concatenating narration, stop truncating from the front, and
stop pretending an argument scrape is a file-reference list.

<!-- Updated: Validation Session 1 - result = last tool-free message; no-result cases and resultComputed sentinel; filesTouched = Read/Write/Edit only; truncation surfaced in Workbench and chat; consumer list extended -->

## Requirements

Functional:

- `ChildHandle.result` carries the child's **last non-empty `assistant/message` that
  carries no `toolCalls`**, not a concatenation. A message that also declares tool calls
  is narration accompanying tool use, never the deliverable.
- Only a **completed** child may have a `result`:
  - A `cancelled`, `failed`, or `interrupted` child has **no** `result` and an `error`
    that says so and points at its full durable log (the session id every handle
    already carries).
  - A **completed** child with no qualifying terminal message also has no `result` and an
    explicit `error` saying it produced no final report, with the same full-log pointer.
  - The outer detached-runner catch currently sets status but can leave `failure` empty;
    this phase must set it on every failed path before exposing the handle.
- The result-or-error derivation is memoized: an internal `resultComputed` sentinel on
  the internal child marks the digest as computed even when `result` is `undefined`, so
  a settled child is derived from its log exactly once either way.
- Truncation is explicit and marked, using the repo's existing
  `… [truncated N chars]` convention plus a `truncated: true` flag, and the cap is
  raised from 4 000 to a named constant well under `toolOutputLimit` (60 000). Both the
  Workbench child card and the chat delegation detail render the marker and the flag.
- The argument-derived path list is renamed to what it actually is — **files touched** —
  and extracted per tool name rather than by blind `args['path']`:
  `Read`/`Write`/`Edit` → `args.path`. `Glob` contributes nothing (it has no path
  argument, `src/capabilities/fs/tools.ts:343`) and `Grep`'s `args.path` is a
  *directory* scope (`tools.ts:370`), so both are omitted entirely — the list is files,
  not scopes.
- Real file *references* come from the child's own report, which phase 1's preamble now
  instructs it to include. The digest never claims to derive them.
- Every handle keeps `childSessionId`, which is the pointer to the full durable log for
  anyone who wants the narration.

Non-functional:

- `withResult` stays pure over `child.events`; no new I/O.
- The memoization at `executor.ts:478` is **replaced** by the `resultComputed`
  sentinel: the current `child.result === undefined && status !== 'running'` guard
  recomputes a completed child's missing result on every call.

## Architecture

Replace `ChildExecutor.withResult`'s digest block (`src/harness/agents/executor.ts:477-489`).

Current:

```ts
for (const event of child.events) {
  if (event.type === 'assistant/message' && event.content.trim() !== '') summary.push(event.content.trim())
  if (event.type === 'tool/call') {
    const filePath = event.call.args['path']
    if (typeof filePath === 'string') files.add(filePath)
  }
}
child.result = { summary: summary.join('\n\n').slice(0, 4_000), fileReferences: [...files].slice(0, 20) }
```

Target shape:

```ts
const MAX_REPORT_CHARS = 16_000
const MAX_FILES_TOUCHED = 40

/** Tools whose `path` argument names a FILE the child worked on. */
const FILE_ARG_TOOLS = new Set(['Read', 'Write', 'Edit'])
```

- Walk the events **backwards** for the first `assistant/message` whose trimmed content
  is non-empty **and** which carries no `toolCalls`. That is the report.
- Walk forwards for `tool/call` events, collecting `args.path` only for
  `FILE_ARG_TOOLS`. `Glob` and `Grep` are skipped by construction.
- Truncate the report to `MAX_REPORT_CHARS` with an explicit marker and set
  `truncated: true`.

Updated `ChildHandle.result` type:

```ts
readonly result?: {
  /** The child's FINAL message — its whole deliverable. */
  readonly report: string
  /** Files the child read or wrote, from tool arguments. Not a claim about
   *  everything it found: discovered paths live in `report`. */
  readonly filesTouched: readonly string[]
  readonly truncated?: boolean
}
```

This renames `summary` → `report` and `fileReferences` → `filesTouched`. The known
consumers:

- `src/web/agent-delegation.ts` — `wait` / `list` / `cancel` serialize handles whole, so
  they pick the rename up for free.
- `src/web/server.ts` serialization endpoints — `childrenOfRoot` (`server.ts:2225`) and
  the child wait/cancel routes — pass handles through as JSON.
- `web/lib/api.ts` — `fetchChildren` / `waitChild` / `cancelChild` (`api.ts:603-616`)
  and the `ChildRow` type they return.
- `web/lib/types.ts` — the child handle type (`types.ts:249`).
- `web/components/workbench/AgentRunsPanel.tsx` and
  `web/components/chat/MessageParts.tsx` — the Workbench child card and the chat
  delegation detail both render the digest; both need the field rename, and both must
  show the truncation marker and flag.
- `tests/harness/g4-agents.spec.ts` and `tests/web/server-g4.spec.ts` assert on
  `result.summary`.
- `tests/browser/chat-shell.e2e.ts` routes a fixture child result with
  `result: { summary, fileReferences }` (line 109).
- `docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md` describes
  the child card digest; update it with the rename.

### The failure and absence cases

- A `cancelled` / `failed` / `interrupted` child: leave `result` absent and ensure
  `error` names the situation and the full log:

  > `the child did not complete; its full log is session <id>`

  `withResult` surfaces `child.failure` as `error` (`executor.ts:498`), so every
  cancellation/failure path — including the outer detached-runner catch that currently
  only changes status — must populate `failure` before the handle is exposed.

- A **completed** child with no qualifying terminal message: leave `result` absent and
  set an explicit failure such as:

  > `the child produced no final report; its full log is session <id>`

  Mark the derivation computed via the `resultComputed` sentinel so the log is scanned
  once. A cancelled child mid-narration and a silently-empty completed child therefore
  both report honestly instead of handing back or fabricating a deliverable.

## Related Code Files

- Modify: `src/harness/agents/executor.ts` — `ChildHandle.result`, `withResult`,
  `resultComputed` sentinel, terminal-failure error text
- Modify: `web/lib/types.ts` — the child handle type
- Modify: `web/lib/api.ts` — `ChildRow` / child fetch helpers if the type is duplicated
  there
- Modify: `web/components/workbench/AgentRunsPanel.tsx` — render `report` /
  `filesTouched` / the truncation flag
- Modify: `web/components/chat/MessageParts.tsx` — the delegation detail renders the
  same fields
- Modify: `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts`
- Modify: `tests/browser/chat-shell.e2e.ts` — the fixture child result shape
- Modify: `web/components/workbench/agent-runs.mounted.spec.tsx` (untracked, already on
  this branch) if it asserts on the digest
- Modify: `docs/harness.md`, `docs/capabilities.md` — the result contract
- Modify: `docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md` —
  the child card digest description

## Implementation Steps

1. Add the constants and `FILE_ARG_TOOLS` to `executor.ts`.
2. Rewrite the digest block: backwards scan for the report (non-empty, no `toolCalls`),
   forwards scan for `filesTouched`, explicit truncation marker and flag.
3. Change the `ChildHandle.result` type; run `npm run typecheck` and let it list every
   consumer.
4. Implement the `resultComputed` sentinel and the terminal-state error text.
5. Update `web/lib/types.ts`, `web/lib/api.ts`, `AgentRunsPanel.tsx`, and
   `MessageParts.tsx` for the rename and the truncation flag.
6. Update the harness, web, and browser specs; add the new cases from Success Criteria.
7. Update `docs/harness.md`, the `docs/capabilities.md` Agent section, and the warm
   studio design doc.

## Success Criteria

- [ ] A child emitting messages `"checking A"`, `"checking B"`, `"Answer: X"` reports
      exactly `"Answer: X"`.
- [ ] An `assistant/message` that also carries `toolCalls` is skipped when selecting the
      report; the last tool-free message wins.
- [ ] A child whose messages total 50 000 chars returns `MAX_REPORT_CHARS` of its
      **final** message with `truncated: true` and a visible marker — not the first
      4 000 chars of its first message. The Workbench card and the chat delegation
      detail both show the truncation.
- [ ] A cancelled child has no `result` and an `error` naming its session id; the same
      holds for `failed` and `interrupted`.
- [ ] A completed child with no qualifying terminal message has no `result` and an
      `error` naming its session id; the child's log is scanned exactly once (sentinel
      observable through repeated `wait`/`list` calls returning stable handles).
- [ ] `filesTouched` for a child that ran `Read{path:'a.ts'}`, `Glob{pattern:'**/*.ts'}`,
      `Grep{pattern:'x'}` contains `a.ts` and nothing invented — no Glob or Grep paths.
- [ ] `filesTouched` for a `worker` that wrote two files contains both.
- [ ] A settled child's digest is computed once whether or not a result exists
      (sentinel, not the old `result === undefined` guard).
- [ ] The Workbench child card and the chat delegation detail show the report; no
      `undefined` after the rename.
- [ ] `npm run typecheck`, `npx vitest tests/harness/g4-agents.spec.ts
      tests/web/server-g4.spec.ts`, the panel spec, and the browser fixture route
      (`chat-shell.e2e.ts`) pass.

## Risk Assessment

**A child whose real value was in intermediate messages now returns less.** *Signal:* a
parent asking follow-up questions it could previously answer from the digest. *Response:*
this is the intended trade — phase 1 tells the child to put everything in the final
message. If it still happens, the fix is stronger preamble wording, not re-concatenation.

**The field rename breaks a consumer the typechecker cannot see** (a JSON path in a test
fixture, a browser assertion, the e2e route stub). *Signal:* a green typecheck with a
red browser suite. *Response:* grep `summary` and `fileReferences` across `web/`,
`tests/` and `docs/` before finishing, not after — the consumer list above is the
starting point, not the proof.

**A completed child can still lack a final report.** *Signal:* status is `completed` but
no qualifying tool-free assistant message exists. *Response:* treat that as an explicit
result-contract failure with the full-log pointer; never serialize silent success and
never fall back to intermediate narration.

**16 000 chars is a guess.** *Signal:* a report truncated at the cap in normal use.
*Response:* the cap is a named constant and `toolOutputLimit` is 60 000, so raising it is
a one-line change with headroom already proven.
