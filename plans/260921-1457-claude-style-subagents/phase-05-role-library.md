---
phase: 5
title: "A real role library"
status: todo
priority: P2
effort: "4h"
dependencies: [0, 1, 2]
---

# Phase 5: A real role library

## Overview

`explorer` and `worker` are permission tiers wearing role names: their descriptions are
"read-only" and "with file tools" (`src/harness/agents/definition-service.ts:135,145`).
There is nothing for a model to choose between — it picks a permission level and then
writes the entire specialist prompt itself, in `objective`, every time.

Claude Code's value is that `description` drives selection. This phase makes the catalog
selectable, and tells the model when delegating is worth it at all.

<!-- Updated: Validation Session 1 - writer guidance states the asymmetric root-turn/child-call lease boundary honestly (no child-run serialization claim); role description cache keyed by WorkspaceId; catalog returns bundled four plus valid workspace custom roles -->

## Requirements

Functional:

- Bundled roles have descriptions that say **when to use this one instead of another**,
  not what tools it holds.
- Bundled instructions are real specialist prompts, written for the phase 1 contract: the
  final message is the deliverable, so each role's instructions specify what its report
  must contain.
- Exactly four bundled roles, distinguished by expertise: `explorer`, `worker`,
  `reviewer`, `verifier`. Do not add a fifth bundled role in this phase. `action:
  'catalog'` returns those four **plus valid workspace custom roles** — it lists the
  workspace's definitions, and only the bundled set stays capped.
- The `Agent` tool description gains a delegation-guidance line — when delegating pays and
  when it does not. The analysis found no guidance anywhere, and the brainstorm report
  flagged over- and under-delegation as the result.
- The tool description states the writer boundary **honestly**. A registered root Agent
  holds the project lease from its first write-capable call until `agent/turn-settled`
  (`src/web/server.ts:732-782`). Before a write-capable child starts, the executor emits
  `agent/child-writer-handoff`, releasing the root's current lease
  (`server.ts:784-794`; `executor.ts:319-329`). Child Agents are not in the server
  `sessions` registry, so their write-capable calls use the fallback per-call
  acquire/release path; the root can later reacquire. Nothing serializes the child's
  whole run or gives it priority after handoff. Guidance therefore says: do not fan out
  writers or keep the root writing concurrently; use read-only roles for parallel work.
  This is option A from the brainstorm report, restated truthfully — child turn-level
  leasing, queueing and worktree isolation stay out of scope.
- `action: 'catalog'` already returns names, descriptions, tools and model
  (`src/web/agent-delegation.ts:326-337`); it gains nothing structural.

Non-functional:

- Bundled **definition records** remain immutable in the definition service and
  copy-to-customize (`definition-service.ts:226-245`) — this says nothing about a role's
  tool capability; `worker` still has Write/Edit and `verifier` still has Bash.
- `BUNDLED_AGENT_ROLES` is the single source; `list()` and `resolve()` derive from it.
- The role listing cache in `agentTool` becomes **keyed by `WorkspaceId`**: today it is a
  closure-global `roles`/`rolesFor`/`refreshedAt` triple
  (`src/web/agent-delegation.ts:150-164`), so two workspaces alternating within the 5 s
  TTL can each be shown the other's custom role descriptions. Per-workspace cache
  entries fix the leak; no behavior change beyond correctness.
- Mostly prose plus that cache fix. No other runtime mechanism is added by this phase.

## Architecture

### The roles

| Role | Tools | Chooses it when |
|---|---|---|
| `explorer` | `Read`, `Glob`, `Grep` | you need to find or understand something and will act on it yourself |
| `worker` | `Read`, `Glob`, `Grep`, `Write`, `Edit` | one concrete, already-decided edit |
| `reviewer` | `Read`, `Glob`, `Grep` | you want defects found in code you or a worker just wrote |
| `verifier` | `Read`, `Glob`, `Grep`, `Bash` | you need a command run and its outcome judged (tests, typecheck, build) |

`reviewer` and `verifier` are the two additions. Both earn their place against the
writer-boundary reality: `reviewer` is read-only, so it fans out; `verifier` holds `Bash`
and therefore participates in the same project lease. A verifier child receives no
whole-run lease after handoff, so its Bash calls can contend with a root that reacquired
or with another writer. The docs say exactly that, not "one at a time".

Each definition in `bundledDefinition()` (`definition-service.ts:131-153`) gets:

- a `description` phrased as a selection rule — the sentence the model reads in the tool
  description at `agent-delegation.ts:176`;
- `instructions` that state the role's method **and** the exact shape of its final report,
  since phase 1 made the final message the whole deliverable;
- `disallowedTools` kept explicit, as the existing two do.

Example, `reviewer`:

```ts
{
  name: 'reviewer',
  description: 'Finds defects in existing code. Use it after you or a worker changed something, when you want a second read rather than more edits.',
  instructions: [
    'You review code and report defects. You cannot change anything.',
    'Read the files named in your brief plus whatever they depend on. Look for incorrect behaviour first, then missing error handling, then contract breaks — not style.',
    'Your final message is a list. Each entry: `path:line` — the defect in one sentence — the concrete input or state that triggers it. Say "no defects found" if that is the truth; do not pad the list.',
  ].join(' '),
  tools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['Write', 'Edit', 'Bash', 'Skill', 'MemoryCreate', 'MemoryUpdate', 'MemoryForget'],
}
```

### The guidance line

Added to `describe()` in `src/web/agent-delegation.ts:166-180`:

> Delegate when the work is separable and its result compresses — a search across many
> files, a review, a verification run. Do not delegate what you can do in two tool calls,
> and do not delegate work whose context you would have to retype. Root writer turns hold
> the project lease, but spawning a writer child hands off the current lease and the child
> has no whole-run lock; the root can later reacquire. Do not fan out writers or keep the
> root writing concurrently — parallel fan-out belongs to read-only roles.

`describe()` is already rebuilt per `schema()` call with a role cache, so the roles list
picks the new descriptions up with no change — once the cache is keyed by `WorkspaceId`
(below).

### The workspace-keyed role cache

`agentTool`'s closure currently holds one `roles` list with one `rolesFor` workspace id
and one `refreshedAt` (`src/web/agent-delegation.ts:150-164`). Replace the triple with a
per-workspace `Map<WorkspaceId, { roles, refreshedAt }>` (same `ROLE_CACHE_MS`), so a
switch between two workspaces within the TTL serves each its own listing instead of the
last-refreshed workspace's custom roles. Keep the map bounded with lazy TTL eviction on
schema/catalog access (remove expired entries before inserting/refreshed access); the
static bundled fallback stays as the initial value for every workspace.

## Related Code Files

- Modify: `src/harness/agents/definition-service.ts` — `BUNDLED_AGENT_ROLES`,
  `bundledDefinition()`
- Modify: `src/web/agent-delegation.ts` — the guidance line in `describe()`, the
  WorkspaceId-keyed role cache
- Modify: `web/components/settings/AgentsPanel.tsx` — the bundled list is longer; check
  layout and the copy-to-customize affordance
- Modify: `tests/harness/g4-agents.spec.ts` — per-role ceiling cases
- Modify: `tests/web/server-g4.spec.ts`, `web/components/settings/management.spec.tsx`
  if either asserts the bundled-role count
- Modify: `docs/capabilities.md`, `docs/harness.md` — the role catalog and the
  asymmetric root-turn/child-call lease boundary

## Implementation Steps

1. Rewrite `explorer` and `worker` descriptions and instructions for the phase 1
   contract; keep their names, tools and `disallowedTools` as they are.
2. Add `reviewer` and `verifier` to `BUNDLED_AGENT_ROLES` and `bundledDefinition()`.
3. Grep for hardcoded expectations of two bundled roles across `tests/` and `web/` — the
   tool's own fallback list at `agent-delegation.ts:150-153` is one of them and must be
   updated too.
4. Key the role listing cache by `WorkspaceId` in `agentTool` and lazily evict expired
   workspace entries so the long-lived closure stays bounded.
5. Add the guidance line to `describe()`.
6. Check `AgentsPanel.tsx` renders four bundled roles without layout breakage.
7. Extend the specs: `verifier` may call `Bash`, `reviewer` may not; a `reviewer` spawn
   with `grantTools:['Write']` reports the dropped grant; two workspaces alternating
   within the TTL each see their own role descriptions.
8. Update `docs/capabilities.md` and `docs/harness.md`.

## Success Criteria

- [x] `action:'catalog'` returns the four bundled roles with descriptions that state
      *when to choose them*, with no description defined by its tool list, **plus** valid
      workspace custom roles; bundled names stay capped at four.
- [x] The tool description carries the delegation-guidance line and distinguishes the
      root turn-held lease, the child per-call fallback after handoff, and the absence of
      a whole-child-run lock — no false serialization or one-at-a-time claim anywhere.
- [x] `verifier` can call `Bash`; `reviewer` and `explorer` are denied it by the ceiling.
- [x] A `reviewer` spawned with `grantTools:['Write']` reports `droppedGrants:['Write']`.
- [x] Each bundled role's instructions specify the shape of its final report.
- [x] `agent-delegation.ts`'s static fallback role list matches the bundled roles.
- [x] The role description cache is keyed by `WorkspaceId`: alternating two workspaces
      within the TTL serves each workspace its own custom role descriptions, and expired
      workspace entries are evicted lazily so the cache remains bounded.
- [x] The Settings agents panel lists four bundled roles and each can be copied to
      customize.
- [x] Two `reviewer` children fan out concurrently; a writer-child test demonstrates the
      actual boundary: root lease handoff completes before the child's first write,
      child calls have no whole-run lease, and a later root write can reacquire/contend —
      exactly as documented.
- [x] `npm run typecheck`, the g4 suites and `management.spec.tsx` pass.

## Risk Assessment

**A richer catalog invites over-delegation.** *Signal:* trivial single-file questions
being delegated. *Pre-decided response:* the guidance line is the first lever and it is in
this phase; the second is narrowing `description` wording. Do not add a mechanical gate —
there is no eval to tune it against, which the brainstorm report already noted.

**`verifier` holding `Bash` makes lease contention easier to hit**, because a verification
run is exactly what a model will pair with a writer. The initial handoff releases the
root's held lease, but the child has no whole-run lease and a later root write can
reacquire. *Signal:* `project busy: another session is executing on this project folder`
in child results. *Response:* document this asymmetric boundary and tell the model not to
keep the root writing concurrently. If it becomes common, that is evidence for child
turn-level leasing, a queue, or worktrees in a separate plan.

**The workspace-keyed cache grows unbounded.** *Signal:* expired entries remain after
workspace churn. *Response:* lazy TTL eviction is part of this phase and is covered by a
test; workspace-deletion hooks are unnecessary for a cache whose entries expire on the
next access.

**Four roles is the bundled catalog for this plan.** Locked on 2026-09-22: `explorer`,
`worker`, `reviewer`, `verifier`. *Signal:* one role never chosen, or the model
repeatedly writing a specialist prompt into `prompt` that matches no role. *Response:*
do not add a fifth bundled role here. Workspace copy-to-customize is the extension path;
promote a custom role only in a later plan.
