---
title: Permission policy layers and approval UX
date: 2026-09-21
summary: Split workspace overrides from mode defaults, persist policy.json, fix yolo/wildcard/Always-allow, and relay child approvals to the parent stream.
---

# Permission policy layers and approval UX

## What happened
Live permission, `--yolo`, Always allow, and the `*` editor row did not match the kernel gate. CLI-seeded overrides froze Ask-before-changes onto Full access; GET meta returned the overlay so Save/Always allow snapshotted mode defaults; MCP ignored `defaultMode`; child asks never reached the open conversation.

## Decision
Workspace `policy` is overrides only (`policy.json`). Effective = mode defaults overlaid by overrides, unless `--yolo` (unnamed tools allow; host blocks, exposure, child ceilings, deny, and interactive MCP still apply). `modeFor` is exact → `mcp__server__*` → `*` → defaultMode. Always allow writes one override and lets re-evaluation settle; interactive tools hide the action. Child questions and `approval-settled` frames relay onto the parent SSE. Already-aborted signals cancel before waiting.

## Verification
Focused g1/g2/g3/g4/g5 + product-ui/workflow tests passed. Full vitest: 716 passed; pre-existing MCP stdio `EPIPE` after watchdog remains.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
