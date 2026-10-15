# The Prompt & Context Contract

This document is the normative reference for what every model request
carries and where. The machine-checked version is
`tests/harness/g5-prompt-contract.spec.ts` — a diff there is a contract
change and is reviewed as one. Assembly happens in exactly one place:
`buildContext()` (`src/harness/context/builder.ts`).

## Message layout

```
[0]   system   TRUSTED   base prompt | child preamble + capability line + role
                         + mode instructions (root only)
                         + MCP precedence block (only when a mcp__* schema is carried)
                         + file scope (when file tools are exposed)
                         + harness authoring reference (when file tools are exposed)
                         + <environment_context>
                         + compaction continuation note (compact + checkpoint)
[1]   system   wrapped   workspace-instructions   (fixed cost)
[2]   system   wrapped   compacted-history         (fixed cost)
[3]   system   wrapped   parent-context            (droppable)
[4]   system   wrapped   skill-catalog             (droppable)
[5+]  system   wrapped   one per agent-definition skill (droppable as a group)
[..]  system   wrapped   memory entries (guidance + MEMORY.md indexes)
[..]  user/assistant/tool — conversation history (turn-windowed)
```

Attachments inline into their user message (`userMessageContent`); tool
schemas travel in `tools`, never in a message.

**Prefix stability.** Everything before history must render byte-identically
from one request to the next unless a real source changed (mode, tools,
instructions, compaction). Providers cache by prefix, so a change at
position N re-bills every token after it. These rules follow:

- The system block carries the **date only** (see below); the time of day
  rides each typed user message as a host-added first line
  `[sent YYYY-MM-DD HH:MM zone]`, rendered from the message's durable event
  timestamp. Messages with an `origin` (command expansion, hook context,
  continuation) carry none. The line exists only in model requests — never
  in the log, the UI, or the summarizer's source.
- A skill the model loads with `Skill` arrives as that tool's **result**, in
  history at the load point, and stays for later turns. Only an agent
  definition's `skills:` preloads use the `[5+]` blocks, because they are
  fixed for the child's whole run.
- The **skill catalog** `[4]` and the **MEMORY.md indexes** are read once per
  session and kept (`prefixSnapshots` in `src/web/server.ts`): a memory write
  or a skill edit no longer re-bills the whole request. The copy is re-read
  only when the prefix moves anyway — a new compaction checkpoint, a project
  rebind, a host restart — and a new session always reads the disk. A stale
  row hides nothing: the model sees its own memory writes in history, and
  the `Skill` tool's `catalog`/`load` read the disk. An empty memory index or
  a failed read is not kept, so it retries.
- **CLAUDE.md** (`[1]`) is deliberately re-read every request: an edit there
  must apply to the running session at once, and edits are rare (one change
  in ~20k measured request pairs).

## Trust model

| Source | Trust | Rationale |
|--------|-------|-----------|
| Base/child prompt, environment, file scope, harness authoring reference, compaction note | **trusted** | Host-owned constants or facts |
| Mode instructions | **trusted** | Configuration the workspace author chose; the exposure/permission gates — not prose — are the enforcement boundary. `manifest.sources.modeSource` records provenance (`bundled`/`workspace`) so drift is auditable. |
| Child role body | **trusted** | Same rationale as modes; pinned at spawn, `child.source` records provenance. |
| CLAUDE.md layers (user, workspace, project, local; `@imports`) | **wrapped lower-trust** | Human-authored prose, one step removed from configuration — see [Claude Code format parity](claude-format.md) |
| Skills, skill catalog, memory, compaction summary, parent-context | **wrapped lower-trust** | Derived from or authored by untrusted content |

The envelope (`wrapUntrusted`): a preamble declaring the body is DATA, then
`<untrusted kind="…" key="value">…</untrusted>`. Forged delimiters — opening
or closing, any case — are backslash-neutralized inside the body, and
attribute values are `"`-escaped. Containment is defense-in-depth; the
gates are the enforcement.

## The `<environment_context>` block

```
<environment_context>
Today: 2026-10-06 Monday (timezone +07:00)
Platform: darwin arm64 · Node v22.9.0
Workspace: /abs/project (git branch: feat/x)
</environment_context>
```

- Rendered by `renderEnvironmentContext` from host facts; the builder embeds
  the pre-rendered block (tests stay clock-free).
- Day granularity and a fixed position keep the provider prompt-cache prefix
  stable for the whole day. (The former minute-granularity line changed the
  first message every minute; usage logs showed ~83% of uncached input tokens
  lost exactly at minute boundaries.) The time of day travels with each typed
  user message instead — see *Prefix stability* above.
- The git branch is cached per project root for the server's lifetime
  (read-only hardened invocation, 2s timeout, silent omit). The Git view is
  the source of truth; a stale branch is the documented trade-off.
- Children receive date/platform but not the workspace line (their project
  path arrives via file scope).
- The manifest reports the parsed facts under `sources.environment`.

## Harness authoring reference

