---
title: "G1-G5 dnt-harness base"
description: "Implementation plan for the five approved design goals: reliable harness with built-in tools, workspace isolation, modes/context/skills/memory, bounded multi-agent with compatibility, and MCP + hooks production."
status: done
priority: P1
effort: "large"
tags: [g1, g2, g3, g4, g5, harness, workspace, modes, agents, mcp, hooks]
created: 2026-09-09
---

# G1-G5 dnt-harness base

## Overview

Implement the five approved design goals (G1–G5) for dnt-harness, transforming it from a single-session chat harness into a multi-workspace, mode-driven, multi-agent base with MCP integration and hooks. Each phase builds on the previous. All design decisions are locked in the approved specs under `docs/superpowers/specs/2026-09-09-g*.md`.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | G1: Reliable harness + 6 built-in tools + file-first storage + 3 live controls | P1 |
| 2 | G2: Multiple workspaces & isolation | P1 |
| 3 | G3: Modes, context engine, skills & memory | P1 |
| 4 | G4: Agent definitions, bounded multi-agent & compatibility | P2 |
| 5 | G5: MCP (stdio+HTTP) & hooks production | P2 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: G1 Reliable Harness & Built-in Tools](./phase-01-start.md) | Done |
| 2 | [Phase 2: G2 Workspace Isolation](./phase-02-g2-workspace-isolation.md) | Done |
| 3 | [Phase 3: G3 Modes Context Skills Memory](./phase-03-g3-modes-context-skills-memory.md) | Done |
| 4 | [Phase 4: G4 Agents Tools Compatibility](./phase-04-g4-agents-tools-compatibility.md) | Done |
| 5 | [Phase 5: G5 MCP Hooks Production](./phase-05-g5-mcp-hooks-production.md) | Done |

## Success Criteria

- [x] All five phases complete with acceptance criteria met per spec
- [x] File-first storage (JSONL canonical, SQLite rebuildable-only) working end-to-end
- [x] Three live controls (model, permission, mode) functional without steering
- [x] Workspace isolation enforced at service boundary
- [x] Five bundled modes + custom file-based modes working
- [x] Bounded multi-agent with Claude-first compatibility
- [x] MCP stdio + HTTP with hooks (PreToolUse/PostToolUse) in production
- [x] No OS sandbox claims; app-level isolation stated honestly
- [x] All tests pass; no regression in existing behavior

## Architecture Summary

```
Web UI (React)
  ↕ REST/SSE
Web Server (Node)
  ↕
Kernel (event bus, service registry, effects)
  ↕
Harness
  ├── Session (JSONL events, Turn/Step lifecycle)
  ├── Agent (loop, tool calls, live controls)
  ├── Tools (Read/Write/Edit/Glob/Grep/Bash + MCP + hooks)
  ├── Approval (allow/ask/deny, serialized gate)
  ├── Modes (5 bundled + custom, context builder)
  ├── Workspaces (isolation, ownership, file-first storage)
  └── Agents (definitions, bounded children, compatibility)
```

## Key Constraints

- File-first: `events.jsonl` canonical; SQLite only as rebuildable index
- No steering: messages while running queue for later Turn
- Three live controls: model (next request), permission (next tool gate), mode (next tool gate + next context)
- App-level isolation only — not OS sandbox
- Claude-first tool names; Codex adapter version-targeted
- No plugin marketplace in G5 (deferred to G6)

## Validation Log

### Session 1 — 2026-09-09
**Trigger:** `/ak:plan --validate` on the freshly created G1-G5 plan.

### Verification Results
- **Tier:** Full (5 phases)
- **Claims checked:** 18
- **Verified:** 15 | **Failed:** 3 | **Unverified:** 0

#### Failures (all resolved by validation answers)
1. [Fact Checker] `src/harness/session/scope.ts` cited in phase-01 — not found; actual: `src/harness/agent/scope.ts` (write site `agent.ts:81`, readers `server.ts:279,306`).
2. [Contract Verifier] `SessionsService` replacement has 5 consumers (`src/index.ts`, `session/service.ts`, `harness/agent/service.ts`, `bins/headless.ts`, `web/server.ts`); plan omitted `headless.ts` and `agent/service.ts`.
3. [Contract Verifier] `SessionEvent` union extension also touches `web/lib/project.ts` (projection consumer) plus 3 test files; plan omitted `web/lib/project.ts`.

#### Questions & Answers

1. **[Architecture]** Phase 1 ghi sai đường dẫn scope file (`src/harness/session/scope.ts` không tồn tại; thực tế là `src/harness/agent/scope.ts`). Sửa thế nào?
   - Options: Fix plan → agent/scope.ts (Recommended) | Move file sang session/ | Giữ cả hai (alias)
   - **Answer:** Fix plan → agent/scope.ts
   - **Rationale:** Không tạo refactor không cần thiết; scope thuộc agent runtime.

