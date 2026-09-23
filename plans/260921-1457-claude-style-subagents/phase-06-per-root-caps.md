---
phase: 6
title: "Per-root caps"
status: todo
priority: P3
effort: "3h"
dependencies: [0]
---

# Phase 6: Per-root caps

## Overview

Capacity is one global counter today, so two conversations delegating at once steal each
other's slots (`plans/reports/brainstorm-260921-1414-multi-agent-gaps.md`, gap 4). This
phase counts active children per root session and keeps a separate host ceiling.

<!-- Updated: Validation Session 1 - depends on phase 0; async preflight then synchronous check-and-reserve stated precisely; per-turn quota distinct and not released on settle; cleanup tested behaviorally; global 12 hardcoded/documented with typed 429 failures and per-root-only success reporting -->

Token accounting was removed from this phase on 2026-09-22. The design seed lives in
`plan.md` under Deferred. Do not add usage fields, a `step/usage` event, or a token
figure on the child card while implementing this phase.

This phase depends on phase 0, which fixes the spawn ordering it builds on: asynchronous
preflight first (ownership, depth, dependency checks — including the `parentIsChild`
await the current code runs before reserving, `executor.ts:192`), then a synchronous
check-and-increment with **no `await` between checking and incrementing**. It does not
make delegation produce a better answer; it stops one conversation from consuming the
host's slots.

## Requirements

Functional:

- Active capacity is counted **per root session**, with a separate global ceiling.
- `MAX_ACTIVE_PER_ROOT = 3` (today's effective limit), `MAX_ACTIVE_GLOBAL = 12`. The
  global ceiling is a hardcoded, documented constant of the host — it is not
  configurable and not advertised in successful results.
- The failure message names **which** limit was hit, so a caller can tell "you are
  delegating too much" from "the host is busy". Capacity failures stay typed
  `SpawnError('capacity')` tool errors; the HTTP route keeps mapping them to **429**
  with the distinct messages.
- Successful spawn/wait/list results expose only the **per-root** figure — the existing
  `active: "n/3"` text means "active for this conversation" and keeps meaning that. The
  global count is never added to success payloads or the child card.
- The reservation invariant, after phase 0's reordering: asynchronous preflight may run
  first, but the capacity check-and-increment block itself is synchronous with no
  `await` inside, so concurrent spawns cannot race past either limit.
- Per-root counters are released on settle and cannot leak on a pre-launch failure — the
  rollback (`executor.ts:360-369`) must cover both counters.
- The **per-turn quota stays distinct**: `MAX_CHILDREN_PER_TURN = 8` is unchanged, and a
  per-turn slot is **not** released when a child settles — it is consumed by the spawn
  attempt and rolled back only on pre-launch failure (`executor.ts:363-364`). Settle
  releases active capacity only.
- Map and counter cleanup (per-root entries deleted at zero, per-turn keys cleared at
  the root's terminal-turn hook, root-scoped state cleared on session deletion) is
  asserted **behaviorally** through public `spawn`/`wait`/`list` operations — no
  production test accessor, matching phase 0's rule.

Non-functional:

- No change to the LLM seam, session event types, or the Workbench child card beyond the
  existing `active n/3` text, which must keep meaning "active for this conversation".

## Architecture

`executor.ts` — replace the scalar:

```ts
// was: private reservedActive = 0
private reservedGlobal = 0
private readonly reservedPerRoot = new Map<SessionId, number>()
```

The check at `executor.ts:201-207` becomes two checks with distinct messages, e.g.:

- `capacity reached: 3 active children for this conversation`
- `capacity reached: 12 active children on this host; another conversation is delegating`

Both carry `SpawnError('capacity')`, so the HTTP route's existing mapping
(`server.ts:2202-2203`) returns 429 for either with the message telling them apart.

Both decrement sites (`executor.ts:349`, `356`) and the rollback (`executor.ts:363-366`)
update both counters. The per-root entry is deleted at zero so the map does not grow with
dead sessions. The per-turn map is untouched by settle decrements by construction — only
the rollback and the phase 0 terminal-turn hook write to it.

## Related Code Files

- Modify: `src/harness/agents/executor.ts` — counters, messages, rollback
- Modify: `src/web/agent-delegation.ts` — capacity text in spawn results
- Modify: `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts`
- Modify: `docs/harness.md`, `docs/capabilities.md` — the two ceilings

## Implementation Steps

1. Write the concurrency test first: 4 children spawned concurrently for one root must
   not all run.
2. Replace the scalar with the global counter plus the per-root map.
3. Split the capacity check into two messages; update the `active: "n/3"` string in
   `agent-delegation.ts:279` to report the per-root figure it already means.
4. Cover both counters in the decrements and the rollback; delete zero entries; leave
   the per-turn map untouched on settle.
5. Tests: 3 children for one root then a 4th refused naming the per-root limit; two roots
   each getting 3 concurrently; the global ceiling refused with its own message; a
   pre-launch failure leaving both counters and the per-turn counter unchanged; per-root
   entry disappearance and per-turn-key clearing observed through public operations
   (a fresh spawn after the turn hook fires sees a fresh per-turn budget; `list` after
   eviction still reconstructs settled children per phase 0).
6. Update the docs. Do not add token accounting.

## Success Criteria

- [x] One root may hold 3 active children; the 4th fails naming the per-conversation limit.
- [x] Two roots each hold 3 active children at the same time without interfering.
- [x] The global ceiling refuses with a message that says the host is busy, distinct from
      the per-root message; both surface as `SpawnError('capacity')` and HTTP 429.
- [x] Successful spawn/wait/list results show only the per-root `active n/3` figure; no
      global count appears in success payloads, the tool result, or the child card.
- [x] A spawn that fails **before the parent relationship commit** rolls back both active
      counters and the per-turn attempt. A failure after that commit settles a durable
      failed child, releases active capacity, and keeps the per-turn attempt charged until
      the terminal-turn cleanup hook, matching phase 0.
- [x] A settled child releases its active slot but **not** its per-turn slot; the
      per-turn budget is exhausted by attempts, not by completions.
- [x] The per-root map has no entry for a root with no active children, and per-turn
      keys are cleared at the terminal-turn hook — both asserted through public
      spawn/wait/list behavior with no production test accessor.
- [x] `MAX_CHILDREN_PER_TURN = 8` still enforced.
- [x] No usage field, `step/usage` event, or token figure is added.
- [x] `npm run typecheck` and the g4 harness + web suites pass.

## Risk Assessment

**The synchronous-reservation property is load-bearing and easy to break.** After phase 0
the shape is: async preflight, then a check-and-increment block with no `await` inside —
precisely so concurrent spawns cannot race past the limit. *Signal:* a test spawning 4
children concurrently and seeing 4 run. *Pre-decided response:* write that concurrency
test first, before changing the counters, so it fails for the right reason if the
property is lost.

**Per-root counters leak on abnormal settle**, growing the map with dead sessions.
*Signal:* the map's size exceeding live session count. *Response:* delete at zero, and
assert it in the pre-launch-failure test — through public operations, not an accessor.

**Settle releasing the per-turn slot by mistake** would quietly raise the per-turn
budget to "8 concurrent". *Signal:* a ninth spawn in one turn succeeding after earlier
children completed. *Response:* the per-turn map is written only by the spawn attempt and
the rollback; the settle-path test asserts the budget is consumed by attempts.

**Token accounting gets pulled back in** because the child card looks like the natural
place for a number. *Signal:* a diff in `src/harness/llm/` or `events.ts` from this
phase. *Response:* revert that diff. The contract is recorded in `plan.md` under
Deferred and belongs to a later plan.
