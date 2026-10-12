# Claude Code slash commands and plugins — implementation report

Date: 2026-10-12. Branch: `main`. Status: implemented and reviewed three times; not yet committed.

## Outcome

dnt-harness now reads Claude Code custom slash commands, plugins and marketplaces in their native format. The only extension is a workspace layer (`<data>/workspaces/<ws>/`) between the user and project layers.

- Commands: `~/.claude/commands` < plugin (`plugin:cmd`) < workspace < project `.claude/commands`. Skills run as `/skill`; a skill shadows a same-named command, as in Claude Code 2.1.293.
- Expansion: `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n` (zero-based), named arguments, `${CLAUDE_*}`, inline `!` shell and fenced `!` blocks. Shell runs through the guarded Bash pipeline with `command/tool-call` made durable before the side effect.
- `allowed-tools` only turns a policy ask into allow, in the root conversation, for the turn that ran the command. `model` applies to that turn.
- Plugins: own store `<data>/plugins` (never `~/.claude`), install/enable/update/uninstall across user (read-only), workspace, project and local scopes, contributing namespaced commands, skills, agents, hooks and MCP servers.
- UI: Settings → Plugins, `/` menu with commands and `argument-hint`, collapsed "Command expanded" marker in the transcript.

## Verification

- `pnpm run typecheck`, `pnpm run build:web`, `git diff --check`: pass.
- Last fully green `pnpm test`: 2575 passed, 1 skipped. After the skill-over-command precedence change, full runs showed 1–2 timing-sensitive failures in `tests/web/server-g1.spec.ts` / `server-g4.spec.ts` (known flaky under parallel load; they pass alone and re-run together 27/27).
- 53 of 53 local plugins of the official Claude marketplace install and load.

## Review rounds

1. Self-review: precedence, memory-only hosts, containment.
2. Self-review: durable audit of inline shell, model-loaded command grants, symlink containment of plugin trees.
3. Two read-only premium subagent reviewers found 17 issues, all fixed. Most severe: uninstalling plugin id `..@..` deleted the data home; prefix `allowed-tools` rules were bypassable with `$(…)`, backticks, `&` and redirects; a subagent could grant itself `allowed-tools`.

## Known limits

- Hooks with `if`, `async` or `asyncRewake` are reported "not run" instead of executed.
- Plugin `npm`, `sse` and `ws` sources/transports are unsupported.
- A foreground `!` command that exceeds its timeout is treated as failed, not auto-backgrounded.

## Unresolved questions

- Commit scope: `src/web/server.ts` and a few web files contain both this work and uncommitted MCP, subagent-executor and PWA changes from an earlier session, interleaved in the same hunks.
