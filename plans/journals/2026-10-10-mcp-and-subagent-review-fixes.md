---
title: MCP and subagent review fixes
date: 2026-10-10
summary: Implemented nine review fixes plus related OAuth and audit ownership hardening; regression coverage added.
---

# MCP and subagent review fixes

## Changes
Fixed malformed stdio JSON handling, single-flight journal opening, OAuth revoke/refresh and reauthorization races, refresh-token preservation, audit-fault reporting/repair ownership, and managed OAuth connection tests. Serialized manual delegation with conversation admission; Stop closes keepOpen turns without draining queued input; report delivery tracking no longer evicts active-turn ownership at 4096 IDs. Fixed root-deletion cleanup regression found by full suite.

## Verification
Final typecheck and git diff --check passed. Full suite with default workers: 2520 passed, 2 failed, 1 skipped (product-copy and delivery:steer). Full suite with --maxWorkers=2: 2521 passed, 1 failed, 1 skipped. Remaining product-copy failure flags × at web/components/common/Toast.tsx:102 and reproduces on archived HEAD 34b27c7. delivery:steer passed five isolated repetitions and reduced-concurrency full suite; root cause of default-suite timing failure remains unconfirmed. Baseline pnpm invocation failed because its node_modules was a symlink; direct Vitest invocation succeeded in running the baseline checks.

## Status
No commits, deployment, or frontend changes. Build/browser and live-provider validation not run. AgentWiki publish skipped. Follow up separately on product-copy false positive and full-suite steer timing failure.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
