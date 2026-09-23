# Research — model-driven delegation (the `Agent` tool)

Date: 2026-09-21 · Branch: `feat/workbench-terminal` · Scope: research only, no code changed.

## Question

G4 multi-agent runtime exists, but only the human can start a child (UI panel / HTTP).
What is the right way to let the *root model* delegate by itself?

## What already exists

| Piece | Where | State |
|---|---|---|
| Child runtime (spawn/list/wait/cancel/recover, caps, ceilings) | `src/harness/agents/executor.ts` | complete |
| Role definitions (bundled `explorer`/`worker`, workspace `*.md`, Claude import) | `src/harness/agents/definition-service.ts` | complete |
| HTTP surface | `src/web/server.ts:1930-2045` (`POST …/agents/:name`, `GET …/agents/children`, `GET/DELETE …/children/:id`) | complete |
| UI | `web/components/workbench/AgentRunsPanel.tsx` (spawn form + child cards + poll) | complete |
| Model-facing tool | — | **missing** |

Tool registry today: `Read Write Edit Glob Grep Bash Skill Memory*` only
(`src/harness/modes/bundled.ts:75`). No delegation verb reaches the model.

## Constraints found in the code (these decide the design)

1. **The name is already reserved: `Agent`.**
   `RESERVED_TOOL_NAMES` (`src/harness/mcp/config.ts:71-74`) includes `Agent`, and the
   G5 spec line 57 lists it as a canonical built-in. Not `Task`, not `Delegate`.

2. **Tool calls inside one step run strictly sequentially** —
   `src/harness/agent/agent.ts:405-455` is an awaited `for` loop. So a *blocking*
   delegation tool can never produce two children running at once, even though the
   executor is built for 3 (`MAX_ACTIVE_CHILDREN = 3`). This is the single most
   important fact: Claude's blocking `Task` tool gets parallelism from parallel tool
   batches, which this loop does not have.

3. **The G4 spec already fixed the shape**: "internal operations are spawn,
   list/status, wait/result and cancel… avoid duplicate result tools if wait already
   returns persisted results" (`docs/superpowers/specs/2026-09-09-g4-agents-tools-compatibility-design.md:23,57`).
   Async lifecycle, one tool, no `result` twin.

4. **Turn-stopping kills unwaited children.** `resolveForRootCompletion()`
   (`executor.ts:379`) cancels every still-running child of the closing turn
   (`server.ts:715-727`). An async spawn that the model never waits on is lost work.

5. **Ceilings are already enforced twice** for children: exposure gate
   (`server.ts:1128`) + executor depth check (`executor.ts:160-167`). A child that
   somehow carries `Agent` in its ceiling still fails with `SpawnError('depth')`.

6. **Spawn needs `parentTurnId`**, which `agentScope` does not carry
   (`src/harness/agent/scope.ts:13-31`). The HTTP route derives it from the last
   `turn/start` event (`server.ts:1954`) — the same trick works inside a tool, and it
   is exact there because the parent turn is open.

7. **Mode ceilings apply to delegation too**: spec line 61 — "Plan has no shell/writes
   and may only delegate readers". Chat exposes nothing.

8. **Child approvals route to the child's own SSE stream**
   (`server.ts:1373-1392`, keyed by `scope.sessionId`). A `worker` child under
   *Ask before changes* will block on an approval the user only sees after opening the
   child session; undecided approvals expire after 5 min (`limits.ts:34`).

9. **Result digest is already bounded**: summary ≤ 4 000 chars + ≤ 20 file refs
   (`executor.ts:409-421`), well under `toolOutputLimit` 60 000.

## Options

### A. One blocking `Agent` tool (Claude `Task` dialect)
`Agent({definition, objective, constraints, references, requiredResult, grantTools})`
→ spawns, awaits, returns the digest.

- ✅ smallest surface, no orphan children, no turn-end race, model cannot forget to wait.
- ❌ **zero parallelism** (constraint 2) — the 3-child capacity becomes decoration.
- ❌ one tool call can block for minutes with no bound; needs its own timeout.
- ❌ diverges from the G4 spec's stated async lifecycle.

### B. One `Agent` tool with an `action` enum — **recommended**
`action: 'spawn' | 'list' | 'wait' | 'cancel'`.

