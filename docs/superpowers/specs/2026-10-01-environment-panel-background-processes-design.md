# Environment Panel + Background Processes — Design

Date: 2026-10-01
Status: Approved (brainstorming session, design sections approved by user)
Reference: dntspace-app `src/components/chat/EnvironmentPanel.tsx`

## Problem

mini-dsh's workbench dock (Git, Subagents, Trajectory, Files, Context, Terminal) is
opened on demand — nothing in the chat column gives an always-visible glance of the
session's environment. dntspace-app solves this with a pinned Environment panel
(git summary, tasks, background processes, subagents, session media) that collapses
to summary chips. mini-dsh adopts that concept for what its harness actually has.

Additionally, mini-dsh's Bash tool is synchronous only: a long-running command blocks
the whole turn and there is no way to watch or kill it afterwards. The panel needs
real background processes to be truthful, so the backend ships in the same effort.

## Decisions (from the brainstorming dialogue)

1. **Concept**: env summary panel in the dntspace style — NOT an environment-variable editor.
2. **Placement**: pinned inside the chat column, above the transcript. Not a workbench tab.
3. **Sections v1**: Git, Subagents, Background processes. (dntspace's Tasks and Session
   media have no mini-dsh data source — no plan tool, no media folders.)
4. **Background source**: real agent-run background commands — Bash gains
   `run_in_background`, a host-owned ProcessRegistry tracks children, and two new
   Claude-first tools (`BashOutput`, `KillShell`) let the model read output and kill.
5. **Collapse behavior**: chips row + auto-open once per session scope on the first
   live event; a user collapse is sticky (never auto-reopens for that scope).

## Architecture

```
Bash(run_in_background) ──▶ ProcessRegistry (host-owned, per session)
                               │  keeps child + 64KB ring buffer
                               │  emits durable: process/start, process/exit
                               ▼
                    Session log ──SSE──▶ web (useSessionStream)
                               │              │
                    REST GET/stop ──▶ EnvironmentPanel (pinned above transcript)
                                      ├─ Git row      ← existing git report API
                                      ├─ Subagents    ← agent/child-* events
                                      └─ Processes    ← process/* events + REST
Model control: BashOutput(processId), KillShell(processId) — two new tools
```

Components and their single purposes:

- **ProcessRegistry** (`src/harness/processes/registry.ts`): owns background children
  per session. One clear interface: register (spawn), output (read ring), kill,
  snapshot, dispose-on-session-delete. It exposes lifecycle callbacks (`onStart`,
  `onExit`) and knows nothing about the web, SSE, or the session log — the host in
  `server.ts` bridges those callbacks to durable session-event appends.
- **Bash tool (background branch)** (`src/capabilities/shell/bash.ts`): spawns and
  hands ownership to the registry; returns immediately. Reuses the existing tree tag
  and `killTree` machinery.
- **BashOutput / KillShell tools**: the model's read and kill surface over the
  registry handle.
- **Web routes** (`src/web/server.ts`): hydration snapshot + operator stop.
- **EnvironmentPanel** (`web/components/chat/EnvironmentPanel.tsx`): renders
  git/subagents/processes from events + REST; opens the matching workbench tab on click.

## Backend: background Bash, registry, tools

### ProcessRegistry

- Host-owned `Map<sessionId, Map<processId, ProcessRecord>>` where a record holds the
  child process, tree tag, ring buffer, status, command, cwd, startedAt, turnId.
- `processId` format: `proc_<uuid>`.
- **Cap: 8 running processes per session**, plus a **host-global cap of 24 running
  background processes** across all sessions (child-agent sessions multiply: root +
  6 subagents × 8 would otherwise allow 56). Either cap hit fails the Bash call with
  an actionable error (kill or wait); no queueing.
- Ring buffer: 64KB per process; capture stops at the cap with a truncation marker
  (same philosophy as the Bash tool's capture cap).
- Processes **outlive the turn**: stopping a turn never kills background processes.
  Deleting a session kills all of its running processes (registry dispose) and emits
  nothing — the session's log is being deleted, so exit events would have no reader.
- Kill reuses the existing `killTree` + MSYS tag sweep from `bash.ts` (taskkill /T /F
  on Windows, process-group kill on POSIX) — no new kill semantics are invented.

### Bash tool changes

- New argument `run_in_background?: boolean`.
- Background spawn is identical to today's spawn (treeTag, `cwd = exec.root`,
  detached) except: no timeout timer, no turn-abort wiring (`exec.signal` is NOT
  consulted — the process must survive the turn), no await on close.
- The call still goes through the full approval waterfall (`tools/pre-execute` etc.)
  exactly like a foreground Bash call — background is not an approval bypass.
- Tool result on success:
  `background process started: id=proc_…; read output with BashOutput; kill with KillShell`
- `timeoutMs` is ignored in background mode; the tool description says so.

### New tools

- `BashOutput(processId)` — returns the captured output (capped at the model-visible
  limit with a truncation note) plus a status line (`running` / `exit code: N` /
  `killed` / `interrupted`). Always allowed without approval (reads the agent's own
  process output).
- `KillShell(processId)` — tree-kills the process and confirms. Always allowed
  without approval (the agent kills only what it spawned). Unknown id → an error
  listing currently known ids.
- Neither sets `requiresRoot` — they read an in-memory buffer and kill a process the
  agent itself spawned; no granted workspace root is involved.
- Both are plain `ToolDefinition`s created with a registry-handle **closure** (the
  same options pattern `bashTool` uses) and scope lookups by `exec.sessionId` — the
  field `ToolExecution` already carries. No `ToolExecution` extension is needed.
  Registered next to `bashTool` in `src/web/server.ts` and `src/bins/headless.ts`.

