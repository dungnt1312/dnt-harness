# The agent harness

The harness turns the kernel's mechanics into an agent runtime: a durable
session log, an LLM streaming seam, a turn/step driver, a guarded tool pipeline,
and an approval policy. Everything below is a plugin or a listener on the
kernel — the harness depends only on the kernel, never on the web host.

```
src/harness/
├── storage/   File-first session store: events.jsonl canonical, summary.json rebuildable
├── session/   Durable log: SessionEvent union, deriveMessages(), fork
├── llm/       Seam: provider registry + agent-facing stream, mock + DeepSeek
├── agent/     Turn/step driver: inbox, pre-step admission, turn-stopping
├── tools/     Registry + guarded pipeline: pre-execute -> run -> post-execute
├── approval/  Policy riding tools/pre-execute: allow | ask | deny
├── guard/     Dangerous command guard riding tools/rewrite: preset deny/ask on Bash content
├── workspace/ Workspace registry, project binding, ownership, writer leases
├── modes/     Four bundled + custom file modes (instructions, sources, exposure, permissions)
├── context/   Mode-driven builder: budget, trim order, compaction, per-request manifest
├── skills/    Workspace skill files + on-demand, mode-gated loading
├── memory/    Workspace/project Markdown topic files + MEMORY.md indexes
├── agents/    Definitions, bounded one-level delegation, Claude/Codex adapters
├── mcp/       MCP client (stdio + Streamable HTTP), config/secrets, health/retry/breaker
├── hooks/     Claude Code hooks: settings.json layers, shell runner, verdicts
├── instructions/ CLAUDE.md layers + @imports
└── limits.ts  Centralized bounded-execution defaults
```

## Session log (`session/`)

### The durable vocabulary (`events.ts`)

A session is an **append-only log** of durable facts. The closed union of
events is the whole vocabulary — new durable facts extend this type, and every
switch over it ends in `assertNever`:

```
turn/start          opens a turn
user/message        a user input the model will see (optional `attachments: AttachmentRef[]`)
step/start          opens one model request
assistant/chunk     a streamed delta (UI fidelity only — never model history)
assistant/message   the assembled assistant reply (+ optional toolCalls)
tool/call           the model requested a tool
tool/result         the tool answered (ok, output); `recovery: true` marks a
                    synthesized record whose real outcome is unknown.
                    MCP results may also carry `outcome`
                    (success | error | indeterminate | audit_fault) and
                    `invocationId`. Non-MCP tools omit both. `indeterminate`
                    is not retried; `audit_fault` blocks further MCP dispatch.
step/end            closes one model request
turn/end            closes the turn (reason: completed | rejected | empty |
                    failed | cancelled | interrupted | limit)
approval/request    a pending approval question, recorded durably (out-of-grant
                    questions also carry `scopeWarning` and `proposedGrant`)
approval/decision   its settlement: allow | deny | expired | cancelled | invalidated
input/queued        a pending input waiting for the current turn to close
                    (`runsNow: true` when the host dispatches a turn for it
                    at once because the session was idle)
session/title       derived or custom session title
session/project     session project binding
session/model       the session's model preference (provider/model/thinkingLevel;
                    an omitted field keeps the previous value, null is an
                    explicit clear)
session/grants      the session's extra file-tool folders (full list, last
                    wins, `revision` per change; `approvalId` when an approval
                    granted one)
session/child-meta  child-session provenance (parent turn, definition, brief, inherit audit)
agent/child-spawn   durable spawn intent + brief, written before a child agent starts
agent/child-result  a child agent's settled status (+ its failure, when failed)
mcp/call            one MCP tool call (hashed args/results, duration, error flag)
hook/run            one hook execution (event, matcher, exit code, decision)
```

Every event is stamped with `seq` (monotonic, 1-based) and `timestamp`.

