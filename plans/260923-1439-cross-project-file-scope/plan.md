---
title: "Cross-project file scope"
description: "File tools operate across primary project + additional granted roots; out-of-grant paths ask for approval."
status: completed
priority: P1
effort: "5-6d"
tags: [harness, fs-tools, permissions, web]
created: 2026-09-23
---

# Cross-project file scope

## Overview

Today every file tool is confined to ONE root (the bound project's folder). This plan turns the grant into
`primary + additional[]` (other workspace projects or arbitrary folders, each `read` or `write`), declared per
project and extendable per session, snapshotted into child agents, and listed in the model's context. Paths
outside every grant raise an approval instead of failing. Model follows Codex `writable_roots` / Claude Code
`additionalDirectories`.

Contract + research: [brainstorm report](../reports/brainstorm-260923-1430-cross-project-file-scope.md).

## Decisions (accepted)

| Decision | Choice |
|---|---|
| Out-of-grant path | `ask` approval, forced even when the tool's policy is `allow`; auto-allowed when the mode's `outOfGrant: 'allow'` (bundled full-access; duplicates inherit) or `--yolo` |
| Never askable | UNC/device/reserved paths, `deniedRoots`, junction/symlink escapes from a granted root, write into a `read` grant |
| Root sources | other projects in same workspace (live-resolved by projectId) + arbitrary absolute folders; one validator for every source |
| Grant lifetime | project default (`additionalDirectories`) + session grants (`session/grants` event, derived from log) |
| Child agents | inherit a **spawn-time snapshot** of the parent's effective grant; cannot widen it; child approvals are `once` only |
| Approved out-of-grant call | `once` by default; root-session card offers "Allow `<folder>` for this session" when that folder passes validation; grant written only after `allow` settles |
| Leases | taken after approval; key = outermost project primary containing target, else grant root; hierarchical conflict |
| Bash | unchanged, still unconfined (no OS sandbox); cwd stays primary |
| Headless | single root; out-of-grant hard-fails (non-goal) |

## Phases

| # | Phase | Depends | Status |
|---|-------|---------|--------|
| 1 | [Multi-root grant model + path resolution](./phase-01-start.md) | – | Pending |
| 2 | [Grant sources, child inheritance, model context](./phase-02-grant-sources-and-child-inheritance.md) | 1 | Pending |
| 3 | [Out-of-grant approval](./phase-03-out-of-grant-approval.md) | 1, 2 | Pending |
| 4 | [Writer lease per target root](./phase-04-writer-lease-per-target-root.md) | 1, 3 | Pending |
| 5 | [Web UI for grants](./phase-05-web-ui-for-grants.md) | 2, 3 | Pending |
| 6 | [Docs and verification](./phase-06-docs-and-verification.md) | 1-5 | Pending |

```
P1 grant model ─> P2 sources/inheritance/context ─> P3 approval ─┬─> P4 lease (post-approval)
                                                                  └─> P5 web UI ──┴─> P6 docs/verify
```

## Success Criteria

- [ ] Read/Edit/Glob/Grep work inside a granted additional root; Glob/Grep output paths feed back into Read without approval.
- [ ] Write/Edit inside a `read` grant is denied (no prompt); UNC/device/reserved paths, `deniedRoots`, and junction escapes are denied without prompt and without any fs syscall before decision.
- [ ] Out-of-grant path → `approval/request` with scope warning; allow → runs once; deny → fails; root-session "allow folder" → later calls in that folder need no approval; unsafe folders (drive root, home, app storage ancestors) never offered.
- [ ] Mode `outOfGrant: 'allow'` (incl. a duplicated full-access mode) and `--yolo` auto-allow; re-evaluation from HTTP handlers never auto-allows a pending out-of-grant approval.
- [ ] Project grants persist in `project.json` and apply to every session of the project; session grants persist in the session log, apply only to that session, survive restart; grant APIs require browser principal + workspace ownership.
- [ ] Child agent sees the spawn-time snapshot, cannot widen it.
- [ ] Model context lists granted folders.
- [ ] Overlapping/nested write targets contend on leases; denied approvals never hold a foreign lease.
- [ ] UI manages project folders, session folders, and the approval scope option; card survives reload.
- [ ] Docs describe multi-root scope and restate that Bash is unconfined. `npm test`, typecheck, lint, `build:web` green.

## Risks

- `targetPaths(call)` is the single source of path args for guard, tools, and leases — any fs tool arg rename must update it (covered by tests).
- Plan `260922-1037-modes-as-single-source` (proposed) reshapes modes; Phase 3 adds `outOfGrant` to mode definitions. Coordinate before cooking if that plan starts first.

## Open questions

None.

## Implementation notes (2026-09-23)

Deviations from phase files (behavior as planned; locations differ):
- Grant validation lives in `src/web/folder-grants.ts` (host policy), not `src/harness/workspace/grant-validation.ts`; the harness does not import capabilities.
- The path-scope guard lives in `src/web/path-scope-guard.ts`, not `src/harness/guard/path-scope.ts`.
- `approvedPathResolver(call, allowed)` is called after every decision (allow or deny) so matches are always evicted; the session grant is appended there, right before the call runs (after the allow settles), instead of from an `approval/decision` hook.
- Session grants are derived from the log (`sessionGrantsOf`) with a per-session length-keyed memo.
- Mode form (web) keeps `outOfGrant` optional so an explicit `ask` round-trips.
- Tests live in `tests/capabilities/fs-multi-root.spec.ts`, `tests/web/{folder-grants,out-of-grant-approval,path-scope-guard,cross-root-lease}.spec.ts`, `web/components/settings/folder-grants-ui.spec.tsx`.

Code review (7/10, no critical) — fixed: Win32 trailing dot/space and link/short-name writes into a nested read-only folder (segment refusal + on-disk re-classification); PUT grants on a child session → 409; session answer flag set only by the answer that wins; PATCH project validates grants before any change; memory mode keeps its hard boundary; approval id recorded on `session/grants`; card names read vs read & write; context line omits the approval sentence when the mode allows out-of-grant; pre-execute throw evicts the match; mode form round-trips explicit `ask`.

Follow-up (2026-09-24): added tests for bearer-principal rejection (`tests/web/folder-grants-auth.spec.ts`), retargeted project-grant follow and post-spawn parent grant invisibility (`tests/web/folder-grants.spec.ts`), read-only calls never leasing (`tests/web/cross-root-lease.spec.ts`). Real-backend browser walk-through (13 checks: approval card, session answer, chip, Settings extra folders) passed; it showed the session button truncating the folder name, fixed by keeping the path's end visible (`shortFolder`).

The composer chip re-applies an edit once to the fresh list on 409, so an approval's folder added meanwhile is kept.

By design (non-goal): headless keeps a single root; Bash is not confined by grants.

## Red Team Review

### Session — 2026-09-23
**Findings:** 16 after dedupe of 37 raw (15 accepted, 1 rejected)
**Severity breakdown:** 3 Critical, 6 High, 7 Medium
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer, Scope & Complexity Critic

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Ambient-scope `forceAsk` exemption auto-allows pending approvals on reevaluate; approvedPaths attached pre-approval | Critical | Accept | Phase 3 |
| 2 | Junction escape becomes approvable | Critical | Accept | Phase 1, 3 |
| 3 | Pre-approval realpath on UNC paths leaks NTLM; device paths not refused | Critical | Accept | Phase 1, 3 |
| 4 | Session-grant endpoint on bearer-reachable legacy namespace | High | Accept | Phase 2, 5 |
| 5 | Session-allow grants unbounded parent dir; session grants unvalidated | High | Accept | Phase 2, 3, 5 |
| 6 | Child approvals widen parent + siblings | High | Accept (snapshot + once-only) | Phase 2, 3 |
| 7 | Lease before approval, held on deny; exact-key leases don't contend | High | Accept | Phase 4 |
| 8 | Model not told granted folders | High | Accept | Phase 2, 5 |
| 9 | Relative paths bypass nested read root; first vs longest contradiction | High | Accept | Phase 1, 2 |
| 10 | Grep `../` output round-trips into approvals | Medium | Accept | Phase 1 |
| 11 | Rewrite-chain ordering (prepend) classifies before hooks | Medium | Accept | Phase 3 |
| 12 | Grant frozen at call start; revocation during approval ignored | Medium | Accept | Phase 3 |
| 13 | Session grant races, duplicate cache, grant persisted for denied call, warning lost on reload | Medium | Accept | Phase 2, 3 |
| 14 | Missed consumers/tests/headless; match store leak | Medium | Accept | Phase 1, 2, 3, 6 |
| 15 | Unused `label`/`source` fields | Medium | Accept | Phase 1, 2 |
| 16 | Write into `read` root should ask instead of deny | Medium | Reject — contract acceptance criterion ("Write into a read grant is refused"); user changes grant access instead | – |

User decisions during review: mode property `outOfGrant` (not id-based); project refs resolve live.

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01..06
- Decision deltas checked: 11 (endpoint path, validator, snapshot inheritance, once-only child approvals, outOfGrant mode field, post-approval binding, lease order/key, context source, unified output rule, no label/source, headless non-goal)
- Reconciled stale references: 6 (`/api/sessions/:id/grants`, `source` field, "writes to parent", `--yolo`/full-access id rule, `tests/harness/*fs*`, Phase 4 deps)
- Unresolved contradictions: 0

<!-- slug: cross-project-file-scope -->
