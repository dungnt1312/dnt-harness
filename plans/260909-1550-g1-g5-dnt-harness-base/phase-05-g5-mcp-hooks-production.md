---
title: "Phase 5: G5 MCP Hooks Production"
status: done
---

# Phase 5: G5 MCP Hooks Production

## Overview

Workspace-scoped MCP servers (stdio + Streamable HTTP with OAuth/secrets) and hooks (PreToolUse block/ask/rewrite, PostToolUse validate, UserPromptSubmit inject, SessionStart/End + PreCompact audit/gate). Production hardening: secrets isolation, health/retry/circuit breaker, resource limits, permission model, audit/observability. No plugin marketplace (deferred to G6).

## Requirements

- [x] MCP stdio + Streamable HTTP transports; HTTP+SSE legacy not built
- [x] Workspace-owned config: `mcp.json`, `secrets.json` (encrypted), `hooks.json`
- [x] MCP lifecycle: initialize → tools/list → tools/call → health check → retry → circuit breaker → disconnect
- [x] Tool naming: `mcp__<server>__<tool>`; reserved built-in names protected
- [x] Permissions: default ask for all MCP tools; per-tool allow/ask/deny; host blockedTools not widenable
- [x] Isolation: one OS process per (workspace, server) with CPU/memory/wall-time limits; workspace isolation absolute
- [x] Hooks: PreToolUse (block/ask/allow + updatedInput), PostToolUse (validate), UserPromptSubmit (inject), SessionStart/End + PreCompact (audit/gate)
- [x] Hook safety: direct command+args spawn, strict timeouts, no MCP/model recursion, onFailure policy
- [x] Audit: every MCP call + hook run durably recorded with hashed args/results
- [x] Import: Claude `.mcp.json` / Codex TOML with provenance; no auto-enable or spawn

## Architecture

```
mcp.json (workspace)
  → server spawn (stdio subprocess / HTTP connection)
  → initialize → tools/list → register via ToolsService
  → tools/call through tools/pre-execute waterfall
  → health check / retry / circuit breaker
  → disconnect on Stop/restart/disable

hooks.json (workspace)
  → PreToolUse  → tools/pre-execute (block/ask/allow + updatedInput)
  → PostToolUse → tools/post-execute (validate)
  → UserPromptSubmit → context injection before model request
  → SessionStart/End, PreCompact → audit/gate
```

- **Config:** `mcp.json` (servers, transport, auth, timeouts, allowedTools), `secrets.json` (encrypted, `${VAR}` references), `hooks.json` (event bindings). Strict validation; invalid → surfaced error, no partial execution.
- **Secrets:** Encrypted at rest (OS keychain or file encryption). Never plain in `mcp.json`. Rotation reconnects without app restart.
- **Lifecycle:** Pin MCP spec `2025-06-18`. `initialize` → `tools/list` snapshot → `tools/call`. Timeout per call. Circuit breaker: 5 fails → disable 5 min → auto-reconnect with jitter. No auto-restart mid-Turn.
- **Permissions:** Every MCP tool through `tools/pre-execute`. Policy key = `mcp__server__tool` or wildcard. Default ask. `requiresUserInteraction` → always ask. `allowedTools` is exposure filter, not bypass.
- **Hooks:** `command` type only. Payload JSON via stdin. Exit codes follow Claude convention (0 allow, 2 block, 1 non-blocking). `updatedInput` re-binds approval to rewritten args + re-enters serialized final gate. Rewritten inputs still pass mode exposure + blockedTools + workspace policy.
- **Audit:** `events.jsonl` records `mcp/call` and `hook/run` with server, tool, argsHash, resultHash, durationMs, isError. No raw secrets in logs.

## Related Code Files

- Create: `src/harness/mcp/config.ts`, `src/harness/mcp/client.ts`, `src/harness/mcp/transport-stdio.ts`, `src/harness/mcp/transport-http.ts`, `src/harness/mcp/secrets.ts`, `src/harness/mcp/health.ts`, `src/harness/hooks/config.ts`, `src/harness/hooks/runner.ts`, `src/harness/hooks/audit.ts`
- Modify: `src/harness/tools/service.ts`, `src/harness/approval/policy.ts`, `src/harness/agent/agent.ts`, `src/harness/session/events.ts`, `src/web/server.ts`, `web/lib/api.ts`
- Delete: none

## Implementation Steps