**`deriveMessages(events, attachments?)`** projects model history from the log:
`user/message` → user (with `attachments` resolved through an optional
`AttachmentLookup`), `assistant/message` → assistant (with its tool calls),
`tool/result` → a tool message keyed by `callId`. Structural events and raw
`assistant/chunk` events are skipped. An attachment the host could not load
projects as `[attachment "name" (type) is not available]` so the model never
silently loses what the user sent. `userMessageContent(text, refs, loaded)`
is the pure helper: image refs become `ContentPart` image parts, text refs are
inlined as fenced blocks (truncated at the host's `attachmentTextLimit`), and
a text-only message stays a plain `string` so existing `toWireMessages` shapes
are unchanged. This function is the *only* way model context is built.

**`deriveSessionModel(events)`** (alias `sessionModelOf`) projects the
per-session model preference from the log, last `session/model` event wins.
An omitted field carries the preceding value forward; `null` survives as an
explicit session-owned blank for `provider`/`model` (so sending is rejected),
while `thinkingLevel: null` means the selected model's configured default.
Neither kind of null re-inherits global controls. A saved level is a
**preference, not a capability**: `expressibleThinkingLevel` keeps it only
for a model whose catalog entry documents it, so switching to a model that
does not offer it drops the override (the model's own default governs) while
the saved value stays in the log and applies again on a model that does.
The returned `hasEvent` flag separates a **legacy log** (no `session/model`
event — the caller alone falls back to the global default) from a session
that owns a preference, even an all-null one. `deriveMessages` ignores these
events; the preference is durable exactly like `session/title` and replays
across restarts.

### `Session` (`session.ts`)

```ts
const session = kernel.ctx.sessions.create()
session.append({ type: 'user/message', turnId, content: 'hello' })
session.deriveMessages()        // ModelMessage[]
session.fork(boundarySeq?)      // child session with copied history, seq rebased
```

- `append()` is the **only** way state grows: it stamps the event, stores it,
  and broadcasts `session/event` (so observers/UI render from it).
- `fork()` copies events up to and including `boundarySeq` (all when omitted)
  into a new session with `seq` rebased from 1; copied history is not
  re-broadcast, the child's future appends are. This is the resume/experiment
  seam.

### `SessionsService` (`service.ts`)

Registers the `sessions` service. `create(workspaceId?)` opens a session
scoped to a workspace; `get`/`delete`/listing resolve ownership the same way,
and a missing summary is rebuilt from the log rather than treated as data
loss. `fork(source, boundarySeq?)` is unchanged. `readCanonicalEvents(id)`
reads the persisted log without consulting — or recovering — a loaded
`Session`, the seam for reconciling a poisoned in-memory session against the
store; `undefined` means no durable store behind the id, while I/O and schema
errors propagate.

### Durable storage (`storage/`)

The store is **file-first**: for every session, `events.jsonl` under
`workspaces/<ws>/sessions/<id>/` is the canonical record; `summary.json` is a
rebuildable projection (a missing or stale summary only delays listing, it
never loses data). One writer per session keeps appends serialized with
monotonic `seq` and a schema version on every record.

- **Durability barriers**: an append is acknowledged only after the record is
  `fsync`-ed — with one exception: sessions built with
  `relaxedStreamingAppends` (the web host default; opt out with
  `DNT_HARNESS_FSYNC_EVERY_EVENT=1`) append `assistant/chunk` records without
  a per-record sync, and the session's next `durable()` barrier (or summary
  projection, or store close) supplies one batched `checkpoint()` fsync for
  the whole written prefix. A crash may lose the unsynced tail of an
  in-flight streamed answer — a fact restart recovery already treats as
  unknown — while every barriered record keeps its strict per-record sync.
  Directory entries are synced best-effort (Windows cannot fsync a
  directory handle — a documented limit), and replacements use
  temp + sync + rename.
- **Torn-tail quarantine**: a truncated final record — the classic
  crash-while-writing shape — is preserved verbatim to a `.partial-<ts>`
  sibling, then the log is repaired to its good prefix. Middle corruption is
  an error, never a silent skip.
- **Recovery semantics**: a host restart marks still-open turns `interrupted`
  (queued input stays queued); a missing `tool/result` for a durable
  `tool/call` is answered by a synthesized recovery record whose content says
  the outcome is unknown (never a tool replay); approvals left pending are
  settled as `invalidated` — late answers are refused. A late event never
  revives a terminal turn.

## LLM seam (`llm/`)

### Vocabulary (`types.ts`)

- `ModelMessage` — `system | user | assistant | tool`; `content` is a plain
  `string` or ordered `ContentPart[]` (`{type:'text',text}` | `{type:'image',
  mediaType, base64, name?}`) when the turn carries images. `messageText()`
  is the honest text projection (images become `[image: name]` placeholders).
  Assistant messages may carry `toolCalls`, tool messages carry `toolCallId`.
- `ToolCall` — `{ id, name, args }`; `args` is a JSON object validated at the
  model-JSON boundary.
- `ToolSchema` — the model-facing shape of one tool.
- `ModelRequest` — `{ model?, messages, tools? }`, projected from the log.
- `StreamEvent` — `{ type: 'delta', delta }` or `{ type: 'toolCalls', calls }`.
- `ContentPart` — the multimodal vocabulary: text stays a bare string so
  callers that never carry images change nothing; image parts are built only
  at the boundary from verified attachment bytes.

### The provider contract

```ts
interface LlmProvider {
  readonly name: string
  readonly models?: readonly string[]
  stream(request: ModelRequest): AsyncIterable<StreamEvent>
}
```

Providers are the only model-aware code. They never touch sessions or the loop —
the seam is the whole contract. Two providers ship:

- **`DeepSeekProvider`** (`deepseek.ts`) — streams `chat/completions` over SSE.
  Translates the internal vocabulary to the OpenAI-style wire format at the wire
  boundary, accumulates streamed `tool_calls` fragments into one `toolCalls`
  event, parses arguments as JSON, and skips `content: null` deltas emitted by
  reasoning-capable models while thinking.
- **`MockLlmProvider`** (`mock.ts`) — a deterministic scripted provider for tests
  and offline runs: each step is a text reply (streamed as word deltas) and/or a
  set of tool calls. The request is ignored; determinism is the point.

### `LlmService` (`service.ts`)

Registers the `llm` service:

- `register(provider)` — the registration is an **effect** (unwinds when the
  owning fiber unloads); the first provider becomes the active one.
- `use(name)` — switch providers; fails loud on an unknown name.
- `active()` — the active provider, or throws.
- `stream(request)` — the entry point. It dispatches the **`llm/stream`
  waterfall** whose default delegates to the active provider, so middleware can
  replace the request downstream or short-circuit with its own iterable. The
  chain result is normalized so consumers always receive an `AsyncIterable`.

## The turn/step driver (`agent/`)

### `Agent` (`agent.ts`)

One agent is bound to one durable session and runs the turn/step flow over an
inbox. A **step** is one model request plus the tools it calls; a **turn** is
zero or more steps — it opens before its first input is claimed and closes once
nothing is owed.

Input reaches the driver through one inbox:

- `send(content)` — queues a **user** message; wakes the driver.
- `inject(content)` — queues **injected context** that must reach the next
  admitted request *without* waking the driver; it waits until a user message
  arrives and is claimed alongside it.
- `run()` — drives turns until the inbox drains (only a `user` item opens a
  turn), then goes idle. Re-entrant calls are a no-op while running.

### The turn flow

```
turn/start
  claim inbox (injected context waits for a user message to wake the driver)
  -> agent/pre-step (waterfall)      reject | enter(contents)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append admitted input as user/message
     derive model history from the log (+ tool schemas)
     agent/request (waterfall) -> llm/stream (waterfall) -> assistant/chunk*
     transient mid-stream failure on the first attempt of a step
       -> step/abandoned (chunks are spent) -> fresh step/start -> re-ask
     assistant/message (+toolCalls)
     tool/call* -> tools/pre-execute -> execute -> tools/post-execute -> tool/result*
     step/end
     tools ran -> they owe the model their results -> next step
  -> agent/turn-stopping (serial)
turn/end
```

Details worth knowing:

- **Unbounded tool continuation.** The turn keeps spending steps while tools owe
  the model their results; there is no step bound — the model decides when it is
  done (`toolCalls.length === 0` ends the loop).
- **`agent/pre-step`** (waterfall) admits a claim. `enter(contents)` runs a step
  with the (possibly rewritten) contents; `reject` closes the turn with reason
  `rejected`. A first `enter` rewritten to empty closes it with reason `empty`.
- **`agent/request`** (waterfall) sits between the log projection and the
  provider — the web host uses it to stamp each session's effective model,
  provider, and thinking level onto every request; middleware may prepend a
  system message, etc.
- **`agent/turn-stopping`** (serial) runs *before* `turn/end` is appended, so
  observers see a settled step and no closing turn yet.
- **Failure closes the turn durably.** If a step throws, `closeOpenTurn()`
  appends `turn/end: failed` for the newest still-open turn so the log never has
  a dangling `turn/start`; the error still propagates to the caller.
- **No tools service mounted?** The loop still runs; tool calls fail as unknown
  tools (`no tools service mounted`).

### `AgentsService` (`service.ts`)

Registers the `agents` service: `create(session?)` binds an `Agent` to a fresh
session when none is given. Cross-service reads happen lazily at call time, so
mount order never matters.

### `agentScope` (`scope.ts`)

`agentScope.run({ sessionId }, fn)` — an `AsyncLocalStorage` populated while a
turn is in flight. Tool pipeline listeners (like the web approval bridge) read
it to attribute a tool call to the right session; the store is absent outside
any run. This scope carries the initiator's identity through the run.

## Tool pipeline (`tools/`)

### Vocabulary (`types.ts`)

- `ToolDefinition` — `{ name, description, parameters, execute(args) }`;
  `execute` returns a plain string (success), or throws to fail through
  `ToolResult`.
- `ToolResult` — `{ ok, output }`; what one tool run answers.
- `PreExecuteDecision` — `{ kind: 'allow', call }` (optionally rewritten) or
  `{ kind: 'deny', reason }`.

### `ToolsService` (`service.ts`)

Registers the `tools` service:

- `register(tool)` — registration is an **effect** (unwinds on unload, so the
  schema leaves request assembly too); duplicate names fail loud.
- `schemas()` — every registered tool's schema, joined into request assembly.
- `execute(call)` — the guarded pipeline:

```
tools/pre-execute (waterfall)   policy + rewriting, or deny
   → allow ? tool.execute(args) : (deny reason becomes a failed result)
tools/post-execute (waterfall)  transform the result the model sees
→ ToolResult
```

Grants: `setRootResolver` yields `{ root, additionalRoots?, deniedRoots? }`
per call. After authorization settles, `setApprovedPathResolver(call, allowed)`
supplies the out-of-grant paths an approval authorized for exactly that call,
and right before the tool body runs the grant is resolved again and
intersected with the one the call started with — a folder revoked while the
call waited for approval no longer authorizes it.

An unknown tool, a **denied** call, or a **throwing** tool body all become a
failed `ToolResult` the model can see — never an exception into the loop. The
finalized call is recorded before dispatch, then current exposure, permission,
guard, path, and interaction authority are checked again immediately before the
body. A human approval receipt is exact-call and requirement-bound. If the
final check newly requires an ask not covered by that receipt, dispatch fails
with a fresh-call requirement; the final gate never opens a second question or
retries the side effect. Prepared calls are single-use. The durable `tool/call`
and `tool/result` events belong to the agent loop; this method only decides and
executes.

## Managed commands and background processes (`processes/`)

Managed Bash waits 120 s by default (maximum 600 s), then auto-backgrounds eligible
commands without killing or rerunning. A bare `sleep` (including leading
`VAR=value` assignments) and session-less calls retain deadline termination.
`BashOutput` accepts `block` (default false) and
`timeoutMs` (default 30000, maximum 600000); expiry/abort ends waiting, not execution.
Normal child completion retains processes under the child owner. Cancel child stops
them, including retained processes of a completed child, without rewriting its result.
Child background lifetime defaults to 3600000 ms from commitment; root has no such
cap. Process events persist to canonical owner sessions. Interactive PTYs are unchanged.

`Bash { run_in_background: true }` spawns exactly like a foreground call (tree
tag, granted root, full approval waterfall — background is not a bypass) but
returns immediately with a process id; `timeoutMs` is ignored and the process
ignores the turn's abort signal, so it survives the turn. The host-owned
`ProcessRegistry` (`src/harness/processes/registry.ts`) keeps the child per
session, a 64 KB head-capped output ring, and kills through the shell
capability's `killTree` (process-group kill on POSIX; `taskkill /T` plus an
MSYS environment-tag sweep on Windows). Ended records stay readable for one
hour (configurable via `endedRetentionMs`) and are pruned on later lookups;
the durable event log remains the archive.

