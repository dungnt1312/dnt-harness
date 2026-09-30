# Root Session Execution Domains — Isolation, Delegation, and Shared-Resource Concurrency

Status: proposed for approval on 2026-09-24. Design only; implementation is not authorized by this document.
Supersedes conflicting ownership and coordination rules in G1–G5, especially workspace-global live mode selection, turn-wide project writer leases, workspace-only child lifecycle authorization, and the fixed host-wide child admission ceiling.

## Outcome

Each root session is an independent execution domain. Work in one root session must not change, block, cancel, inspect, consume the logical quota of, or supply cached execution results to another root session merely because both sessions belong to the same workspace or project.

A root execution domain contains:

- one root session;
- its current and historical Turns;
- its child sessions and delegation lifecycle;
- its live mode and permission state;
- its approvals, tool executions, temporary execution state, usage, and user-created terminals.

Workspace and project resources remain shared configuration and shared filesystem state. Sharing a folder does not imply execution ownership: sessions may observe each other's completed filesystem changes, but one session does not acquire an application-wide right to stop another from running.

## Constraints

- Preserve the existing kernel, agent loop, file-first session logs, context builder, and tool pipeline.
- Preserve one active root Turn per root session.
- Preserve workspace/project path containment, host restrictions, dangerous-command policy, MCP configuration, and external-process safety boundaries.
- Preserve one-level delegation and the rule that a child cannot delegate.
- Preserve truthful recovery: history recovers after restart; unfinished work is interrupted and never replayed automatically.
- Do not claim OS, process, or filesystem snapshot isolation. Sessions that share one checkout share its resulting filesystem state.
- Do not silently retry side-effecting tools or MCP calls.
- Maintain backward-readable event logs and provide an explicit migration for legacy root sessions.

## Non-goals

- Automatic Git worktrees, branch creation, merge orchestration, or file partitioning.
- Distributed scheduling, detached children, recursive agent swarms, or cross-host execution.
- Preventing external editors, scripts, or arbitrary Bash commands from modifying shared files.
- Exactly-once remote effects.
- Making workspace configuration private to a session. Mode definitions, agent definitions, MCP server definitions, hooks, secrets metadata, project records, and memory resources remain workspace/project resources; their *selected runtime state* is session-owned where specified below.

## Core invariants

### I1. Root-domain isolation

For distinct root sessions A and B:

- stopping, deleting, changing controls on, or spawning children from A affects only A and A's descendants;
- A cannot wait for, read lifecycle results from, reconcile, or cancel B's children;
- A's approvals, tool-call IDs, MCP outcomes, dangerous-command matches, quotas, and transient execution state cannot be resolved through B;
- A running in a project never produces `project busy` for B.

### I2. Shared data is not shared execution state

Workspace/project configuration and project files may be shared. Mutable execution state must be keyed by a root execution domain or by an immutable tool execution identity, never by workspace alone or by a model-supplied call ID alone.

### I3. Host protection does not become sibling admission control

Logical quotas are per root or per root Turn. Host-level resource protection may limit concurrent dispatch, but it queues work fairly; it does not reject a root because another conversation consumed a fixed global child count.

### I4. Every mutating control names its owner

Mode, permission, approval, child lifecycle, terminal lifecycle, and tool execution APIs must identify the owning root session. Authorization never depends on an opaque child or terminal ID being hard to guess.

### I5. Shared-folder races are reported as data conflicts, not conversation conflicts

File tools use short-lived per-path coordination and optimistic validation. A collision reports the file/path conflict and asks the caller to re-read or retry. It never reports that another conversation owns the project.

## Ownership model

| Resource/state | Owner | Sharing rule |
| --- | --- | --- |
| Workspace/project definitions | Workspace/project | Shared configuration; edits do not automatically rewrite an active session snapshot |
| Project filesystem | Host filesystem | Shared resulting state; no Turn-wide ownership |
| Root mode selection | Root session | Live for that root and its descendants only |
| Root permission overrides | Root session | Live for that root and its descendants only |
| Root model/thinking | Root session | Existing per-session snapshot behavior remains |
| Child model override | Child session | Pinned at spawn; otherwise resolved from its root according to the existing precedence |
| Approvals | Root session + Turn + tool execution | Visible/answerable only in the owning root domain |
| Child sessions | Root session | Parent-root lifecycle and quota ownership |
| Tool execution | Session + Turn + host-generated execution ID | Globally unique identity; model call ID is transcript metadata only |
| MCP connection | Workspace + server | Transport may be shared; invocations and outcomes are isolated by execution ID |
| Interactive terminal | Root session | Sibling roots cannot list, drive, resize, or kill it |
| Host restrictions/config | Host/workspace | Mandatory shared safety ceiling; may affect all matching future executions |

