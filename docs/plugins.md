# Claude Code commands and plugins

dnt-harness reads Claude Code custom commands and plugins in their native
format. Its only extension is the same **workspace layer** used elsewhere:
`<data>/workspaces/<workspace>/` behaves like an additional `~/.claude/`.

Implementation: `src/harness/commands/`, `src/harness/plugins/`,
`src/web/slash-commands.ts`. Detailed design and compatibility decisions:
[the approved design](superpowers/specs/2026-10-10-claude-plugins-design.md).

## Custom slash commands

Sources, lowest to highest precedence:

1. bundled: the app's own `commands/` folder (read-only, see below)
2. `~/.claude/commands/`
3. commands contributed by enabled plugins (namespaced `plugin:command`)
4. `<workspace>/commands/`
5. ancestor/project `.claude/commands/` folders, nearest project folder wins

Every Markdown file is a command. Subfolders create `:` namespaces:
`.claude/commands/git/commit.md` is `/git:commit`. A folder containing
`SKILL.md` is also a command. Skills in the normal skill catalog are invoked
with `/skill-name`; plugin skills are `/<plugin>:<skill>`, with a unique bare
name accepted as an alias. When a skill and a command share a name, the skill
wins (Claude loads skills ahead of `commands/` files).

Command frontmatter supports `description`, `argument-hint`, `arguments`,
`allowed-tools`, `model`, `disable-model-invocation` and `user-invocable`.
The body supports Claude's `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n` (zero-based),
named arguments, `${CLAUDE_*}` variables, `` !`shell` `` and fenced ` ```! `
shell blocks.

Inline shell runs through the normal Bash tool pipeline: mode exposure,
PreToolUse hooks, Dangerous Commands, policy, approvals and durable audit.
Each run is logged as `command/tool-call` (made durable before the command
starts) and `command/tool-result`; these never enter model history. When a
later marker fails after an earlier one ran, the typed prompt is still logged
with the turn error so the side effect has an owner.
Markers run one at a time in order; the first failure rejects the prompt and
the remaining markers never start. A marker succeeds only when Bash reports
`exit code: 0`.
`allowed-tools` only turns a policy ask into allow for the command's turn, in
the root conversation (never a subagent); it never lifts a deny, a
dangerous-command question, an out-of-grant question, an interactive-MCP
question or a hook's ask. A `Bash(prefix…)` rule never covers a command with
`$(…)`, backticks, `${…}`, a single `&` or a redirect; file rules match a
normalized project-relative path and refuse `..`.

The transcript preserves `/name args` as what the user typed and stores the
expanded prompt as a collapsed `origin: command` message the model reads.
The `Skill` tool accepts `name` plus optional `args`, and can load commands as
well as skills unless `disable-model-invocation: true`. A command loaded by the
model applies its `allowed-tools` and `model` to the rest of that turn, as a
typed `/name` does.

### Bundled commands: `/image` and `/video`

The repository's `commands/` folder ships with the app. `src/bins/web.ts` passes
it as `bundledCommandsDir`, as it does for the bundled skills. It is the lowest
layer, so a user, plugin, workspace, or project command of the same name
replaces it. It is read-only, and the file tools cannot reach it (it is a
protected root). The `/` menu lists these commands with source `bundled`.

- `/image <description>` asks the model to call `GenerateImage` with that
  description. The command grants `allowed-tools: GenerateImage`.
- `/video <description>` asks the model to call `GenerateVideo`. It animates an
  image attached to the same message through that image's `attachmentId`, or
  makes a text-to-video call without one. The command grants
  `allowed-tools: GenerateVideo`.

Typing the command is the decision to spend, so the Ask before changes and Edit
automatically modes do not ask a second time. The grant is the command's own
turn and one tool: it never lifts a deny, a guard question, or a model-initiated
call. A model that calls `GenerateImage` on its own still asks. Both commands set
`disable-model-invocation: true`, so the model cannot start them through the
`Skill` tool. They need the tool to be exposed: in Plan, which exposes neither
tool, the model is told what was asked but cannot generate. An empty `/image`
tells the model to ask what to create rather than call the tool.

## Plugin format

A plugin may contain:

```text
.claude-plugin/plugin.json    optional when a marketplace entry names it
commands/
agents/
skills/
hooks/hooks.json
.mcp.json
```

The manifest may add component paths through `commands`, `agents`, `skills`,
`hooks` and `mcpServers`. Every path must stay inside the plugin after
symlink resolution. A plugin tree containing any symlink that points outside
it (or a broken one) is refused at install and at load; internal symlinks are
allowed. Plugin components are namespaced:

- commands: `/plugin:command`
- skills: `/plugin:skill`
- agents: `plugin:agent`
- MCP server: `plugin_<plugin>_<server>`, yielding Claude-compatible tool names
  such as `mcp__plugin_toolkit_docs__search`

Plugin hooks merge with settings hooks. `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PLUGIN_DATA}` are substituted and exported to hook processes.
Plugin hooks support Claude's `if`, `async` and `asyncRewake` fields; their
semantics are in `claude-format.md` (Hooks). Unsupported plugin components
(LSP, output styles, themes, `userConfig`, …) are reported as notes.

## Store and marketplaces

dnt-harness has its own host-wide store; it never writes Claude Code's
`~/.claude/plugins`:

```text
<data>/plugins/
  known_marketplaces.json
  installed_plugins.json
  marketplaces/<marketplace>/
  cache/<marketplace>/<plugin>/<version>-<content hash>/
  data/<plugin>@<marketplace>/