- Caps: **8 running per session**, **24 host-global**; beyond either, the call
  fails with an actionable error. No queueing.
- The model reads output and status with `BashOutput(processId)` and kills with
  `KillShell(processId)`; both are always allowed (they only touch processes
  the agent itself spawned) and need no granted root. Lookups are scoped by the
  executing session — a foreign session's id is unknown.
- Lifecycle lands on the session log as durable `process/start` /
  `process/exit` events; `termination` is one of `exited` (own exit),
  `killed` (KillShell or operator stop), `failed` (child error), or
  `interrupted` (see restart semantics below). The web Environment panel
  renders from these events.
- REST: `GET /api/workspaces/:ws/sessions/:sid/processes` (live reconciliation
  for state an SSE gap missed), `GET …/processes/:id` (one process plus its
  captured output — the workbench Process view), and
  `POST …/processes/:id/stop` (200 killed, 404 unknown, 409 already ended).

**Restart semantics:** sessions load lazily, so on the FIRST read of a session
after boot the host closes any `process/start` that has no `process/exit` with
one synthetic durable `process/exit { interrupted }`. Orphaned OS processes are
NOT re-adopted — they may survive the host (platform-dependent), but the
registry no longer owns them; `BashOutput`/`KillShell` on such ids answer
unknown truthfully. Deleting a session kills its running processes silently
(the log — their only reader — is being deleted; no exit events are written).

