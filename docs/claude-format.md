# Claude Code format parity

dnt-harness reads the same files Claude Code reads — `CLAUDE.md`,
`settings.json` hooks, and subagent files — in the same format and with the
same semantics. The one addition is a **workspace layer**: because one host
serves many workspaces, the workspace data folder
`<data>/workspaces/<ws>/` is laid out like a second `~/.claude/`.

```
~/.claude/                  user       CLAUDE.md  settings.json  agents/  skills/
<data>/workspaces/<ws>/     workspace  CLAUDE.md  settings.json  agents/  skills/
<project>/                  project    CLAUDE.md  .claude/CLAUDE.md  CLAUDE.local.md
                                       .claude/settings.json  .claude/settings.local.json
                                       .claude/agents/  .claude/skills/
```

Precedence: user < workspace < project < local. The web bin passes
`userClaudeDir: ~/.claude`; embedders that omit it skip the user layer.

Design and rationale: [the spec](superpowers/specs/2026-10-08-claude-format-parity-design.md).

## CLAUDE.md (`src/harness/instructions/claude-md.ts`)

Loaded when the mode's `sources.workspaceInstructions` is on, in this order
(later = more specific):

1. `~/.claude/CLAUDE.md`
2. `<data>/workspaces/<ws>/CLAUDE.md`
3. for each directory from the outermost ancestor of the project (below home)
   down to the project root: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`

`AGENTS.md` is read through an import (`@AGENTS.md`), as Claude Code does, and
as a fallback in a directory with no `CLAUDE.md` of its own.

`@path` imports (relative to the importing file, `~/…`, or absolute) are
followed outside code blocks/spans, depth ≤ 5, each file once. Each layer's
imports stay inside that layer (user: home; workspace: its folder; project:
the outermost directory of its chain), after symlinks, and never reach the
host's credential roots or app storage — a repository cannot pull
`~/.ssh/…` or another workspace into context. Caps: 40 KB per file, 200 KB
total, enforced on the read itself; overflow is truncated with a marker.
Content is wrapped as lower-trust `workspace-instructions`.

The retired `INSTRUCTIONS.md` files are no longer read.

## Hooks (`src/harness/hooks/`, host in `src/web/claude-hooks.ts`)

Sources — all merged, all run: `~/.claude/settings.json`,
`<ws>/settings.json`, `<project>/.claude/settings.json`,
`<project>/.claude/settings.local.json`. `disableAllHooks: true` anywhere turns
every hook off. Loading is lenient (bad entries are skipped and listed in
Settings → Hooks); saving the workspace layer is strict.

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Write|Edit",
  "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.sh", "timeout": 30 } ] } ] } }
```

| Event | Fires | Matcher | Effect |
|---|---|---|---|
| `PreToolUse` | before a tool's authorization | tool name | exit 2 / `permissionDecision: "deny"` / `decision: "block"` denies; `"ask"` forces an approval prompt; `updatedInput` rewrites and re-enters every gate; `additionalContext` reaches the model with the call's result |
| `PostToolUse` | after the tool succeeded | tool name | exit 2 / `decision: "block"` reason and `additionalContext` are appended to the result the model sees |
| `PostToolUseFailure` | after the tool ran and failed (`error` in input) | tool name | same as `PostToolUse`; a call that was denied before running fires neither |
| `UserPromptSubmit` | prompt admission | — | plain stdout / `additionalContext` become context; exit 2 / `decision: "block"` rejects the prompt |
| `Stop` | the root model finished | — | `decision: "block"` + `reason` continues the turn; `stop_hook_active` is true on the repeat; capped at 8 per turn |
| `SubagentStart` / `SubagentStop` | a child's first step / finish | agent type | context for the child / continue the child |
| `Notification` | a permission prompt is waiting | `permission_prompt` | observe-only |
| `PreCompact` | manual or automatic compaction | `manual` / `auto` | `continue: false` stops it; exit 2 only reaches the user |
| `SessionStart` | conversation created | `startup` | stdout / `additionalContext` join the first message |
| `SessionEnd` | conversation deleted | `clear` | observe-only |

Matchers are regular expressions over the whole value; blank or `*` matches
everything. Identical commands run once per event; matching hooks run in
parallel. Other Claude events (`PermissionRequest`, …) parse, are kept on
save, and are listed as not run.

**`if`, `async`, `asyncRewake`** (Claude command-hook fields; design:
`superpowers/specs/2026-10-12-hook-if-async-rewake-design.md`).

- `if` is a permission rule (`Bash(git commit:*)`, `Edit(src/**)`) matched
  against the tool call of `PreToolUse`, `PostToolUse` and
  `PostToolUseFailure`. It is a diagnostic on any other event.
  - It errs toward running the hook: any part of a compound command may
    match.
  - A command with substitutions or redirects matches when the rule's
    literal head occurs in it.
  - Hooks that share one command and differ only in `if` have separate ids
    and switches.
- `async: true` runs the hook in the background. It never blocks, decides
  or adds context, and its `hook/run` (`background: true`) lands when it
  finishes.
- `asyncRewake: true` (implies `async`): when the hook exits 2, its output
  is queued for the root conversation as lower-trust input
  (`origin: 'hook'`).
  - `rewakeMessage` is the prefix the model reads; `rewakeSummary` is the
    line the user sees.
  - An idle conversation wakes; a running turn is never interrupted, so the
    input waits behind it.
  - The rewake skips `UserPromptSubmit` and slash expansion.
  - An identical finding is dropped.
  - At most 4 rewakes per conversation per 10 minutes.
  - A hook whose interpreter cannot open its script is reported once as a
    broken installation and never wakes the model.