## 1. Root execution identity

A root session ID is the execution-domain ID. A child keeps its own session ID but durably records `rootSessionId`, `parentSessionId`, and `parentTurnId`.

The ambient execution scope must expose:

```ts
interface ExecutionScope {
  workspaceId: WorkspaceId
  projectId?: ProjectId
  sessionId: SessionId
  rootSessionId: SessionId
  turnId: TurnId
  child?: {
    parentSessionId: SessionId
    parentTurnId: TurnId
    definition: string
  }
}
```

For a root, `sessionId === rootSessionId`. Every transient map or policy lookup must use the appropriate identity from this scope.

## 2. Session-owned mode and permission controls

### 2.1 Durable mode snapshot

Add a canonical root-session event:

```ts
{
  type: 'session/mode'
  modeId: string
  revision: number
  snapshot: NormalizedModeDefinition
  hash: string
}
```

The normalized snapshot is stored so restart behavior does not depend on a custom mode file still existing or retaining the same content. Mode definition files remain workspace resources used when selecting a new snapshot.

New root sessions snapshot the workspace's default mode at creation. The workspace selection becomes a **default for new conversations and draft UI**, not a live control for existing roots.

A mode change while a conversation is open appends `session/mode` to that root. It applies at the next model request and next unstarted tool gate in that root domain. It may re-evaluate that root's pending approvals and descendants, but cannot touch sibling roots.

Children do not receive an independently mutable mode picker. They resolve the current mode from `rootSessionId`, then intersect it with their immutable definition and spawn-time tool ceilings. A live root mode restriction therefore still narrows its running children without affecting another root.

The child consistency boundary is explicit:

- pinned at spawn: definition identity/hash, role instructions, task packet, inherited-context bytes/hash, project/workspace binding, file grants, model override, skills list, and definition/spawn tool ceiling;
- live from the root at each model request and immediately before each unstarted tool execution: selected mode snapshot/revision and optional permission override/revision;
- live mandatory ceilings: host/workspace blocked tools, dangerous-command configuration, MCP allowlists, and other security configuration;
- immutable once started: an already-dispatched provider request or executing tool is not killed by a control change; Stop remains the cancellation mechanism.

Tool preparation records the root mode and policy revisions it observed. After any approval wait and immediately before the side-effecting tool body starts, the final gate re-reads those revisions and effective authority. A newly unexposed or denied call ends truthfully without running; a still-allowed call proceeds. A pending child approval is re-evaluated only by changes to its own root or by mandatory host/workspace ceilings.

### 2.2 Permission state

Effective authority is the intersection of:

1. host mandatory restrictions;
2. workspace mandatory restrictions and MCP/hook configuration;
3. the root's selected mode snapshot;
4. optional root-session permission overrides;
5. a child's definition and spawn-time ceiling;
6. exact approval decisions for a single tool execution.

If explicit permission customization remains a product control, add a root event such as `session/policy` containing only validated overrides and a monotonic revision. If the UI exposes no independent override, the selected mode's permission defaults are the root policy and no extra event is required.

A workspace mode/default change never reevaluates approvals belonging to existing roots. A mandatory host/workspace safety configuration change may reevaluate affected calls across roots because it is an authority ceiling, not a conversation preference; audit records must name that reason distinctly.

### 2.3 APIs

Add:

```http
GET /api/workspaces/:wid/sessions/:sid/mode
PUT /api/workspaces/:wid/sessions/:sid/mode
GET /api/workspaces/:wid/sessions/:sid/policy        # when overrides exist
PUT /api/workspaces/:wid/sessions/:sid/policy        # when overrides exist
```

`GET/PUT /api/workspaces/:wid/mode` becomes the default-mode endpoint for drafts and future sessions. It must not mutate a running or existing root session.

## 3. Tool execution identity

### 3.1 Host-generated identity

At durable `tool/call` admission, mint a globally unique `executionId` such as `exec-<uuid>`. Preserve the model's `call.id` as `callId` solely for provider transcript pairing.