## Approval (`approval/policy.ts`)

`attachApproval(ctx, options)` attaches one `tools/pre-execute` listener with a
per-tool policy:

```ts
type ApprovalMode = 'allow' | 'ask' | 'deny'

interface ApprovalOptions {
  policy?: Readonly<Record<string, ApprovalMode>>
  defaultMode?: ApprovalMode            // default 'ask'
  askUser?: (call: ToolCall, lifecycle: ApprovalLifecycle) => Promise<boolean>
}

interface ApprovalLifecycle {
  approvalId: string      // the id in the log and the id a bridge answers with
  done: Promise<void>     // settled without an answer: retire the question
  expiresAt: number       // epoch ms; transports show the decision window
}
```

- `allow` → `next()` (let the call through).
- `deny` → `{ kind: 'deny', reason }`.
- `ask` → consult `askUser`; **without an answerer the policy fails closed**
  (denies with a reason the model sees). Returning `true` allows, `false` denies.
- Lookup order: exact tool name, then `mcp__server__*`, then catch-all `*`,
  then `defaultMode`. An already-aborted `exec.signal` cancels without waiting.
- The listener is **owned by the calling fiber** — unloading that fiber removes
  the policy, so several scoped policies can coexist.

The web host uses the selected mode's `permissionDefaults` as its single
permission layer; workspace overrides and policy routes do not exist. Web
`--yolo` maps every `ask` in that map to `allow`, while preserving every
explicit `deny`; unnamed tools still use the unchanged `defaultMode` fallback.
Headless uses its explicit map. Interactive MCP (`requiresUserInteraction`)
still force-asks. Bundled Full access carries a `'*': 'allow'` catch-all, so
MCP tools run there without asking.

On re-evaluation (a mode switch while a call waits), the exposure check
matches the host gate: built-ins must be listed by name, while `mcp__*` calls
stay exposed unless the incoming mode's ceiling is empty — mode files cannot
name dynamic MCP tools, so a non-empty built-in list never cancels their
pending asks.

`forceAsk(call, scope)` receives the call's own session/workspace — the
executing scope at first evaluation, the pending entry's stamped scope on
re-evaluation — so a settings change with no agent in flight never answers
for another workspace. `requestDetails(call)` adds facts (such as the
out-of-grant warning) to the durable `approval/request`.

An approval is bound to the exact call it names: it carries an expiry
(undecided requests settle as `expired` — never an implicit approval), and a
stop/cancel or a policy change settles it as `cancelled`/`invalidated` before
it can be answered. Every settlement is a durable `approval/decision` event,
and late answers to a settled approval are refused rather than replayed.

That record is written against **the session that asked**, resolved by its own
id rather than by the ambient agent scope: a settlement also arrives from a
reevaluation on an HTTP request, where no agent is in flight, and the `allow`
that let a re-gated call proceed has to appear in the log like any other
authorization.

## Dangerous command guard (`guard/`)

`attachDangerousCommandGuard(ctx, { configSource })` evaluates the finalized
`command` argument of every `Bash` call after rewrite hooks and before the
approval decision/final dispatch:

- **Presets** — six curated groups (`fsDestructive`, `gitDestructive`,
  `systemPriv`, `networkExfil`, `dbDestructive`, `resourceExhaust`), each
  a list of regexes; per-workspace setting is `deny | ask | off` (defaults:
  FS/Network/Resource `deny`, Git/System/DB `ask`). `off` skips the group.
- **Custom rules** — ordered `isRegex` or case-insensitive substring rules,
  each `deny | ask | allow` with highest priority (an `allow` can exempt a
  narrow path from a preset `deny`).
- **Normalization** — join unquoted Bash backslash-newline continuations, strip
  `#` comments outside quotes on each LF/CRLF line, then trim and collapse
  whitespace; quoted continuations remain content boundaries, quoted or escaped
  hashes are preserved, and matching is case-insensitive. This prevents a
  comment on one line from hiding executable text on a later line without
  manufacturing tokens inside quotes.
