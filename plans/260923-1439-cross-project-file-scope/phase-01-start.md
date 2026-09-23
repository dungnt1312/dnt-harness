---
title: "Phase 1: Multi-root grant model + path resolution"
status: todo
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Multi-root grant model + path resolution

## Overview
Replace the single-root grant with `primary + additional[]` in the tool pipeline and make fs tools resolve paths
against any granted root, with per-root access (`read` | `write`). No new grant sources yet (resolver still
returns only primary) — this phase is behavior-preserving until Phase 2 feeds roots.

## Requirements
- Functional:
  - `ToolExecution` gains `additionalRoots?: readonly GrantedRoot[]` where `GrantedRoot = { path: string; access: 'read' | 'write' }`. `root` stays the primary (keeps Bash + existing callers working). <!-- red-team #15: no `label` -->
  - `RootResolver` (no-arg, reads ambient `agentScope`) returns the same shape plus `additionalRoots`.
  - **Resolution rule** (red-team #9, #10): `abs = path.resolve(primary, target)` for every target (relative or absolute), then match `abs` against all granted roots. Primary counts as `write`. Among additional roots, pick the **longest** containing root. Additional roots never overlap the primary (enforced in Phase 2 validation), so a relative path can never bypass a read-only root.
  - **Classification** (lexical first, shared by Phase 3 guard):
    1. `blocked` — UNC/device/reserved paths: starts with `\\` or `//` (covers `\\?\`, `\\.\`, `\\host\share`), or any segment is a Windows reserved name (`CON`, `NUL`, `PRN`, `AUX`, `COM1-9`, `LPT1-9`, with or without extension). Hard-deny, never askable, **no fs syscall**. (red-team #3)
    2. `denied` — inside `deniedRoots` → hard-deny.
    3. `in-grant` — lexically inside a granted root → then realpath check against **that** root; realpath outside it → `escape` (hard-deny, never askable). (red-team #2)
    4. `out-of-grant` — lexically outside every root → `OutOfGrantError` (Phase 3 turns it into an approval). No realpath/stat for this class before approval.
  - Write-capable tools (`Write`, `Edit`) on a `read` root → error `path '<p>' is in a read-only granted folder`.
  - Error text for primary-only escapes keeps the existing wording `escapes the workspace root` (existing assertions in `tests/capabilities/fs-tools.spec.ts:122-131` stay valid). (red-team #14)
  - **Output paths** (red-team #10): `Glob` and `Grep` both print primary-relative paths when under primary, absolute paths otherwise. `Glob` gains optional `path` (base dir); its pattern matches relative to that resolved base.
- Non-functional: no behavior change when `additionalRoots` is empty; existing fs specs pass unchanged.

## Architecture
- New `src/capabilities/fs/grants.ts`: `GrantedRoot`, `OutOfGrantError`, `classifyTarget(exec, target, intent)` (pure lexical, no IO), `resolveInGrants(exec, target, intent)` (classify + realpath for in-grant), `targetPaths(call)` (shared arg extractor: `Read/Write/Edit.path`, `Glob.path`, `Grep.path`) reused by Phase 3/4.
- `resolveGrantedPath(root, target, deniedRoots)` stays as the single-root primitive (also used by `src/web/project-files.ts:65`, unchanged).
- `ToolsService.buildExecution` copies `additionalRoots` from the resolver grant.

## Related Code Files
- Create: `src/capabilities/fs/grants.ts`, `tests/capabilities/fs-multi-root.spec.ts`
- Modify: `src/harness/tools/types.ts`, `src/harness/tools/service.ts`, `src/capabilities/fs/tools.ts`, `src/index.ts` (exports near `:220`, `:234`)
- Verify unchanged (RootResolver/resolveGrantedPath consumers): `src/bins/headless.ts:133-145`, `src/web/project-files.ts`, `scripts/_spawn-explore.mts:40`, `tests/harness/agent-tools.spec.ts:67`, `tests/harness/g1-approval.spec.ts:160-167`, `tests/capabilities/fs-tools.spec.ts`, `tests/web/server-project-files.spec.ts`

## Implementation Steps
1. Add `GrantedRoot` + `additionalRoots` to `ToolExecution` and `RootResolver`; pass through in `buildExecution`.
2. Implement `classifyTarget`, `resolveInGrants`, `OutOfGrantError`, `targetPaths` in `grants.ts`.
3. Switch `granted(exec, target)` in `tools.ts` to `resolveInGrants` with intent per tool (Read/Glob/Grep = read, Write/Edit = write).
4. Glob `path` param + unified output formatting for Glob and Grep.
5. Tests: relative→primary; absolute in additional read root readable; write into read root refused; out-of-all-roots throws `OutOfGrantError` without any fs call (spy `fs.stat`/`realpath`); UNC `\\host\s\x`, `\\?\C:\x`, `\\.\pipe\x`, `C:\x\NUL.txt` blocked without fs call; deniedRoots inside additional root refused; junction inside additional root pointing outside → `escape` (hard error); two nested additional roots → longest match wins; Grep hit in additional root fed back into Read resolves in-grant.

## Success Criteria
- [x] New spec green; `tests/capabilities/fs-tools.spec.ts` + `tests/web/server-project-files.spec.ts` unchanged and green.
- [x] `npm run typecheck` green.

## Risk Assessment
- Reserved-name list incomplete → a device path reaches realpath. Signal: test matrix gap; response: extend list, never drop the "no IO before approval" rule.
- Windows case-insensitivity: reuse existing `within()`; do not add a second comparison.
