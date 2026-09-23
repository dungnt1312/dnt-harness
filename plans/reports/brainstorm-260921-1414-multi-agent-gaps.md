# Brainstorm — what the delegation work still does not cover

Follows `research-260921-1403-model-driven-delegation.md` and the shipped plan
`plans/260921-1414-agent-delegation-tool/`. Question asked: the plan may be right, but is
it *enough*? Findings below are verified in code, not assumed.

> Later decision, 2026-09-22: `plans/260921-1457-claude-style-subagents/` took gap 4
> (per-root cap), gap 5 (result contract), and gap 8 (delegation guidance). Gap 2 (token
> accounting) is deferred. Gap 3 (child approvals) shipped in the 2026-09-21 permission
> work. Gap 1 stays at option A: say that writers serialize. Do not treat the "Must"
> table below as the current plan.

## The finding that changes the picture

**Parallel children only work for readers. Two write-capable siblings break.**

`WorkspaceService.acquireRoot` (`src/harness/workspace/service.ts:457-465`) **throws**
`ScopeError('project-active')` when another session holds the project lease — it does not
queue. The lease is per project folder and is held for the whole turn
(`src/web/server.ts:603-652`).

So: child A (worker) acquires the folder on its first write; child B's first write fails
with "another session is executing on this project folder" and B reports a tool failure
rather than waiting. The spawn-time writer handoff (`agent/child-writer-handoff`) only
solves *root vs child*, never *sibling vs sibling*.

Consequence: `explorer` fan-out (the `Read`/`Glob`/`Grep` case) genuinely parallelizes;
`worker` fan-out does not. Claude Code avoids this by giving each subagent its own git
worktree. Nothing in the shipped plan addresses it, and nothing in the tool description
warns the model about it.

| Option | Cost | Note |
|---|---|---|
| A. Accept and be honest | tiny | Tool description + docs state that write-capable children serialize; steer fan-out to readers |
| B. Queue the lease instead of throwing | small | Siblings wait their turn; a waiter can now exhaust the child's own budget, so it needs a bounded wait + clear failure |
| C. A worktree per write-capable child | large | Real parallel writers; needs creation, merge-back, cleanup, and a policy for conflicts |

## The other gaps, ranked

### 1. The root is parked while it waits

A tool call blocks the step (`agent.ts:405-455`), so during `Agent wait` the root does
nothing else. Claude Code's background subagents notify the parent in a *later* turn;
that path does not exist here because `inject()` deliberately does not wake the driver
(`agent.ts:53,129,149-152`) — only a user message opens a turn. Same root cause as the
"children are cancelled when the turn closes" rule.

Options: (a) keep it, as the G4 spec says; (b) let children outlive the turn and inject
their results into the next one, which still needs the user to speak first; (c) add an
inbox kind that wakes the driver — this changes G1 turn semantics and deserves its own
design.

### 2. No token or cost accounting anywhere

Verified: no `usage` field in the LLM seam or in any session event. Delegation multiplies
spend by the number of children and the product currently cannot show that at all — not
per child, not per turn. For a feature whose whole point is running several models at
once, this is the most visible missing number.

### 3. A child's approval is a dead end

The approval question is emitted on the **child's** session stream
(`server.ts:1354-1392`), so it is answerable only by opening that child. Undecided
approvals expire after 5 minutes and the child dies quietly. Phase 3 added an
`awaitingApproval` badge, which surfaces the problem but does not solve it. Options:
relay child approvals onto the root's stream labelled with the child, or make spawn
refuse roles whose tools would ask under the current mode.

### 4. The active cap is global, not per root

`reservedActive` is one counter on one `ChildExecutor` (`executor.ts:92`), so two
conversations delegating at the same time compete for the same 3 slots and one gets a
capacity failure it did nothing to cause. Should be per root, with a separate global
ceiling. Claude Code's comparable default is 20 concurrent, depth 3.

### 5. The result has no contract

`requiredResult` is free text and the digest is just concatenated assistant messages cut
at 4 000 chars plus 20 file references (`executor.ts:409-421`). No structured output, no
artifacts, no way for a child to hand back anything but prose.

### 6. A child can never be resumed

After a restart, unfinished children surface as `interrupted` and are never re-executed
(by design). There is also no way to continue a finished child with a follow-up. Codex
has `resume_agent`; Claude Code resumes through `SendMessage`. The G4 spec bans
*steering*, but resume-after-restart is a different thing and was never decided.

### 7. One level only

By design, and probably right for now — but a researcher child cannot fan out further,
so a wide research tree has to be shaped entirely by the root.

### 8. Nothing tells the model *when* delegation is worth it

Two bundled roles, and no guidance in the mode instructions. In practice models either
over-delegate trivial work or ignore the tool. There is also no eval that would show
which way it went.

## Suggested grouping for a v2 plan

| Tier | Items | Why |
|---|---|---|
| **Must, to call it real** | Writer parallelism (pick A/B/C), token accounting, child approval relay, per-root cap | Without these, parallel delegation is either wrong, invisible, or silently stuck |
| **Quality** | Result contract, delegation guidance + more bundled roles | Makes the output usable and the tool used correctly |
| **Later** | Resume, background children + driver wake, depth > 1 | Each changes turn or lifecycle semantics and needs its own design |

## Unresolved questions

1. Writer parallelism: accept serialization (A), queue the lease (B), or worktrees (C)?
2. Should token/cost accounting be part of this work, or its own plan — it touches the
   LLM seam and every session, not just delegation.
3. Child approvals: relay to the root's stream, or refuse to spawn a role that would ask?
4. Is one level still the right ceiling once roles multiply?