- **Limitations** — this is regex matching, not a shell AST. Documented
  non-matching fixtures include quoted executable names, command substitutions
  (`$(...)`), heredocs, commands delegated through interpreters, and Windows-shell
  syntax. A matching custom substring `allow` exempts the whole normalized
  compound command, including later commands; use narrowly anchored custom
  patterns. Per-command exceptions require a deferred redesign. Obfuscation such
  as `eval $(echo ...|base64 -d)` can bypass the guard.
- **Enforcement** — `deny` returns `{kind:'deny', reason}` before any
  `approval/request`; `ask` stores a `GuardMatch` and forces the approval
  waterfall via `forceAsk` so a Mode `allow` cannot skip the question,
  surfacing `Dangerous Commands: matched <preset/rule>` as a red banner
  on the approval card; `allow`/no-match passes through; a throw
  fail-closes to `deny`.
- **Storage** — `<home>/workspaces/<ws>/dangerous-commands.json` with
  `<home>/dangerous-commands.json` global fallback, hash-checked
  (`expectedHash` → `409` on conflict), atomic `replaceFileAtomic` writes.

The guard never widens a Mode denial (`toolExposure` or
`permissionDefaults` deny still wins), and Mode changes re-evaluate pending
approvals the same way they always have. It is advisory application-level
matching, not shell confinement: Bash still has the OS user's reach, and the
known parser/obfuscation gaps above remain outside this non-sandbox guard.

## Path-scope guard (`src/web/path-scope-guard.ts`)

The web host appends a final `tools/rewrite` listener after rewrite-capable
hooks, so it sees the finalized call before classifying each
`Read/Write/Edit/Glob/Grep` path against the run's grants without touching the
filesystem (see `docs/capabilities.md`):

- network/device paths, app storage, and writes into a read-only granted
  folder are denied before any `approval/request`;
- a path outside every granted folder is recorded with immutable path/intent
  and owning-root scope, then current grants and the live mode's exemption are
  resolved by authority at approval and final dispatch. It forces an approval
  even when the tool itself is `allow`, unless the executing mode currently has
  `outOfGrant: allow` (bundled Full access; duplicates inherit it) or the host
  runs `--yolo`;
- the card shows `Outside granted folders: <path> (read|write)`; a root
  session's card may also offer `Allow <folder> for this session` when that
  folder passes grant validation. Children answer `once` only.
- only an **allow** settlement authorizes the path, once; a session-scoped
  answer appends `session/grants` right before the call runs, and a failure
  to record it fails the call.

Writes into another folder take that folder's writer lease **after** the
approval gate (a pending or denied question never holds it); lease keys are
the outermost project folder containing the target, and leases are
hierarchical, so nested folders contend.

## Live controls, queued input, and limits

Three controls take effect **without steering** — each resolves at its gate,
so a change lands on the next opportunity instead of interrupting a running
turn:

- **Model** — the model/provider/thinking level are **per-session** facts: a
  durable `session/model` preference (see the session log vocabulary) is
  re-resolved per model request, and the host stamps the effective pair onto
  the request through `agent/request`. A mid-turn change therefore lands on
  the turn's next request without touching the stream in flight, and the
  context budget is recomputed for the new model on that same request. Only
  a legacy log without any `session/model` event falls back to the global
  default (`/api/model-defaults`), which every workspace shares.
- **Permission** — re-resolved at each tool-start gate (the next gated call).
- **Mode** — root-owned and live: re-gates tool exposure and permission
  defaults at the next unstarted tool call *and* reassembles context at the next
  model request, with pending approvals re-evaluated (newly unexposed calls are
  cancelled). A sibling root is unaffected. A child resolves this owning root
  mode, intersected with the child's immutable admission ceiling.

Messages sent while a turn runs are **queued, never injected**: each pending
input gets a stable id, duplicate `clientRequestId`s dedup, the queue is
bounded (`maxPendingInputs`), and queued items wait for the current turn to
close before claiming the next one.

Turns have no wall-clock deadline or model-step budget: the loop continues until
the model returns no tool calls or the user explicitly stops it. Operational
watchdogs and resource caps remain centralized in `limits.ts`:
`streamFirstEventMs` (10 minutes before the first model output or tool-call
fragment; no silence deadline after output starts), `stepRetries` / `stepRetryBaseMs` (a model request that
fails *transiently before producing any output* — `ProviderError.transient`,
e.g. a stream that closed empty — is asked again with exponential backoff, 3
extra attempts by default; a stop cancels the wait, and a failure after output
started is never retried), `toolTimeoutMs`, `approvalExpiryMs`, `toolOutputLimit`,
`maxPendingInputs`, `automaticCompactionPressure` (estimated pre-trim tokens/availableTokens
ratio from the settled turn's fresh context manifest that triggers automatic
compaction at a completed boundary; 0 disables), `compactionTailTurns`
(latest covered completed turns duplicated raw beside the summary,
default 4; 0 disables covered duplication, not uncovered history), plus composer-attachment limits
`maxAttachmentBytes`, `maxAttachmentsPerMessage`, and `attachmentTextLimit`
(model-visible cap for inlined text attachments; images travel as `ContentPart`
image parts with a flat `IMAGE_TOKEN_ESTIMATE` so multi-image turns do not
silently under-count).

## Mode-driven context assembly

