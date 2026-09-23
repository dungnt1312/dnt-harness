---
title: "Phase 4: Writer lease per target root"
status: todo
priority: P1
effort: "0.5d"
dependencies: [1, 3]
---

# Phase 4: Writer lease per target root

## Overview
Writes into additional roots or approved out-of-grant paths must lease the right key, only after approval, and
contend with any overlapping lease.

## Requirements
- Functional (red-team #7):
  - **Key function** `leaseKeyFor(targetRealpath)`: outermost registered project primary (any workspace) containing the target; else the containing granted root; else (approved out-of-grant) the target's parent dir.
  - **Hierarchical conflict:** `acquireRoot` refuses when any held key by another session is equal, ancestor, or descendant of the requested key (reuse `rootsOverlap`, `src/harness/workspace/service.ts:342-352`; today exact-key `Map` at `:458-468`).
  - **Order:** primary-root lease for `Bash`/in-primary writes keeps current behavior (listener at `server.ts:797`). Cross-root leases (key ≠ primary) are taken by a second pre-execute listener registered **after** `attachApproval` (`server.ts:1779`), so a pending or denied approval never holds a foreign lease.
  - Held cross-root leases follow the existing per-turn set (`heldLeases`) and release on `agent/turn-settled` and child writer handoff (`server.ts:826-850`).
  - Retarget busy check (`server.ts:4034-4042`) also treats a project as busy when any busy session holds a lease whose key is inside it.
- Non-functional: one key per call → no lock-order deadlock; `acquireRoot` still fails fast (`project busy`).

## Related Code Files
- Modify: `src/web/server.ts` (second lease listener, retarget busy check), `src/harness/workspace/service.ts` (`acquireRoot` hierarchical check)
- Create: `tests/web/cross-root-lease.spec.ts`

## Implementation Steps
1. `leaseKeyFor` helper (uses project list + grants).
2. Hierarchical `acquireRoot`.
3. Post-approval cross-root lease listener.
4. Tests: A (project X) writes into Y via grant while B's turn holds Y → `project busy`; nested grant `D:\shared` vs approved out-of-grant `D:\shared\sub\f` contend; denied cross-root write leaves Y free; read-only calls never lease; retarget of Y blocked while A holds a lease inside Y.

## Success Criteria
- [x] Spec green; existing lease/writer/g2 specs green.

## Risk Assessment
- Hierarchical conflicts may serialize more than today when grants nest; acceptable (correctness over parallelism). Signal: existing G2 concurrency specs slower/failing → review key choice, not the rule.