All execution-bound state uses `executionId`:

- approval request and decision;
- dangerous-command match;
- path-scope approval;
- MCP invocation and staged outcome;
- tool result outcome;
- hooks and audit records;
- cancellation and diagnostics.

No cache, journal, or side channel may key execution state solely by `callId`.

### 3.2 Event compatibility

New events carry both identities:

```ts
{ type: 'tool/call', executionId, call: { id: callId, name, args }, ... }
{ type: 'tool/result', executionId, callId, ok, output, ... }
```

Legacy events without `executionId` remain readable. They receive a deterministic replay-only identity derived from `sessionId + tool-call event seq`; that identity is never used to dispatch new side effects. New projection/recovery pairs calls and results by `executionId`. Legacy projection pairs a result to the nearest preceding unmatched call with the same model `callId` inside the same Step and Turn; an ambiguous legacy log is surfaced as corruption/interruption rather than guessed. Reusing `callId` in later Turns is therefore safe.

### 3.3 MCP

MCP `invocationId` is the host-generated `executionId`, never the model call ID. A workspace journal may remain shared, but terminal reuse is valid only when the entire immutable intent matches:

- execution ID;
- root/session/Turn identity;
- server and tool;
- argument hash;
- configuration and secret revisions.

An existing execution ID with different intent is an integrity error and is never returned as a cached result.

Dispatch uses an atomic per-`executionId` journal reservation. Under one serialized journal operation it either:

1. creates the first durable intent and grants this caller dispatch ownership;
2. finds an identical open intent and returns `indeterminate/in-flight` without dispatching again; or
3. finds a terminal record and returns only its durable outcome metadata.

Concurrent callers cannot both pass a separate `hasTerminal` check and append duplicate intents. Terminal records are audit evidence, not a full-result cache: unless the complete bounded tool result is durably stored and hash-verified, recovery never fabricates or replays the prior full output. It reports the durable terminal outcome plus an explicit `result unavailable after restart` diagnostic. Normal in-process completion returns the original full output directly.

The MCP outcome must be returned directly through the execution result or staged by `executionId`. A process-global map keyed by model call ID is forbidden.

### 3.4 Dangerous-command guard

A dangerous-command match is attached to the current tool execution or keyed by `executionId`. There is no fallback lookup by bare `call.id`. Configuration changes clear or reevaluate matches using workspace plus execution ownership without exposing one session's match to another.

## 4. Shared-project concurrency

### 4.1 Remove Turn-wide project leases

Remove application behavior that holds a project/root lease from the first `Write`, `Edit`, or `Bash` call until Turn settlement. Remove `project busy` as a tool result and remove writer handoff between a root and its child.

`Bash` is not automatically classified as owning the project. Read-only and mutating Bash commands both run under the normal permission, dangerous-command, cancellation, and process-cleanup gates.

### 4.2 File-tool conflict contract

Application-native mutations use a short-lived mutex keyed by canonical real target path only around final validation and replacement. Canonicalization repeats inside the critical section so a symlink/junction or creation-path race cannot redirect the operation. Waiting for this mutex is internal and cancellable; it does not fail because another root is active.

Every successful full or ranged `Read` returns machine-usable observation metadata out of band from the displayed text: canonical path, whole-file SHA-256, byte length, and observed existence. A ranged read still hashes the whole file. `Grep`/`Glob` output is not an overwrite observation. The tool pipeline makes this metadata available to the next `Write`/`Edit` call without requiring the model to copy a hidden token; compatibility schemas may continue accepting an explicit `expectedSha256`.

- Creating a path requires an observation that it was absent, or an explicit create-only operation; final creation uses exclusive-create semantics. If the target appeared after observation, return a conflict.
- Overwriting an existing file requires a previously observed whole-file hash. A `Write` that never observed the existing target is refused rather than acting as last-writer-wins.
- `Edit` requires the observed whole-file hash and validates both hash and exact-match contract inside the short critical section. A changed, missing, or ambiguous source returns a conflict.
- Existing-file replacement writes a sibling temporary file, flushes it, and atomically replaces the target where the platform supports that operation. Temp cleanup is mandatory. If replacement fails, the old target must remain readable and unchanged; a platform without that guarantee must fail clearly rather than truncate in place.
- New-file creation writes with exclusive ownership and removes an incomplete file if a pre-publication write/flush fails.
- Mutations of different canonical files do not wait for each other. Application locking does not claim protection from external editors or processes.

