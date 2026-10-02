# G1 — Reliable Base Harness & Built-in Tools

Status: design approved by user on 2026-09-09. Implementation not started by this approval.

## Outcome

Extend dnt-harness's existing harness, without adopting dntspace architecture, so every execution has an identity, enforced permissions, bounded lifetime, durable history and truthful outcomes. Users can stop execution and reopen history after restart. G1 supplies the execution foundation for later workspace environments, context/skills, bounded multi-agent and trusted plugins.

## Constraints and non-goals

Keep the existing kernel, service/effect model, agent loop, session-event projection and tool pipeline. Single host/local base; no multi-tenant platform or OS sandbox guarantee. No scheduler, workflow engine, distributed runtime, automatic crash resumption, generic side-effect replay, advanced context engine or new plugin ecosystem. Approval of this design is not authorization to implement subsequent goals.

## Approved design

### Built-in tools (approved scope amendment)

G1 delivers the reliable harness together with six foundational built-in tools. Standardize and harden the existing read/write/edit/glob/grep/bash capabilities rather than creating a second implementation.

| Canonical public name | Responsibility | Required contract |
| --- | --- | --- |
| Read | Read a file by range | Validate arguments, bound output, report missing/invalid paths clearly |
| Glob | Find paths by pattern | Bound results/traversal; enforce root and link containment |
| Grep | Search file contents | Filters, bounded output and cancellable searches |
| Write | Create or replace a complete file | Distinguish creation from overwrite; validate previously observed state before overwrite and detect conflicts |
| Edit | Exact text replacement | Reject missing/ambiguous matches; validate observed state to avoid clobbering external edits |
| Bash | Execute an actual Bash command | Explicit executable/cwd/environment, spawn-error handling, output cap, timeout, cancellation and verified process cleanup |

- Adopt Claude-style public names now; verify concrete argument/result schemas against the selected upstream reference before freezing compatibility. Document supported subsets rather than claiming full Claude parity.
- Normalize existing lowercase names to canonical identity in tool registration, permission rules and compatibility/import mappings. Do not expose duplicate aliases to the model or lose restrictions during renaming.
- Common execution context carries an explicitly granted root, session/Turn/tool execution identity and AbortSignal. Missing required scope fails closed; tools do not derive authority from a UI-global active folder.
- All tools use the same argument validation, permission/approval gate, result/error contract and durable execution events. Read/search defaults allow and mutation/shell defaults ask, subject to effective policy and later mode exposure.
- File tools enforce containment including path traversal, symlinks/junctions and creation-path checks, and do not expose application-internal storage. Checks and file-state conflict detection are not an OS sandbox or a guarantee against hostile external filesystem races.
- Apply existing persistence rules: durable intent before side effects, truthful results after execution, no automatic tool replay after unknown crash outcomes. Bound stored/model-visible output and mark truncation explicitly.
- Bash must mean Bash. Unsupported environments disable it with an actionable error; never silently substitute PowerShell or claim cwd confines shell access.

#### Goal boundaries

G1 provides root-aware tool mechanisms, schemas, validation, execution gates, cancellation, events and real filesystem/shell integration tests. It can run with one explicitly granted root without implementing multiple workspaces.

G2 binds that root and policy to workspace/project/session ownership and adds cross-workspace isolation. G3 owns Skill and memory tools, context and bundled/custom mode configuration. G4 owns delegation and compatibility adapters. G1's live-mode gate seam does not move the G3 mode system into G1.

Not added to G1: skill/memory/delegation tools, plugins/MCP, apply_patch, interactive terminal continuation, web tools, dedicated git tools or additional delete/rename/multi-edit tools.

### Domain and lifecycle

- Session contains Turns; a Turn contains model Steps and tool executions. Do not add overlapping Task/Job/Run entities merely for naming symmetry with agent.run().
- One active Turn per session; stable execution identities, including across restarts.
- Turn states: queued, running, cancelling, completed, failed, cancelled, interrupted. Track current activity (model/tool/approval) separately from state and terminal reason separately from both.
- Terminalize once. Late events cannot revive terminal Turns. Stop prevents new requests/tools. Do not report cancellation complete while execution remains active.

### Durable storage and events