Every model request is assembled by one context builder
(`src/harness/context/builder.ts`) from the active mode's definition
(`src/harness/modes/`) — the full message layout, trust model, environment
block, and trim order are normative in `docs/prompt-contract.md` and locked
by `tests/harness/g5-prompt-contract.spec.ts`. In short: one trusted system
message (base prompt or child preamble + capability line + role body, mode
instructions, the `<environment_context>` date/platform/workspace/git
block, file scope, compaction continuation note), then wrapped lower-trust
system messages for workspace/project
instructions, history per the mode's history setting (`none`/`recent`/
`compact` — `none` still keeps the current turn's tool loop; `compact` reads
a compaction checkpoint when one exists and equals `recent` when none does —
nothing is dropped without a summary covering it), active skills,
bounded MEMORY.md indexes (never pinned topic bodies), tool results and the schemas the mode's exposure
ceiling allows. The budget is `context window − output reserve − safety
margin` — the window is the operator's per-model override when set
(verified), else the shared model catalog's documented value for the model
(exact ID → known family → a 256k default; see
`src/harness/llm/model-catalog.ts`). Over-budget content trims in a defined
order or fails loud. The first, cheapest bucket is **microcompact**: once the
request passes 85% of the budget, old results of reproducible tools
(`Read`/`Glob`/`Grep`/`Bash`/`BashOutput`/`Write`/`Edit`/`mcp__*`) become a
short placeholder *in that request only* — the log is untouched — keeping the
newest 5 verbatim and never touching the unanswered tool batch or
`Agent`/`Skill`/`Memory`/`TodoWrite` results. It is the only lever for a long
single-turn run such as a subagent, whose open turn whole-turn dropping can
never shed; as a last resort before `ContextBudgetError` it keeps only the
newest result. Disabled loaders contribute nothing. Compaction (`context/compaction.ts`)
writes immutable checkpoints with range/provenance at completed boundaries and
never mutates the original JSONL. A checkpoint replaces only the covered range:
the covered events ride in the summary (a lower-trust wrapped block), with the
latest `compactionTailTurns` covered completed turns optionally duplicated raw
(default four; zero disables duplication). **All uncovered history** remains
eligible, regardless of the tail count. Existing budget trimming may still drop
oldest completed turns as whole units, preserving tool-call/result pairing and
the open task; those budget omissions are explicitly recorded in the manifest.
Trusted context frames this as the same conversation continuing after compaction,
not a new session, and recent raw conversation may supersede the summary.
The summary itself remains lower-trust reference data, never authoritative instructions.
The host summarizer uses the session's effective (provider, model) pair with a
structured-section prompt (`COMPACT_SUMMARY_PROMPT`). Folding is incremental:
when a valid canonical checkpoint exists, it seeds the accumulated summary and
only the uncovered delta beyond `coversSeq` is projected and folded — a repeat
attempt never re-summarizes already-covered history, and an unchanged boundary
is an idempotent no-op that appends no lifecycle events. The delta folds
chronologically through bounded requests, carrying the accumulated summary
into each later request. Each conversation-source payload, including the
accumulated summary, is at most 200,000 characters; returned summaries are
at most 24,000 characters. An invalid seed (unproven boundary, empty or
oversized summary) fails closed rather than silently folding from scratch.
A transient provider failure re-asks the same chunk with agent-loop retry
policy (`stepRetries`, exponential backoff); each attempt's partial output is
discarded, so a retry never duplicates text. When one chunk's answer would
exceed the cap, it is re-asked once with an explicit hard-length constraint;
still-oversized, failed, empty output prevents publication
of a new checkpoint rather than silently claiming partial coverage. An explicit
`maxChars` source cap rejects insufficient bounds instead of slicing the source.
With no model pair, the extractive fallback preserves the exact source only if
it fits within 24,000 characters, otherwise it fails explicitly.
Automatic compaction triggers only for compact-history mode after a completed
turn, using that turn's fresh estimated `preTrimTokens/availableTokens` pressure
(falling back to `usedTokens` for older manifests). This measures pressure before
microcompaction and budget trimming, not provider-measured token usage. Attempts
are deduplicated by completed boundary; rejected, empty, failed and cancelled
turns never reuse stale pressure. The standard web bin enables 0.85; embedded
hosts default to disabled and explicit zero disables it. Headless integration
is deferred. PreCompact hooks gate both manual and automatic attempts under one
per-session reservation. New inputs may be durably queued but cannot run a model
until maintenance settles; Stop/delete/shutdown cancel maintenance without
advancing queued input. Cancellation reaches the running PreCompact command's
process tree and prevents subsequent hooks from starting.

A successful durable canonical `compaction/end` is the authority. Checkpoint
JSON is an atomic, rebuildable cache: loaders validate coverage against session
facts and recover missing/corrupt cache from qualifying canonical success.
The builder also requires the supplied summary and coverage to match qualifying
canonical success; a closed turn alone cannot authorize invented summary text.
Unproven legacy or invalid coverage leaves history intact. Summarizer streams
require exactly one valid settled stop completion, no tool calls and bounded
nonempty text; configured first-progress, idle and total logical-request
deadlines and provider ownership apply. Text attachments use ordinary bounded
loading; images are explicit references, never claims about unseen pixels.
Compaction does not rewrite the last-request manifest: only the next real
request demonstrates consumption. Covered raw duplication may shrink by whole
turns to fit, with explicit omissions; the default four and explicit zero do
not cap uncovered history.
Every attempt is durably visible through two log-only events:
`compaction/start` opens the transaction before the summarizer runs, and
`compaction/end` closes it with the stored summary (or `error` on failure) —
a crash leaves the dangling start honest, and the transcript renders the
lifecycle live (Compacting… → Compacted, summary expandable) from the SSE
stream without any new endpoint. Each request carries a truthful **manifest**
(mode/model revisions, source hashes, ranges, budget, omission decisions) that
the UI's inspector renders as-is.