- Limits: 8 background hooks per conversation and 32 per host. A launch
  over a limit is audited as `skipped:cap`.
- A user Stop, deleting the conversation, or host shutdown kills them; a
  killed hook never rewakes.

**Execution.** `command` runs through the shell (`/bin/sh -c`, `cmd.exe` on
Windows) in the project folder (else the workspace folder) with
`CLAUDE_PROJECT_DIR` set; credential-looking environment variables are
scrubbed (`DNT_HARNESS_CHILD_PASS_ENV` passes named ones through). `timeout`
is in seconds (default 60); a timeout or Stop kills the whole process tree.

**Input** (stdin JSON): `session_id`, `transcript_path` (the session's
`events.jsonl`), `cwd`, `permission_mode` (modes map to `default`,
`acceptEdits`, `plan`, `bypassPermissions`), `hook_event_name`, plus per event
`tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `prompt`,
`stop_hook_active`, `agent_id`, `agent_type`, `source`, `trigger`, `reason`,
`message`. `tool_input` uses Claude's argument names (`file_path`,
`old_string`, `new_string`, `replace_all`, …) and `updatedInput` is mapped back.

**Output.** Exit 0: stdout JSON (`continue`, `stopReason`, `systemMessage`,
`decision`, `reason`, `hookSpecificOutput.{permissionDecision,
permissionDecisionReason, updatedInput, additionalContext}`). Exit 2: blocking
error, stderr is the reason. Other exits: non-blocking.

**Hardening that does not change the format.** A hook narrows, never widens:
`allow` cannot bypass mode exposure, policy denies or the dangerous-command
guard. Hook-provided context is wrapped as lower-trust data. Every hook run is
a durable `hook/run` event (event, matcher, exit code, duration, decision); a
PreToolUse audit that cannot be made durable denies the call.

**Trust and snapshot.** Binding a project folder to a workspace is the trust
decision (Claude's folder-trust dialog): its `.claude/settings*.json` hooks run
from then on. As in Claude Code, hook configuration is captured once per
conversation (children share their root's): a settings file changed
mid-conversation — by a person or by the agent — takes effect in the next
conversation, or immediately for all conversations when hooks are saved in
Settings → Hooks. A `Write`/`Edit` aimed at any `.claude/settings*.json`,
`.claude/hooks/…`, or `~/.claude/settings.json` always asks for approval,
whatever the mode allows.

**Stop.** `continue: false` from any tool hook stops the turn (the user's Stop);
a turn stop kills running hook process trees. Each hook's `systemMessage`,
`stopReason` or error text is kept on its `hook/run` event (`message`).

**Migration.** A legacy `<ws>/hooks.json` is converted once into
`<ws>/settings.json` (`command` + `args` become one quoted command line,
`timeoutMs` becomes seconds, `prefix*` matchers become `prefix.*`; `onFailure`
has no Claude equivalent and is dropped) and renamed `hooks.json.migrated`.

## Commands and plugins

Custom commands, plugin manifests, marketplace installs, and `enabledPlugins`
use Claude Code's formats with the workspace layer inserted. Commands expand
server-side (`$ARGUMENTS`, `${CLAUDE_*}`, inline shell through the guarded Bash
pipeline); plugins contribute namespaced commands, skills, agents, hooks and
MCP servers. See [plugins.md](plugins.md).

## Subagents (`src/harness/agents/definition-service.ts`)

Layers, later wins by name (case-insensitive): bundled roles
(`explorer`, `worker`, `reviewer`, `verifier`) < `~/.claude/agents/` < enabled
plugin agents (`plugin:agent`) < `<ws>/agents/` < `<project>/.claude/agents/`.
A file named like a bundled role
overrides it, as a Claude custom agent overrides a built-in.

Format: Claude Code subagent Markdown with YAML frontmatter.

- `name` (identity; falls back to the file name) and `description` (required),
  non-empty body.
- `tools` / `disallowedTools`: comma string or list. **Omitted `tools` inherits
  every tool** the conversation exposes (never `Agent`: children do not
  delegate); such a role also inherits the parent's MCP tools (`mcpServers`
  limits them to named servers). Explicit `tools` may list
  `mcp__server__tool` or `mcp__server__*`. Claude names map (`Task`→`Agent`,
  `MultiEdit`→`Edit`, `LS`→`Glob`, `Bash(git:*)`→`Bash`); names dnt-harness lacks (`WebFetch`, `WebSearch`,
  `NotebookEdit`, team tools…) are dropped with a warning — narrowing only.
- `model`: `inherit`, an alias (`sonnet` / `opus` / `haiku` → the first served
  model whose id contains it, preferring the conversation's provider), a
  `provider:model`, or a model id. A definition model this host cannot serve
  falls back to the conversation's model; an explicit spawn `model` still fails
  loudly.
- `skills`: comma string or list; preloaded into the child.
- `mcpServers`: comma string or list of server names; limits an inheriting
  role's MCP tools to those servers.
- Recognized, not enforced, reported as notes: `permissionMode`, `hooks`,
  `memory`, `color`, `effort`, `isolation`, `background`,
  `maxTurns`. Unknown keys are ignored with a note.

Settings → Agents lists every layer with its source and path; create/paste
writes Claude Code files into the workspace layer only. User and project files
are edited in place with any editor.
