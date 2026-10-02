---
title: "Phase 2: G2 Workspace Isolation"
status: done
---

# Phase 2: G2 Workspace Isolation

## Overview

Multiple workspace environments (Work, Life) with strict ownership, data isolation, project binding, and file-first resource layout. Every access enforces workspace ownership at the service boundary.

## Requirements

- [x] Workspace CRUD: create, rename, switch, archive/restore, delete (empty only)
- [x] Project binding: `project.json` with working folder, workspace-owned, no implicit cross-project access
- [x] Session ownership: session ↔ workspace fixed at creation, optional project binding within same workspace
- [x] Data isolation: list/search/direct-ID reads and all writes fail closed on mismatched scope
- [x] Filesystem scope: file tools use explicit project root, containment including traversal/symlinks/creation paths
- [x] Overlapping project roots rejected across workspaces
- [x] Writer coordination: one write-capable Turn per protected project root
- [x] Three live controls scoped to workspace (already in G1, now workspace-aware)
- [x] File-first layout: `workspaces/<id>/` with skills/agents/memory/projects/sessions/cache

## Architecture

```
<dsh-home>/
  app.json
  workspaces/<ws-id>/
    workspace.json
    skills/<name>/SKILL.md
    agents/<name>.md
    memory/workspace/<topic>.md
    memory/projects/<project-id>/<topic>.md
    projects/<project-id>/project.json
    sessions/<session-id>/events.jsonl
    cache/
```

- **Scope propagation:** `agentScope` carries `workspaceId + projectId` alongside `sessionId`. All services resolve through it; agent-supplied `workspaceId` arguments are rejected.
- **Permission:** Workspace-local policy (allow/ask/deny) + host restrictions. Mode defaults from G3 overlay; deny never widenable.
- **Isolation:** Every repository query filtered by workspace; direct-ID access checks ownership. No cross-workspace search. Child agents (G4) inherit parent workspace.
- **Honesty:** Documented "app-level isolation only — not OS sandbox" in G3/G5 as well.

## Related Code Files

- Create: `src/harness/workspace/service.ts`, `src/harness/workspace/types.ts`, `src/harness/project/service.ts`
- Modify: `src/harness/session/service.ts`, `src/harness/storage/file-session-store.ts`, `src/harness/agent/scope.ts`, `src/harness/tools/service.ts`, `src/web/server.ts`, `web/lib/api.ts`
- Delete: none

## Implementation Steps

1. **Workspace model:** `workspace.json` schema, CRUD, migration of existing data to `Default` workspace (idempotent).
2. **Project binding:** `project.json` with working folder, ownership checks, no external-path grants, overlap rejection.
3. **Session scoping:** Session creation requires workspace; enforce at storage/API/runtime layers.
4. **Service boundary isolation:** Filter all list/search/reads by workspace; direct-ID ownership checks; agent tools cannot escape.
5. **Scoped tools:** File-tool root derived from project binding, not global active folder; containment with realpath/symlink handling.
6. **Writer coordination:** Lease per protected root, app-local serialization.
7. **UI:** Workspace selector with activity/approval badges, project list, session header showing workspace/project/model, mode/model/permission controls while running.

## Todo

- [x] Workspace CRUD + migration
- [x] Project binding + overlap rejection
- [x] Session scoping + ownership enforcement
- [x] Service boundary isolation (all queries filtered)
- [x] Scoped file-tool roots + containment
- [x] Writer coordination per project root
- [x] Workspace selector UI + badges
- [x] Isolation honesty documentation

## Success Criteria

- [x] G2 acceptance criteria 1-16 all pass (see spec)
- [x] Work/Life data fully isolated (list, search, direct ID, writes)
- [x] Two tabs with different workspaces do not affect each other
- [x] Switching workspace never changes running Turn ownership/root
- [x] File tools reject traversal/symlink/internal storage access
- [x] Files canonical; cache deletion loses no data
- [x] External Markdown edits validated; stale writes conflict-detected
- [x] Archive/delete preserves external project folders

## Risk Assessment

- **Symlink/Junction escape:** Lexical prefix checks insufficient. Mitigate: canonical realpath before containment check; test on Windows.
- **Overlapping roots across workspaces:** Hard to enforce with external folders. Mitigate: reject at project creation; canonicalize before comparison.
- **Writer coordination on Windows:** No cgroup equivalent. Mitigate: app-local lease; document external-editor bypass limit.
