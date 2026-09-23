---
title: "Phase 2: Grant sources, child inheritance, model context"
status: todo
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 2: Grant sources, child inheritance, model context

## Overview
Feed `additionalRoots` from two durable sources — project settings and session grants — snapshot them into
child agents at spawn, and tell the model which folders it may use.

## Requirements
- Functional:
  - **Project grants:** `ProjectRecord.additionalDirectories?: AdditionalDirectory[]`, `AdditionalDirectory = { kind: 'project'; projectId; access } | { kind: 'path'; path; access }`. Stays `v: 1` (optional field). `project` entries resolve **live** to that project's current `path` (user decision); same workspace only; dangling id → skipped at runtime + "missing" in UI.
  - **One validator for every grant source** (project, session PUT, approval) — `validateGrant(path, primary)` (red-team #5, #9):
    - absolute, exists, is a directory (realpath taken once here; stored path = realpath)
    - not UNC/device/reserved (Phase 1 `blocked` rule)
    - not a volume root (`C:\`, `/`), not the user home dir itself
    - not inside, equal to, or an ancestor of any `deniedRoots` entry or `userSkillsDir` (`src/bins/web.ts:61`)
    - does not equal, contain, or sit inside the primary (reuse `rootsOverlap`, `src/harness/workspace/service.ts:342-352`)
    - project-kind entries validated against the referenced project's current path at save time and again at resolve time (skip if now invalid).
  - **Session grants:** durable session event `session/grants` `{ revision: number; roots: { path; access }[] }` (full replacement). Grants are **derived from the log** via `sessionGrantsOf(events)` (last-wins, mirrors `sessionModelOf`, `src/harness/session/events.ts:200`), memoized per session by last seq — no separate cache (red-team #13). Add the event to the exhaustive switch (`events.ts:204-241`, `assertNever`) and to `web/lib/types.ts` event unions.
  - **Session grant API** (red-team #4): `PUT /api/workspaces/:id/sessions/:sid/grants` body `{ expectedRevision, roots }`; resolves the session via `findSession` (workspace ownership); requires browser principal (same rule as `POST /api/approvals`, `src/web/server.ts:4328-4337`); `409` on revision mismatch or child session; every root through `validateGrant`. Route-inventory row next to `route-inventory.ts:31`, `credential: 'cookie+csrf'`, `clients: ['browser','test']`.
  - **Project grant API:** `PATCH /api/workspaces/:id/projects/:pid` accepts `additionalDirectories`; browser principal required; validation errors → 400 `ScopeError('root-invalid')`.
  - All grant mutations for one root session go through a single async queue (serializes PUT vs approval appends).
  - **Resolver** (`server.ts` `setRootResolver`): primary = bound project; additional = project `additionalDirectories` ∪ `sessionGrantsOf(root session)`. Dedupe by normalized path; `write` wins on duplicate.
  - **Child inheritance** (red-team #6): at spawn, the parent's effective `additionalRoots` are **snapshotted** into `AgentScope.childOf.grants` (beside `toolCeiling`); the resolver uses the snapshot for children. Consistent with "spawn-time grants never expand" (`server.ts:1514-1517`). Children never own or write grants.
  - **Model context** (red-team #8): a context source lists the effective grants each step — primary path + each additional root (absolute path, access) and one line: "paths outside these folders require user approval". Included for children (from their snapshot).
  - Sessions without a bound project (no primary) get no grants (non-goal); memory mode unchanged.
  - **Headless** (`src/bins/headless.ts`): single root only; out-of-grant stays a hard failure (documented non-goal). (red-team #14)
- Non-functional: resolver per tool call stays O(grants), no disk IO (validation happened at write time).

## Architecture
```
tool call ─> RootResolver()  (ambient agentScope)
              ├─ primary: workspaces.getProject(scope.projectId).path
              ├─ child?  → scope.childOf.grants (spawn snapshot)
              └─ root:   → project.additionalDirectories (live project refs) ∪ sessionGrantsOf(session.events)
context builder ─> "Granted folders" section from the same resolver output
```

## Related Code Files
- Modify: `src/harness/workspace/types.ts`, `src/harness/workspace/service.ts`, `src/harness/session/events.ts`, `src/harness/agent/scope.ts` (`childOf.grants`), `src/harness/agents/executor.ts` (snapshot at spawn ~484-499), `src/web/agent-delegation.ts` (pass parent grants), `src/harness/context/builder.ts` (grants section), `src/web/server.ts` (resolver, PATCH project, PUT session grants, grant queue), `src/harness/mcp/route-inventory.ts`, `web/lib/types.ts`, `web/lib/api.ts`
- Create: `src/harness/workspace/grant-validation.ts`, `tests/harness/grant-sources.spec.ts`, `tests/web/session-grants.spec.ts`, `tests/harness/grants-context.spec.ts`

## Implementation Steps
1. `validateGrant` + types.
2. Workspace service setter with atomic `project.json` write (existing pattern).
3. `session/grants` event + `sessionGrantsOf` + exhaustive switch + web types.
4. Resolver merge, dedupe, child snapshot (`childOf.grants`) at spawn.
5. Context source for granted folders.
6. REST endpoints (auth, ownership, revision, queue) + route inventory + client api.
7. Tests: project grant applies to 2 sessions; session grant only to its session and survives restart (replay); child sees snapshot, parent grant added after spawn not visible to child; PUT on child → 409; stale `expectedRevision` → 409; bearer principal PUT → rejected; invalid paths (`C:\`, home, UNC, overlapping primary, ancestor of app storage) → 400; retargeted project grant follows new path; context section lists grants.

## Success Criteria
- [x] Specs green; restart test proves durability.
- [x] Existing workspace/project/session specs green (optional field back-compat).

## Risk Assessment
- Live project refs: a referenced project retargeted to a folder that now overlaps the primary → skipped at resolve time with UI "invalid" state. Signal: resolver test with overlapping retarget.
- Context section increases prompt size marginally; keep it to one line per root.
