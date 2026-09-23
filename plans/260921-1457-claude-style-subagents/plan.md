---
title: "Claude style subagents"
description: "Make a child agent an actual agent: its own system prompt, a free-form brief, and a defined deliverable — then four roles and per-conversation caps."
status: completed
priority: P1
effort: ""
tags: [multi-agent, g4, context, delegation]
created: 2026-09-21
supersedes: [260921-1414-agent-delegation-tool]
---

# Claude style subagents

## Overview

`plans/260921-1414-agent-delegation-tool/` shipped the delegation **plumbing** —
lifecycle, capacity caps, project-lease integration, per-child model pinning, tool ceilings,
and restart recovery. Most of that plumbing works, but validation found lifecycle-boundary
defects that phase 0 fixes before this plan builds the **agent** contract on top.

A child in mini-dsh today runs with the root's own system prompt, receives a rigid
four-field form, is told nothing about what it is or what it owes back, and hands the
parent a front-truncated concatenation of its own narration. Delegation therefore costs
3× the tokens and returns less than reading the files inline would.

Analysis with the code evidence:
`plans/reports/research-260921-1451-claude-style-subagents.md`.

This plan fixes the **contract** first, in the order that each step pays off, and leaves
the scaling work (parallel tool batches, worktrees, background children, depth > 1) where
the earlier research correctly left it: separate plans.

## The four defects this plan repairs

1. **The role's instructions never reach the system prompt.** `BuildContextInput`
   (`src/harness/context/builder.ts:32-52`) has no child field and the only production
   call site (`src/web/server.ts:1457-1469`) passes none. `scope.childOf` is read for
   tool ceilings, MCP denial and skill preload — never for the prompt. The definition
   body arrives as text inside the first user message via `renderPacket`
   (`src/harness/agents/executor.ts:524-536`).

2. **So the mode prose outranks the role, and they conflict.** An `explorer` spawned to
   grep for a symbol is told by its system prompt: *"You are a planning assistant… the
   plan itself is the deliverable"* (`src/harness/modes/bundled.ts:53`). A `worker` whose
   ceiling excludes `Bash` is told *"full access… shell commands run with host
   privileges"* (`bundled.ts:67`).

3. **The child is never told its final message is the deliverable.** `BASE_SYSTEM`
   (`builder.ts:115`) is the same sentence a root gets. Nothing says it is a subagent,
   that the user will not see its intermediate work, or that it cannot delegate.

4. **The report keeps the narration and drops the conclusion.** `withResult`
   (`executor.ts:477-489`) concatenates **every** non-empty `assistant/message` and cuts
   at `.slice(0, 4_000)` — from the front. A child's answer is its last message. And
   `fileReferences` scrapes `args['path']`, which `Glob` does not have at all
   (`src/capabilities/fs/tools.ts:343`) and which for `Grep` is a *directory*
   (`tools.ts:370`) — so the real file references, which live in the tool **output**,
   can never be found by that scrape.

Defects 3 and 4 are one defect: there is no contract, so the child narrates and the
parent truncates the narration.

Validation Session 1 (2026-09-22) added a **prerequisite phase 0** that hardens the
existing lifecycle boundary — spawn ownership, failure compensation, bounded executor
indexes, and an executor-only child session. The new prompt, brief, and result
contracts below all stand on it.

## Decisions (accepted 2026-09-22)

