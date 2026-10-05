# Agent Tool Contract Clarity — Design

Date: 2026-10-04
Status: Draft (brainstorming session, design approved by user; awaiting spec review)
Scope: `Agent` tool description/parameters + dead `SpawnError` code. No runtime behavior change.

## Problem

The `Agent` tool's description is the only contract the model sees, and it is
silent or misleading on behavior the code already defines. A model reading it
cannot tell:

1. what `reconcile` does (listed in `action`, described nowhere);
2. which of `prompt` / `objective` wins — `objective` says "(use prompt instead)",
   while runtime already treats prompt as the brief and returns a note;
3. what happens when `wait` times out (children keep running), or what the
   default wait is (30s);
4. how long the turn-close join lasts (`delegationJoinMs`, 30 min) and what
   happens after (children cancelled, partial reports);
5. that a running child can be parked on a user approval (`awaitingApproval`);
6. whether there is a cap on children — there is none per conversation, but
   nothing says so.

Separately, `SpawnError.code` still includes `'capacity'` and `server.ts` maps it
to HTTP 429, but the per-root (6) and per-turn caps were removed on purpose
(executor comment "Reservation accounting, uncapped"; `g4-subagent-contract`
`describe('capacity')` asserts spawning is uncapped). Nothing throws it.

## Decisions (from the brainstorming dialogue)

1. **Description-only fix.** No change to spawn/wait/join/reconcile behavior.
2. **State "no cap" explicitly.** The description says a conversation may run
   any number of children. The per-provider request admission
   (`request-lifecycle.ts`) is not mentioned: it limits concurrent model
   requests, not children, and is an implementation detail.
3. **Numbers come from code**, never literals in prose, so a limit change
   updates the description.
4. **Remove `'capacity'`** from `SpawnError` and the 429 mapping.
5. **Short.** The description ships every turn; each addition is one sentence.
6. Other follow-ups (e2e `/terminals` fixture, 844KB chunk split, separating
   the uncommitted perf work) are separate specs.

## Changes

### 1. `describe()` in `src/web/agent-delegation.ts`

Add/extend sentences (wording final in implementation; meaning fixed here):

- After "spawn returns immediately…": **"There is no cap on how many children a
  conversation runs."**
- New, after the spawn/wait sentence: **"`wait` blocks up to timeoutMs (default
  ${DEFAULT_WAIT_MS/1000}s, max ${MAX_WAIT_MS/1000}s); a child still running
  after that keeps running — wait again or cancel it. A child flagged
  awaitingApproval is parked on the user."**
- Extend the join sentence: "Children you leave running are joined when your
  turn would close **for up to ${joinMinutes} min; past that they are cancelled
  and report what they got done.** Their reports come back…"
- New: **"`reconcile` repairs a child left `uncertain` (its result could not be
  confirmed as saved, e.g. after a crash or restart): it records exactly one
  result from storage and never reruns work."**

### 2. `PARAMETERS` in the same file

| Parameter | New description |
|---|---|
| `objective` | `spawn: structured alternative to prompt; when both are given, prompt is the brief` |
| `childIds` | `wait/cancel/reconcile: child session ids; wait defaults to every running child; required for cancel and reconcile` |
| `timeoutMs` | `wait: how long to block (default ${DEFAULT_WAIT_MS}, capped at ${MAX_WAIT_MS}); children keep running past it` |

### 3. Join duration plumbing

- `DelegationDeps` gains `readonly joinTimeoutMs?: number`.
- `agentTool` uses `deps.joinTimeoutMs ?? DEFAULT_LIMITS.delegationJoinMs`
  (import from `src/harness/limits.ts`), rendered as whole minutes
  (`Math.round(ms / 60_000)`; if < 1 min, render seconds).
- `src/web/server.ts` `agentTool({...})` registration passes
  `joinTimeoutMs: limits.delegationJoinMs` — the same value the
  `agent/turn-continuation` handler already uses.
- Optional field ⇒ existing test constructions of `agentTool(deps)` compile
  unchanged.

### 4. Dead `'capacity'` code

- `src/harness/agents/executor.ts`: `SpawnError.code` union becomes
  `'depth' | 'packet' | 'inherit' | 'ownership'`.
- `src/web/server.ts` (~line 3456): status becomes
  `error.code === 'packet' || error.code === 'inherit' ? 400 : 404`.
- `tsc` must report no remaining reference. Comments about "capacity
  released" (reservation accounting) stay — that accounting still exists.
- Historical specs under `docs/superpowers/specs/` are not edited.

## Error handling

No new error paths. Removing `'capacity'` narrows a type; any stale reference
fails typecheck rather than runtime.

## Testing

Extend `tests/harness/g4-subagent-contract.spec.ts`
`it('describes the delegation trade-off and the writer boundary honestly')`
(or a sibling `it`) to assert the description:

- contains the no-cap sentence;
- contains `default 30s`, `max 120s` and `keeps running`;
- contains `awaitingApproval`;
- defines `reconcile` and `uncertain`;
- with `joinTimeoutMs: 5 * 60_000` injected, says `5 min`; without it, says
  `30 min`;
- and the `objective` parameter description says prompt is the brief.

Verification commands:

- `npx tsc --noEmit`
- `npx vitest run tests/harness/g4-subagent-contract.spec.ts tests/web/agent-tool-ownership.spec.ts tests/harness/subagent-stability.spec.ts`

`server-g4` and some other suites already fail on this branch before this change
(see perf-review memory). Any failure there is judged against a stash baseline,
not assumed caused by this change.

## Risks

- `executor.ts` and `server.ts` carry uncommitted command-lifecycle changes.
  Commit this work by hunk (`git add -p`) so the two features stay separable.
- Description length grows by ~4 sentences on every turn; acceptable, but
  wording should stay terse.

## Out of scope

- Any runtime behavior change (wait semantics, join timeout, admission).
- Documenting per-provider request admission.
- e2e fixture `/terminals` mock, bundle chunk split, perf-commit separation.