## Delegation (`agents/`, tool in `src/web/agent-delegation.ts`)

One root agent spawns children through the **same** loop and builder — there is
no second runtime. `ChildExecutor` owns the lifecycle (spawn / list / wait /
cancel / reconcile) and enforces one level: a child cannot delegate. Spawning is
uncapped — no per-conversation, host, or per-turn ceiling — though each child
still gets an isolated session, a brief, and an immutable admission ceiling of
owning-root mode exposure ∩ definition ∩ spawn grant. The ceiling is pinned at
the serialized admission point before child durability: later root widening
cannot add tools, while the owning root's live mode can still narrow unstarted
child calls.

**Staying alive on long work.** A child is one long open turn — dozens of model
requests with nothing to drop between them — so stability is decided by what
happens when a request fails or grows, and by what happens to the child when its
root stops waiting:

- *Too large.* The provider's refusal (`ProviderError.contextExceeded`, from the
  wordings OpenAI-compatible gateways use) is not final: the loop assembles the
  request again with `ModelRequest.squeeze` raised, and `squeezeBudget` shrinks
  the builder's budget by level (×0.7, ×0.45, ×0.25) so microcompact and the
  other trims actually send less. The chars/4 estimate runs low on non-English
  text and code; this is the correction. Only after the last level is the
  failure final.
- *Stalled or empty.* Every attempt streams under its own abort controller, so a
  timeout before first model progress (`streamFirstEventMs`) aborts that attempt,
  not the run. Tool argument fragments yield `toolCallProgress` without logging
  partial arguments or executing calls; accounting and SSE heartbeats are not
  model progress. After progress starts there is no silence timeout: a hung
  upstream must be stopped by the user. First-progress timeouts are retried like
  an empty stream (`stepRetries`, exponential
  backoff). Requests are re-assembled per attempt. A user stop is never retried.
- *Died mid-stream.* A transient failure after chunks reached the log is no
  longer final either, on the step's first attempt: the streamed text never
  joined model history (only `assistant/message` does) and no tool ran under
  that step id, so re-asking duplicates nothing. The loop appends
  `step/abandoned` for the spent step, mints a fresh step id, and re-asks
  wholesale — once per step; a second failure is final, and later steps of the
  same turn (whose input was tool output, not user input) still fail at once.
  Projections fold the abandoned step's chunks behind a discarded-attempt
  disclosure instead of duplicating them.
- *The root stops calling tools while children run.* Closing the turn would
  cancel them and lose their work. Instead the `agent/turn-continuation` serial
  event lets the host join the turn's unreported children
  (`ChildExecutor.joinTurnChildren`, bounded by `delegationJoinMs`, 30 min by
  default; a user stop ends the wait and leaves cleanup to Stop). Their reports
  come back as one user message of the same turn (`formatChildReports`) and the
  model gets one more step; a child the model already `wait`ed on is not
  delivered twice. Past the deadline a child is cancelled and reports what it did.
- *A child that did not finish.* `ChildHandle.partial` carries its last message
  and the files it touched for `failed` / `cancelled` / `interrupted` children.
  It is evidence, not a verdict — `result` stays exclusive to a completed child,
  and the root's report marks partial files as unverified.
- *A wait that outlives the turn's patience.* The `Agent` tool's `wait` honors
  the call's abort signal, so Stop returns at once instead of sitting out the
  timeout.

**Lifecycle boundary.** `spawn` checks, in order: the brief and inherit fields
(`SpawnError('packet' | 'inherit')`), that the parent is a root owned by the
requested workspace and project (`'ownership'`) and not itself a child
(`'depth'`), then records reservations in one synchronous block with no `await`
inside. It writes the child's `session/child-meta`, then the parent's
`agent/child-spawn` — the commit point. A failure before it deletes the new
child session and rolls every reservation back; after it, the child settles as
a durable failed child — unless the append's own durability cannot be
established, which leaves it `uncertain` (below). Settling releases the
conversation's active count; the per-turn attempt stays recorded until the
root turn's `agent/turn-settled`. A child
session is driven by the executor only: the message routes answer 409 for any
session carrying `session/child-meta`, so a child can never be resumed as a
plain root Agent.

**Uncertain children.** A rejected append is not proof of absence: the record
may have reached storage before the parent `Session` poisoned. When the
parent's `agent/child-spawn` or `agent/child-result` append fails and
`readCanonicalEvents` cannot establish whether it landed, the child's status
becomes `uncertain` — asserting neither terminal failure nor rollback. No
durable record ever carries the status. A spawn-`uncertain` child is never
launched; a result-`uncertain` child loses its advertised result but keeps its
log. Either way the entry is retained and keeps holding an active slot until
settlement proves a durable parent result, a proven-absent spawn is cleaned up
(below), a committed spawn that never launched settles as `interrupted`
(below), or the root is deleted. When canonical storage can be read, a
rejected append resolves by itself: the record that landed is committed, the
one that did not is missing.

**Uncertainty survives a restart.** A reconstructed child's status is the
parent's durable terminal record. A child whose own log holds a terminal turn
but whose parent carries no `agent/child-result` therefore reads `uncertain`
after a restart too: a terminal child turn proves only that the child stopped,
never that the parent accepted its result, and manufacturing a terminal status
from it would be unstable. Only a child with no terminal turn (or an
interrupted one) reports `interrupted`.

