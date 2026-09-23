---
title: Subagent lifecycle follow-up
date: 2026-09-23
summary: "Reviewed existing subagent implementation and hardened terminal outcome, ownership, persistence cleanup, and inherited-context labels."
---

# Subagent lifecycle follow-up

## What happened
The Claude-style subagent plan's phases 0–6 were already implemented and committed, but an independent review identified that a failed child turn could look completed, direct child lookup lacked parent ownership validation, and terminal persistence failure could release capacity despite lacking a durable record. A second review caught retained capacity after root deletion. Inherited-context truncation could also lose its speaker label.

## Decision
Keep the accepted child contract. Classify terminal turns from their durable reason; validate ownership on direct lookup and listing; retain the capacity reservation on terminal persistence failure, releasing it only after successful root deletion; preserve an explicit speaker-labelled truncation fragment. Added regression coverage in g4-subagent-contract and agent-inheritance specs. No unrelated work was overwritten.

## Next steps
Complete final full-suite, typecheck, build, and independent review. The PM2 server was not restarted here and remains stale relative to concurrent uncommitted server changes; verify live only after coordinating deployment. No commit was requested. AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
