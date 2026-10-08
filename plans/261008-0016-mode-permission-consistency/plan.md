---
title: "Mode permission consistency"
description: "Close the Plan-copy MCP exposure hole, make mode instructions/memory guidance match actual behavior, and keep the Modes editor lossless."
status: completed
priority: P1
effort: "~4h"
tags: [permissions, modes, mcp, security]
created: 2026-10-08
---

# Mode permission consistency

## Overview

Review of the four bundled modes (2026-10-08) found the permission matrix correct, with
three deviations between what a mode *says* and what it *does*:

1. **MCP read-safe restriction is keyed on `mode.id === 'plan'`**
   (`src/web/execution-authority.ts:110`). A duplicated Plan (`plan-copy`) or any custom
   read-only mode exposes every MCP tool, including mutating ones, guarded only by `ask`.
   Reproduced: `plan → create_issue: hidden`, `plan-copy → create_issue: ask`.
2. **Ask-before-changes instructions promise "ask before any write"**, but structurally safe
   Markdown memory writes are auto-allowed (`src/web/server.ts:2519`, constrained by
   `src/capabilities/fs/grants.ts:187-188,253-256`).
3. **Plan receives write-oriented memory guidance** (`src/harness/memory/context.ts:12`,
   injected at `src/web/server.ts:2321` and `src/bins/headless.ts:236`) although Write/Edit
   are not exposed and Plan's own instructions say it cannot write memory.

Discovered while scoping (same editor path that a Plan copy goes through):

4. **Modes editor tool list is stale** (`web/lib/mode-form.ts:8-11`): lists removed
   `Memory*` tools and lacks `BashOutput`, `KillShell`, `TodoWrite`, `AskUserQuestion`.
   `parseModeForm` filters exposure through it, so opening + saving a duplicated
   Full-access/Edit mode silently drops those four tools; selecting a `Memory*` switch
   produces a file the server rejects. The form also ignores any new mode key, so it would
   silently drop the new `mcpExposure` field from (1).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | MCP exposure restriction is a mode property that survives duplication and protects custom read-only modes by default | P1 |
| 2 | Bundled mode instructions describe actual behavior | P2 |
| 3 | Memory guidance matches the exposed tools (read-only variant) | P2 |
| 4 | Modes editor round-trips every server-valid mode field and tool | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [MCP exposure as a mode property](./phase-01-mcp-exposure-property.md) | Completed |
| 2 | [Modes editor lossless round-trip](./phase-02-modes-editor.md) | Completed |
| 3 | [Instructions and memory guidance truthfulness](./phase-03-instructions-memory-guidance.md) | Completed |
| 4 | [Docs and whole-change verification](./phase-04-docs-verification.md) | Completed |

Dependencies: 2 depends on 1 (field name/values). 3 is independent. 4 last.

## Constraints

- No commit, no live server restart, no live data mutation under `~/.dnt-harness/data`.
- Preserve unrelated dirty working-tree changes (`git status` shows in-flight work in
  `src/web/server.ts`, `src/capabilities/fs/*`, web files).
- Existing durable `session/mode` snapshots (no new field) must keep their current
  behavior: a legacy Plan snapshot stays read-safe.
- Exposure stays a hard ceiling; nothing here may widen what an existing bundled mode exposes.

## Success Criteria

- [x] `plan-copy` (duplicated through `ModesService.duplicate`) hides `mcp__s__create_issue` exactly like Plan.
- [x] A custom mode exposing only Read/Glob/Grep with no `mcpExposure` key gets read-safe MCP exposure.
- [x] `mcpExposure: all` explicitly re-opens MCP for a custom read-only mode (opt-in works).
- [x] Zero-tool mode with `mcpExposure: all` still refuses every MCP call.
- [x] `description` survives duplicate and editor save.
- [x] Legacy Plan snapshot without `mcpExposure` still refuses mutating MCP tools.
- [x] Bundled Full access / Edit / Ask exposure matrix unchanged (regression test).
- [x] Modes editor: parse→serialize of every bundled mode is lossless (tools + `mcpExposure` + `outOfGrant`).
- [x] Plan context contains read-only memory guidance; write modes keep the write guidance.
- [x] `npm run typecheck` exit 0; targeted suites pass.