The model-visible error names the path and stale-state condition, for example:

> `conflict: src/a.ts changed after it was observed; re-read before writing`

It never names another conversation or asks the user to stop one.

### 4.3 Bash and external writers

Bash can modify arbitrary shared state with host-user authority. No application-level mutex can make it transactionally isolated. The product must state:

- concurrent sessions may observe Bash/file changes immediately;
- Bash may race file tools, other Bash processes, Git, and external editors;
- users who require snapshot isolation should use separate project folders or a future opt-in worktree mode.

This limitation is preferable to falsely claiming safety while blocking whole Turns and still permitting external races.

### 4.4 Administrative project mutations

Changing or deleting a project binding is an administrative operation, not a writer lease. It may require affected root sessions to be idle because it changes their fixed execution scope. Such a refusal must say the project configuration cannot change while named sessions are active; it must not leak into ordinary tool execution.

## 5. Delegation ownership and scheduling

### 5.1 Logical quotas

Keep logical limits local:

- up to 6 queued, dispatching, running, or uncertain children per root session;
- up to 8 spawn attempts per active root Turn;
- one delegation level.

Remove the fixed `MAX_ACTIVE_GLOBAL = 12` admission refusal. A sibling root never consumes these logical limits.

An uncertain child may continue holding one slot of its own root until reconciled. It cannot reduce another root's capacity.

### 5.2 Host dispatch scheduler

Host/provider concurrency protection is a fair dispatcher, not spawn admission. Child scheduler states are `queued`, `dispatching`, `running`, and terminal. Transitions are durable enough to recover truthfully but never cause automatic restart replay.

- spawning durably creates a child in `queued` and returns immediately;
- FIFO is preserved within each root; runnable roots are selected round-robin so sustained arrivals from one root cannot starve another;
- a provider-specific semaphore may cap `dispatching + running` requests for that provider; its values are configurable host protection, not a logical conversation quota;
- queued, dispatching, running, and uncertain children count toward their root's 6-child limit but not a host-global logical quota;
- cancellation atomically claims a queued child before dispatch, or signals/awaits it after dispatch has claimed it; exactly one transition wins;
- a child becomes `running` only after dispatch ownership is claimed and its provider request begins;
- Stop affects only the owning root's queued/dispatching/running children.

With N continuously runnable roots and available provider capacity, every root receives a dispatch opportunity within at most N scheduler selections. A host shutdown marks queued children interrupted and cancels dispatched children truthfully. Normal sibling activity does not produce `capacity reached: another conversation is delegating`.

### 5.3 Parent-addressed APIs

Replace workspace-only lifecycle routes with root-owned routes:

```http
POST /api/workspaces/:wid/sessions/:root/children
GET  /api/workspaces/:wid/sessions/:root/children
GET  /api/workspaces/:wid/sessions/:root/children/:child?waitMs=...
POST /api/workspaces/:wid/sessions/:root/children/:child/cancel
POST /api/workspaces/:wid/sessions/:root/children/:child/reconcile
```

Every operation verifies durable parent/root ownership. A child ID is not an authorization capability. A sibling root receives 404 for another root's child.

### 5.4 Spawn admission and Turn closing

Spawning and root Turn completion share one serialized parent-session admission writer. `spawnAdmission: open | closing | closed` is a durable parent-Turn fact, not an independent in-memory flag.

- a spawn reserves its attempt and child ID only while admission is `open`;
- child metadata is flushed before the parent spawn record, as today, but no child is schedulable until the parent relationship commit is durably confirmed;
- root completion appends/flushes `closing` through the same writer before enumerating committed and reserved children;
- a reservation that started before `closing` must resolve to one of: durably committed and included in cleanup, proven uncommitted and deleted/released, or `uncertain` and retained as an explicit cleanup blocker;
- no spawn can commit after the durable `closing` boundary;
- completion cancels or waits for that Turn's queued/dispatching/running children, records their terminal outcomes, then appends `closed` and the root terminal record;
- a spawn racing the boundary either commits before `closing` and is included, or fails before child work starts with a truthful `turn is closing` response.

Stop/completion has a configurable cleanup deadline. If a child ignores cancellation or a parent/child durability boundary remains uncertain, the API returns a non-success cleanup-pending/error result and the root does not claim confirmed cancellation or deletion. Reconcile may later prove settlement; no ambiguous operation is silently declared clean.