1. **Config layer:** `mcp.json` + `secrets.json` + `hooks.json` schemas, validation, workspace-owned loading. Import from Claude `.mcp.json` / Codex TOML with provenance.
2. **Secrets:** Encrypted store, `${VAR}` resolution, rotation without restart. Never plain export.
3. **MCP client (stdio):** Subprocess spawn, JSON-RPC framing, initialize/tools-list/tools-call, timeout, cancellation, disconnect with verified cleanup. Stdio + secrets + hooks land first in this phase.
4. **MCP client (HTTP):** Streamable HTTP transport, OAuth/Bearer auth, session handling, Origin validation. Implemented as the final sub-step of this phase, after stdio/secrets/hooks are stable.
5. **Health/retry/breaker:** Health check every 30s, retry 3x with backoff, circuit breaker 5 fails → 5 min disable → auto-reconnect with jitter.
6. **Tool registration:** Map `mcp__<server>__<tool>` into `ToolsService.register()`. Reserved name protection. Mode ceiling enforcement.
7. **Permissions:** Default ask, per-tool policy, host blockedTools, `requiresUserInteraction`, serialized final gate for approvals.
8. **Hooks runner:** `command` type spawn, payload JSON via stdin, exit code handling, `updatedInput` rewrite with re-binding, timeout, onFailure policy.
9. **Audit:** Durable events for MCP calls + hook runs with hashed args/results. Metrics (latency, error rate, breaker state).
10. **UI:** Server list (status/breaker/enable/disable), tool exposure matrix, hook bindings, approval banner, secrets management (masked), inspector integration.

## Todo

- [x] Config schemas + validation + import with provenance
- [x] Secrets encrypted store + rotation
- [x] MCP stdio client + lifecycle + cleanup
- [x] MCP Streamable HTTP + Bearer/OAuth access-token refs + session handling
- [ ] Interactive browser OAuth authorization — deferred: config validates an OAuth access-token reference (provider + encrypted secret) and the HTTP transport sends Bearer, but there is no interactive browser flow to obtain or refresh tokens
- [x] Health/retry/circuit breaker
- [x] Tool registration + naming + reserved names
- [x] Permissions (default ask, per-tool, blockedTools)
- [x] Hooks runner (command type, payload, exit codes, updatedInput)
- [x] Durable hashed audit events + breaker/status metrics (full p50/p95 dashboard deferred)
- [x] UI (server list, tool matrix, hook bindings, secrets) — Settings → MCP/Hooks/Secrets panels
- [x] Windows subprocess cleanup verification
- [x] Fixture tests for MCP spec + hook contract (in-repo fixtures: `tests/fixtures/mcp-stdio-server.mjs`, `tests/fixtures/hook-command.mjs`; protocol pinned to MCP 2025-06-18)
- [ ] Pinned upstream MCP/hook fixtures — deferred: fixture coverage runs against in-repo fakes only; no pinned upstream vendor samples
- [x] CPU/memory/lifetime watchdogs on stdio with process-tree kill (delta-based CPU sampling; application control, not OS sandbox)

## Success Criteria

- [x] G5 acceptance criteria 1-13 all pass (see spec)
- [x] stdio + HTTP servers initialize, list tools as `mcp__server__tool`, appear in request schemas
- [x] Same MCP tool respects per-tool and wildcard policies; deny not widenable
- [x] Timeout/server death → truthful failed result, no hang; no orphan subprocess
- [x] Explorer has zero MCP tools; Worker only sees explicitly granted tools
- [x] PreToolUse hook can block; PostToolUse can flag secrets; UserPromptSubmit can inject
- [x] Hook execution independent of Bash tool/shell adapter
- [x] Secrets not in plain; rotation reconnects without restart
- [x] Retry + circuit breaker + health check work; breaker recovery re-registers tools
- [x] Chat sends no MCP schemas; Plan exposes none unless allowlisted
- [x] Restart does not auto-recover failed servers; interrupted calls marked
- [x] Invalid config surfaced, no partial execution; import records provenance
- [x] Audit events contain hashed args/results, duration, identity; no raw secrets

## Risk Assessment

- **Windows subprocess cleanup:** Orphan processes after Stop/restart. Mitigate: verified kill + wait; same gate as G1 Bash.
- **HTTP auth complexity:** OAuth flows vary by provider. Mitigate: start with Bearer token; OAuth as incremental addition; fixture-verify each provider.
- **Hook escalation:** `updatedInput` rewrite could bypass gates. Mitigate: re-bind approval to rewritten args; re-enter serialized final gate; mode exposure + blockedTools + workspace policy still enforced.
- **MCP server side effects:** Server writes files outside app lease. Mitigate: documented as out-of-app guarantee; UI states limitation honestly.