- `spawn` → `{childSessionId, definition, status}` immediately; model may spawn up to 3.
- `wait` → `{childIds?}` (default: every running child of this turn), returns digests;
  races `exec.signal` so Stop is honored.
- `list` → current statuses. `cancel` → stop one child.
- ✅ real fan-out within the existing sequential loop.
- ✅ matches spec line 23/57 and the Codex async dialect the repo pins.
- ✅ reuses `ChildExecutor` 1:1; no runtime change.
- ❌ the model can end a turn with children running → they are cancelled (mitigate:
  description states it, plus a `turn-stopping` note in the tool result).
- ❌ 4 actions = more schema for the model to get wrong.

### C. B, minus `list`/`cancel` (`spawn` + `wait` only)
Lifecycle visibility stays human-only in the panel.
- ✅ leanest async form. ❌ the model cannot recover from a stuck child by itself.

**Recommendation: B.** Constraint 2 rules out A if parallel delegation is the point,
and the spec already named the lifecycle. If you want the minimum viable slice first,
ship B's `spawn` + `wait` (= C) and add `list`/`cancel` after.

## Round 2 — how Codex and Claude Code actually get parallel agents

### Codex (pinned commit `38cbebaf`, `multi_agents_spec.rs`)

Fully **async lifecycle**, no blocking spawn:

| Tool | Args | Blocking |
|---|---|---|
| `spawn_agent` | V1: `message`/`items`, `agent_type`, `fork_context`, `model`, `reasoning_effort` · V2: `task_name`+`message`+… | async, returns an agent id |
| `wait_agent` | V1: `targets` (**array of ids**), `timeout_ms` · V2: `timeout_ms` only (mailbox) | **blocking** |
| `list_agents` | `path_prefix?` | async |
| `send_input` (V1) / `send_message`, `followup_task` (V2) | `target`, `message`, `interrupt?` | async |
| `close_agent` / `interrupt_agent` / `resume_agent` | `target` | async |

There is **no batch-spawn**. Parallelism comes purely from async spawn: N sequential
`spawn_agent` calls, each returning immediately, then one `wait_agent(targets[…])`
that returns when whichever finishes first. That is exactly option **B** above, and it
works without touching the agent loop.

### Claude Code

Two independent mechanisms, both in play:

1. **Background subagents (async + notification).** The `Agent` tool
   (`subagent_type`, `model`, `name`) runs in the background by default; the parent is
   *notified in a later turn* and monitors with `/tasks`; `SendMessage` resumes an
   agent by id/name. Limits: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` default **20**,
   nesting depth `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` default **3** (at the limit the
   Agent tool is withheld). Foreground mode still exists and blocks.
2. **Parallel tool batches.** The harness executes several `tool_use` blocks from one
   assistant message concurrently: `partitionToolCalls()` accumulates *consecutive*
   concurrency-safe calls into one batch, `isConcurrencySafe(parsedInput)` decides per
   invocation (parse failure ⇒ unsafe; `Bash` is safe only for read-only commands), an
   unsafe call breaks the batch and gets exclusive access, `MAX_CONCURRENCY` defaults to
   **10** (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`), and results are yielded **in receipt
   order, not completion order**. This is why a *blocking* `Task`/`Agent` tool still
   fans out there — three Agent calls in one message run at the same time.

### What that means for mini-dsh

- Mechanism 2 is precisely what `agent.ts:405-455` lacks (constraint 2). Copying it
  would give parallel delegation **and** parallel `Read`/`Grep`/`Glob` — but it touches
  the G1 core: durable `tool/call` ordering, concurrent approval questions, and the
  "stop between batch calls" guarantee at `agent.ts:410-425` all have to be re-stated
  for a batch.
- Mechanism 1's notification step does **not** exist here: `inject()` deliberately does
  not wake the driver — only a user message opens a turn (`agent.ts:53,129,149-152`).
  A Claude-style "child finished → parent wakes up" would need a new inbox kind that
  wakes the loop, which changes G1 turn semantics.
- Codex's model needs **neither**: async spawn + blocking `wait(targets[])` produces
  real concurrency inside today's sequential loop, costing one extra step.

### Revised recommendation

**Phase 1 — option B, Codex-shaped** (`Agent` with `spawn | wait | list | cancel`;
`wait` takes an array and defaults to every running child of this turn). Real
parallelism up to `MAX_ACTIVE_CHILDREN = 3`, zero changes to the agent loop, matches the
G4 spec's stated lifecycle and the dialect the repo already pins.

