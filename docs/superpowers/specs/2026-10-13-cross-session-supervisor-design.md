# Cross-Session Supervisor — Design

**Date:** 2026-10-13
**Status:** Draft — awaiting review
**Scope:** Harness (new `orchestration/` subsystem) + web host wiring + web UI

---

## 1. Context & Goals

Today every root session is driven by a human: the user reads each transcript,
types each prompt, answers each approval. Running several sessions in parallel
means the user is the scheduler, the reviewer and the approver for all of them.

This feature adds a **supervisor**: a root session that acts as a *team lead*
over other root sessions ("workers"). The user talks to the supervisor; the
supervisor spawns or adopts workers, reads what they are doing, prompts them,
stops/forks/deletes them, and makes the decisions a user would make — inside a
**risk-tiered** envelope. Low-risk decisions are automatic, medium-risk ones are
judged by the supervisor with a stated confidence, and high-risk ones always go
to the human.

The decision model follows the "System One" idea (fast, typed, calibrated
decisions used as smart if-statements, escalating when confidence is low).
V1 implements it with deterministic rules plus the supervisor model's own
judgment; a seam lets V2 plug in a dedicated decision provider.

### Goals

1. A supervisor is an ordinary root session (own transcript, SSE, UI) whose
   mode exposes a set of `Session*` tools.
2. Workers are real root sessions: listed in the sidebar, openable, promptable
   by the human at any time. The supervisor either **spawns** them or
   **attaches** sessions that already exist.
3. The supervisor can inspect (tail + filter), prompt (queue or steer), stop,
   fork, and delete (spawned + idle only) its workers.
4. Worker approvals and questions are answered by a tiered policy: rules,
   then the supervisor's judgment, then the human. The human can always answer
   first; the first answer wins.
5. The host wakes the supervisor when a worker changes state in a way that
   needs attention (turn finished, failed, needs a decision).
6. Every supervisor action and decision is durable, attributed, and visible in
   both the supervisor's and the worker's logs/UI.

### Non-goals (V1)

- No nested supervisors (a supervisor cannot manage a supervisor), consistent
  with the harness's one-level delegation.
- No cross-workspace management: workers live in the supervisor's workspace.
- No scheduled/background supervisor (automations may open one later; not
  designed here).
- No dedicated decision-model provider (V2, behind the `Judge` seam).
- No supervisor-granted session-wide folder grants, no supervisor edits of
  modes, guard rules, hooks, or settings.
- The supervisor does not edit code itself: its mode has no `Write`, `Edit`,
  or `Bash`.

---

## 2. Architecture

```
┌──────────────────────── web host (server.ts) ────────────────────────┐
│ orchestration-host.ts  (NEW) — implements OrchestrationHost port:     │
│   createRootSession · submitMessage · agent.stop · sessions.fork ·    │
│   delete flow · answerApproval/answerQuestion · queueHookRewake        │
│ askUser answerer ──► DecisionRouter (NEW) ──► human UI (unchanged)    │
│ session/event listener ──► WakeupCoalescer (NEW)                      │
├──────────────────── harness/orchestration/ (NEW) ─────────────────────┤
│ tools.ts      Session* tool definitions over the OrchestrationHost   │
│ registry.ts   who-manages-whom, derived from worker logs/summaries    │
│ inspect.ts    tail + filter projection with caps                      │
│ risk.ts       RiskClassifier (rules → tier)                           │
│ policy.ts     autonomy policy: tier × judgment → act | escalate       │
│ judge.ts      Judge seam (V1: supervisor turn; V2: decision provider) │
│ wakeups.ts    coalescing + loop budget (fake-clock testable)          │
└───────────────────────────────────────────────────────────────────────┘
```

The harness modules are pure: they depend on an injected `OrchestrationHost`
port, never on `server.ts`. All HTTP and approval-map wiring lives in one new
web file, `src/web/orchestration-host.ts`, to avoid growing `server.ts`
further than the call sites need.

### 2.1 What makes a session a supervisor

A new bundled mode, **Supervisor** (`id: 'supervisor'`). A session is a
supervisor exactly while its live mode snapshot (`session/mode`) exposes the
`Session*` tools. This reuses the mode machinery end to end: per-session
snapshot, exposure ceiling, permission defaults, UI mode picker, final gate.
Switching a supervisor to another mode removes its tools (exposure ceiling)
but keeps its workers attached; switching back restores control.

