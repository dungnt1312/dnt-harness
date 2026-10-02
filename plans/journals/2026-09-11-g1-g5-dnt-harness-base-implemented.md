---
title: G1-G5 dnt-harness base implemented
date: 2026-09-11
summary: "Full G1-G5 base: file-first storage, workspace isolation, modes/context/skills/memory, bounded multi-agent, MCP + hooks, Settings UI; 286 tests green, pm2 restarted"
---

# G1-G5 dnt-harness base implemented

## What happened

Implemented the full approved G1–G5 base for dnt-harness from the validated plan at
`plans/260909-1550-g1-g5-dnt-harness-base/`, phase by phase with a code-review gate
after each. Final state: 286 vitest tests green, both TypeScript configs clean
(`tsconfig.json`, `tsconfig.web.json`), `npm run build:web` green, and the pm2
process `dnt-harness` (port 3082) restarted so the running host serves the new code.

Delivered per goal:

- **G1 — reliable harness.** File-first storage: `workspaces/<ws>/sessions/<id>/events.jsonl`
  canonical with schema version, monotonic seq, one writer per session, fsync
  durability barriers before acknowledging input / recorded side effects /
  terminal state, torn-tail quarantine (`events.jsonl.partial-*`) plus repair, and
  middle corruption blocking continuation with a line-numbered error.
  `summary.json` is rebuildable-only (rebuilt at boot when missing).
  Turn states (queued/running/cancelling/completed/failed/cancelled/interrupted/limit)
  with truthful terminal reasons, restart recovery (open turns → `interrupted`,
  tool calls without results → explicitly marked `recovery: true` unknown-outcome
  records, undecided approvals → `invalidated`), no replay, bounded input queue
  with stable `inputId`s and `clientRequestId` dedup resolved against the canonical
  log, exactly three live controls (model next request, permission next gate, mode
  next gate + next context), centralized limits, and the six canonical tools
  Read/Write/Edit/Glob/Grep/Bash with granted-root containment (realpath/junction,
  creation paths), `expectedSha256` conflict detection, ambiguous-Edit rejection,
  and a real-Bash adapter (Git Bash on Windows, `DNT_HARNESS_BASH`, `where git`
  fallback, WSL stubs skipped, actionable disable when absent) with verified
  process-tree cleanup.
- **G2 — workspaces and isolation.** `WorkspaceService` (CRUD, idempotent legacy
  migration, project binding with mutual-containment overlap rejection, empty-only
  delete, last-workspace guard, app-local writer lease), per-workspace session
  stores, ownership fixed at creation with foreign ids indistinguishable 404s, and
  per-workspace live controls resolved through the ambient agent scope.
- **G3 — modes, context, skills, memory.** Five bundled modes plus strict
  workspace-owned custom mode files; one mode-driven context builder (the single
  assembly path) with per-request manifest (mode/model revisions, source hashes,
  budget estimate flag, history seq ranges, checkpoint hash, omissions), budget
  measured from the final wrapped texts with the documented trim order
  (skills → memory → oldest completed turns) and loud failure; `history: none`
  keeps the current turn's tool loop; manual + threshold automatic compaction at
  completed boundaries into immutable checkpoints; skills (on-demand `Skill` tool,
  hash-pinned turn-local snapshots, no duplicate injection) and memory (Markdown
  entries, five tools, keyword search, hash conflict detection); lower-trust
  content (workspace instructions, skills, memory, compaction summaries) wrapped
  with neutralized closing delimiters.
- **G4 — agents and compatibility.** Workspace-owned definitions with strict
  validation (bundled Explorer/Worker, copy-to-customize), bounded one-level
  delegation through the same loop and builder (3 active / 8 per root turn,
  per-child step budgets, task packets, isolated child sessions, durable
  spawn/result relationship events), child tool ceiling = mode exposure ∩
  definition ∩ spawn grant enforced at every gate (Explorer cannot gain Bash by a
  parent mode switch), awaited writer handoff, sticky cancellation with awaited
  settlement, root completion resolving active children, restart recovery of child
  relationships, Claude import with blocking-field quarantine and a version-pinned
  Codex adapter that reports unsupported semantics.
- **G5 — MCP and hooks.** Strict workspace-owned `mcp.json`/`hooks.json` with
  AES-256-GCM `secrets.json` (user-scoped master-key ACL verified on Windows,
  fail-closed if it cannot be established), MCP 2025-06-18 stdio plus Streamable
  HTTP (initialize + `notifications/initialized`, monotonic ids, incremental SSE
  with id matching, pagination, Origin, session DELETE, abort cancellation
  notification), workspace-isolated dynamic `mcp__server__tool` schemas, default
  ask + `mcp__server__*` wildcards + host `blockedTools`, `requiresUserInteraction`
  hard-ask, one process per (workspace, server) with singleton connection promises
  and cancellation on disable/close, CPU/memory/lifetime watchdogs, 3-attempt
  retry, closed/open/half-open circuit breaker with automatic re-registration,
  secret rotation reconnecting affected servers before responding, and command
  hooks (PreToolUse block/rewrite re-entering the full gate chain, PostToolUse
  validate with hashed flags, UserPromptSubmit inject, SessionStart/End audit,
  PreCompact gate) with durable hashed audit events.
- **UI.** Settings became tabbed (Providers | Agents | MCP | Hooks | Secrets) with
  role cards, task-packet spawn, child cards with wait/cancel, MCP status and
  lifecycle controls, a validated hooks JSON editor, and masked secret management.

## Decision

Three production requirements drove most of the rework after the first green suite:

1. **Durability of terminal state must be a barrier, not a callback.** `session/event`
   is append visibility; only `session.durable()` is the durability acknowledgment.
2. **Authorization must see the final arguments.** Hook rewrites run in a separate
   `tools/rewrite` phase, then the complete `tools/pre-execute` chain runs against
   the rewritten call, and only then is the durable `tool/call` recorded — so
   approvals, policy, ceilings, and audit all bind the same intent that precedes the
   side effect.
3. **Child authority is an intersection, never a union.** MCP tools in particular
   require an explicit spawn grant; a grant narrows and can never widen a
   definition.

Deferred explicitly, and left unchecked in the plan rather than claimed:
interactive browser OAuth authorization (only OAuth access-token references are
supported), pinned upstream Claude/Codex compatibility fixtures, and the G6 plugin
marketplace.

## Next steps

- Replace the inline compatibility shape tests with fixtures sourced from the pinned
  Claude docs and Codex commit, with golden normalized outputs.
- Add the interactive OAuth authorization flow (device/browser) on top of the
  existing access-token reference support.
- G6 brainstorming: plugin packages and marketplace on the MCP/hooks foundation.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
