---
title: Subagent resume/message and background children
date: 2026-10-15
summary: "Agent action:message (queue/steer/resume from pinned snapshot) and background children that wake the root, on feat/subagent-resume-background"
---

# Subagent resume/message and background children

## What happened
Compared dnt-harness delegation with the Claude Code 2.1.293 bundle (`~/.local/share/claude/versions/2.1.293`): Claude has background agents (`async_launched`, auto-background), `SendMessage` resume/steer, nesting depth 3 and a 20-child concurrency cap. We adopted resume/steer and background only; kept one level, no caps, no worktree isolation.

Implemented on `feat/subagent-resume-background` (worktree `.worktrees/subagent-resume-background`):
- `ChildExecutor.message()` + `Agent action:"message"` (`delivery: queue|steer`). Finished children run again from the `session/child-meta` snapshot (instructions, toolCeiling, skills, grants, inheritedContext, background), never the live role file.
- Runs are scoped by the new `agent/child-resume` event; `currentRun()` replaced `latestChildResult()` so a resume cut by a restart reads `interrupted`, not the previous run's `completed`.
- Background children (`spawn.background ?? frontmatter background ?? false`) skip the turn join/cleanup; their report is queued as `input/queued origin:'child'` via `queueHostInput` (generalized from `queueHookRewake`) and admitted as a `continuation` message.

## Review findings that mattered
GPT-6.1-sol design review found the missing per-run identity (results, digests, owed state all keyed by child, not run). Code review found: a message racing a run's end could be stranded (fixed: wait for settlement, enqueue in the same tick as the running check); background report could be delivered twice when a join ran during the async host delivery (fixed: claim before await, give back on failure); role `background` default skipped for HTTP spawns (fixed: normalize in executor); web projection ignored `agent/child-resume`.

## Decision
Accepted limit: owed background reports are in memory only; after restart they are not re-offered by join/wait-without-ids. Matches "nothing auto-runs after restart".

## Next steps
Merge after user review; consider persisting per-run delivery state if lost reports after crash become a real problem. Flaky in full suite: server-g1 steer, cross-root-lease (pre-existing, green in isolation).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