Custom modes may also expose `Session*` tools (they are added to
`KNOWN_MODE_TOOLS`), so a user can build a variant.

```ts
{
  id: 'supervisor',
  name: 'Supervisor',
  instructions: 'You are a team lead coordinating other sessions ("workers")…',
  sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
  toolExposure: ['Read', 'Glob', 'Grep', 'Skill', 'TodoWrite', 'AskUserQuestion',
    'SessionList', 'SessionInspect', 'SessionSpawn', 'SessionAttach', 'SessionDetach',
    'SessionPrompt', 'SessionStop', 'SessionFork', 'SessionDelete', 'SessionDecide'],
  permissionDefaults: {
    Read: 'allow', Glob: 'allow', Grep: 'allow', Skill: 'allow', TodoWrite: 'allow', AskUserQuestion: 'allow',
    SessionList: 'allow', SessionInspect: 'allow',
    SessionSpawn: 'allow', SessionPrompt: 'allow', SessionStop: 'allow', SessionFork: 'allow',
    SessionDetach: 'allow', SessionDecide: 'allow',
    SessionAttach: 'ask',   // adopting a user-owned session is a human decision
    SessionDelete: 'ask',   // destructive
  },
  mcpExposure: 'none',
}
```

`SessionDecide` is `allow` at the tool layer because its *effect* is gated by
the decision policy (§5), not by the tool approval.

### 2.2 Ownership: who manages whom

Ownership is a property of the **worker**, recorded once in the worker's own
log (single writer, no dual-write between two logs):

```ts
| { type: 'session/supervisor'; supervisorSessionId: string | null; via: 'spawn' | 'attach' | 'human' }
```

- Last record wins; `null` means detached.
- `SessionSummary` gains `supervisorSessionId: string | null` (projected like
  `projectId`), so the registry is derived from summaries without loading the
  supervisor's or workers' full logs.
- `registry.ts` answers `workersOf(supervisorId)` and `supervisorOf(workerId)`
  from `ctx.sessions.summaries()`.
- Deleting a supervisor appends `session/supervisor: null` to each worker
  (detach, never delete).

### 2.3 Durable vocabulary changes

| Event | Change |
|---|---|
| `session/supervisor` | **New**, in the worker log (above). |
| `session/orchestration` | **New**, in the supervisor log: `{ autonomy, workerModes, decisionWindowMs }`, last wins. |
| `input/queued`, `user/message` | `origin` gains `'supervisor'`; new optional `fromSessionId`. |
| `approval/decision` | New optional `decidedBy: { kind: 'human' } \| { kind: 'supervisor'; sessionId; tier; confidence; rationale } \| { kind: 'rule'; sessionId; tier; rule }`. Absent means human (legacy logs). |
| `SessionSummary` | New `supervisorSessionId`. |

Every switch over `SessionEvent` gains the new cases (`assertNever` enforces
it). `deriveMessages` renders a supervisor-origin message as a normal user
message for the worker's model (the supervisor *is* acting as the user), and the
UI labels it "from Supervisor ‹title›".

---

## 3. Supervisor tools

All tools take the supervisor's scope from the execution (`exec.sessionId`,
`exec.workspaceId`), never from arguments. Every tool refuses targets that are
not root sessions in the same workspace, are child-agent sessions, are
supervisors themselves, or are the caller.

| Tool | Arguments | Effect | Rules |
|---|---|---|---|
| `SessionList` | `scope: 'workers' \| 'workspace'`, `status?` | Rows: id, title, project, mode, status/activity, pending approvals/questions/inputs, supervisor, updatedAt | `workspace` lists unmanaged roots so the supervisor can propose attaching them |
| `SessionInspect` | `sessionId`, `tail = 20` (max 100), `types?`, `sinceSeq?` | Status block + compact projection of the last events (§3.1) | Full projection for own workers only; any other root in the workspace returns the header block alone, without the last assistant text or any transcript, enough to decide whether to propose attaching it |
| `SessionSpawn` | `prompt`, `title?`, `projectId?`, `modeId?`, `controls?` | `createRootSession` → `session/supervisor (via: spawn)` → `submitMessage(origin: supervisor)` | `modeId` must be in the supervisor's `workerModes` (§5.4) |
| `SessionAttach` | `sessionId` | `session/supervisor (via: attach)` | Target unmanaged; `ask` by default |
| `SessionDetach` | `sessionId` | `session/supervisor: null` | Own workers only |
| `SessionPrompt` | `sessionId`, `content`, `delivery: 'queue' \| 'steer'` | `submitMessage` with `origin: 'supervisor'` | Own workers only; same validation as the HTTP route |
| `SessionStop` | `sessionId` | Same as `POST …/stop` | Own workers only |
| `SessionFork` | `sessionId`, `atSeq?` | `ctx.sessions.fork` + register entry + `session/supervisor (via: spawn)` on the fork | Own workers only; worker must be idle |
| `SessionDelete` | `sessionId` | Same flow as `DELETE /api/sessions/:id` | Own workers **spawned** by this supervisor (`via: spawn`) and idle; attached sessions belong to the user and are only detached |
| `SessionDecide` | `approvalId` + `allow`, or `questionId` + `answers \| decline`; `confidence` (0–1), `rationale` | Routed through the decision policy (§5) | Pending item must belong to an own worker |

