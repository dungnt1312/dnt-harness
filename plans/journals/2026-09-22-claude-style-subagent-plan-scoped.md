---
title: Claude-style subagent plan scoped
date: 2026-09-22
summary: "Locked the subagent plan: four roles, brief form, caps only; token accounting deferred."
---

# Claude-style subagent plan scoped

## What happened

Updated `plans/260921-1457-claude-style-subagents/` after the status review. Phases 1-3 still ship together, and phase 3 now states that the Workbench spawn form's primary field is a prose brief. The bundled catalog is locked at explorer, worker, reviewer, and verifier. `references` stay named paths in the brief; `inherit: brief` is a separate opt-in conversation projection with no tool results.

## Decision

Phase 6 is per-conversation capacity only (`phase-06-per-root-caps.md`). Token accounting left this plan; the contract seed is in `plan.md` under Deferred. Parallel tool batches, writer worktrees, background children, depth greater than one, and resume stay closed until phases 1-3 are live. Child approval relay already shipped on 2026-09-21 and is not a phase here.

## Next steps

Cook phases 1-3 together when implementation starts. `ak plan validate` passed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