The web host passes the actual workspace resource folder as
`harnessWorkspaceDir`. When any filesystem tool is exposed, the builder adds a
short host-owned reference to message `[0]`: project/workspace/user locations,
scope selection and one sentence pointing to the `create-skill` skill (when
`Skill` is carried) or `docs/agent-guide.md` for formats. `Skill catalog` is
mentioned only when `Skill` is carried, `Agent catalog` only when `Agent` is
carried and never for a child. It is
included for roots and children, survives base/child prompt overrides, and is
measured as fixed system-prompt cost in the existing manifest/section body.
It is absent for zero-tool requests and callers that omit the workspace folder.

The paths are reference facts, **not grants**; filesystem access and writes
still require the effective mode, exposure and approval policy. The full
[agent guide](agent-guide.md) is a source-repository doc, not an assumed file in
arbitrary user projects. Root `CLAUDE.md` points agents working on this repo to
that guide; the guide is read on demand rather than injected wholesale.

## MCP precedence block

When the request's schemas include any `mcp__*` tool, the builder adds one fixed
sentence pair after the base/child prompt and mode/role: external tool
descriptions and returned content describe capabilities or provide task data and
do not override host instructions, tool exposure, grants or approval policy. It
lives outside `DEFAULT_BASE_SYSTEM`, so base/child overrides keep it, and it
depends only on whether MCP schemas exist (byte-stable per tool set). It is
defence in depth; the tool pipeline stays the enforcement.

## Tool selection and Bash

The base and child prompts choose tools by task (Read known files, Glob paths,
Grep text, Bash for builds/tests/Git/metadata and unsupported operations). Bash
results carry no harness-added advice: only the program's own output, truncation
markers and the exit/termination suffix. Existing files need an observation
(Read, or a prior successful Write/Edit/ApplyPatch) before they are changed;
reading through Bash creates none and new files need none.

## System prompt overrides

`system-prompts.json` per workspace (`src/harness/prompts/store.ts`) can
replace the base prompt (root) or the subagent preamble (child) **wholesale**.
Blank/absent falls back to the default. An override never merges and never
touches mode instructions, environment, file scope, or any wrapped source.
The Settings panel shows the effective text; compare-and-swap prevents
silent clobbering.

## Budget & trim order

Budget = context window − output reserve − margin (see
`src/harness/context/budget.ts`). When over budget, in order: microcompact
old reproducible tool results → drop skill catalog → drop skills → drop
inherited parent-context → drop memory → drop oldest completed turns
(whole turns only) → aggressive microcompact → fail loud
(`ContextBudgetError`). Every drop is recorded in `manifest.omissions`.

The window itself resolves once, in `resolveContextWindow` (catalog → family →
fallback) with the source recorded as `budget.windowSource`; an operator
override is a verified *window*, while every token count stays an estimate
(`budget.estimated: true` always). Context state — request manifests, provider
usage and compaction effects — is replayed by one browser-safe reducer
(`src/harness/context/context-state.ts`, tested in
`tests/harness/context-state.spec.ts`) shared by the manifest API, the
trajectory projector and the web UI.

Token counts use one estimator, `estimateTokens` in
`src/harness/context/calibration.ts`: chars/3 rounded up, CJK ideographs
counted twice (`budget.estimator: 'c3'`). Budget decisions follow the
provider's count, as ZCode does: `latestCalibration` finds the newest request
the provider measured (terminal attempt with usage, paired with its manifest by
`contextId`, same estimator, base estimate of at least 1 000 tokens, no
successful compaction since; a measurement of another model or provider stops
the search), and the builder scales every comparison (microcompact threshold,
each trim step, `ContextBudgetError`) by that request's reported/estimated
ratio, clamped to [1, 3] (calibration only tightens). A ratio rather than an absolute offset: the
estimator's error grows with the content, so it stays right when the next
request trims, drops or squeezes differently. `usedTokens`, `preTrimTokens`
and `breakdown` stay pure estimates; `budget.measured` carries the calibrated
`tokens`/`preTrimTokens`, the `ratio` and `source: 'provider_usage' |
'estimate'`. After a turn settles, automatic compaction uses the last
request's own report when the provider measured it (`settledPressureTokens`).
Compaction previews never calibrate: they describe a different history.

## History

Per mode setting: `none` (current turn only), `recent` (full log),
`compact` (checkpoint summary replaces the whole covered range; beside it ride
only the covered messages the user typed plus the latest covered turn's final
answer, verbatim, newest first within `compactionRetainTokens` — default
20 000 estimated tokens, the boundary message truncated, covered tool calls and
results never retained). Nothing is ever dropped without a summary covering it.

## Child differences

Message `[0]` becomes: child preamble (or workspace override) → capability
line derived from the request's actual schemas → `Role — <definition>:` pinned
body. Mode prose is absent (a plan's framing would mis-frame an explorer).
Everything after `[0]` is identical to root, plus the optional
`parent-context` message when the spawn asked for `inherit: 'brief'`.

## Deliberate non-goals

- **Append-mode prompt overrides** — wholesale only, documented above.
- **Preamble deduplication** across wrapped messages — each message is
  self-contained so a drop never orphans an envelope.
- **Mode/role wrapping** — they ride trusted; provenance fields make a
  future change audit-ready without another manifest migration.
- **Tool-schema normalization** — schemas travel as the provider expects.