`SessionFork` needs a fork helper the web host does not have yet; it is added
to `orchestration-host.ts` and also exposed as `POST …/sessions/:id/fork` so
the human gets the same action.

### 3.1 Inspect projection

`inspect.ts` turns a worker's events into a bounded, model-friendly text:

- Header: title, mode, status, activity, `lastSeq`, pending approvals (id,
  tool, tier, summary), pending questions, queued inputs count, the last
  turn's end reason and final assistant text (truncated).
- Body: the last `tail` events matching `types` (`user`, `assistant`, `tool`,
  `approval`, `error`), oldest first, after `sinceSeq` when given. Chunks are
  never included (assembled messages only). Each entry is truncated to
  600 characters; tool outputs to 300; the whole result to 12 000 characters.
- Returns `nextSinceSeq` so the supervisor can read incrementally.
- The whole projection is wrapped as **untrusted worker data**: worker output
  can contain text written to manipulate the supervisor (see §7).

---

## 4. Wake-ups

`wakeups.ts` listens to `session/event` for sessions whose summary has a
`supervisorSessionId`, and emits a wake-up into that supervisor for:

| Worker signal | Reason |
|---|---|
| `turn/end` (completed, error, interrupted) | `worker finished` / `worker failed` |
| `turn/error` | `worker failed` |
| `approval/request` escalated to the supervisor (§5) | `decision needed` |
| AskUserQuestion pending | `question pending` |

Delivery reuses `queueHookRewake` (durable `input/queued`, `origin: 'hook'`,
one-line `summary`, lower-trust content). An idle supervisor wakes at once; a
running supervisor gets it queued behind the current turn.

- **Coalescing:** signals for one supervisor are batched for 2 s into one
  wake-up listing each worker, its reason, and its `lastSeq`. Details are not
  inlined; the supervisor calls `SessionInspect`.
- **Loop budget:** a supervisor may consume at most `maxAutonomousWakeups`
  (default 25) consecutive wake-ups without a human-typed message. When the
  budget is exhausted the host stops waking it, posts a notice in its
  transcript, and sends a notification (push / notify channels). Any human
  message (a `user/message` without `origin`) resets the budget. This bounds the "worker finishes → supervisor
  prompts → worker finishes …" loop.
- Wake-ups are in-memory. After a restart, nothing is replayed (queued input
  never auto-starts, matching the existing restart rule).

---

## 5. Risk-tiered decisions

### 5.1 Flow

The host's existing `askUser` answerer is unchanged for the human: the approval
is recorded, emitted over SSE, and shown in the worker's UI as before. In
addition, when the asking session is a managed worker, the answerer hands the
pending item to the **DecisionRouter**:

```
approval/request (worker)
   │
   ├─► human UI (always, as today)           ─┐
   │                                          │ first answer wins
   └─► DecisionRouter                         │ (settle() is atomic)
         1. RiskClassifier → tier             │
         2. AutonomyPolicy(tier, autonomy):   │
              auto-allow  → answer now (rule) ┤
              judge       → wake supervisor;  │
                            await SessionDecide│
                            within window     ┤
              escalate    → notify human ─────┘
```

If the supervisor has not decided within `decisionWindowMs` (default 90 s), or
decides below the confidence threshold, the router escalates: it sends a
notification and marks the item "escalated" for the UI. The approval keeps
waiting for the human until its normal expiry.

The supervisor may always **deny** (any tier); a denial is fail-safe. It may
**allow** only within its autonomy (§5.3).

### 5.2 RiskClassifier (rules, V1)

