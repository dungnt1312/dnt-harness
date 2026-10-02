---
title: Mini-dsh session routing and persistence hardening
date: 2026-09-15
summary: "Fixed canonical session routes, tool-root parity, and race-safe durable summaries; verified and deployed."
---

# Mini-dsh session routing and persistence hardening

## What happened

The durable session `session-mu0u80ifpaldt1` exposed three related production defects: the web client had no browser-addressable session route, Bash used the host process cwd while filesystem tools used the bound project root, and `summary.json` stayed stale after normal events and restart.

## Root causes and fixes

- Added canonical History API routes: `/workspaces/:workspaceId` and `/workspaces/:workspaceId/sessions/:sessionId`, including direct-link validation, refresh, Back/Forward, first-send, deletion, workspace switching, invalid-route fail-closed behavior, and SSE gating until workspace membership is proven.
- Made `ToolExecution.root` authoritative for Bash cwd, matching Read/Glob/Write/Edit/Grep and preserving no-root fail-closed behavior.
- Reworked session durability around a monotonic append chain. Summary writes now follow durable prefixes, coalesce per session, rebuild when stale, and cannot get ahead of `events.jsonl`.
- Hardened observer failure isolation, concurrent load/delete, append/delete, shutdown draining, summary title-prefix consistency, stale first-send navigation, and failed-first-send draft retention.
- Added project binding to the rebuildable summary projection so lazy restart listings retain the session's project without eagerly loading history.

## Verification

- `npm test`: 411/411 passed.
- `npm run test:browser`: 14/14 passed.
- `npm run typecheck`: passed.
- `npm run build:web`: passed; assets are root-relative for deep routes.
- `git diff --check`: passed, aside from existing line-ending warnings.
- Restarted pm2 process `dnt-harness`; status online.
- Live deep route returned HTTP 200.
- Live session listing restored `projectId: project-mu0r2u0g8q0bdk`.
- Live summary repaired to `eventCount: 1874`, `lastSeq: 1874`, and the correct project binding.

## Decision

Keep `events.jsonl` canonical. Browser routes use IDs and native History API; no router dependency was added. Summary metadata remains rebuildable and backward-compatible with old summaries.

## Next steps

No commit or push was performed. Existing unrelated dirty-tree changes remain intact.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
