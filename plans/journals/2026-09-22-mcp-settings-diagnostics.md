---
title: MCP settings diagnostics
date: 2026-09-22
summary: "List diagnostics, enable confirmation, OAuth single-use deposit, SIGTERM shutdown"
---

# MCP settings diagnostics

The MCP server list now reports containment wording, runtime generation, whether an audit fault is open, and discovered tool names. The settings panel shows those facts and asks for confirmation before Enable, stating that the process runs as the user and is not a sandbox.

OAuth code deposit claims a transaction once, so a second overlapping callback is rejected. The web bin treats SIGTERM the same way as SIGINT: one graceful close, then a forced exit if shutdown is already underway. Stdio request timers are cleared when the call settles.

Node typecheck passed. MCP stack, OAuth, G5, settings panel, and scope-race tests passed (58). The plan is still in progress: no Job Object or cgroup, no 24-hour canary, and no named release approver.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