- Amendment approved on 2026-09-09: use file-first storage. Per-session events.jsonl is canonical; summary.json is a rebuildable metadata projection. SQLite is not required and may only be added as a rebuildable query/index cache, never a second authoritative store.
- Serialize writes through one writer per session; one application process owns a writable data root. Distinguish buffered append from durable acknowledgment. Use explicit durability barriers before acknowledging durable input, starting recorded side effects, and reporting durable terminal state.
- Events carry schema version, monotonic sequence and stable execution IDs. Preserve/quarantine a truncated final record before tail repair; middle-log corruption is surfaced and blocks automatic continuation, not silently skipped. Replacement files use validated temp-file writes, sync and replacement with platform-specific durability limits verified.
- Session metadata updates needed for rebuild (such as rename/archive) must be recorded canonically, not exist solely in summary.json. Context compaction never overwrites the original event history.
- Persist accepted inputs, lifecycle, assistant messages/tool declarations, execution intent/results, approval requests/decisions and error/interruption details.
- Token deltas, heartbeats and transient progress need not each become durable rows. Bound/checkpoint partial output as appropriate.
- Persist meaningful state before acknowledging it as recorded or publishing its durable event.
- Record side-effect intent before execution, result afterwards. This is not an exactly-once guarantee.
- List stored sessions on startup; load full histories lazily. Preserve the existing event projection approach and simple SSE snapshots/dedup unless implementation evidence demands more.

### Recovery

- Recover history, never silently replay tools or resume execution.
- Mark unfinished Turns interrupted after host restart. Invalidate old execution approvals. Retain queued input without automatically starting it.
- A missing result after recorded tool intent means outcome unknown, not proof that the tool failed or had no side effect.
- Persist an explicitly identified recovery record and project valid tool-call/result pairs. Do not present synthetic recovery records as original tool output.
- Continue only through a new user-triggered execution that can inspect actual state.

### Cancellation and limits

- Propagate Turn cancellation/deadline to provider requests, approval waiters and cancellable tools, including child-process cleanup.
- File operations that already completed remain completed; cancellation is not rollback.
- Do not permit a new writer to overlap an execution that has not actually stopped.
- Include maximum steps, Turn deadline, provider/stream inactivity limits, tool timeouts, approval expiry, tool output limit and bounded pending inputs.
- Centralize configurable defaults. Cost-budget engine and context-token optimization are not G1 work.

### Approval and policy

- Bind each approval to session, Turn, exact tool execution and fixed arguments; include expiry and decision state.
- Reconnect snapshots expose still-pending approvals. First valid decision wins; stale decisions cannot execute tools.
- Stop cancels waiters. Restart invalidates them. Expiration never approves implicitly.
- Refuse session deletion while active execution has not stopped.
- One-shot approve/deny only initially; durable per-tool Always Allow is delivered as the workspace policy design in [G5](2026-09-09-g5-mcp-hooks-production-design.md) for MCP tools and host-level blockedTools. G1 itself does not introduce durable allows.
- Enforce mandatory tool policy at the execution boundary, not merely through an optional extension listener.

### Errors and retries

- Distinguish tool failure, policy denial, provider failure, storage failure and cancellation/interruption.
- Fail closed before side effects when execution intent cannot be persisted; never report unrecorded state as durably saved.
- Classify errors before adding bounded retry. Retry only suitable transient provider failures before meaningful output, within deadline/cancellation limits; honor Retry-After where applicable.
- No automatic retry after partial output, no generic retries of side-effecting tools, no repeated retries for invalid credentials/configuration.
- Upstream requests/billing may still duplicate under transport ambiguity; do not promise exactly-once.

### Input while running (approved G2 amendment)

- Give accepted inputs stable identities; client request IDs deduplicate transport retries. Preserve order and show pending/consumed status.
- Input received while idle starts a new Turn. Input received while running or waiting for approval is durably queued for a subsequent Turn and never injected into the active Turn's context. Serialize acceptance against terminalization: if the Turn has already ended, accept the input as a new Turn rather than lose it.
- Queued input does not supersede a pending approval; approvals keep their own lifecycle until decided, expired or invalidated by Stop/restart/terminalization.
- Queued input does not interrupt an already executing tool, undo effects, replay tools or elevate permissions. Stop remains the explicit cancellation control.
- Queued input remains visible, is never silently replayed and is not auto-executed. Stop does not automatically advance pending work; restart does not execute queued input without user action.

