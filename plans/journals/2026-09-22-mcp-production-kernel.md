---
title: MCP production kernel
date: 2026-09-22
summary: "No-replay MCP calls, generation fence, and qualified containment"
---

# MCP production kernel

Implemented the safety kernel of `plans/260922-1139-mcp-production-completion` on `feat/workbench-terminal`.

`tools/call` is sent once. A lost response is `indeterminate` and the same invocation is not dispatched again. The intent is fsynced to the workspace execution journal before the send. Saving or importing a server does not start it; Enable does. Config, secret, and OAuth revocation fence that workspace's clients before the write is acknowledged. A retired stdio transport latches `stopped` before spawn and kills a child if stop wins the race.

v1 config stays readable. Migration quarantines omitted `enabled` and rewrites legacy oauth as an external token. Hard process limits are refused: this build does not apply a Windows Job Object or a Linux cgroup. Managed OAuth is authorization-code plus PKCE for the local fixture profile. Logout closes that principal's SSE streams.

Node `tsc --noEmit` passed. The MCP, G5, control-plane, host-guard, and terminal vitest suites that were run passed. The plan stays in progress: there is no 24-hour canary, no named release approver, and no hard containment claim.

## Files

- `src/harness/mcp/` execution journal, coordinator, migration, ownership lock, outbound policy, OAuth
- `src/web/server.ts` auth scope, generation fence, stream close on logout
- `src/harness/mcp/client.ts` single dispatch and spawn latch

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
