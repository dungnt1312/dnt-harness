---
title: MCP production phases advanced
date: 2026-09-22
summary: "Corrupt journal fails closed, 409 keeps the MCP form, phase 10-11 stay blocked"
---

# MCP production phases advanced

Continued `plans/260922-1139-mcp-production-completion` without claiming production signoff.

A corrupt execution-journal record now poisons the journal before `open()` throws, so `dispatchToolCall` returns `error` and does not send. Restart recovery still closes an unresolved intent as `indeterminate` and does not dispatch it. Migration dry-run stays mutation-free and the backup manifest stores a sha256. Protocol tests reject a repeated `tools/list` cursor, link-local and private targets, and plain HTTP off loopback.

The MCP settings form keeps the draft when save returns 409 and reloads the list. Web REST `fetch()` stays inside `web/lib/api.ts`; a static test fails if another TypeScript file calls it.

Phase 1 is completed. Phases 2-9 are in progress with the criteria that already have tests checked. Phases 10 and 11 are blocked: this run cannot produce a 24-hour canary, a named approver, a Windows Job Object, a Linux cgroup, or cross-platform CI artifacts.

`tsc --noEmit` passed for the server and the web project. The touched vitest files passed.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