```

Settings → Plugins adds a marketplace by GitHub `owner/repo`, git URL, or an
absolute local folder. Until it is added, the panel offers Anthropic's
official marketplace (`anthropics/claude-plugins-official`) as a one-click
recommendation.

The **Available** list has one tab per marketplace (plus **All** when there
are several), category chips with counts, and a search box. Each row opens a
details dialog (`GET /api/workspaces/<ws>/plugins/<id>`) listing the plugin's
skills, commands, agents, hook events and MCP servers with their
descriptions; installed plugins have the same entry under their row menu. An
installed plugin is read from its cache folder. A plugin that is not
installed is read from its marketplace source without installing: a relative
source in place, a git source cloned into `<data>/plugins/tmp/` and removed
afterwards. Results are memoized per marketplace revision; failures are not.

Installing `plugin@marketplace` from a marketplace that is not added yet adds
it first, as Claude Code does. The source comes from, in order: settings
`extraKnownMarketplaces`, Claude Code's own
`~/.claude/plugins/known_marketplaces.json` (read only), then the built-in
`claude-plugins-official`. An unknown marketplace is refused with 404. This is
what makes **Install** work on a plugin that `~/.claude/settings.json` enables
but this host has not installed. Marketplace entries support a relative folder,
`github`, `url` (git repository), and `git-subdir` sources. Installation copies
or clones the plugin into the cache and records the install in Claude's
`installed_plugins.json` shape. Cache folders are immutable and keyed by
version plus content hash, so reinstalling elsewhere never rewrites code an
existing install runs. Plugin, marketplace and version names must be safe
single path segments; nothing outside the store's own folders is ever deleted.
A memory-only host (no data home) refuses every plugin route.

## Enable scopes

`enabledPlugins` resolves in this order (later wins):

```text
~/.claude/settings.json                         user, read-only
a workspace's settings.json                    workspace
<project>/.claude/settings.json                 project
<project>/.claude/settings.local.json           local
```

The UI installs at workspace scope by default; project and local scopes appear
when a project is bound. A plugin enabled in `~/.claude/settings.json` but not
installed in dnt-harness's own store is listed as **not installed**. The app
never changes that user file.

Enabling/installing is the trust decision: hooks and MCP servers may execute
code. Plugin MCP servers are materialized into the workspace's `mcp.json` as
enabled, plugin-owned entries; stdio executables are resolved and hash-pinned
at that decision. Disabling/uninstalling removes the plugin-owned entries and
disconnects them, without touching user-owned servers.
