---
title: "Phase 3: G3 Modes Context Skills Memory"
status: done
---

# Phase 3: G3 Modes Context Skills Memory

## Overview

Five bundled modes (Chat, Ask before changes, Edit automatically, Plan, Full access) + custom file-based modes, one mode-driven context builder, budget-aware assembly, compaction, skill loading, and file-based memory. Live mode switching at tool gate + next context.

## Requirements

- [x] Five bundled modes + custom Markdown/frontmatter modes (workspace-owned)
- [x] Mode has four fields: instructions, context sources, tool exposure, permission defaults
- [x] Mode live control: next tool-start gate + next model request context reassembly
- [x] Context builder: single pipeline, disabled loaders skipped, lower-trust content cannot override policy
- [x] Budget: context window − output reserve − safety margin; model change recomputes; trim order defined
- [x] History settings: none/recent/compact; `none` retains current Turn tool loop
- [x] Compaction: manual + auto at completed boundaries; immutable JSONL; checkpoints with range/provenance
- [x] Skills: workspace-local + bundled read-only; `Skill` tool on-demand; no classifier; Turn-local active
- [x] Memory: Markdown per fact/topic; workspace/project scoped; pinned + on-demand retrieval; explicit writes
- [x] Context inspector + manifest per request

## Architecture

```
Model Request
  ← Context Builder (mode-driven)
      ├── System + mode instructions
      ├── Workspace/project instructions (if enabled)
      ├── History (per history setting)
      ├── Active skills (if on-demand)
      ├── Pinned/retrieved memory (if enabled)
      ├── Tool results + tool schemas
      └── Budget check → trim/compact/fail
```

- **Mode resolution:** Per-request, workspace-scoped. Mode file validated at selection; not hot-reloaded mid-Turn.
- **Tool exposure:** Mode defines hard ceiling; permission defaults overlay; session override cannot grant unexposed capability.
- **Live switching:** Next tool-start gate enforces new mode exposure + permission defaults; next model request reassembles context. Pending approvals re-evaluated per G3 spec.
- **Skills:** Catalog bounded + searchable; `Skill` tool call or explicit user selection loads scoped instructions + resources. No duplicate injection.
- **Memory:** `memory_search`, `memory_read`, `memory_create`, `memory_update`, `memory_forget` tools. Pinned loading and on-demand retrieval are independent toggles.

## Related Code Files

- Create: `src/harness/modes/service.ts`, `src/harness/modes/types.ts`, `src/harness/modes/bundled.ts`, `src/harness/context/builder.ts`, `src/harness/context/budget.ts`, `src/harness/context/compaction.ts`, `src/harness/skills/service.ts`, `src/harness/memory/service.ts`, `src/harness/memory/tools.ts`
- Modify: `src/harness/agent/agent.ts`, `src/harness/tools/service.ts`, `src/harness/approval/policy.ts`, `src/harness/session/events.ts`, `src/web/server.ts`, `web/lib/api.ts`
- Delete: none

## Implementation Steps

1. **Mode system:** Define mode schema (four fields), bundled modes, custom mode file loading/validation, mode resolution per request.
2. **Context builder:** Single pipeline assembling sources per mode config. Disabled loaders skipped. Budget calculation with model-aware limits. Trim order. Clear failure on unfit.
3. **History settings:** `none`/`recent`/`compact` with current-Turn tool loop retention.
4. **Compaction:** Manual + auto trigger at completed boundaries. Checkpoint files with range/provenance. No side effects. No auto-promotion to memory.
5. **Skills:** Workspace-local + bundled discovery, `Skill` tool, on-demand loading, hash validation, Turn-local lifetime, mode-gated exposure.
6. **Memory:** Markdown file CRUD, pinned loading, on-demand retrieval, five native tools, scope checks, conflict detection, forget semantics.
7. **Inspector/manifest:** Per-request manifest with mode/model revisions, source hashes, ranges, budget, omission decisions. UI renders truthfully.
8. **UI:** Mode selector, skills/memory CRUD, error surfaces. No visual builder.

## Todo

- [x] Mode schema + bundled modes + custom file loading
- [x] Context builder pipeline + budget + trim order
- [x] History settings (none/recent/compact)
- [x] Compaction (manual + auto) + checkpoints
- [x] Skill discovery + loading + mode gating
- [x] Memory files + five tools + pinned/retrieval
- [x] Context inspector + manifest
- [x] Mode selector UI + skills/memory CRUD
- [x] Live mode switching tests (mid-batch, approval re-eval)

## Success Criteria

- [x] G3 acceptance criteria 1-13 all pass (see spec)
- [x] Five bundled modes exist; Chat sends no tool schemas, no environment loaders
- [x] Mode switch mid-Turn: current request/tool finishes; unstarted calls gate against new mode; no resurrection; no double-execute
- [x] Disabled loaders contribute nothing to any request
- [x] Budget accounts for schemas + output reserve; model change recomputes; unfit fails clearly
- [x] `history: none` excludes previous Turns while current Turn tool loop works
- [x] Compaction preserves original JSONL; checkpoints carry range/provenance; no side effects
- [x] Skill/memory files validated; conflicts surfaced; invalid never executed
- [x] Every request has manifest; inspector matches

## Risk Assessment

- **Budget estimation accuracy:** Token counts vary by provider. Mitigate: configurable limits, labeled estimates, safety margin, clear failure over silent truncation.
- **Compaction quality:** Summaries may lose critical context. Mitigate: preserve references, no auto-promotion, manual override.
- **Skill content injection:** Malicious skill content could override policy. Mitigate: lower-trust classification, no permission grant from skill content, mode exposure ceiling.
