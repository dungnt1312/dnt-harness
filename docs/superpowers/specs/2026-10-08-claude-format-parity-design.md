# Claude format parity: CLAUDE.md, hooks, subagents

Status: approved (user delegated decisions, 2026-10-08)

## Goal

dnt-harness reads and writes the **same files, in the same format, with the
same semantics** as Claude Code for three surfaces — memory/instruction files,
hooks, and subagent definitions. Where dnt-harness differed, dnt-harness
changes. The one deliberate addition is a **workspace layer**, because
dnt-harness hosts many workspaces: the workspace data folder
(`<data>/workspaces/<ws>/`) is laid out like a second `~/.claude/`.

```
~/.claude/                  user       CLAUDE.md  settings.json  agents/  skills/
<data>/workspaces/<ws>/     workspace  CLAUDE.md  settings.json  agents/  skills/
<project>/                  project    CLAUDE.md  .claude/CLAUDE.md  CLAUDE.local.md
                                       .claude/settings.json  .claude/settings.local.json
                                       .claude/agents/  .claude/skills/
```

Precedence everywhere: user < workspace < project (< local).

Safety properties dnt-harness already had stay, as long as they do not change
the file format: mode exposure ceilings, approval policy, the dangerous
command guard, untrusted-content wrapping, durable `hook/run` audit.

## A. CLAUDE.md

Loaded when the mode's `sources.workspaceInstructions` is on (unchanged gate).

Order (each later file appears later in context, so it wins on conflict):

1. `~/.claude/CLAUDE.md`
2. `<data>/workspaces/<ws>/CLAUDE.md`
3. For each directory from the outermost ancestor of the bound project down to
   the project root (stopping above the home directory and the filesystem
   root): `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`.

`AGENTS.md`: Claude Code reads it only through an import (`@AGENTS.md`).
dnt-harness honors that, and additionally reads `AGENTS.md` in a directory that
has **no** `CLAUDE.md`/`.claude/CLAUDE.md` — a repository written for other
agents still gets its instructions; a repository with a CLAUDE.md is read
exactly as Claude reads it.

Imports: `@path` tokens (relative to the importing file, `~/` = home, or
absolute) outside fenced code blocks and inline code spans. Max depth 5,
cycles skipped, each file loaded once. Caps: 40 KB per file, 200 KB total;
overflow truncates with a marker.

The legacy `INSTRUCTIONS.md` files are retired (none exist in deployed data).

## B. Hooks — `settings.json`

Sources, all merged and all run (Claude semantics):
`~/.claude/settings.json`, `<ws>/settings.json`,
`<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`.
`disableAllHooks: true` in any source disables every hook. Other settings keys
are preserved and ignored.

Schema (Claude):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Write|Edit",
  "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/x.sh", "timeout": 60 } ] } ] } }
```

- Events run: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`,
  `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`.
  Other event names parse and are reported as unsupported; they never fail
  a file.
- Matcher: omitted, `""` or `*` matches all; otherwise a regex anchored on the
  whole name (`Write|Edit`, `mcp__github__.*`). Tool events match the tool
  name; `SessionStart` the source (`startup|resume|clear|compact`);
  `PreCompact` the trigger (`manual|auto`); `Notification` the type.
- Execution: `command` runs through the shell (`/bin/sh -c`, `cmd.exe` on
  Windows) in the project directory (else the workspace folder) with
  `CLAUDE_PROJECT_DIR` set and credential-looking variables scrubbed.
  `timeout` is seconds (default 60). Matching hooks of one event run in
  parallel; identical commands are deduplicated.
- Input (stdin JSON): `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name`, plus per event `tool_name`,
  `tool_input`, `tool_use_id`, `tool_response`, `prompt`, `stop_hook_active`,
  `source`, `trigger`, `custom_instructions`, `reason`, `message`.
  `permission_mode` maps modes: ask-before-changes→`default`,
  edit-automatically→`acceptEdits`, plan→`plan`, full-access→`bypassPermissions`.
- Output: exit 0 = success (stdout JSON parsed when it is an object; for
  `UserPromptSubmit`/`SessionStart` plain stdout is added as context).
  Exit 2 = blocking error, stderr goes to the model (PreToolUse denies the
  call; PostToolUse annotates the result; UserPromptSubmit rejects the prompt;
  Stop/SubagentStop continue the turn). Other exits are non-blocking.
  JSON: `continue`/`stopReason`, `systemMessage`, `suppressOutput`,
  `decision: "block"`/`reason`, `hookSpecificOutput.{permissionDecision
  (allow|deny|ask), permissionDecisionReason, updatedInput, additionalContext}`
  and the legacy `decision: approve|block` for PreToolUse.
- dnt-harness hardening (format-neutral): `allow` never bypasses mode exposure,
  policy denies or the guard; `ask` forces an approval prompt; rewritten input
  re-enters every gate; injected context is lower-trust data. `PreCompact`
  cannot block (Claude semantics). Stop-hook continuations are capped at 8 per
  turn in addition to `stop_hook_active`.
- Trust: binding a project folder is the folder-trust decision (Claude's trust
  dialog); its `.claude/settings*.json` hooks run from then on.
- Migration: a legacy `<ws>/hooks.json` with no `hooks` in `<ws>/settings.json`
  is converted once into `settings.json` and renamed `hooks.json.migrated`.

## C. Subagents — `agents/*.md`

Layers: `~/.claude/agents/` < `<ws>/agents/` < `<project>/.claude/agents/`;
the bundled roles (`explorer`, `worker`, `reviewer`, `verifier`) sit below all
of them, so a file of the same name overrides a bundled role, as Claude's
custom agents override built-ins.

Format: YAML frontmatter (real YAML) + Markdown body.

- `name` (identity; falls back to the file name), `description` (required).
  Names are matched case-insensitively (`Explore` == `explore`).
- `tools` / `disallowedTools`: comma-separated string or list. **Omitted
  `tools` inherits every tool the conversation exposes** (Claude semantics).
  Claude names map (`Task`→`Agent`, `MultiEdit`→`Edit`, `LS`→`Glob`); names
  dnt-harness lacks are dropped with a warning — only narrowing, never widening.
- `model`: `inherit`, an alias (`sonnet|opus|haiku` → the first available
  model whose id contains the alias, preferring the conversation's provider),
  a `provider:model` id, or a model id. An unavailable definition model falls
  back to the conversation's model with a warning.
- `skills`: comma string or list.
- Recognized but not enforced: `permissionMode`, `hooks`, `mcpServers`,
  `memory`, `color`, `effort`, `isolation`, `background`, `maxTurns`. They are
  shown as warnings; they do not block the agent. Unknown keys are ignored.
- The dnt-harness-only `inheritable` key is removed.
- In-app create/edit writes the workspace layer only; user and project files
  are read-only in Settings.

## Tests

Unit: CLAUDE.md layering/imports/caps; settings parse/merge/migration; hook
runner I/O contract (exit codes, JSON fields, plain stdout context, timeout,
shell, env); agent YAML parse (comma tools, inherit, aliases, warnings) and
layer precedence. Web: hooks block/rewrite/ask/inject/Stop-continuation,
project agents and CLAUDE.md reach the request.
