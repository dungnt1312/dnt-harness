---
title: Validate Claude-style subagents plan
date: 2026-09-22
summary: "Full-tier validation hardened lifecycle, result, brief, inheritance, role, and capacity contracts with zero unresolved contradictions."
---

# Validate Claude-style subagents plan

## What happened

Validated `plans/260921-1457-claude-style-subagents/` against the current uncommitted working tree at Full tier. The audit sampled 90 claims: 58 verified, 26 failed, and 6 unverified. Most failures were expected future behavior, but the pass also found stale server references, incomplete contract consumers, lifecycle ownership/orphan issues, direct child-session identity loss, durable brief gaps, ambiguous final-report semantics, inheritance/checkpoint contradictions, a cross-workspace role-cache leak, and stale writer-lease claims.

## Decisions

Eight user decisions were recorded in `plan.md`: terminal tool-free reports only; durable `brief` with legacy `objective` reads; messages-only inheritance; Agent tool + HTTP inheritance with audit metadata; direct child messages blocked; lifecycle hardening added as phase 0; writer guidance follows the current asymmetric root-turn/child-call lease boundary; and `inheritable` round-trips through native dnt-harness definitions but not the Claude adapter.

## Plan changes

Added `phase-00-lifecycle-hardening.md` and rewired all phase dependencies. Reconciled result/error memoization, normalized brief rendering/storage, inheritance snapshot/refusal/budget plumbing, manifest inspector consumers, bundled-role catalog and bounded workspace cache, and per-root/global capacity semantics. Updated writer claims against the current working tree: registered roots hold leases through turn settlement; child handoff releases the root lease; unregistered children use per-call fallback and have no whole-run lock.

## Validation outcome

The whole-plan sweep reread all 8 plan files, checked 9 decision deltas, reconciled 4 stale-reference groups, and found 0 unresolved contradictions. `ak plan validate` passed. The plan was reindexed and activated. No source code, tests, build, or deployment was run because this was plan validation only.

## Next step

Start implementation in a fresh context with:

`/ak:cook C:/Users/DungNguyen/workspace/dnt-harness/plans/260921-1457-claude-style-subagents/plan.md`

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