These close the open questions in
`plans/reports/research-260921-1451-claude-style-subagents.md` and the proposal that
followed the status review, plus the eight questions answered in Validation Session 1
(recorded under [Validation Log](#validation-log)). Cook this plan as written here.

1. **Ship phases 0–3 as one delivery.** Phase 0 hardens the lifecycle boundary the
   other phases rely on; phase 1 without phase 2 leaves a child that knows how to end
   and a parent that still truncates it. Phase 3 includes the Workbench spawn form in
   `web/components/workbench/AgentRunsPanel.tsx`: the primary field is a prose brief,
   and the four-field packet stays in the disclosure.
2. **The bundled catalog stops at four roles:** `explorer`, `worker`, `reviewer`,
   `verifier`. Extra specialists are workspace copies, not more bundled roles in this
   plan. `action: 'catalog'` returns those four **plus valid workspace custom roles** —
   the bundled set is what stays capped.
3. **`references` and `inherit: 'brief'` both stay.** `references` are the paths or
   notes the caller names in the brief. `inherit` is an opt-in, character-capped
   projection of recent parent **messages only** — no tool calls or results, no
   checkpoint summary — captured synchronously at spawn, wrapped as lower-trust
   context. The `Agent` tool and the HTTP route accept `inherit`; the Workbench gets no
   control in this plan. It does not replace `references`.
4. **Phase 6 is per-conversation capacity only.** Token accounting left this plan. The
   seed for a later plan is under [Deferred](#deferred). Do not fold it back while
   cooking.
5. **Do not open the scaling plans from this cook** — parallel tool batches, a worktree
   per writer, background children that wake the driver, depth greater than one, or
   resume. Revisit only after phases 0–3 are live and delegation is actually used.
6. **Child approval relay is already shipped** (journal
   `plans/journals/2026-09-21-permission-policy-and-approvals.md`). Questions and
   `approval-settled` frames already ride the parent SSE with `childSessionId`. This
   plan does not touch that path.
7. **The report is the child's last tool-free message.** Only a completed child may have
   a `result`: the last non-empty `assistant/message` that carries **no** `toolCalls`.
   Cancelled, failed, interrupted, and completed-without-terminal-report children have no
   result and an explicit error pointing at the full durable log. That result-or-error
   derivation is memoized with a `resultComputed` sentinel. `filesTouched` lists
   `Read`/`Write`/`Edit` file paths only — Glob and Grep directory scopes are omitted.
   Truncation is an explicit marker plus a flag, surfaced in both the Workbench and chat.
8. **The brief is durable.** `session/child-meta` and `agent/child-spawn` carry
   `brief`; readers and projectors keep accepting legacy `objective`. One helper selects
   the trimmed non-empty `prompt`, otherwise the trimmed non-empty `objective`; rendering
   and both durable writers reuse that normalized string. Packet semantics are validated
   once in `ChildExecutor.spawn` as a typed `SpawnError('packet')`; the `Agent` tool and
   HTTP parse shape only, and HTTP maps `'packet'` to 400. Supplying both non-empty fields
   uses `prompt` and returns a note.
9. **State the writer boundary exactly — no child-run serialization claim.** Registered
   root Agents hold the project lease from their first write-capable call until
   `agent/turn-settled`. A write-capable child triggers a handoff that releases the root's
   current lease, but the child is not in the server session registry and therefore
   acquires/releases per call; the root can later reacquire. There is no lease covering a
   child's whole run and no child priority after handoff. Guidance says not to fan out
   writers or continue concurrent root writes; use read-only roles for parallel work.
   Child turn-level leasing, queueing, and worktrees remain separate future work.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | The delegation lifecycle is safe by construction: ownership-checked spawns, compensated failures, bounded executor indexes, and an executor-only child boundary | P1 |
| 2 | A child's system prompt makes it that role, and states its deliverable | P1 |
| 3 | The parent receives the child's actual answer, or an honest failure with a full-log pointer | P1 |
| 4 | The root, and the Workbench form, brief a child in prose; the four-field form still works | P1 |
| 5 | A child can start from a bounded slice of the parent conversation (messages only), while named references stay in the brief | P2 |
| 6 | The bundled catalog is exactly `explorer`, `worker`, `reviewer`, and `verifier` | P2 |
| 7 | Active child caps are per conversation, with a separate host ceiling | P3 |

## Phases

| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 0 | [Harden the child lifecycle boundary](./phase-00-lifecycle-hardening.md) | Done | — |
| 1 | [The child is a real agent](./phase-01-child-as-agent.md) | Done | 0 |
| 2 | [The result contract](./phase-02-result-contract.md) | Done | 0, 1 |
| 3 | [A free-form brief](./phase-03-free-form-brief.md) | Done | 0, 1 |
| 4 | [Context inheritance](./phase-04-context-inheritance.md) | Done | 0, 1, 3 |
| 5 | [A real role library](./phase-05-role-library.md) | Done | 0, 1, 2 |
| 6 | [Per-root caps](./phase-06-per-root-caps.md) | Done | 0 |

Order: ship 0–3 together before any other phase — phase 0 is the prerequisite the
prompt, brief, and result contracts stand on. Then 5, then 4. Phase 6 depends only on
phase 0; do it when two conversations delegating at once matters. Each phase must pass
`npm run typecheck` and its targeted suite before the next starts.

## Constraints / non-goals

- **Prompt text never grants authority.** Definition instructions move into the system
  block as workspace-owned configuration, exactly as mode instructions already are
  (`builder.ts:140-141`). They can never widen the exposed schema set or the enforced tool
  ceiling; child/MCP filtering, the child ceiling check (`src/web/server.ts:1280-1293`),
  host policy, and approval remain the authority boundary, unchanged by prompt text.
- **One context assembly path.** Everything goes through `buildContext`. No second
  builder for children.
- **One level of delegation stays.** Depth > 1 is out of scope; the three existing layers
  (definition ceiling, the gate's explicit deny at `server.ts:1282-1284`,
  `SpawnError('depth')`) are untouched.
- **Out of scope, and not to be opened from this cook.** Unchanged from
  `plans/reports/research-260921-1403-model-driven-delegation.md`, plus the cuts in the
  2026-09-22 decisions: parallel tool batches in `src/harness/agent/agent.ts:405-455`; a
  git worktree per write-capable child; background children with a driver wake
  (`src/harness/agent/agent.ts:129`); nesting depth > 1; resuming a finished or
  interrupted child; token accounting on the LLM seam.
- **Writer coordination is asymmetric and does not serialize a child's whole run.** A
  registered root Agent holds the project lease from its first write-capable call until
  `agent/turn-settled` (`src/web/server.ts:732-782`). Spawning a write-capable child
  triggers `agent/child-writer-handoff`, which releases the root's current lease
  (`server.ts:784-794`; `executor.ts:319-329`). Because child Agents are not entries in the
  server `sessions` registry, their calls take the fallback per-call acquire/release path;
  the root can also reacquire on a later call. This plan must not claim child-run or
  parent/child serialization. Guidance says: do not fan out writers or keep the root
  writing concurrently; use read-only roles for parallel work. Child turn-level leasing,
  queueing, and worktrees stay future work.
- **The async tool shape is kept.** `spawn | wait | list | cancel | catalog` stays. The
  sequential step loop makes it the only shape that fans out, and the analysis found the
  shape was never the problem.
- Existing `tests/harness/**` and `tests/web/**` stay green. The HTTP route's four-field
  `task` body stays accepted (`tests/web/server-g4.spec.ts` uses it in 13 places, plus
  one route caller in `tests/web/server-session-model.spec.ts`).

## Success Criteria

- [x] A direct message/run request against a session carrying `session/child-meta` is
      rejected before a normal Agent is created; a foreign-workspace/project spawn is
      rejected before child state exists; a post-relationship launch failure settles a
      durable failed child instead of orphaning a session (details in phase 0).
- [x] A child's request system prompt contains its definition's instructions and the
      deliverable rule, and does **not** contain the mode's role prose.
- [x] An `explorer` spawned in Plan mode is not told the deliverable is a plan.
- [x] A child that narrates for 10 messages returns its **last** message as the report,
      and a message that also carried tool calls is never taken as the deliverable.
- [x] A child that produced no terminal message reports that honestly — whether it is
      completed, cancelled, failed, or interrupted, it has no `result` and an explicit
      error naming its session log; the result-or-error derivation is memoized.
- [x] `filesTouched` lists only `Read`/`Write`/`Edit` file paths; Glob and Grep
      directory scopes are omitted, and truncation shows an explicit marker and flag in
      the Workbench and in chat.
- [x] The root briefs a child with `prompt` in prose; the four-field form still works;
      the durable events carry `brief` and legacy `objective` logs still read back.
- [x] The Workbench spawn form submits a prose brief without an objective, and still
      submits the four-field packet.
- [x] `inherit: 'brief'` lets a child answer a question about a file the root read and
      the brief never named. The projection is built from parent messages only — no
      tool results, no checkpoint summary. Named `references` still appear in the brief
      when both are set. The `Agent` tool and the HTTP route accept `inherit`; the
      Workbench gains no control in this plan.
- [x] Bundled roles are exactly `explorer`, `worker`, `reviewer`, and `verifier`, their
      descriptions distinguish them by when to choose them, and `action: 'catalog'`
      additionally lists valid workspace custom roles.
- [x] The delegation guidance states the asymmetric lease boundary honestly — root turns
      hold a lease, child calls use fallback per-call locking after handoff, and no lease
      serializes the child's whole run — and says not to fan out writers or keep the root
      writing concurrently.
- [x] Two conversations delegating at the same time do not steal each other's capacity.
- [x] This plan does not add token or currency accounting.
- [ ] `npm test`, `npm run typecheck`, `npm run build:web` exit 0; pm2 `mini-dsh`
      restarted and verified live.

### Outcome (2026-09-23)

Cooked phases 0–6 in one pass. `npm run typecheck` 0 errors; `npm run build:web`
ok; pm2 `mini-dsh` restarted and verified live (bundled roles = explorer,
worker, reviewer, verifier; 7 legacy child relationships recovered). The
`npm test` criterion stays unchecked: 931 pass, 10 fail — the same 10
(`workspace-isolation` ×1, `session-model` ×3, `composer.mounted` ×6) fail on the
pre-change baseline and belong to the auth/MCP work. Playwright `chat-shell`
fails at setup on a missing `GET /api/auth/state` fixture route (same origin).
Review and dispositions:
`plans/reports/code-reviewer-260923-1027-claude-style-subagents.md`.
Deviations: the Settings create form now saves via a native `dialect:
"mini-dsh"` import (so `inheritable` round-trips) and gained "Copy to
customize"; a workspace file named like a new bundled role is warned about and
deletable rather than migrated.

### Outcome (2026-09-23, follow-up session)

Post-acceptance review found the lifecycle contract leakier than the suites
proved, and the user chose to repair it (then to reconcile ambiguous
durability against canonical storage). Landed on top of the committed phases,
all test-first in `tests/harness/g4-subagent-contract.spec.ts` plus new
`tests/web/agent-inheritance.spec.ts` / `agent-tool-ownership.spec.ts`:

- A child is `completed` only when its newest terminal turn record says
  `completed`; failed/cancelled/interrupted turns report honestly with no
  result.
- Direct `wait`/`cancel`/listing and the Agent tool enforce parent
  workspace/project/caller-root ownership; the Agent tool can no longer touch
  a sibling conversation's child.
- `agent/child-result` persists only after the child log flushed; an append
  whose durable acknowledgement is rejected (poisoned or not) is settled by
  reading canonical storage (`SessionsService.readCanonicalEvents`, which
  first drains the loaded writer's queue) — a committed record is kept, a
  provably absent spawn is rolled back with its reservation, and anything
  unreadable stays an explicit runtime-only `uncertain` that holds capacity
  and survives restart unchanged.
- `ChildExecutor.reconcile` (single-flight per child, ownership-checked
  before joining) repairs `uncertain` children exactly once; exposed via the
  Agent tool `reconcile` action, a workspace-scoped parent-owned
  `POST /api/workspaces/:wid/sessions/:parent/children/:child/reconcile`
  (legacy implicit-workspace route kept), and a Workbench "Retry settlement"
  button.
- Inherited-context truncation keeps a speaker-labelled `[truncated]`
  fragment at the 12 000-char cap.

Gates re-verified directly on the current tree: `npm test` 111/111 files,
`npm run typecheck` 0, `npm run build:web` 0 (known chunk-size warning only).
The checkbox stays open solely for the pm2 half: the tree also carries the
unrelated in-flight cross-project-file-scope work
(`plans/260923-1439-cross-project-file-scope/`), so restarting `mini-dsh` now
would deploy that WIP; restart and live-verify after it lands. Known unrelated
flake: `tests/capabilities/bash.spec.ts` orphan-marker (Windows Git Bash
process-tree race, documented 2026-09-18) — passes isolated and in this run.

## Risks

| Risk | Mitigation |
|---|---|
| Hardening the lifecycle (phase 0) regresses existing delegation behaviour | Phase 0 is written test-first over the current public `spawn`/`wait`/`list`/`cancel` surface; approval relay, model pinning, recovery, and one-level tests must stay green before phases 1–3 start |
| Moving definition instructions into the system block reads as a privilege escalation | It is not: the ceiling is enforced by the gate, not the prompt. Phase 1 states this in `docs/capabilities.md` and keeps the gate untouched, and a test asserts a definition body cannot obtain a tool outside its ceiling |
| Dropping the mode prose for children removes a safety statement | The statement was never the enforcement. Phase 1 substitutes a capability line derived from the child's effective exposed schemas — which exclude the `Agent`, MCP, and anything outside the ceiling — and states those tools are still subject to host policy and approval |
| Returning only the final message loses work when a child crashes mid-way | The child's full log is durable and reachable by its session id, which every handle already carries. Phase 2 makes the failure say so instead of pasting narration |
| `inherit: 'brief'` multiplies cost and can hand a role context it should not see | Explicit opt-in, never a default, hard char cap, messages-only source, and it rides as `wrapUntrusted` lower-trust content like the compaction summary already does (`builder.ts:154-163`); `inheritable: false` lets a role refuse, and durable child metadata records mode/hash/char count for audit |
| A richer role library invites over-delegation | Phase 5 adds a "when delegation is worth it" line to the tool description. The bundled catalog stops at four roles |
| The asymmetric writer boundary gets misdescribed as serialization (in docs, guidance, or tests) | Phase 5 distinguishes root turn-held leases, child per-call fallback after handoff, and root reacquisition; tests assert there is no whole-child-run exclusion |
| Token accounting gets folded back into phase 6 because the seam looks small | It is deferred on purpose. The design seed stays under Deferred; a cook of this plan does not implement it |

## Relationship to other plans

- **Supersedes parts of** `plans/260921-1414-agent-delegation-tool/` (status `done`). That
  plan's lifecycle, model resolution and UI work stand. Its `TaskPacket` rendering and
  result digest are replaced here. Its "Outcome notes" stay accurate as history.
- **Consumes** `plans/reports/brainstorm-260921-1414-multi-agent-gaps.md`: gap 5 (result
  contract) is phase 2, gap 8 (delegation guidance) is phase 5, and gap 4 (per-root cap)
  is phase 6. Gap 2 (token accounting) moved to Deferred on 2026-09-22. Gap 3 (child
  approvals) shipped in the permission-policy work and is not a phase here. Gap 1's
  writer-parallelism fork stays out; its option A guidance line is in phase 5, restated
  honestly as an asymmetric root-turn/child-call lease boundary rather than child-run
  serialization.

## Deferred

Token accounting is a later plan, started only after phases 0–3 are live. The contract
to carry forward, so it does not have to be rediscovered:

- The LLM stream's terminal event carries optional `usage: { inputTokens, outputTokens }`
  taken from the provider. Absent when the provider omits it. Never estimated into a
  number that looks measured, and never a currency figure.
- A durable `step/usage` event is appended inside the existing agent durability barrier.
  An older build reading a log that contains it must not fail.
- A child handle sums the events in its own log. `spawn` / `wait` / `list` and the
  Workbench child card show that sum.

The scaling items listed under Constraints stay closed until the same condition: phases
0–3 are live and delegation is actually used.

## Validation Log

### Session 1 — 2026-09-22
**Trigger:** `/ak:plan plans/260921-1457-claude-style-subagents --validate`
**Questions asked:** 8

### Verification Results
- **Tier:** Full
- **Claims checked:** 90
- **Verified:** 58 | **Failed:** 26 | **Unverified:** 6

Many of the 26 failures are expected: they flag **target** behaviour the plan proposes
(`inherit`, `prompt`, `brief`, `resultComputed`, per-root counters, `SpawnError('packet')`,
`inheritable`) which correctly does not exist in the baseline yet. The remainder exposed
real plan defects, all propagated into the phase files in this pass:

1. **Stale server references.** The plan cited the child gate at `server.ts:1169/1176`
   and the `buildContext` call at `server.ts:1344-1357`; the current tree has the gate at
   `server.ts:1280-1293`, the production `buildContext` call at `1457-1469`, and the POST
   agents route at `2145-2217`. Also `agent.ts:…` refs now resolve to
   `src/harness/agent/agent.ts`.
2. **Caller count wrong.** `tests/web/server-g4.spec.ts` has 13 `task:` occurrences, not
   12, plus a route caller in `tests/web/server-session-model.spec.ts`.
3. **Final-message ambiguity.** "Last non-empty assistant message" did not exclude
   messages that also carry `toolCalls`, and did not say cancelled/failed/interrupted
   children have no result.
4. **Absent-result memoization gap.** The existing `result === undefined` guard
   recomputes a completed child's (missing) result on every call; a `resultComputed`
   sentinel is required.
5. **Missing result consumers.** The rename touches
   `web/components/chat/MessageParts.tsx`, `web/lib/api.ts` (`fetchChildren`/`waitChild`),
   `src/web/server.ts` serialization endpoints, `tests/browser/chat-shell.e2e.ts`, and
   `docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md` — none
   were listed.
6. **Durable brief gap.** `session/child-meta` and `agent/child-spawn` durably carry
   `objective` (`src/harness/session/events.ts:46-47`); adding `prompt` without evolving
   those events and their readers/projectors would strand the prose brief.
7. **Checkpoint/tool-results contradiction.** Phase 4's projection was
   "checkpoint-first, else messages" while also claiming no tool results; the accepted
   source is messages only.
8. **Inheritance API ambiguity.** Which callers accept `inherit` (tool, HTTP, Workbench),
   what is durable (mode/hash/char count, not the string), and what the manifest exposes
   were unstated.
9. **Direct-child route identity loss.** Nothing stopped a root-style message/run against
   a session carrying `session/child-meta`, which would rebuild the child as a normal
   Agent and drop its identity.
10. **Lifecycle ownership/orphan/map defects.** Spawn did not verify parent
    workspace/project ownership; failure after `session/child-meta` but before the parent
    relationship orphaned a durable session; executor maps grew without bound; per-turn
    keys were never cleared.
11. **False writer-serialization claim.** The project lease is acquired and released per
    tool call (`src/web/server.ts:732-775`); writers do not serialize for a whole run.
12. **Global role cache.** The role list cache in `agentTool`
    (`src/web/agent-delegation.ts:150-164`) is closure-global and keyed by the last
    workspace seen, so custom role descriptions can leak across workspaces within the
    5 s TTL.
13. **Reservation wording.** The current code awaits `parentIsChild` before reserving;
    the invariant to state is async preflight first, then a synchronous check-and-increment
    with no `await` inside.
14. **Incomplete definition/manifest consumers.** `inheritable` round-trip must include
    the parser, `serializeDefinition` (`src/web/server.ts:3559`), `web/lib/types.ts`,
    Settings copy/edit, tests and fixtures; the manifest additions must include
    `web/lib/api.ts` `ContextManifestView` and `web/components/layout/ContextPanel.tsx`.

#### Questions & Answers

1. **[Architecture]** Đâu là định nghĩa chính xác của “final report” để không nhầm một
   assistant message có tool calls hoặc narration khi child bị cancel là kết quả cuối?
   - Options: Completed terminal only — chỉ lấy assistant message cuối không có tool calls
     khi child hoàn tất; cancelled/failed không có result và trả error trỏ tới full log
     (Recommended) | Last text message — luôn lấy assistant message không rỗng cuối cùng,
     kể cả khi child cancelled/failed | New final event — thêm durable event riêng cho
     final report
   - **Answer:** Completed terminal only.
   - **Rationale:** narration/tool traffic không phải deliverable. Plan extends the same
     honest-error rule to interrupted and completed-without-terminal-report states, and
     memoizes the result-or-error derivation.
2. **[Architecture]** Prompt-only brief nên được lưu trong durable child metadata/events
   như thế nào?
   - Options: Add brief field — evolve events sang `brief`, vẫn đọc legacy `objective`;
     projectors/UI dùng `brief ?? objective` (Recommended) | Normalize to objective — ghi
     `prompt ?? objective` vào field `objective` | Store both fields — giữ `objective` và
     thêm optional `prompt`
   - **Answer:** Add brief field.
   - **Rationale:** the prose brief survives restart/recovery without permanently
     misnaming it as an objective. A single executor validator is the propagation detail
     that keeps tool and HTTP semantics aligned.
3. **[Assumptions]** Nguồn cho `inherit:'brief'` nên xử lý checkpoint thế nào khi
   checkpoint hiện tại có thể chứa tool results và có thể cũ hơn các message mới?
   - Options: Messages only — dùng durable user/assistant messages, loại tool-call
     messages/results, giữ phần mới nhất theo char cap (Recommended) | Checkpoint plus
     delta — ghép checkpoint summary với messages sau `coversSeq` | Safe checkpoint
     redesign — tạo projection/checkpoint mới chỉ từ user/assistant rồi ghép delta
   - **Answer:** Messages only.
   - **Rationale:** one bounded source avoids stale/tool-derived checkpoint content and a
     second trust/freshness contract.
4. **[Scope]** `inherit` nên được hỗ trợ ở những bề mặt nào và lưu ở mức nào?
   - Options: Tool + HTTP metadata — Agent tool và HTTP nhận `inherit`; Workbench chưa có
     control; string chỉ sống trong runtime child scope, durable metadata lưu
     mode/hash/char count (Recommended) | Agent tool only | Full Workbench control
   - **Answer:** Tool + HTTP metadata.
   - **Rationale:** auditability without persisting the inherited payload or opening
     resume; the Workbench control can arrive later without another API change.
5. **[Risks]** HTTP hiện có thể nhận message trực tiếp vào một child session và tạo
   Agent thường không có `childOf`, làm mất role prompt/tool ceiling. Plan nên xử lý thế
   nào?
   - Options: Block child messages — từ chối message/run trực tiếp cho session có
     `session/child-meta`; child chỉ được executor điều khiển (Recommended) | Reconstruct
     identity — cho phép route điều khiển child nhưng tái tạo đầy đủ identity | Document
     only — không sửa route
   - **Answer:** Block child messages.
   - **Rationale:** resume stays out of scope and child identity cannot be silently
     downgraded to a root Agent.
6. **[Risks]** Audit phát hiện executor không tự xác minh parent workspace/project, có
   thể để orphan child durable khi pre-launch fail, và giữ map entries sau settle. Có đưa
   hardening này vào plan không?
   - Options: Add prerequisite phase (Recommended) | Fold into phase 6 | Separate future
     plan
   - **Answer:** Add prerequisite phase.
   - **Rationale:** prompt/result contracts must not be layered on an unsafe lifecycle;
     phase 0 owns the cohesive correctness boundary.
7. **[Tradeoffs]** Plan hiện nói write-capable children “serialize”, nhưng code chỉ lock
   theo từng tool call và root/siblings có thể interleave. Chọn contract nào?
   - Options: State per-call locking — sửa guidance/docs, không fan out writers, giữ
     worktree/queue ngoài scope (Recommended) | Fix turn-level lease | Remove guidance
   - **Answer:** State per-call locking.
   - **Rationale:** the plan must state enforcement that exists, not promise whole-run
     serialization.
8. **[Scope]** `inheritable` nên tham gia contract definition ở mức nào?
   - Options: Full mini-dsh round-trip — parser, save/serialize API, web types, Settings
     copy/edit và fixtures; Claude compatibility không quảng bá field không chuẩn
     (Recommended) | Parser-only key | Drop role refusal
   - **Answer:** Full mini-dsh round-trip.
   - **Rationale:** parser-only support would silently lose the field on round-trip, while
     emitting it as Claude-compatible would misstate interoperability.

#### Confirmed Decisions
- Result contract: only completed children may return the last tool-free message;
  every terminal state without that report returns an honest full-log error;
  `resultComputed` memoizes the result-or-error derivation; `filesTouched` =
  Read/Write/Edit only; explicit truncation in Workbench and chat.
- Durable brief: `brief` on both durable events, legacy `objective` readers,
  `SpawnError('packet')` validation in the executor, HTTP 400 mapping, prompt-wins note.
- Inheritance: messages-only source, synchronous capture at spawn, tool + HTTP accept
  `inherit`, Workbench control deferred, durable audit metadata, manifest visibility.
- Child boundary: root-style message/run blocked on child sessions; executor-driven only.
- Lifecycle hardening: phase 0 added as prerequisite for all other phases.
- Writer guard: registered root turns hold leases, child calls use fallback per-call locks
  after handoff, and no child-run serialization is claimed; child turn-level leasing,
  queueing, and worktrees stay future work.
- `inheritable`: full mini-dsh round-trip, absent means allowed, never emitted through
  the Claude adapter.
- Dependencies: 1←0; 2←0,1; 3←0,1; 4←0,1,3; 5←0,1,2; 6←0; ship 0–3 together.

#### Action Items
- [x] Fix stale server references (gate `1280-1293`, `buildContext` `1457-1469`, POST
      route `2145-2217`, `src/harness/agent/agent.ts` paths) across plan and phases.
- [x] Correct the `task:` caller count to 13 in `server-g4.spec.ts` plus the
      `server-session-model.spec.ts` route caller.
- [x] Rewrite the phase 2 result contract (toolCalls filter, no-result cases, sentinel,
      `filesTouched` scope, truncation surfacing, full consumer list).
- [x] Add durable `brief` evolution and `SpawnError('packet')`/HTTP-400 semantics to
      phase 3, with the event/projector/UI/fixture consumer list.
- [x] Rewrite phase 4's inheritance source to messages-only, pin the capture point, add
      inherit surfaces, durable audit metadata, manifest consumers, and the
      `inheritable` round-trip including the Claude-adapter exclusion.
- [x] Add phase 0 to the phases table and rewire every phase's `dependencies` frontmatter.
- [x] Replace the writer-serialization claim with the current asymmetric lease contract
      (root turn-held lease; child per-call fallback after handoff; no child-run lock) in
      plan.md Constraints, phase 5 guidance, and success criteria.
- [x] Add the WorkspaceId-keyed role-cache fix and the catalog-includes-custom-roles
      correction to phase 5.
- [x] Correct phase 6's reservation invariant wording, per-turn quota semantics,
      behaviorally-tested cleanup, and typed/429 capacity failure reporting.
- [x] Update plan goals, success criteria, risks, and constraints for foundation
      hardening and the corrected result/inheritance/writer semantics.
- [ ] Implementation: every phase's Success Criteria stay unchecked until cooked.

#### Impact on Phases
- Phase 0: added as prerequisite (already carried its Validation Session 1 marker);
  dependencies of every other phase rewired; unchanged intent.
- Phase 1: depends on 0; capability line now derived from effective child schema
  filtering (no `Agent`, no MCP, nothing outside the ceiling) and phrased as exposed
  tools subject to policy/approval; stale server refs fixed.
- Phase 2: depends on 0,1; only completed children may return the tool-free last message;
  every terminal state without one gets a full-log error; `resultComputed` memoizes the
  result-or-error derivation; `filesTouched` is narrowed to Read/Write/Edit, truncation is
  surfaced in Workbench and chat, and consumers cover chat/api/server/e2e/design docs.
- Phase 3: depends on 0,1; durable `brief` events with legacy `objective` readers,
  `SpawnError('packet')`, HTTP 400 mapping, corrected route refs and caller counts,
  event/projector/UI/fixture consumers named.
- Phase 4: depends on 0,1,3; checkpoint source removed (messages only), capture point
  pinned, inherit on tool + HTTP only, runtime-only string with durable audit metadata,
  manifest hash/chars/omission with inspector consumers, `inheritable` full round-trip
  with Claude-adapter exclusion, wrapper preamble wording.
- Phase 5: depends on 0,1,2; guidance and success criteria state the asymmetric
  root-turn/child-call lease boundary instead of child-run serialization; role cache is
  keyed by `WorkspaceId` with lazy TTL eviction; catalog criterion covers bundled four
  plus valid workspace custom roles.
- Phase 6: depends on 0; async preflight then synchronous check-and-reserve stated
  correctly, per-turn quota distinct and not released on settle, cleanup asserted
  behaviourally, global 12 hardcoded/documented with typed tool errors and HTTP 429
  while success exposes only per-root `active n/3`.

### Whole-Plan Consistency Sweep
- Files reread: `plan.md`, `phase-00-lifecycle-hardening.md`,
  `phase-01-child-as-agent.md`, `phase-02-result-contract.md`,
  `phase-03-free-form-brief.md`, `phase-04-context-inheritance.md`,
  `phase-05-role-library.md`, `phase-06-per-root-caps.md`
- Decision deltas checked: 9
- Reconciled stale references: 4 groups (child gate, `buildContext` call, POST agents
  route, and `src/harness/agent/agent.ts` path normalization)
- Additional contradictions reconciled during the sweep: phase 0/6 rollback semantics,
  result/error behavior for completed children without a terminal report, one normalized
  durable/runtime brief, independently droppable inherited context, shared Agent/HTTP
  inheritance plumbing and refusal invariant, bounded workspace role cache, and the
  current asymmetric root-turn/child-call lease boundary
- Unresolved contradictions: 0
- Gate result: **GO** — eligible for implementation after a fresh-context handoff

<!-- slug: claude-style-subagents -->