**Phase 2 (separate, optional) — parallel tool batches**, ported from Claude Code's
partition algorithm: consecutive concurrency-safe calls in one batch, bounded
concurrency, results re-ordered to receipt order, unsafe calls exclusive. Benefits every
tool, not just delegation, and only then does a blocking one-shot `Agent` become viable.
Do not fold this into phase 1 — it rewrites the durability/stop/approval invariants of
the step loop and deserves its own plan and tests.

Explicitly **not** recommended now: Claude-style background notification (needs new
inbox-wake semantics) and Codex V2's mailbox/`send_message` steering (spec: "no
send_message/send_input, steering, inbox or mid-Turn follow-up").

### Sources

- Codex pinned spec: https://github.com/openai/codex/blob/38cbebaf3fe3e81a94bf462079e7cf9659fc9e50/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code parallel agents overview: https://code.claude.com/docs/en/agents
- Claude Code concurrency internals (third-party source analysis): https://claude-code-from-source.com/ch07-concurrency/
- Anthropic parallel tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use

## Implementation surface (if B is accepted)

| File | Change |
|---|---|
| `src/web/server.ts` (~line 835, beside `Skill`) | register the `Agent` tool; resolve scope via `agentScope`, parent turn via last `turn/start`, call `childExecutor.{spawn,childrenOfRoot,wait,cancel}` |
| `src/web/server.ts:1087` gate | hard-deny `Agent` when `scope.childOf !== undefined` (third layer, explicit reason) |
| `src/harness/modes/bundled.ts` | add `Agent` to `KNOWN_MODE_TOOLS`; expose in `ask-before-changes` / `edit-automatically` / `full-access` (+ `plan` restricted to read-only definitions); `permissionDefaults: Agent: 'ask'` (spawn starts a tool-using process — `'allow'` only in Full access) |
| `src/harness/agents/executor.ts` | accept an `AbortSignal` in `wait()` so a root Stop does not sit out the 30 s timeout |
| `web/components/workbench/AgentRunsPanel.tsx` | refresh children when the model spawns (today polling only starts once a running child is already in state — a model-spawned child appears late) |
| `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts` | new: model spawns via tool, child cannot call `Agent`, mode gate denies in Chat/Plan, capacity error becomes a readable `ok:false` result, Stop cancels a waited child |
| `docs/harness.md`, `docs/web.md`, `docs/capabilities.md` | document the built-in `Agent` tool + its mode exposure |

Non-goals (spec-aligned): steering / send-message to a child, grandchildren, a second
result tool, cross-session sibling reads.

## Final proposal (after review)

### Review corrections to the sections above

1. **Plan mode needs no special-casing.** The exposure gate resolves the mode from
   `scope.workspaceId` (`server.ts:1096-1123`), and a child carries the *same*
   workspaceId — so a child in Plan already cannot `Write`/`Edit`/`Bash`. "Plan may only
   delegate readers" is enforced by construction; the implementation table's
   "plan restricted to read-only definitions" entry is unnecessary.
2. **Delegation cannot escalate authority.** Every child tool call re-enters the same
   approval policy under the same mode (`server.ts:1354-1364`). So the `Agent` tool's
   own permission is about cost/intent, not safety — `allow` is defensible everywhere
   except the mode whose whole premise is asking first.
3. **Stop is a real defect without a signal.** A blocking `wait` would ignore
   `exec.signal` (`executor.ts:337` takes only `timeoutMs`), so a root Stop would hang
   until the timeout. Signal support is mandatory, not optional.

### The contract

One tool, the reserved name `Agent`, one object argument:

```jsonc
{
  "action": "spawn" | "wait" | "list" | "cancel",
  // spawn
  "definition": "explorer",            // role name from the workspace catalog
  "objective": "…",                     // required
  "constraints": [], "references": [],  // optional
  "requiredResult": "bounded summary with file references",
  "grantTools": ["Read", "Grep"],       // narrows the definition; never widens
  // wait / cancel
  "childIds": ["…"],                    // wait: default = every running child of this turn
  "timeoutMs": 30000                    // wait only; capped at 120 000 like the HTTP route
}
```

Results (bounded JSON text):