### Narrow live execution controls

Amended on 2026-09-09 with the G3 approval: exactly three live execution controls exist — model, permission and mode.

- Model/provider changes select an already configured connection for the next model request in the same Turn; do not interrupt the current request, replay work or silently fall back on incompatibility.
- Evaluate current effective permission immediately before each tool start, including remaining calls from an existing batch. Re-evaluate pending approvals against policy changes; approval cannot override deny or revive cancelled/denied calls.
- Mode selection is live per [G3](2026-09-09-g3-modes-context-skills-memory-design.md): the current mode gates tool exposure and permission defaults at the next tool-start gate and reassembles context for the next model request. Mode is not pinned for the Turn. Selecting a validated mode is live; mode definition files are not hot-reloaded.
- No live control automatically kills a tool or provider request already running; explicit Stop uses the cancellation contract above. No live control replays or undoes side effects.
- Record the mode/model/policy revision actually used per request/execution. Workspace identity and project root remain fixed. General resource/plugin/file hot reload is not part of these controls.

### Shell support

- Explicit shell adapter/executable, cwd and environment; detect unsupported environments and disable clearly.
- Handle spawn errors, timeout and cancellation with verified cleanup behavior.
- Certify the actual intended deployment shell first, not Bash/PowerShell/CMD/WSL simultaneously.
- Do not translate Bash commands into PowerShell implicitly or claim path checks provide shell sandboxing.

## Acceptance criteria

1. Normal chat and tool loops persist and reopen correctly.
2. Duplicate input requests do not create duplicate execution.
3. A provider that sends no data can be stopped.
4. Stop during tools starts no further tool/model request.
5. Reload during approval restores actionable pending state.
6. Approvals cannot authorize work after Stop/restart.
7. Repeated tool calls stop at execution budget.
8. Crash between side effect and result records unknown/interrupted outcome without replay.
9. Storage failure is not reported as successful durable acceptance.
10. Shell spawn failure settles rather than hanging execution.
11. Late events cannot revive terminal Turns.
12. Existing tool-result, provider-selection and session-projection behavior retains regression coverage.
13. Model changes affect the next request within the active Turn without interrupt/replay; invalid selections surface errors.
14. Policy or mode changes gate tools not yet started and stale approvals cannot bypass new restrictions; running tools are not implicitly killed.
15. Input accepted while running or awaiting approval is persisted in order, queued for a subsequent Turn and never injected into the active Turn's context or used to supersede a pending approval.
16. Input acceptance/terminalization races neither lose accepted input nor revive a terminal Turn; queued input is not auto-executed after Stop or restart.

17. All six foundational tools expose validated canonical contracts; legacy name normalization preserves permission decisions and does not duplicate exposed tools.
18. Denied Edit and expired Write approval leave target files unchanged.
19. File overwrites/edits detect changed observed state instead of silently clobbering external edits; ambiguous Edit matches fail clearly.
20. Read/Glob/Grep and writes reject out-of-root traversal/link paths and internal application storage access, including file creation paths.
21. Large file/search/shell output stays within configured limits with explicit truncation; no unbounded inline history growth from a single result.
22. Real Bash integration verifies long-running command timeout/Stop and process cleanup on the supported environment; unsupported shell/spawn failure settles clearly.

Use deterministic fake providers, controllable tools and injected clocks for lifecycle/failure tests. Add real temporary-filesystem and supported-shell integration tests for the six tools; mocks alone do not establish file safety or process cleanup. Live model calls are not the correctness oracle.

## Implementation details still to verify

These do not reopen the approved scope: verified upstream tool argument/result schemas and compatibility subset; file-state conflict and path-containment mechanics; exact event/checkpoint schema, durability barriers and lock/replacement semantics on the supported filesystem; numerical budget defaults; supported deployment shell and its process-tree termination behavior. Resolve through targeted implementation planning and evidence.

## Core principles

- Persist history; do not replay side effects automatically.
- Stop means verified execution termination, not merely a UI label.
- Unknown outcomes remain unknown instead of being fabricated as success or failure.
