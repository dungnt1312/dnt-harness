---
title: Subagent resume/steer and background children
status: completed
branch: feat/subagent-resume-background
created: 2026-10-15
---

# Subagent resume/steer and background children

## Outcome
The root model can keep talking to a child after spawn (queue or steer a running child,
resume a finished one, also after a server restart), and can spawn a background child that
outlives the spawning turn and reports back by waking the root.

## Decisions (user, 2026-10-15)
- Running child: the model picks `delivery: "queue" | "steer"` (default queue).
- Background is opt-in: `spawn.background ?? frontmatter background ?? false`, fixed for the child's life.
- A background child that settles while the root is idle wakes the root (queued behind a busy turn, never steers).
- Resume works after restart from a durable snapshot; `inheritedContext` is persisted (already bounded by MAX_INHERITED_CHARS).
- A durable notification left pending by a crash waits like any pending input (nothing auto-runs after restart).
- Constraints: one level, no concurrency caps, no worktree isolation.

## Non-goals
Nested delegation, SendMessage between siblings, worktree isolation, a separate SendMessage tool,
re-queuing undelivered notifications after restart.

## Design summary (incorporates GPT-6.1-sol review)
- Snapshot: `session/child-meta` additionally carries `instructions`, `definitionSource`, `toolCeiling`,
  `skills`, `grants`, `inheritedContext`, `background`. Resume rebuilds `childOf` only from it; the live
  exposure gate still intersects with the root's current mode. Legacy children (no `toolCeiling`) cannot resume.
- Runs: the parent log gets `agent/child-resume { childSessionId, parentTurnId, runId }`; results of a resumed
  run carry `runId`. The current result is the last `agent/child-result` AFTER the latest admission
  (spawn or resume). Resume is only admitted once the prior run's result is durable, so ordering is sound.
- Child-side run boundary: a resume writes `input/queued { origin: 'parent', resume: true }` into the child log
  first (durable). Report digest, partial, files and terminal-turn checks read only events from that boundary.
- Each run is a fresh `InternalChild` charged to the CALLING turn through the same admission writer and
  closing fence as spawn; `settledHandles` is invalidated.
- Messages to a running child are durable `input/queued { origin: 'parent' }` in the child log before
  `enqueueAccepted`/`steer`. A queued/dispatching child refuses messages (brief must run first); `uncertain` refuses.
- Background: not tracked in `turnChildren`, skipped by `resolveForRootCompletion`; still cancelled by root Stop
  and root deletion. On natural settle the executor notifies the host unless a `wait` is watching that child
  (then wait delivers). Stop-cancelled or undeliverable reports stay owed and are handed back at the next
  root turn join (and to `wait` without ids).
- Notification input: `input/queued { origin: 'child' }` admitted as `user/message { origin: 'continuation' }`;
  hidden from the queued-user projection like hook rewakes; never expanded as a prompt.

## Phases
| # | Phase | Status |
|---|---|---|
| 1 | [Resume and message](phase-01-resume-and-message.md) | completed (5d5cf90, fda347d) |
| 2 | [Background children](phase-02-background-children.md) | completed (8936bbf, fda347d) |

## Acceptance criteria
- AC1 `message` to a running child with `queue` is answered in a later child turn; with `steer` the current turn ends `steered`.
- AC2 `message` to a completed child starts a new run whose handle reports only the new run's result.
- AC3 After a restart (new executor on the same storage) a completed child can be resumed with its pinned ceiling;
  widening the role file does not widen the resumed child.
- AC4 A resume admitted but interrupted by restart reads `interrupted`, never the previous run's `completed`.
- AC5 A legacy child without snapshot, an `uncertain` child, a foreign child, and a closing turn are refused.
- AC6 A background child survives the spawning turn's completion; root Stop cancels it without waking the root.
- AC7 A background child that settles while the root is idle wakes it once with its report; a watched child is
  delivered by `wait` only; an undeliverable report is handed back at the next turn join.
- AC8 Frontmatter `background: true` is enforced (no longer an unsupported warning); spawn `background:false` overrides it.
- `pnpm test`, `pnpm run typecheck`, `pnpm run build:web` pass (pre-existing flaky tests reported separately).

## Result (2026-10-15)
All AC1–AC8 covered by tests/harness/subagent-resume.spec.ts, tests/harness/subagent-background.spec.ts,
tests/web/agent-background-wake.spec.ts and web projection specs. Typecheck and build:web clean; full suite
4346/4349 with one known-flaky test per run (server-g1 steer / cross-root-lease), green in isolation.
GPT-6.1-sol reviewed design and code; code findings fixed in fda347d.

## Known limits (accepted)
- Owed background reports live in memory: after a restart an undelivered report is not re-offered by join/wait
  without ids (still readable via list/wait by id). Persist delivery per run if this matters.
- A notification already queued is not withdrawn if a later `wait` by id also returns the same report.