## Red Team Review

Session 2026-10-08. Reviewers: Assumption Destroyer (gpt-6.1-sol), Failure Mode Analyst
(gpt-6-sol). Security Adversary (opus-5-5) did not finish within ~20 min and was cancelled; the
security lens was covered by the lead's own pass (headless exposure gate, child scopes,
pending re-evaluation) — see Validation Log.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| F1 | High | Explicit `mcpExposure: all` evaluated before empty `toolExposure` re-opens MCP for zero-tool modes (`execution-authority.ts:105`, `builder.ts:390-391`) — raised by both | **Accept** → Phase 1 rule 1 unconditional + test |
| F2 | Med | `description` is a valid key but dropped by `parseModeFile` (`service.ts:401-408`) and the form; duplicate/edit loses it | **Accept** → Phases 1–2 |
| F3 | Med | "needs no approval" prose untrue for headless (`headless.ts:201-206`) | **Accept (modified)** → "may proceed without a separate approval" |
| F4 | Med | Derivation silently narrows existing read-only sessions without snapshot/hash change | **Reject (documented)** — fail-closed narrowing matches the existing "narrowing denies unstarted calls" contract; documented in Phase 4 |
| F5 | Med | Mode switch between `rootModeOf` (`server.ts:2208`) and exposure snapshot (`server.ts:2236`) can pair old instructions with new schemas | **Reject (out of scope)** — pre-existing, cosmetic: every call is still gated by pre-execute + final-gate against current authority. Logged as follow-up |
| F6 | Med | Stamped Ask-before-changes sessions keep old instructions | **Accept as note** — old text is stricter than behavior; no migration |

### Whole-Plan Consistency Sweep

- Rule order in Phase 1 updated (zero first); success criteria extended with zero+`all` case.
- `description` added consistently to Phase 1 (server) and Phase 2 (form) and the round-trip fixture.
- Phase 3 wording changed; Phase 4 docs step covers the F4 behavior note.
- No remaining contradictions.

## Validation Log

Session 1 (auto; user instructed "không cần hỏi lại" — decisions taken on the recommended option).

### Verification Results
- Claims checked: 12 · Verified: 12 · Failed: 0 · Unverified: 0 · Tier: Standard
- `execution-authority.ts:110` `mode.id === 'plan'` ✔; `service.ts:168-174` duplicate = serialize→save ✔;
  `mode-form.ts:8-11` stale list ✔ (`MemorySearch…` vs `bundled.ts:102-105`); `tsconfig.web.json`
  includes only `web/` but `DangerousCommandsPanel.tsx:27` already imports `src/harness/guard/defaults.ts`,
  and `bundled.ts` imports only a type → web import is safe ✔; `memoryGuidance` call sites
  `server.ts:2321`, `headless.ts:236` ✔; existing test `tests/harness/memory-tools.spec.ts:75` ✔;
  Plan denial regex tests `tests/web/permission-hardening.spec.ts:140,272,401` ✔.
- Security self-pass: headless gate (`headless.ts:180-184`) uses `toolExposure.includes` and
  registers no MCP tools → no MCP path; children resolve root mode via `rootModeOf`
  (`server.ts:1907`) → derivation applies to children; pending approvals re-run the host
  resolver (`policy.ts:457`) which calls `exposureRefusal` → newly hidden MCP calls are denied.

### Decisions
1. Default for custom modes without Write/Edit/Bash → `read-safe` (Recommended, fail-closed). ✔
2. Zero ceiling is unconditional (F1). ✔
3. No versioning of derivation for legacy snapshots (F4). ✔
4. Memory exception prose uses "may" instead of porting to headless (F3). ✔
