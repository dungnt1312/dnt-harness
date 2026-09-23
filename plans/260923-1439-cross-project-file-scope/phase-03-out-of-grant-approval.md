---
title: "Phase 3: Out-of-grant approval"
status: todo
priority: P1
effort: "1.5d"
dependencies: [1, 2]
---

# Phase 3: Out-of-grant approval

## Overview
Classify fs tool paths before authorization. Out-of-grant → force an approval (with a scope warning); only an
**allow settlement** authorizes the path, once; "allow for session" adds a validated session grant.

## Requirements
- Functional:
  - **Mode property** (user decision): `ModeDefinition.outOfGrant: 'allow' | 'ask'` (default `'ask'`). Bundled `full-access` = `'allow'`; duplicating a mode copies it; custom file modes may set it. Parsed/validated in `src/harness/modes/service.ts` like `permissionDefaults`. `--yolo` treats it as `'allow'`.
  - New `tools/rewrite` listener `attachPathScopeGuard` for `Read/Write/Edit/Glob/Grep` using Phase 1 `classifyTarget` (lexical, **no fs IO**):
    - `blocked` / `denied` / `escape` → `deny` (never askable)
    - write intent into `read` root → `deny`
    - `in-grant` → `next()`
    - `out-of-grant` → record match `{ sessionId, workspaceId, callId, path, intent, exempt }` where `exempt` = executing workspace's mode `outOfGrant === 'allow'` or `--yolo`, computed **now** from the agent scope; then `next({ call })`.
  - **Ordering** (red-team #11): register the guard **without prepend**, after the PreToolUse hooks listener (`server.ts:959/1005`), so it classifies the final rewritten call. Test asserts listener order.
  - **forceAsk** (red-team #1): `forceAsk(call)` returns true when a stored match exists for `(sessionId?, call.id)` and `!match.exempt`. It never reads ambient scope for this decision, so `reevaluate()` from HTTP handlers (`server.ts:3428, 4159, 4192`) sees the stored workspace's decision. Path-scope matches are **not** cleared by `clearForWorkspace`/reevaluate.
  - Match store keyed by `(sessionId, callId)`; entries evicted when `prepare()` returns (allow or deny) — no process-lifetime growth (red-team #14).
  - **Authorization binding** (red-team #1, #5): no `exec` threading through the waterfall. `ToolsService` gets `setApprovedPathResolver((call, exec) => ApprovedPath[] | undefined)`, consulted **once in `prepare()` after the pre-execute decision is `allow`**, keyed on the final prepared call. Host implementation returns the stored match's path (intent-bound) only if the match exists for that exact call. `resolveInGrants` accepts that exact lexical path; realpath is computed **at execute** and must not land in `deniedRoots` or `blocked`; for approved writes the realpath's parent must equal the lexical parent's realpath (no junction swap).
  - **Re-resolve before execute** (red-team #12): `prepare()` calls the root resolver again right before `tool.execute` and intersects with the build-time grant; a grant revoked while waiting for approval no longer authorizes.
  - `askUser` adds `scopeWarning: "Outside granted folders: <path> (<read|write>)"` and `proposedGrant: <folder>` to `PendingApproval` and `approvalEnvelope` (every `guardWarning` site: `server.ts:134, 175, 345, 397, 5280`, `web/hooks/useSessionStream.ts:86`, `web/components/chat/ApprovalBar.tsx:62,90`). Both are also recorded in the `approval/request` event so reconnect/replay rebuilds the card (red-team #13).
  - `proposedGrant` = target's parent dir (file) or base (Glob/Grep), passed through `validateGrant`; if invalid (drive root, home, app storage ancestor, overlaps primary…) the session option is **not offered** (red-team #5).
  - **Approval answer** `scope: 'once' | 'session'`. `session` allowed only for root sessions (children: `once` only — red-team #6). The session grant is appended **after** the policy settles `allow` (hook on the `approval/decision` allow record / `web/approval-settled` with decision), via the Phase 2 grant queue; access = the call's intent. If settlement is deny/expired/cancelled, nothing is written. Grant write failure → the call is denied with reason, HTTP 500 to the answering client (red-team #13).
- Non-functional: approval request/decision events remain the audit trail; session-grant event references the `approvalId`.

## Architecture
```
prepare(call)
 ├─ buildExecution (grant snapshot A)
 ├─ tools/rewrite: hooks → dangerousGuard → pathScopeGuard (appended last) ─ out-of-grant? store match{exempt}
 ├─ tools/pre-execute: host gate → approval(forceAsk = dangerous || pathScope(!exempt) || mcp) → lease (Phase 4, after approval)
 ├─ decision allow → approvedPathResolver(finalCall) → exec.approvedPaths ; evict match
 ├─ re-resolve grant B ; exec.additionalRoots = A ∩ B
 └─ execute → resolveInGrants (realpath checks at execute)
approval/decision allow (scope=session) → grant queue → session/grants
```

## Related Code Files
- Create: `src/harness/guard/path-scope.ts`, `tests/harness/path-scope-guard.spec.ts`
- Modify: `src/harness/modes/types.ts`, `src/harness/modes/bundled.ts`, `src/harness/modes/service.ts` (`outOfGrant`), `src/harness/tools/service.ts` (approved-path resolver, re-resolve), `src/harness/tools/types.ts`, `src/capabilities/fs/grants.ts`, `src/web/server.ts` (attach guard, forceAsk, askUser warning, envelope fields, approval answer `scope`, post-settlement grant append), `web/lib/types.ts`, `web/hooks/useSessionStream.ts`

## Implementation Steps
1. `outOfGrant` mode field + bundled value + parser.
2. `path-scope.ts` guard with `(sessionId, callId)` store and eviction.
3. ToolsService: approved-path resolver after allow; re-resolve + intersect before execute.
4. `resolveInGrants`: approved exact path + execute-time realpath checks.
5. Server wiring: guard registration order, forceAsk, askUser fields, request event fields, answer `scope`, post-settlement append.
6. Tests:
   - out-of-grant Read in ask mode → approval; allow → content; deny → failure, no read, no fs syscall before approval (spy)
   - tool policy `allow` in a mode with `outOfGrant: 'ask'` still asks; mode with `outOfGrant: 'allow'` (bundled full-access **and** a duplicate of it) auto-allows; `--yolo` auto-allows
   - pending out-of-grant approval in workspace B + Dangerous Commands save in B while default workspace is full-access → stays pending (reevaluate regression)
   - blocked/denied/escape/write-to-read-root → deny without approval
   - `session` scope → next call in same dir runs without approval; child card offers only `once`; `session` answer then mode switch to deny → no grant written
   - proposed grant `C:\` / home → no session option
   - hook rewrite after classification → guard sees final path (ordering test)
   - grant removed while approval pending → allowed call fails closed
   - reload page → card still shows scope warning + session option.

## Success Criteria
- [x] Spec green; existing approval, dangerous-guard, modes specs unchanged and green.

## Risk Assessment
- New mode field touches the modes contract; plan `260922-1037-modes-as-single-source` (proposed) may reshape modes — coordinate before cooking if it starts first.
- Execute-time realpath for approved writes to non-existent files uses deepest-existing ancestor (existing `deepestExisting`); junction swap between approval and execute is caught by the parent-realpath equality check.