The model-facing `Agent` tool uses the ambient active Turn ID; it never searches for the latest historical `turn/start`.

### 5.5 Manual UI delegation

Starting a manual HTTP delegation Turn is allowed only when the root has no active Turn. The first spawn creates a real root Turn with `kind: 'delegation'`, a durable synthetic user/audit opener describing that delegation was requested through the UI, and open spawn admission. While that delegation Turn remains active, further manual spawns may join it only by explicitly naming its Turn ID; an omitted Turn ID starts a new delegation Turn only when no Turn is active. There is no implicit search for the latest historical Turn.

While a delegation Turn is open, ordinary user messages are durably queued for the next conversational Turn and never join its context. Delegation Turns do not run the root model, do not inject a synthetic user message into later model history, and are excluded from conversational history/context and compaction summaries while remaining visible in lifecycle/audit projections.

The client explicitly closes manual spawn admission, or an inactivity deadline closes it. The Turn then waits for or cancels its children, records results, and ends. Restart marks an unfinished delegation Turn and its children interrupted; it never reopens admission or redispatches them. A ninth later manual delegation does not inherit attempts from previous delegation Turns.

### 5.6 Stop and delete

All Stop routes converge on one implementation:

1. close spawn admission;
2. cancel the root agent request/tool/approval;
3. cancel and await that root's queued/running children;
4. append truthful terminal records;
5. return success only after cleanup is confirmed.

Deleting a root first performs the same descendant cleanup. It never touches sibling roots or their children.

## 6. Approval isolation

Every approval is bound to:

- workspace and project;
- `rootSessionId` and executing `sessionId`;
- Turn ID;
- `executionId`;
- exact tool and arguments;
- policy and mode revisions used when asked.

Approval lists and SSE envelopes are filtered by owning root. A parent may view that its child is awaiting approval, but only the user's action authorizes it; the root model never approves for a child.

A mode/policy change reevaluates approvals only in that root domain unless a mandatory host/workspace restriction changed. Settlement uses `executionId`, so repeated model call IDs cannot settle the wrong waiter.

## 7. Interactive terminal ownership

A terminal is owned by a root session and records `rootSessionId` in `TerminalInfo`. Routes move under the root session:

```http
GET/POST /api/workspaces/:wid/sessions/:root/terminals
GET      /api/workspaces/:wid/sessions/:root/terminals/events
POST     /api/workspaces/:wid/sessions/:root/terminals/:id/input
POST     /api/workspaces/:wid/sessions/:root/terminals/:id/resize
DELETE   /api/workspaces/:wid/sessions/:root/terminals/:id
```

A sibling root cannot list, subscribe to events or scrollback, send input to, resize, or kill the terminal. Terminal IDs are still random but ownership is verified explicitly. The service subscription itself is keyed by `rootSessionId`; filtering only at the HTTP route is insufficient because workspace-wide SSE would still leak terminal creation, output, and exit events.

The per-root terminal cap is 4. A user-created terminal is not an agent tool, so ordinary agent Stop does not kill it. Root deletion, workspace deletion, explicit terminal kill, idle reap, or host shutdown does.

## 8. Shared configuration boundaries

Root isolation does not duplicate every workspace service:

- MCP connections may remain one per workspace/server, provided request IDs and outcomes are execution-isolated.
- Mode and agent definition files remain shared catalogs; selected normalized snapshots are root-owned.
- Hooks, dangerous-command rules, blocked tools, secrets, and MCP allowlists remain mandatory workspace/host ceilings.
- Editing a shared mandatory safety configuration may affect future gates in multiple roots. That effect must be labeled as a configuration/security change, not a conversation control change.
- Workspace/project instructions, skills, and memory remain shared content sources selected under each root's mode. Their content does not grant authority.

## 9. Persistence and recovery

### 9.1 Canonical records

Add or amend durable records for:

- root `session/mode` snapshot and revision;
- optional root `session/policy` revision;
- child `rootSessionId` and parent Turn identity;
- host-generated `executionId` on tool calls/results, approvals, hooks, and MCP audits;
- delegation Turn kind and spawn admission transitions where needed for recovery.

### 9.2 Recovery

After restart:

- unfinished root and delegation Turns become interrupted;
- children never auto-resume;
- queued/running scheduler state is reconstructed as interrupted, not queued again;
- approvals are invalidated;
- mode/policy snapshots replay from the root log;
- no project writer lease is recovered because no Turn-wide lease exists;
- MCP legacy records remain audit history but cannot satisfy a new execution ID.

## 10. Migration and compatibility

### 10.1 Root mode migration

Before enabling per-root mode APIs, run a checksummed, idempotent migration under an exclusive data-home migration fence. Server startup does not accept session creation, mode mutation, or execution until the migration either completes or leaves the host in explicit repair-required mode.

1. snapshot the validated workspace default mode definitions and hashes used for this migration; a missing/disabled/invalid custom selection falls back to the bundled default and is named in the report;
2. enumerate root sessions only;
3. for each root lacking `session/mode`, write a pre-change backup and append one normalized `session/mode` snapshot plus durability barrier;
4. mark that root complete in a checksummed migration journal so restart resumes without duplicate appends;
5. leave child logs unchanged; children resolve their root;
6. record a final migration report and preserve backups of changed logs.

A session that cannot be migrated is fenced from new execution until repaired; it is never allowed to fall back to a mutable workspace live mode. New-session creation is enabled only after the migration version is committed, and new roots always include their mode snapshot in the creation durability boundary.

### 10.2 API transition

- Update the web client atomically with the server routes.
- Keep workspace `mode` only as the default for new roots.
- Return `410 Gone` from legacy workspace-only child wait/cancel routes after one compatibility release; they cannot safely preserve root isolation.
- Make the legacy Stop route call the canonical root cleanup path immediately.
- Root-owned terminal rollout requires a host restart or an explicit pre-upgrade drain that kills and confirms all workspace-owned legacy PTYs. After the feature flag/schema is active, every legacy workspace terminal route — list, create, events/SSE, scrollback, input, resize, and kill — returns `410 Gone`; no old event subscription remains registered. There is no in-place adoption of an unowned PTY.

### 10.3 MCP journal transition

New invocation IDs use the `exec-` namespace and a journal schema that records root/session/Turn identity. Legacy terminal records remain readable for audit but are excluded from new idempotency lookup.

## 11. Rollout phases

1. **Execution identity:** introduce `executionId`, migrate tool events compatibly, isolate approval/guard/path/MCP state, and add cross-session duplicate-ID tests.
2. **Root controls:** add root mode snapshots and APIs, migrate legacy sessions, update UI selection semantics, and scope approval reevaluation.
3. **Child ownership:** parent-address lifecycle routes, close HTTP spawn/completion races, remove `ad-hoc`, and unify Stop/delete cleanup.
4. **Scheduling:** remove the global child admission cap, add fair queued dispatch, and expose queued/running status.
5. **Project concurrency:** remove Turn-wide leases and handoff, add per-path mutation critical sections and mandatory optimistic overwrite checks.
6. **Terminal ownership:** bind PTYs and routes to root sessions.
7. **Documentation cleanup:** amend G1–G5, capability docs, route inventory, UI text, and tests that currently require `project busy`, workspace-global mode, workspace-only child access, or host-global child rejection.

Each phase must be independently migration-safe. Phase 1 precedes new MCP production claims; phases 2–5 are all required before claiming root-session independence.

## 12. Acceptance criteria

### Root independence

1. Two root sessions bound to the same project run concurrently; neither receives `project busy`.
2. A pending approval in A does not delay or deny a tool in B.
3. Stop/delete of A leaves B and B's children running.
4. Switching A's mode changes A's next request, stale batch gates, pending approvals, and children, but does not change B's manifest, schemas, permission decisions, or approvals.
5. A root and one of its children each prepare a call under A's old mode and park on approval; after A switches to a mode that denies/unexposes the calls, both fail at the final pre-side-effect gate, while an equivalent pending call in B remains governed by B's unchanged mode.
6. Restart preserves different mode selections for A and B.

### Filesystem concurrency

7. Concurrent mutations of different files proceed independently.
8. Full and ranged reads provide a whole-file observation hash; an overwrite without a valid observation is refused.
9. Concurrent native mutations of the same canonical file serialize only their final validation/write section; one stale overwrite returns a path-specific conflict without clobbering, including symlink/junction aliases.
10. Injected temp-write/flush/replace failures preserve the previous file bytes and clean temporary files.
11. Concurrent Bash is allowed under its normal permission and danger gates; documentation and UI do not claim transaction isolation.

### Delegation