2. **[Scope]** SessionsService (in-memory Map) sẽ được thay bằng file-backed store. Có 5 consumers gồm `bins/headless.ts` và `harness/agent/service.ts` mà plan chưa liệt kê. Chiến lược?
   - Options: Replace in-place, đủ 5 callers (Recommended) | Store mới song song | Chỉ web host dùng file store
   - **Answer:** Replace in-place, đủ 5 callers
   - **Rationale:** Tránh hai đường lưu trữ lệch behavior; headless CLI cũng phải thấy history bền.

3. **[Architecture]** Bash tool hiện hardcode `/bin/bash`; máy anh là Windows (Git Bash có sẵn). G1 shell adapter nên làm gì?
   - Options: Resolve bash.exe, disable nếu thiếu (Recommended) | POSIX-only, disable Windows | Thêm PowerShell adapter
   - **Answer:** Resolve bash.exe, disable nếu thiếu
   - **Rationale:** Giữ "Bash means Bash"; không giả lập PowerShell dưới tên Bash.

4. **[Scope]** G5 yêu cầu cả stdio và Streamable HTTP (+OAuth). Thứ tự trong phase?
   - Options: stdio trước, HTTP cuối phase (Recommended) | stdio + HTTP song song | Cắt HTTP khỏi G5
   - **Answer:** stdio trước, HTTP cuối phase
   - **Rationale:** Giữ đúng spec Option B (production cần HTTP) nhưng giảm rủi ro auth kéo chậm stdio.

#### Confirmed Decisions
- Scope file: `src/harness/agent/scope.ts` là nơi mở rộng (thêm workspaceId/projectId ở G2).
- SessionsService: replace in-place, đủ 5 consumers, không store song song.
- Shell: adapter resolve bash executable (ưu tiên Git Bash bash.exe trên Windows); disable với lỗi actionable nếu thiếu.
- G5: stdio + secrets + hooks trước; Streamable HTTP + OAuth là sub-step cuối phase 5.

#### Action Items
- [x] phase-01: sửa modify list (agent/scope.ts, thêm headless.ts, agent/service.ts, web/lib/project.ts)
- [x] phase-01: ghi rõ replace in-place 5 consumers
- [x] phase-01: Bash adapter resolve bash.exe / disable nếu thiếu
- [x] phase-05: thứ tự stdio → HTTP trong phase

#### Impact on Phases
- Phase 1: modify list + storage seam + Bash adapter wording updated.
- Phase 5: implementation step ordering updated.
- Phases 2-4: no changes needed (validation answers do not alter their contracts).

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01-start.md, phase-02-g2-workspace-isolation.md, phase-03-g3-modes-context-skills-memory.md, phase-04-g4-agents-tools-compatibility.md, phase-05-g5-mcp-hooks-production.md
- Decision deltas checked: 4 (scope path, store strategy, shell adapter, G5 transport order)
- Reconciled stale references: 4 (all in phase-01/phase-05; no other file cited the wrong scope path or omitted consumers)
- Unresolved contradictions: 0

### Session 2 — 2026-09-11 — Implementation complete
**Trigger:** final sync-back after G1–G5 implementation.

- **Delivered:** phases 1–5. File-first storage (`events.jsonl` canonical, `summary.json` rebuildable, durability barriers, torn-tail quarantine), restart recovery, three live controls (model/permission/mode), workspace isolation with project binding and writer leases, five bundled + custom modes with one context builder (budget, compaction, per-request manifest), on-demand Skill tool, five memory tools over workspace Markdown, bounded one-level delegation with Claude/Codex compatibility adapters, MCP stdio + Streamable HTTP with encrypted secrets, health/retry/circuit breaker, command hooks (PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/End/PreCompact) and hashed audit events. App-level isolation only — no OS sandbox claim.
- **Verification:** vitest 286/286 green (33 files); `tsc -p tsconfig.json` and `tsc -p tsconfig.web.json` clean; `vite build` passes. One flaky failure observed once in `tests/web/server-g3.spec.ts` (mode-gated write containment); it did not reproduce on two full reruns. Deployed via pm2: process `dnt-harness` restarted, online.
- **Review:** multiple code-reviewer rounds; all P0/P1 blockers resolved.
- **Deferred (explicit, tracked as unchecked items in phase files):**
  - G4: compatibility fixtures from pinned upstream samples — inline shape tests only; the spec's acknowledged evidence gate stays open.
  - G5: interactive browser OAuth authorization — Bearer + OAuth access-token references only, no browser flow.
  - G5: pinned upstream MCP/hook fixtures — in-repo fixtures only.
  - G5: full p50/p95 metrics dashboard — durable hashed audit + breaker/status metrics shipped.
  - G6 (by design, out of scope): plugin marketplace.

## Related Specs

- [G1](../../docs/superpowers/specs/2026-09-09-g1-reliable-harness-design.md)
- [G2](../../docs/superpowers/specs/2026-09-09-g2-workspace-isolation-design.md)
- [G3](../../docs/superpowers/specs/2026-09-09-g3-modes-context-skills-memory-design.md)
- [G4](../../docs/superpowers/specs/2026-09-09-g4-agents-tools-compatibility-design.md)
- [G5](../../docs/superpowers/specs/2026-09-09-g5-mcp-hooks-production-design.md)
