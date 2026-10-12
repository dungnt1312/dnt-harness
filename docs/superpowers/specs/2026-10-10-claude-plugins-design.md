# Claude Code commands and plugins — design

Status: approved 2026-10-10 (user: "giống y Claude, thêm 1 layer workspace";
decisions delegated). Extends [Claude format parity](2026-10-08-claude-format-parity-design.md).

Ground truth for semantics is Claude Code 2.1.293 (the binary on the dev
machine) and the official marketplace `anthropics/claude-plugins-official`
(315 plugins). Where this document says "as Claude", the behaviour was read
from that source, not guessed.

## Goal

dnt-harness reads and runs Claude Code custom slash commands and Claude Code
plugins in their own format. The one addition, as everywhere else, is the
**workspace layer** (`<data>/workspaces/<ws>/`, laid out like `~/.claude/`).

Three sub-projects, delivered in order:

1. Custom slash commands (files) and `/skill` invocation, Claude style.
2. Plugin loader: an installed and enabled plugin contributes commands,
   skills, agents, hooks and MCP servers.
3. Marketplaces and installation: own store, `enabledPlugins` across four
   layers, Settings → Plugins.

## 1. Slash commands

### Sources and names

| Layer | Folder |
|---|---|
| user | `~/.claude/commands/` |
| workspace | `<data>/workspaces/<ws>/commands/` |
| project | `<project>/.claude/commands/` |
| plugin | `<plugin>/commands/` + manifest `commands` paths |

- Every `*.md` below the folder is a command. Subfolders namespace the name
  with `:` — `commands/git/commit.md` is `/git:commit` (as Claude: the
  relative directory parts joined by `:`).
- A folder inside `commands/` holding `SKILL.md` is a command named after the
  folder (Claude's skill-in-commands layout).
- Plugin commands are `/<plugin>:<name>`.
- Precedence by name: user < workspace < project (later wins), like agents.
- Skills are commands too: every user-invocable skill in the catalog is
  `/<skill-name>`. When a command and a skill share a name, the skill wins
  in the `/` menu, the model's catalog and on invocation — Claude Code
  2.1.293 loads skills ahead of legacy `commands/` files and takes the first
  name match.
- Built-in host commands (`/compact`) are reserved and win over everything.

### Frontmatter (all optional)

| Key | Effect |
|---|---|
| `description` | menu and catalog text; default: first non-empty body line (heading marks stripped, ≤ 100 chars) |
| `argument-hint` | shown in the `/` menu after the name |
| `arguments` | named positional arguments (`arguments: system module` → `$system`, `$module`) |
| `allowed-tools` | tools that run without asking for the rest of the turn (see Authority) |
| `model` | model for the turn the command starts (`inherit`, Claude alias, `provider:model`, alias or id) |
| `disable-model-invocation` | the model cannot run it through the `Skill` tool and it is left out of the model's catalog |
| `user-invocable: false` | hidden from the `/` menu; the model can still load it |
| `context`, `agent`, `effort`, `hooks`, `shell`, `version`, `when_to_use` | recognized, not enforced; listed as notes |

### Expansion (host side, as Claude)

When a root conversation's message starts with `/<name>` (name =
`[A-Za-z0-9_.:-]+`, followed by whitespace or end), the host resolves it:

1. Built-in: handled by the client, never reaches the server as a command.
2. Command or skill found: expand. Unknown name: the prompt is rejected with
   `Unknown command: /<name>` (Claude: "Unknown skill"). A message whose first
   token contains a further `/` (a path such as `/usr/bin/env`) is never a command.

Expansion of the body, in Claude's order:

1. Skills only: prefix `Base directory for this skill: <dir>`.
2. Argument substitution (port of Claude's function): named arguments,
   `$ARGUMENTS[n]`, `$n` (0-based), `$ARGUMENTS`; `\$` escapes. When the body
   has no placeholder and arguments are non-empty, `\n\nARGUMENTS: <args>` is
   appended. Arguments split shell-style (quotes respected).
3. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`,
   `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`.
4. Inline shell: `` !`cmd` `` (at line start or after whitespace) and fenced
   ```` ```! ```` blocks run through the **Bash tool pipeline** of the
   conversation (mode exposure, Dangerous Commands guard, policy, approval,
   audit). The output replaces the marker. A denied or failed command
   rejects the prompt with Claude's message
   `Shell command permission check failed for pattern "<raw>": <reason>`.

`@path` text in a command body is left as text, as for every other message in
dnt-harness (the model reads files with `Read`); dnt-harness does not inline
`@` mentions anywhere, and commands do not become the exception.

### Log and transcript

- The user's `user/message` keeps exactly what was typed (`/name args`), so
  retry, reuse and titles behave as before.
- The expansion follows it as `user/message` with `origin: 'command'`
  (model-visible, never a user bubble). The transcript shows the typed text
  with a command chip and one collapsed "Command /name expanded" line.
- The composer's `/` menu lists built-ins, then commands, then skills, with
  `argument-hint`. Picking one inserts a chip whose wire text is `/name `.
  Messages written by the retired `Use the <name> skill:` form still parse as
  a chip; on the server that legacy phrase still reaches the model unchanged.

### Model invocation

The `Skill` tool takes `name` and optional `args`. It resolves skills and
commands alike (commands with `disable-model-invocation` are refused, as
Claude). A command load is expanded exactly like a user invocation, then
pinned for the turn like a skill. The catalog block lists both, minus
`disable-model-invocation` entries.

### Authority

- `allowed-tools` (Claude permission-rule syntax: `Read`, `Bash(git:*)`,
  `Bash(git status:*)`, `mcp__x__y`) turns a policy **ask** into **allow** for
  matching calls during the turn the command started. It never lifts a mode
  exposure denial, a policy deny, a Dangerous Commands match, an out-of-grant
  path question, an interactive MCP question or a hook's `ask`. This is the
  same "narrow, never widen" rule hook `allow` follows.
- `` !`cmd` `` is a Bash tool call. With the command's `allowed-tools`
  covering it, a mode that asks for Bash runs it without asking; otherwise
  the approval card appears before the turn starts.
- `model` resolves with the same resolver subagent files use; a model this
  host cannot serve keeps the conversation's model and logs a note.

## 2. Plugin loader

### Format (as Claude)

```
<plugin>/
  .claude-plugin/plugin.json   name (required), version, description, author, …
  commands/  agents/  skills/  hooks/hooks.json  .mcp.json
```

Manifest path fields `commands`, `agents`, `skills` (string or list,
supplementing the defaults), `hooks` (path or inline object), `mcpServers`
(path or inline object). Unknown fields (`lspServers`, `outputStyles`,
`userConfig`, …) are kept and reported as not supported.

### Contribution

| Part | Joins | Name |
|---|---|---|
| commands | command catalog, layer `plugin` | `<plugin>:<cmd>` |
| skills | skill catalog, layer `plugin` | `<plugin>:<skill>`; the frontmatter `name` without `:` is also an alias (`/brainstorming` finds `superpowers:brainstorming`) |
| agents | agent catalog, layer `plugin` | `<plugin>:<agent>` |
| hooks | merged with settings hooks, layer `plugin` | — |
| MCP | workspace MCP config, materialized | server `plugin_<plugin>_<server>` → tools `mcp__plugin_<plugin>_<server>__<tool>` (Claude's tool names) |

- `${CLAUDE_PLUGIN_ROOT}` is substituted in hook commands, MCP
  command/args/env/url and command bodies, and exported to hook processes.
  `${CLAUDE_PLUGIN_DATA}` is `<data>/plugins/data/<plugin>@<marketplace>/`.
- Plugin layers sit between user and workspace for every part. Settings
  layers own the name space first: a workspace or project file with the same
  name wins over a plugin.
- Hook `if`, `async` and `asyncRewake` run as in Claude (see
  `2026-10-12-hook-if-async-rewake-design.md`). Prompt, agent, MCP-tool and
  HTTP hook types are still parsed, kept and shown as "not run", like
  unsupported events.
- MCP is workspace-scoped in dnt-harness. Enabling a plugin anywhere in a
  workspace (user, workspace, or one of its projects) materializes its
  servers into that workspace's `mcp.json` with `provenance.plugin`, enabled.
  Disabling or uninstalling removes exactly those entries. `${VAR}` in env and
  headers resolves from the workspace secrets as for any MCP server.

## 3. Marketplaces and installation

### Store (host-wide, own, laid out like `~/.claude/plugins/`)

```
<data>/plugins/
  known_marketplaces.json   { name: { source, installLocation, lastUpdated } }
  installed_plugins.json    { version: 2, plugins: { "<p>@<m>": [ { scope, installPath, version, installedAt, lastUpdated, gitCommitSha?, workspaceId?, projectPath? } ] } }
  marketplaces/<name>/      clone or copy of the marketplace
  cache/<m>/<p>/<version>/  installed plugin files
  data/<p>@<m>/             CLAUDE_PLUGIN_DATA
```

dnt-harness never writes `~/.claude/plugins` or `~/.claude/settings.json`.

### Marketplace sources

`marketplace.json` at `.claude-plugin/marketplace.json`. Add by: GitHub
`owner/repo`, git URL (`https://…`, `git@…`, `file://…`), or a local folder.
Plugin entries: relative path string, `{source:"github", repo, ref?, sha?}`,
`{source:"url", url, ref?, sha?}` (git), `{source:"git-subdir", url, path,
ref?, sha?}`; `npm` and others report "not supported". `strict: false` lets
the entry stand in for a missing `plugin.json`. Git work uses the `git` CLI
(`clone --depth 1`, `ref` → `--branch`, `sha` → fetch + checkout).

### Enabling (four layers, as Claude plus workspace)

`enabledPlugins: { "<p>@<m>": true|false }` in
`~/.claude/settings.json` (read only) < `<ws>/settings.json` <
`<project>/.claude/settings.json` < `<project>/.claude/settings.local.json`;
the most specific value wins. A plugin runs when its merged value is `true`
and it is installed in the store. Enabled-but-not-installed (typically from
`~/.claude/settings.json`) is listed with an Install button.

Install at scope workspace (default), project or local: fetch to the cache,
record it, write `enabledPlugins[id] = true` in that scope's settings file.
Disable writes `false` at the chosen scope; uninstall removes the record,
the scope's key and (when no record remains) the cache. Update re-fetches
the marketplace and the plugin. `extraKnownMarketplaces` in project settings
is shown as a suggestion in Settings → Plugins.

### Trust

Installing or enabling a plugin is the trust decision (its hooks and MCP
servers run code), as in Claude. Settings → Plugins says so on every install.
Writes into `.claude/settings*.json` by the agent already always ask.

## Out of scope

LSP servers, output styles, themes, `userConfig` prompts, npm plugin sources,
`/plugin` slash UI (Settings → Plugins replaces it), `context: fork`
execution of commands, frontmatter hooks on skills.