- `spawn` → `{childSessionId, definition, status:"running", active:"2/3", droppedGrants:[…]}`
- `wait` → handles with the executor's digest (≤4 000 chars + ≤20 file refs); children
  still running are returned as `running` with an explicit "call wait again" note
- `list` → every child of this root · `cancel` → the handles after cancellation

Failures stay `ok:false` with an actionable message: capacity (`3 active` / `8 per
turn`), unknown role **plus the catalog listing**, depth (a child called `Agent`).

Fan-out: the model emits `spawn` ×N (sequential but each returns immediately), the
children run concurrently, then one `wait`. Same shape as Codex `spawn_agent` ×N +
`wait_agent(targets[])`.

### Work items

| # | File | Change |
|---|---|---|
| 1 | `src/harness/agents/executor.ts` | `wait()` accepts `{timeoutMs, signal}` and a list of ids; races the abort signal so root Stop returns at once |
| 2 | **new** `src/web/agent-delegation.ts` | one shared implementation of spawn/list/wait/cancel for a root session + the `Agent` tool factory; `server.ts` HTTP routes call the same helpers (DRY — the routes at `server.ts:1930-2045` duplicate this logic today) |
| 3 | `src/web/server.ts` (~835, beside `Skill`) | register the tool from the factory |
| 4 | `src/web/server.ts:1087` gate | explicit deny of `Agent` when `scope.childOf !== undefined` |
| 5 | `src/harness/modes/bundled.ts` | `Agent` in `KNOWN_MODE_TOOLS`; exposed in plan / ask-before-changes / edit-automatically / full-access; defaults: `ask` in ask-before-changes, `allow` elsewhere; Chat unchanged (none) |
| 6 | `web/components/workbench/AgentRunsPanel.tsx` | refresh on a `refreshSignal` prop derived from root-stream `tool/call` events named `Agent`, so model-spawned children appear immediately |
| 7 | `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts`, panel spec | tool spawns a child; child calling `Agent` is denied; Chat denies; capacity failure text; `wait` returns digests; Stop aborts a `wait`; two children run concurrently |
| 8 | `docs/harness.md`, `docs/web.md`, `docs/capabilities.md` | document the built-in `Agent` tool and its mode exposure |

Phase 2, **separate plan**: port Claude Code's `partitionToolCalls` / `isConcurrencySafe`
batching into `agent.ts:405-455`. Only then is a blocking one-shot `Agent` worth
revisiting. Not part of this work.

### Answers to the open questions

1. **Permission**: `ask` in *Ask before changes*, `allow` in *Edit automatically*,
   *Full access* and *Plan* — safe because the child's own calls are gated identically.
2. **Plan**: expose it. Read-only children are guaranteed by the mode gate; the tool
   description should still steer Plan toward `explorer`.
3. **Wait bound**: no new constant — default 30 s, cap 120 s, reuse the HTTP route's cap
   (`server.ts:2038`), plus the abort signal.
4. **Roles**: catalog names only. Do not synthesize a description from an async listing
   (`ToolDefinition.schema` is synchronous); an unknown name returns the catalog in the
   error, which self-corrects in one call.

## Risks

1. **Approval deadlock (highest).** Model spawns a `worker` under *Ask before changes*;
   the child blocks on an approval the user never sees → 5 min of a blocked root.
   Mitigations: default the tool's suggested role to `explorer`; surface a
   "child N awaiting approval" signal in the root's tool result on `wait` timeout;
   let `AgentRunsPanel` badge pending child approvals.
2. **Capacity is global, not per root** (`reservedActive`). Two conversations
   delegating at once will see `429`-shaped tool failures. Make the message explicit.
3. **Cost multiplication** — 3 children × their own steps, each on the root's model
   unless the definition overrides it. Worth a UI indicator.
4. **Grant confusion**: `grantTools` only narrows (`executor.ts:217-229`). A model
   passing a tool the definition lacks silently gets nothing — the tool result should
   say which requested tools were dropped.

## Open questions

1. `Agent` default permission: `ask` everywhere, or `allow` in Full access only?
2. Should `Plan` mode expose delegation at all (spec allows readers only) — worth it,
   or keep Plan single-agent?
3. Blocking `wait` bound: reuse the 30 s default + let the model re-wait, or a longer
   dedicated child deadline in `limits.ts`?
4. Should `spawn` accept a role the model invents, or only names from
   `AgentDefinitionService.list()` (the description would then enumerate the catalog)?