**Settlement (`reconcile`).** One repair path covers a retained live entry and
a restart-reconstructed one, and the terminal decision always comes from the
canonical parent log: a durable `agent/child-result` wins outright; otherwise
a canonical child terminal turn is the evidence for appending exactly one
parent result record, and the child settles only once that record is
canonically committed. The append goes through a usable parent writer — a
poisoned loaded parent is never reused, so an entry can remain `uncertain`
until a restart replaces the writer — and concurrent callers share one
settlement instead of writing competing records. A failed append is never
retried through a poisoned session; entries without canonical proof stay
uncertain. Two cleanups cover a live spawn-`uncertain` child that never
launched: when canonical storage proves the parent's spawn record absent, the
child is deleted and its reservation released exactly once; when the record
canonically persisted but no terminal child turn exists, the entry settles as
`interrupted` — the status a restart reconstructs from the same logs —
releasing its slot without touching the root's durable log.

**Bounded memory.** The executor's map holds active children only. Once a
child's terminal record is durable its entry is evicted; `list`/`wait`/
`cancel` rebuild a settled handle from the child's log and the parent's
`agent/child-result` — the same path a restart uses. Recovery indexes children
by id, skips (and logs) any whose parent is missing or owned elsewhere, and
reports unfinished ones as `interrupted`. Deleting a root drops its indexes and
cached manifests.

**The child's prompt.** `buildContext` takes an optional `child` input
(from `AgentScope.childOf`, pinned at spawn): the system block becomes a
subagent preamble (the final message is the whole deliverable; nobody reads
intermediate work; no delegation), a capability line derived from the request's
own schemas, and the role's instructions — in place of `BASE_SYSTEM` and the
mode prose. The server exposes a child only its ceiling, never `Agent`, so the
line cannot advertise a tool it lacks. The manifest records the role and its
instructions' hash. With `inherit: 'brief'` the child also receives a
messages-only projection of the parent conversation as a wrapped
`parent-context` message, droppable under budget (after skills, before
memory and history) with a manifest omission; only its hash and size are
durable.

**The result.** A completed child's `result.report` is its last non-empty
assistant message that carried no tool calls, cut at `MAX_REPORT_CHARS`
(16 000) with a marker and `truncated`; `filesTouched` lists `Read`/`Write`/
`Edit` paths. Any other outcome — or a completed child with no such message —
has no result and an `error` naming its session. The derivation runs once per
child.

The model drives this itself through the built-in **`Agent`** tool, whose
actions mirror the executor: `spawn` returns a handle immediately, `wait` blocks
on several children (capped at 120 s, and it honours a root Stop), `list`,
`cancel`, `reconcile` (canonical settlement for `uncertain` children — a
retained live entry or a restart-reconstructed one), and `catalog` (roles +
`provider:model` ids). The tool is
deliberately asynchronous: one step runs its tool calls in sequence, so a
blocking spawn would serialize children and the executor's parallel capacity
would never be used. A child that is still running when the root's turn closes
is cancelled, which is why the tool tells the model to wait first. The tool
description also carries the delegation guidance (delegate separable work
whose result compresses; not what two tool calls would do) and the writer
boundary: a root turn holds the project lease from its first write until it
settles, spawning a write-capable child hands the lease off, the child then
locks per call with no whole-run lease, and the root may reacquire — so do not
fan out writers. Role listings for the description are cached per workspace.

### Which model a child runs on

Resolution order, applied once at spawn (`resolveChildModel`):

1. the `model` argument of the spawn (the root model's own choice),
2. the role definition's `model:` frontmatter (set in Settings → Agents),
3. the parent conversation's effective pair.

A plain reference is first matched exactly and case-sensitively against the
global model-alias collection. A matching alias resolves to its concrete
provider/model/thinking target before built-in Claude aliases or bare-model
resolution. A present but unusable alias is fail-closed: missing/disabled
providers, removed models, or unsupported thinking reject spawn without
fallback. Alias `thinkingLevel: null` means the target model's default, never
the parent's thinking level. `provider:model` bypasses alias matching; an
unmatched plain name keeps the existing bare-model and Claude-role semantics.

The pair is validated at spawn and then **stamped into the child's own log as a
`session/model` event**, so the child resolves its model exactly like any other
session: the pin survives restart, never re-inherits a later global default,
and alias edits affect future children only.

## Reading further

- Turn-flow tests: `tests/harness/agent-loop.spec.ts` (durable event order,
  inbox semantics, the model-visible-means-logged invariant, fork/resume).
- Tools + approval tests: `tests/harness/agent-tools.spec.ts`, `tools.spec.ts`.
- Provider tests: `tests/harness/llm.spec.ts`; session tests:
  `tests/harness/session.spec.ts`.
- Storage/recovery and lifecycle: `tests/harness/storage.spec.ts`,
  `tests/harness/g1-lifecycle.spec.ts`, `tests/harness/g1-approval.spec.ts`.
- Modes/context and workspace isolation: `tests/harness/modes.spec.ts`,
  `tests/harness/g3-context.spec.ts`, `tests/harness/g3-compaction.spec.ts`,
  `tests/harness/workspace-isolation.spec.ts`.
- Delegation: `tests/harness/g4-agents.spec.ts`,
  `tests/harness/g4-subagent-contract.spec.ts`, and over HTTP
  `tests/web/server-g4.spec.ts`, `tests/web/server-subagents.spec.ts`.