### Durability and restart semantics

- New durable session events (in `src/harness/session/events.ts`):
  - `process/start` `{ processId, command, cwd, turnId? }`
  - `process/exit` `{ processId, exitCode: number | null, termination: 'exited' | 'killed' | 'failed' | 'interrupted', durationMs }`
- `termination` vocabulary, fixed:
  - `exited` — the process ran and terminated on its own (exit code or signal).
  - `killed` — terminated by `KillShell` or the panel's operator Stop.
  - `failed` — the child errored after registration (e.g. stdio error event).
  - `interrupted` — log replay found the process `running` at server shutdown.
- They are written to the session log like every other event, so log replay after a
  restart shows finished processes in the panel with no extra machinery. The
  registry itself stays free of session-log knowledge: it fires `onStart`/`onExit`
  callbacks and the host in `server.ts` appends the durable events.
- **Restart**: on the FIRST read of each session after boot (sessions load
  lazily; a boot-time sweep would force-load every log), the host scans that
  session's events for `process/start` without a closing `process/exit` and
  appends one synthetic durable `process/exit { termination: 'interrupted',
  exitCode: null }` per open id — before any client can see the events, so the
  observable behavior is identical to a boot-time sweep. The log stays truthful
  and the UI needs no boot-time awareness. **Orphans are not
  re-adopted**: detached children may survive the server (platform-dependent) but
  the registry no longer owns them; `BashOutput`/`KillShell` on such ids return
  truthful unknown-id errors. This limitation is documented in `docs/harness.md`.

## Web API

- `GET /api/sessions/:sid/processes` — registry snapshot
  (`{ id, command, cwd, status, startedAt, exitCode?, termination?, durationMs? }[]`).
  This is **live reconciliation, not hydration**: the panel derives its list from
  session events (which already rehydrate from the manifest after restart); the GET
  exists to correct state that went stale while SSE was disconnected (e.g. a process
  that exited mid-gap).
- `POST /api/sessions/:sid/processes/:procId/stop` — operator-initiated kill from the
  panel; `200` with the new status, `404` unknown id, `409` process already exited.
- Both follow the existing session-route auth scope. No new SSE channel: process
  events ride the existing session event stream.

## EnvironmentPanel UI

- Full-width bar **above the transcript** in the chat column, below the header, in the
  non-scrolling host. No overlay behavior at narrow widths (full-width chips row and
  stacked sections both work; truncation handles the rest). Does not touch the
  conversation minimap.
- Two states:
  - **Collapsed (default)**: one ~36px chip row — `[branch +X −Y] [N process] [N subagent]`.
    A chip with active content is visually marked (`text-warn`/spinner conventions).
  - **Expanded**: stacked sections — Git row, Subagents list, Processes list. A section
    with no content is omitted (Git row always renders when a project is open).
- **Auto-open**: the first `process/start` or `agent/child-spawn` for the session scope
  expands the panel exactly once. An explicit user collapse is sticky for that scope.
- **Git row**: branch, `+X −Y` line counts, `↑↓` ahead/behind when available; click
  opens the Git workbench tab (`onView('git')`). Refreshes on mount and when a turn ends.
- **Subagents**: rows from `agent/child-spawn` / `agent/child-result` — name, live
  spinner + duration or final status; click opens the Subagents workbench tab. No stop
  button in the panel (actions live in the workbench tab; no duplicate affordances).
- **Processes**: command (truncated, full text on title), status chip, duration, and a
  Stop button on running rows → `POST …/stop`. Row click is a no-op in v1. Output is
  viewed in the transcript when the model calls `BashOutput` (tool results already
  render there); a workbench process-detail view is an explicit follow-up.
- Built from existing primitives (SectionHeader, ListItemRow) and semantic tokens
  (`text-ok`, `text-bad`, `text-fg-muted`); no bespoke CSS architecture.
- **Mode exposure wiring**: `BashOutput` and `KillShell` are added to the
  `toolExposure` list of every bundled mode that exposes `Bash`. Custom modes are not
  auto-granted the new tools.

## Error handling

- Spawn failure in background mode → tool result error, no registry entry leaks.
- Firehose output → ring stops at 64KB with a truncation marker; `BashOutput` truncates
  the model-visible body like foreground Bash does.
- Stop on an already-exited process → truthful `409` (unknown id is `404`); the panel
  reflects registry state after the call.
- Lost SSE → the panel keeps last-known state and shows the same connection warning
  pattern the TaskStatus line uses (a dropped stream never implies work stopped).
- Unknown `BashOutput`/`KillShell` id → error listing currently known ids.

## Testing

- **vitest backend**: registry unit tests (register/exit/kill, per-session cap 8 and
  host-global cap 24, dispose on session delete); Bash background mode (id returned,
  `BashOutput` sees partial then final output, `KillShell` kills the tree, spawn
  failure cleans up); routes (snapshot, stop, 404, 409, session scope); boot scan
  appends synthetic `interrupted` exits for un-closed `process/start` events.
- **vitest web**: chips render per state; auto-expand exactly once per scope with
  sticky user collapse; git row invokes the workbench-open callback; Stop posts the
  right route; subagent rows derive from events.
- **Live verification** on :3082 per the existing live-verify recipe: spawn a
  `sleep 30` background command, see the row appear, stop it from the panel.
- `docs/harness.md` gains a background-processes section documenting the contract,
  restart semantics, and the no-re-adopt limitation.

## Out of scope (explicit follow-ups)

- Workbench process-detail view (output tail per process in the dock).
- Plan/task section (needs a plan tool), session-media section (needs media folders).
- Re-adopting orphaned processes after restart.
- Per-process output persistence beyond the process's lifetime.
