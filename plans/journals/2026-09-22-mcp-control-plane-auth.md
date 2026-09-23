---
title: MCP control-plane auth tightened
date: 2026-09-22
summary: "Non-loopback bind refused; SSE checks session generation before replay"
---

# MCP control-plane auth tightened

Continued `plans/260922-1139-mcp-production-completion` phase 2 on the existing control-plane code.

`createWebServer` now refuses every non-loopback bind, including callers that pass `unsafeNetworkBind`. This build has no authenticated TLS profile, so that flag cannot open the port. Session and terminal SSE check the authenticated generation before the first snapshot, and a `Last-Event-ID` of `gen=` from another generation is rejected as JSON 401 before the stream starts. Logout still closes streams for that principal.

`docs/web.md` no longer says the host has no authentication. It distinguishes auth-off loopback from `--auth`, and states the same-user and same-origin limits.

Phase 1 criteria were already checked, so its status is completed. Phase 2 is in progress: default-deny, pairing, CSRF, bearer separation, approval binding, and the non-loopback refusal are in place. Still open: a static ban on direct `fetch()`, the paired-browser pass, and a production assertion that test bootstrap cannot mint a session.

Verified with `tsc --noEmit -p tsconfig.json` and vitest on control-plane auth, host guard, terminals, and the MCP production stack (27 tests).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
