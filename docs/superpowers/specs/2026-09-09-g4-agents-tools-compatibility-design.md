# G4 — Agent Definitions, Bounded Multi-agent & Compatibility

Status: scope approved by user on 2026-09-09. Design only; not implemented.
Dependencies: [G1](2026-09-09-g1-reliable-harness-design.md), [G2](2026-09-09-g2-workspace-isolation-design.md), [G3](2026-09-09-g3-modes-context-skills-memory-design.md).

## Outcome

One root agent delegates bounded tasks to one level of child agents using the existing harness and context builder. Definitions are workspace-owned files. Prefer Claude-compatible tools and definition syntax, with version-targeted Codex adapters rather than a second runtime. Compatibility scope is approved; exact public asynchronous tool schemas remain an evidence/fixture gate before implementation, not a claim of completed parity.

## Definitions and execution

- Definitions live at workspaces/<workspace-id>/agents/*.md as Markdown/frontmatter; bundled definitions are read-only and copied explicitly for customization.
- Initial bundled roles: Explorer (hard read-only, no shell) and Worker (execution constrained by effective mode/permissions).
- Identity/description/instructions, tool restrictions, skills, optional model override and bounded execution limits define a role. A role is not a Mode; it never duplicates or overrides the entire context/permission system.
- Validate definitions and expected content hashes. No mid-execution definition hot reload.
- Root spawns children; children cannot spawn grandchildren. Use the same G1 loop and G3 builder, not a separate agent runtime.
- Every child inherits fixed workspace/project scope and receives a task packet: objective, constraints, references, required result. No automatic full parent-history fork or sibling transcript access.
- Child history/context is separate. Skill/memory loaders obey scope and current mode; parent-loaded skills are not implicitly copied.
- Results contain bounded summary, findings, file references, changes, verification and blockers. Runtime status is distinct from model claims of success. Full transcript remains accessible through UI.

## Lifecycle and scheduling

Internal operations are spawn, list/status, wait/result and cancel. Avoid duplicate result tools if wait already returns persisted results. Public names/arguments/results depend on a verified compatibility dialect; do not invent names and claim upstream parity.

- Bound active children, total spawned children per root Turn, concurrent provider requests, child deadlines/steps and total root lifetime.
- Capacity exhaustion reports capacity reached; no new general scheduler queue.
- Wait is event-driven; wait timeout reports still running and does not implicitly cancel.
- No send_message/send_input, steering, inbox or mid-Turn follow-up. New task execution can explicitly receive previous results. User messages remain queued for subsequent Turns under G1.
- Child failure reports an outcome to root rather than necessarily failing siblings. No automatic side-effect retry.
- Root cannot complete while children remain active. Resolve by waiting or cancelling within execution budgets; early model final text does not override lifecycle ownership.
- Stop/failure of root cleans up children and pending approvals. Cancel of a child can leave other children running. Do not report stopped before cleanup is confirmed; no rollback.
- No detached children or automatic restart resumption.

## Authority, live controls and files

Child authority is bounded by host/workspace restrictions, current parent mode/policy, spawn-time capability grant and definition restrictions. Spawn-time grants never automatically expand after a later parent permission increase. Explorer cannot acquire shell/writes by switching root to Full access.

- Parent mode/permission changes gate child tools before each new execution and change child context sources at the next model request. Pending approvals use G3 re-evaluation semantics. Already-running requests/tools finish; use Stop for cancellation.
- Parent Chat exposes no tools to model, but runtime/UI lifecycle cancellation and descendant cleanup remain available.
- Child model defaults to inheritance from the session at each request, or an explicit definition override shown in UI. No separate live child model selector initially.
- Approvals identify workspace/project, child/task, exact tool/arguments. Root cannot approve on behalf of user.
- Parallel readers, one write-capable execution per protected project root, including root. Transfer writer ownership only at a safe boundary; root must not retain a lease while waiting for a child writer blocked on it.
- Revalidate relevant file state before applying edits based on potentially stale reader findings. No worktree orchestration or file-partition parallel writers.
- Locks/path gates are application controls, not an OS sandbox; external editors and unrestricted shell are outside that guarantee.

## File-first persistence

Child sessions use the same sessions/<child-id>/events.jsonl, summary projection and artifacts layout. Metadata records workspace/project, parent session/Turn, definition identity/hash and task/grant. Root records durable spawn intent and result references. Recover incomplete relationships without spawning duplicate work. On restart unfinished executions are interrupted and history remains inspectable; never replay side effects. Child sessions are shown under the root rather than mixed into the normal sidebar by default.

## Built-in tool standard across goals

This inventory coordinates G1-G4; it does not move all implementation into G4.

- G1 filesystem/execution: Claude-style Read, Write, Edit, Glob, Grep, Bash. Dedicated reads support Plan without shell. Read ranges/output are bounded; Edit has unambiguous matching/conflict behavior; Write overwrite validates prior state. Expose Bash only for actual Bash, never mislabel PowerShell. G1 must verify the supported platform shell and cleanup.
- G3 skills: Skill, on-demand and mode-gated. Catalog bounded; scripts do not bypass permissions. Skill creation/editing remains UI/files initially, no extra agent-facing skill CRUD tools.
- G3 memory: native memory_search, memory_read, memory_create, memory_update, memory_forget. Native names are not claimed as Claude/Codex standards; scopes, hashes and write approval apply.
- G4 delegation: internal lifecycle above; prioritize Claude Agent invocation compatibility, then a pinned Codex dialect. Exact async spawn/wait/cancel public contracts must be verified before freezing schemas.
- Normalize legacy dnt-harness names in both registration and permission/import mappings so renames never orphan restrictions. The canonical reserved built-in identity list (Read, Write, Edit, Glob, Grep, Bash, Skill, memory_*, Agent) is normatively defined in [G5](2026-09-09-g5-mcp-hooks-production-design.md) and enforced identically here; no plugin/MCP/delegation tool may occupy a reserved name.
- Generic file tools cannot directly mutate internal session/memory/skill storage. No mandatory dedicated delete/rename, MultiEdit, patch, git, web, question, todo or MCP tools in this approved initial inventory.

Mode invariants remain: Chat has no tools; Plan has no shell/writes and may only delegate readers. Ask asks for writes/shell; Edit allows file edits but asks for shell and memory writes; Full allows exposed capabilities only within hard restrictions. Definitions cannot delegate around these boundaries.

## Compatibility contract

Use one normalized execution service and expose one tool dialect per request, not duplicate aliases. Compatibility includes names, input fields, output shapes and behavior, not merely similar names.

Claude-first definition import recognizes the supported subset of name, description, tools, disallowedTools, model, skills and maxTurns. Explicitly map model aliases and permissionMode to workspace resources and restrictions. Claude skills preload semantics differ from on-demand loading: support or report the difference, never silently reinterpret it as exact compatibility.

Import is explicit into the chosen workspace, preserves provenance and does not modify source files. No credential import or execution of scripts/hooks/MCP during import. Unsupported execution/security fields (worktree isolation, background, hooks, MCP, etc.) block automatic activation or require explicit resolution; they are never silently discarded with broader permissions.

Codex import/adapter targets a tested source version and concrete config/schema, not any arbitrary TOML or a mixture of multi-agent generations. Unsupported messaging/resume/fork/worktree semantics are reported. Session-history migration and whole-environment migration are outside G4.

### Research evidence

- Claude tool catalog: https://code.claude.com/docs/en/tools
- Claude subagent Markdown/frontmatter: https://code.claude.com/docs/en/sub-agents
- Claude settings/permissions: https://code.claude.com/docs/en/settings
- Codex pinned source: https://github.com/openai/codex/blob/38cbebaf3fe3e81a94bf462079e7cf9659fc9e50/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
- Shell: https://github.com/openai/codex/blob/38cbebaf3fe3e81a94bf462079e7cf9659fc9e50/codex-rs/core/src/tools/handlers/shell_spec.rs
- Patch: https://github.com/openai/codex/blob/38cbebaf3fe3e81a94bf462079e7cf9659fc9e50/codex-rs/core/src/tools/handlers/apply_patch_spec.rs

Claude docs verify catalog/conventions but not a complete stable machine-readable schema for every tool. Codex has distinct versioned/feature-dependent multi-agent specs. exec_command/write_stdin include process continuation, not a simple Bash rename. apply_patch uses a freeform patch grammar, not a generic JSON function or standard unified diff. These additional transports/lifecycles are deferred, not faked.

## UI and acceptance

Minimal definition list with validation, child cards, task/status/result/transcript, approvals, cancel child/Stop all, writer ownership and model override visibility. No graph canvas or child chat UI.

Acceptance:
1. Independent readers run concurrently within limits; one-level spawning is enforced.
2. Scope isolation and bounded task context hold; no implicit sibling/cross-workspace reads.
3. Explorer and spawn grants cannot escalate through definitions, modes or delegation.
4. Live parent controls re-gate children and approvals without replay/double execution.
5. Writer lease transfer avoids overlapping writers and parent-child deadlocks.
6. Root Stop cleans up descendants; completion cannot hide active children.
7. Child failures/results remain truthful; restart recovers logs, not execution.
8. Compatibility fixtures verify names, arguments, outputs and restrictions for the chosen version.
9. Unsupported security/execution fields prevent unsafe activation; imports never execute code or expose secrets.
10. Read/search/edits, Skill and memory preserve G1-G3 gates and file-first contracts.

## Non-goals and implementation gates

No recursive swarm, agent messaging/steering, distributed/detached agents, worktrees, concurrent writers, scheduler/workflows, auto-generated authority, marketplace, whole-session migration or full upstream parity.

Before implementation freeze: verify exact Claude invocation/async result contract and pinned Codex adapter schemas with fixtures; settle field mappings and unsupported-field reports, writer transfer mechanics and platform shell support. These are acknowledged technical gates, not unapproved additions or completed compatibility claims.
