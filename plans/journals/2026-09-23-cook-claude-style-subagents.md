---
title: Cook Claude-style subagents
date: 2026-09-23
summary: "Recovered a server.ts lost in a stash pop, then shipped phases 0–6: executor-only children, role system prompts, last-message results, prose briefs, opt-in inheritance, four roles, per-conversation caps."
---

# Cook Claude-style subagents

## What happened

Before any plan work, the baseline was broken: `npm run typecheck` reported 37 errors because `src/web/server.ts` had lost ~1,000 uncommitted lines (control-plane auth, yolo, policy retirement, child approval relay, model pinning). Dangling commits showed why: a concurrent guard session ran `git stash push` at 2026-09-22 17:18 (`491654d`, "temp stash branch changes"), committed guard work touching `server.ts`, and the stash never came back whole. A three-way merge (base `31b0f8f`, stash, HEAD) with 10 hand-resolved conflicts restored it (`5c96100`); the provider default-model removal in `e9716d3` was intentional and kept. Lesson: never `git stash`/`reset` a shared working tree with uncommitted work — and never write files through PowerShell 5.1 `Get-Content`/`Set-Content` (it mojibaked UTF-8 once here; reversed via cp1252 round-trip).

## What shipped

- **Lifecycle**: spawn preflight (packet, ownership, depth) then a synchronous reservation; compensation before the parent's `agent/child-spawn` commit point, a durable failed child after it. Active map holds live children only; settled handles rebuild from durable logs (cached, bounded) and require the commit record. Child sessions answer 409 to messages and never join the root registry. Root delete cancels its children.
- **Prompt**: `buildContext` takes `child`; subagent preamble + capability line from the request's own schemas + pinned role instructions replace BASE/mode prose. Children see only their ceiling, never `Agent`.
- **Result**: last tool-free assistant message, 16k cap with marker + flag, `filesTouched` from Read/Write/Edit; honest errors naming the log otherwise.
- **Brief**: `prompt` primary, durable `brief` (legacy `objective` reads), `SpawnError('packet')` → 400; Workbench brief textarea.
- **Inheritance**: messages-only projection captured at spawn, wrapped `parent-context`, droppable before memory/history, hash + size durable only; `inheritable` native key with a `dnt-harness` import dialect and Settings switch + copy-to-customize.
- **Roles/caps**: explorer, worker, reviewer, verifier with selection-rule descriptions; per-workspace role cache; honest writer-lease guidance; 3 per conversation / 12 host / 8 attempts per turn.

## Verification

typecheck 0; vitest 931 pass, 10 pre-existing failures (same on baseline); build ok; pm2 restarted and live roles verified. Review findings and dispositions: `plans/reports/code-reviewer-260923-1027-claude-style-subagents.md`.

## Open

Pre-existing unit failures (session-model, composer, workspace-isolation) and the `chat-shell` e2e `/api/auth/state` fixture gap belong to the auth/MCP work.
