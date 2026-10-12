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
minimal skill and agent formats, discovery checks and scope selection. It is
included for roots and children, survives base/child prompt overrides, and is
measured as fixed system-prompt cost in the existing manifest/section body.
It is absent for zero-tool requests and callers that omit the workspace folder.

The paths are reference facts, **not grants**; filesystem access and writes
still require the effective mode, exposure and approval policy. The full
[agent guide](agent-guide.md) is a source-repository doc, not an assumed file in
arbitrary user projects. Root `CLAUDE.md` points agents working on this repo to
that guide; the guide is read on demand rather than injected wholesale.

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
