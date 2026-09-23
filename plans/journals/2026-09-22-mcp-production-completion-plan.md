---
title: MCP production completion plan
date: 2026-09-22
summary: Created and red-teamed an 11-phase safety-first plan to bring the working MCP implementation to a qualified production release.
---

# MCP production completion plan

## What happened

Audited the existing MCP implementation and confirmed real stdio/Streamable HTTP execution works, but identified production blockers around post-dispatch retries, ambient environment inheritance, config/runtime drift, unauthenticated local control plane, protocol/input bounds, process containment, OAuth, diagnostics, and real-stack verification.

Created `plans/260922-1139-mcp-production-completion/` with 11 executable phases. The plan preserves current approval, mode, child-agent, workspace, and global-tool-registration contracts.

## Decisions

- Safety kernel first: at most one automatic client dispatch; ambiguous post-dispatch outcomes are `indeterminate`; no universal exactly-once claim.
- Keep the agent's canonical durable `tool/call` barrier and add a separate workspace MCP execution journal before transport dispatch.
- Authenticate the whole local REST/SSE/upgrade control plane before adding new mutation APIs.
- Add v1/v2 compatibility, one data-home ownership lock/fencing epoch, transactional mutation recovery, and a minimum safe rollback floor before changing defaults.
- Direct file edits are drift/import inputs, not a live production API.
- Hard process/resource claims require Windows Job Objects or Linux cgroup v2; unsupported platforms remain qualified best effort.
- Managed OAuth is limited to a pinned authorization-code + PKCE compatibility profile; optional MCP resources/prompts/roots/sampling/legacy SSE require separate plans.
- MCP phases own their specific Settings/transcript/accessibility acceptance while reusing the existing product design contract.

## Validation

The plan passed `ak plan validate`, parses as 11 phases and 107 checklist items, was reindexed, and is the active worktree plan. Multiple red-team passes corrected sequencing, rollback, ownership, OAuth callback, journal operations, containment, UI ownership, and rollout evidence gaps.

## Next steps

Execute from Phase 1 through Phase 11. Do not implement optional capability packs inside this production milestone. Canonical plan: `plans/260922-1139-mcp-production-completion/plan.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
