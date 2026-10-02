---
title: "Phase 1: G1 Reliable Harness & Built-in Tools"
status: done
---

# Phase 1: G1 Reliable Harness & Built-in Tools

## Overview

Reliable harness with Turn/Step lifecycle, file-first JSONL durable storage, three live controls (model, permission, mode), approval semantics, cancellation, and six foundational built-in tools (Read, Write, Edit, Glob, Grep, Bash).

## Requirements

- [x] Session/Turn lifecycle: queued/running/cancelling/completed/failed/cancelled/interrupted + activity tracking + terminal reason
- [x] File-first storage: `events.jsonl` canonical, one writer per session, durability barriers, `summary.json` derived only
- [x] Recovery: history recovery without tool replay, unknown outcome for missing results, recovery record
- [x] Cancellation: AbortSignal propagation to provider, approval waiters, tools, child processes; no auto-replay
- [x] Input queue: stable IDs, client request dedup, ordered queue for later Turn, no mid-Turn steering
- [x] Three live controls: model (next request), permission (next tool gate), mode (next tool gate + next context)
- [x] Approval: bound to exact args, expiry, serialized final gate, deny never widenable
- [x] Six tools: Read, Write, Edit, Glob, Grep, Bash — Claude-style names, root-aware, output bounded

## Architecture

- **Storage layer:** File-first `workspaces/<ws>/sessions/<id>/events.jsonl` + `summary.json`. Replace `SessionsService` in-memory Map with file-backed service. Writer serialization, schema version, monotonic seq, stable execution IDs. `quarantine` for truncated tail.
- **Lifecycle:** Extend `SessionEvent` union (turn/step states, approval events). Single active Turn per session invariant.
- **Live controls:** `agent/request` pipeline checks current mode/model/permission at each gate (not pinned). `deriveMessages()` remains sole projection.
- **Tools:** Normalize lowercase legacy names → canonical `Read/Write/Edit/Glob/Grep/Bash`. Validate, gate, execute, post-execute through `tools/pre-execute` / `tools/post-execute` waterfall. Shell adapter with explicit executable/cwd/env.

## Related Code Files

- Create: `src/harness/storage/file-session-store.ts`, `src/harness/storage/events-jsonl.ts`, `src/harness/tools/definitions.ts`
- Modify: `src/harness/session/service.ts`, `src/harness/session/events.ts`, `src/harness/agent/agent.ts`, `src/harness/agent/scope.ts`, `src/harness/tools/service.ts`, `src/harness/approval/policy.ts`, `src/web/server.ts`, `src/bins/headless.ts`, `src/harness/agent/service.ts`, `web/lib/project.ts`, `web/lib/api.ts`, `src/capabilities/fs/tools.ts`, `src/capabilities/shell/bash.ts`
- Delete: none

<!-- Updated: Validation Session 1 - scope file is src/harness/agent/scope.ts (not session/scope.ts); SessionsService replaced in-place with all 5 consumers (incl. bins/headless.ts, harness/agent/service.ts); SessionEvent union change includes web/lib/project.ts consumer; Bash adapter resolves bash.exe on Windows, disables with actionable error when absent -->

## Implementation Steps

1. **Storage seam:** Define `SessionStore` interface, implement file-backed `events.jsonl` with writer lock, seq, schema version, tail repair, durability barriers. Add `summary.json` rebuild. Keep lazy loading. Replace `SessionsService` in-place: all 5 consumers (`src/index.ts`, `src/harness/session/service.ts`, `src/harness/agent/service.ts`, `src/bins/headless.ts`, `src/web/server.ts`) updated together; no parallel in-memory store remains.
2. **Lifecycle & recovery:** Add Turn states, `interrupted` marking on restart, approval invalidation, recovery record synthesis for missing tool results.
3. **Live controls:** Thread model/mode resolution per request, permission check at each tool-start gate, pending approval re-evaluation. Record revision per request/execution.
4. **Input queue:** Stable pending input IDs, request-ID dedup, ordered queue display, no steering injection.
5. **Six tools:** Standardize names, root-aware execution (project root from scope), containment checks including creation paths, conflict detection for Write/Edit, output caps, Bash adapter that resolves the actual Bash executable (prefer Git Bash `bash.exe` on Windows), disables the tool with an actionable error when absent, and verifies spawn error/timeout/cleanup.
6. **Tests:** Fake providers, controllable tools, injected clocks for lifecycle/failure; real temp-filesystem and shell integration for the six tools. Cover all 16 G1 acceptance criteria.

## Todo

- [x] Storage seam + JSONL writer + tail repair + summary rebuild
- [x] Turn lifecycle + recovery + interrupted marking
- [x] Cancellation propagation (provider/approval/tool subprocess)
- [x] Input queue + dedup + ordering
- [x] Three live controls (model/permission/mode gates)
- [x] Six tools with root-aware containment + Bash adapter
- [x] Integration tests (filesystem + shell on supported platform)
- [x] Verify Windows process cleanup (no orphans)

## Success Criteria

- [x] G1 acceptance criteria 1-16 all pass (see spec)
- [x] Normal chat + tool loop persists and reopens after restart
- [x] Stop during tools does not start further tool/model requests
- [x] Reload during approval restores pending state
- [x] Crash between side effect and result → unknown/interrupted without replay
- [x] Bash means Bash; unsupported env disables clearly; spawn failure settles
- [x] No late event revives terminal Turn
- [x] No dual authoritative writes; SQLite only if rebuildable

## Risk Assessment

- **Platform durability:** fsync semantics differ on Windows vs Linux. Mitigate: verify on target FS; document limits; use temp+sync+rename for replacements.
- **Bash on Windows:** `/bin/bash` hardcode vs Windows adapter. Mitigate: explicit adapter detection; disable with actionable error.
- **JSONL tail corruption:** Partial last line on crash. Mitigate: preserve/quarantine truncated record before repair; never silently skip middle corruption.