Input: the call, the worker's mode snapshot, and facts the host already
computes for approvals — dangerous-guard match, risky-Bash match, out-of-grant
path scope, `toolRequiresInteraction`, `writesHookConfig`, read-only-Bash
classification.

| Tier | Examples |
|---|---|
| `low` | `Write`/`Edit` inside granted roots; read-only Bash inside the project; `TodoWrite`, `Skill`, `BashOutput`, `KillShell`, `DescribeImage` |
| `medium` | Other Bash inside the project without guard or risky match; `Agent` delegation; AskUserQuestion answers; MCP tools with a read-safe name that the mode exposes |
| `high` | Any dangerous-guard `ask` match; any risky-Bash match; any out-of-grant path; session-wide grant proposals; hook-config writes; interaction-required tools; other MCP tools; paid generation (`GenerateImage`, `EditImage`, `GenerateVideo`); any tool the table does not name |

The table is data in `risk.ts` with one test per row. Unknown means `high`.

### 5.3 AutonomyPolicy

Per supervisor, from `session/orchestration.autonomy`:

| Autonomy | `low` | `medium` | `high` |
|---|---|---|---|
| `observe` | escalate | escalate | escalate |
| `rules` | auto-allow | escalate | escalate |
| `standard` (default) | auto-allow | judge (allow if confidence ≥ 0.8) | escalate |

`high` is never decided by anything but a human, at every autonomy level.

### 5.4 Worker modes

`session/orchestration.workerModes` lists the modes `SessionSpawn` may use.
Default: the workspace's default mode only. A supervisor cannot spawn a worker
in a mode the user did not list, so it cannot escalate privilege by choosing
Full access. Attached sessions keep whatever mode the user gave them.

### 5.5 Making a supervisor allow pass the final gate

Today `settle(…, humanApproved)` issues an approval receipt only for human
allows, and `tools/final-gate` refuses an `ask` call without a covering
receipt. Changes:

- `settle` takes an `approver: Approver` (`human | rule | supervisor`) instead
  of the boolean. A receipt is issued for any `allow`, carrying the approver.
- `approval/decision` records `decidedBy` from the same value.
- The router answers through one internal function,
  `answerApproval(approvalId, allow, approver)`, extracted from the
  `POST /api/approvals/:id` handler. The HTTP route keeps its browser-principal
  check and calls it with `{ kind: 'human' }`. Only the router, running
  in-process, can pass a non-human approver; no HTTP route accepts one.
- `scope: 'session'` (session-wide grant) remains human-only.
- The final gate re-checks current authority as today: a supervisor allow
  cannot outlive a mode or guard change.

Questions follow the same pattern: `answerQuestion(questionId, outcome,
approver)` extracted from `POST /api/questions/:id`.

### 5.6 Judge seam (V2)

```ts
interface Judge {
  /** A judgment for one pending item, or 'defer' when this judge cannot answer. */
  judge(input: DecisionInput, signal: AbortSignal): Promise<Judgment | 'defer'>
}
interface Judgment {
  readonly allow: boolean
  readonly confidence: number      // 0..1
  readonly rationale: string
  readonly probabilities?: Readonly<Record<string, number>> // calibrated, V2
}
```

V1 has one implementation, `SupervisorTurnJudge`: it wakes the supervisor and
resolves when `SessionDecide` arrives or the window closes. V2 can add a
`ProviderJudge` that calls a structured-decision model (System One style,
typed outputs with calibrated probabilities) synchronously, tried before the
supervisor turn. `RiskClassifier` is an interface too, so V2 can replace the
table with a model that returns a tier distribution. Neither seam changes the
rule that `high` always escalates.

Because LLM-stated confidence is often overconfident, V1 treats it only as a
gate on `medium` items. The tier rules are what keep risky actions with the
human.

---

## 6. Web host & UI

### 6.1 API

- `GET …/sessions` rows gain `supervisorSessionId`, `isSupervisor`.
- `PATCH …/sessions/:id` accepts `{ supervisorSessionId: string | null }`
  (human attach/detach, recorded `via: 'human'`, no approval needed).
- `GET/PUT …/sessions/:id/orchestration` reads/writes `session/orchestration`
  (browser principal only, like grants).
- `POST …/sessions/:id/fork` (human fork; shared helper with `SessionFork`).
- SSE approval frames gain `decisionRoute: { tier, state: 'auto' | 'judging' | 'escalated', deadline? }`.

### 6.2 UI