12. Each root independently receives 3 child slots and 8 attempts per real Turn.
13. More than 12 children across roots are admitted; excess provider work becomes fairly queued rather than rejected because another root is delegating.
14. Under sustained load from multiple roots, FIFO holds within each root and every runnable root receives a dispatch opportunity within the documented round-robin bound.
15. Cancelling a queued child racing dispatch produces exactly one outcome: never both dispatched and reported cancelled-before-dispatch.
16. A sibling root cannot list, wait for, read results from, reconcile, or cancel another root's child.
17. Spawn racing Turn completion or Stop is either included before admission closes or rejected before child work starts; append failure/crash at each child/parent commit boundary never leaves a completed Turn with hidden running work.
18. Repeated manual delegation batches create separate delegation Turns, exclude their synthetic opener from conversational context/compaction, and do not accumulate under `ad-hoc`.
19. Every Stop route cancels and settles only that root's descendants; cleanup timeout or uncertainty returns a non-success state rather than confirmed cleanup.

### Execution identity and MCP

20. Two sessions, or two Turns in one session, may both emit model call ID `c1`; approvals, dangerous-command matches, path grants, tool results, recovery pairing, and hooks remain correctly attributed.
21. Two MCP calls in one workspace with the same model call ID but different sessions/arguments dispatch independently and return their own outcomes.
22. Concurrent MCP outcomes cannot consume each other's staged metadata.
23. Concurrent callers with the same execution ID cannot both dispatch; an open or terminal immutable-intent mismatch fails as an integrity error.
24. Restart after an MCP terminal record never fabricates a full cached result that was not durably stored; it reports the durable outcome and explicit result availability.

### Terminals

25. A terminal created by A is absent from B's list and returns 404 to B's scrollback/input/resize/kill routes.
26. B's terminal SSE receives no create/data/exit events from A.
27. Activating root-owned terminals drains/kills legacy PTYs and all legacy workspace terminal read, SSE, create, and mutation routes return `410 Gone`.
28. Agent Stop does not kill A's user terminal; deleting A does.

### Migration and compatibility

29. Legacy logs remain readable; migrated roots receive one durable mode snapshot and no child is rewritten as a root.
30. Migration is idempotent across interruption, fences concurrent session creation/control mutation, and reports invalid workspace defaults deterministically.
31. Legacy repeated call IDs pair only within their Step/Turn; ambiguous records are surfaced rather than guessed.
32. Legacy MCP audit rows remain visible but cannot satisfy new invocation lookup.
33. Browser and server route inventories contain no privileged child or terminal mutation/read stream lacking root ownership.
34. Tests that previously expected `project busy`, workspace-global live mode, direct workspace child cancellation, or a 12-child host rejection are replaced with the invariants above.

## Trade-offs

### Recommended: shared checkout + optimistic native file conflicts

Assumption: most coordinated edits use native `Write`/`Edit`, while Bash is explicitly understood as unrestricted shared-state execution.

Advantages:

- satisfies session execution independence;
- preserves the current shared-project workflow;
- introduces conflicts at the actual file boundary instead of blocking unrelated work;
- is substantially smaller than Git worktree orchestration.

Fails first when multiple sessions use Bash or external processes to mutate the same files concurrently. That risk already exists outside the current app lease and must be stated honestly.

### Alternative: automatic worktree per root

Assumption: every project is a suitable Git repository and users accept isolated branches plus an explicit merge/apply workflow.

Advantages: strongest practical filesystem isolation between roots.

Costs: changes current semantics, excludes non-Git projects, complicates uncommitted work, Windows paths, cleanup, branch ownership, submodules, large repositories, and user expectations about immediate shared changes. It is not recommended as the mandatory default; it may be a future opt-in execution mode.

### Rejected: queue all writers per project

Assumption: hiding contention behind a queue is sufficient independence.

It fails because one long approval, model Turn, Bash process, or stuck writer still delays unrelated sessions and makes latency depend on sibling activity. It is `project busy` without the visible error and retains the wrong ownership boundary.

## Better approach

The requested direction is correct, but the better implementation is not simply deleting `project busy`. The root execution domain must become the ownership unit, while shared filesystem safety moves to short per-path validation and host resource protection moves to fair dispatch. This addresses the verified cross-session leaks in controls, child lifecycle, MCP identity, guard state, terminals, and Turn admission instead of masking only the first symptom.