- **Sidebar:** supervisor sessions get a "lead" badge; workers show a small
  "managed by ‹title›" chip and stay in their normal position.
- **Supervisor view:** a Team strip above the transcript listing workers
  (status, pending decisions, last update; click opens the worker). Header
  control for autonomy and worker modes. Tool cards for `Session*` calls.
- **Worker view:** supervisor-origin messages labelled "from Supervisor";
  approval banners show the route ("Supervisor deciding · 0:45 left",
  "Escalated to you", "Allowed by supervisor · 0.86 — ‹rationale›",
  "Allowed by rule (low risk)"). The human answer buttons are always active.
- **Composer:** "New supervisor" entry creates a root with the Supervisor
  mode; any session's menu gains "Assign to supervisor…".

---

## 7. Safety model

- **Prompt injection across sessions.** Worker transcripts are untrusted for
  the supervisor: inspect output and wake-ups are wrapped as lower-trust data,
  and the supervisor's instructions say so. A manipulated supervisor can still
  only reach `low`/`medium` decisions; `high` always needs the human, and
  worker modes are capped by `workerModes`.
- **No new authority path from outside.** Non-human approvers exist only
  in-process. HTTP approval routes keep the browser-principal rule.
- **Human override.** The human can answer any pending item first, stop any
  worker, detach any worker, or switch the supervisor's mode to remove its
  tools at once.
- **Bounded autonomy.** Loop budget (§4) and decision window (§5.1).
- **Audit.** Each worker log shows supervisor-origin messages and
  `decidedBy`; the supervisor log shows every `Session*` call and result.

---

## 8. Error handling

- Target missing, deleted, foreign workspace, child, supervisor, or not owned:
  the tool returns `ok: false` with the reason (never throws).
- Worker busy: `SessionPrompt` queues (or steers on request); `SessionFork`
  and `SessionDelete` refuse with "worker is running; stop it first".
- Worker unavailable after a storage failure: tools report 503-equivalent text.
- Approval settled before `SessionDecide` arrives (human answered, expired,
  cancelled): `SessionDecide` returns "already settled by ‹who›".
- Durable write failure on `session/supervisor` or a decision: fail closed (no
  ownership change; a supervisor allow becomes a deny, as `settle` does today).
- Supervisor deleted while workers wait for its judgment: pending judgments
  escalate immediately.
- Restart: pending approvals are invalidated by recovery as today; ownership
  survives (log-derived); budgets and windows reset.

---

## 9. Testing

Unit (`tests/harness/orchestration/`):

- `risk.spec.ts`: one case per tier row, including unknown → `high`.
- `policy.spec.ts`: the autonomy × tier × confidence matrix; deny always allowed.
- `inspect.spec.ts`: tail/filter/sinceSeq, per-entry and total caps, chunks excluded.
- `wakeups.spec.ts`: coalescing window and loop budget on a fake clock; human
  message resets the budget.
- `registry.spec.ts`: ownership from summaries; last record wins; detach on
  supervisor delete.
- `tools.spec.ts`: each tool against a fake `OrchestrationHost`, including
  every refusal rule.

Integration (`tests/web/`, mock LLM):

- Spawn → worker runs → supervisor woken → inspect → prompt.
- Medium approval allowed by `SessionDecide` passes the final gate and records
  `decidedBy`; below threshold escalates.
- High approval never auto-resolves at `standard`; human answer works.
- Human and supervisor race on the same approval: exactly one settlement.
- Attach refusals (child, supervisor, other owner); delete refuses attached and
  running workers.
- Worker modes cap on spawn; session-wide grant cannot be answered by the
  supervisor.
- `POST /api/approvals/:id` cannot set a non-human approver.

Web: `pnpm run build:web`; component tests for the Team strip and the approval
route banner.

---

## 10. Rollout

1. Harness pure modules + vocabulary changes (events, summary, `settle` approver).
2. `orchestration-host.ts`, extracted `answerApproval`/`answerQuestion`, fork helper, routes.
3. Supervisor bundled mode + tools registration + wake-ups.
4. UI.
5. `docs/orchestration.md` and a pointer in `docs/README.md`.

## 11. Open questions

1. Default autonomy for a new supervisor: `standard` (proposed) or `rules`?
2. Should `SessionAttach` stay `ask` in the Supervisor mode, given the human
   can also attach from the UI without an approval?
3. Is 90 s the right decision window, given the 5-minute approval expiry?
