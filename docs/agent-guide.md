# Agent guide: using dnt-harness

Start here when an AI agent needs to create skills, define custom agents, or
understand where harness configuration belongs. This guide lives in the
**dnt-harness source repository**, not in every project opened by the app.
The web host also supplies a short authoring reference in model context,
including the actual workspace resource directories, when file tools are exposed.

## Choose the scope before creating files

Use project scope for repository/team conventions; workspace scope for resources
shared by projects in one workspace; user scope only when machine-wide sharing
is requested. Ask if the intended audience is unclear. Do not overwrite an
existing resource or edit a bundled resource just to customize it.

| Scope | Skill | Agent definition |
|---|---|---|
| Project | `<project>/.claude/skills/<name>/SKILL.md` | `<project>/.claude/agents/<name>.md` |
| Workspace | `<workspace-dir>/skills/<name>/SKILL.md` | `<workspace-dir>/agents/<name>.md` |
| User | `~/.claude/skills/<name>/SKILL.md` | `~/.claude/agents/<name>.md` |
| Bundled harness | source repo `skills/<name>/SKILL.md` | built-in roles in `src/harness/agents/definition-service.ts` |

`<workspace-dir>` is `<data-dir>/workspaces/<workspace-id>`. Use the exact paths
provided by the runtime; do not guess the id or assume the default data home.
Settings → Skills/Agents creates and edits **workspace** resources. User and
project layers are read-only in Settings, but can be edited with authorized
file tools or an external editor.

These locations are **not filesystem grants**. Workspace resources are app
configuration, not automatically writable project files. If tools cannot access
a target, use Settings or request authorized access; do not bypass the boundary
with Bash. Read-only modes and restricted children must not attempt writes.

Project skills also support `.agents/skills/` by default. Skill scan folders,
enabled rules and precedence are configurable in Settings → Skills → Source
folders. The default order is `.claude/skills` → `.agents/skills` → workspace →
user → bundled. Agent precedence is project → workspace → user → bundled.
A higher layer shadows a lower resource of the same name; confirm which one resolves.

## Create a skill

A skill is reusable instructions loaded on demand, not a new tool or permission.
Load `create-skill` through the `Skill` tool when that skill is available.
Create a kebab-case folder with a non-empty `SKILL.md`:

```markdown
---
name: review-api
description: Use when reviewing API changes for validation and compatibility.
---

Read the changed endpoints and their callers. Check validation, authorization,
error responses and compatibility. Report findings with file paths and evidence.
```

Keep the name consistent with the folder; folder lookup names are kebab-case,
up to 64 characters. Use a concrete description: it is what the model sees
before loading the instructions. Put longer references or scripts beside the
file, and name them in the instructions. Resource files require a separate Read;
loading the skill does not execute scripts.

Verify that `Skill` with `action: "catalog"` lists the name in the intended
project session, then load it by name. Confirm its resolved source in Settings
or the skills API. A disabled source rule or a higher-layer duplicate can make
a correctly written file invisible or shadowed. Verify discovery and relevance
separately: being listed does not prove a model will select it for a real request.
See [Skills](skills.md) for the parser, source rules, API and hiding behavior.

## Create a custom agent

An agent definition is one Markdown file with YAML frontmatter and role
instructions. It is not a mode, and cannot grant privileges:

```markdown
---
name: api-reviewer
description: Reviews API changes for correctness and compatibility.
tools: Read, Glob, Grep
model: inherit
---

Read endpoints, callers and tests relevant to the brief. Do not change files.
Return prioritized findings with path:line evidence, then verification gaps.
```

`description` and a non-empty body are required; `name` falls back to the file
name. Prefer a descriptive kebab-case filename. `tools` and `disallowedTools`
accept comma-separated strings or YAML lists. Omitted `tools` inherits exposed
tools, so explicitly list tools for a narrow read-only role. `model` can inherit,
use an available alias, or select `provider:model`. Optional `skills` lists
skills to preload into the child's turn; use names that resolve in its project.

Check `Agent` with `action: "catalog"` or Settings → Agents for the resolved
role, source path and warnings. Test a small representative task before relying
on a new role. Fields such as `maxTurns`, `permissionMode`, `hooks`, `memory`,
`mcpServers`, `isolation` and `background` are recognized but **not enforced**;
do not promise their behavior. See [Claude format](claude-format.md) for the
complete supported contract.

## Delegate a task

When the `Agent` tool is exposed, spawn a role with a self-contained prose brief:

```json
{
  "definition": "api-reviewer",
  "prompt": "Review the endpoint changes in src/api and their tests. Do not edit files.",
  "requiredResult": "Prioritized findings with path:line evidence and verification gaps."
}
```

Spawn returns immediately. Use `wait` to collect results; use `list` to inspect
children and `cancel` to stop them. Give delegates exact paths, constraints and
an expected deliverable; their final report is what comes back. Context is
isolated by default; optional `inherit: "brief"` supplies a bounded projection
of recent parent messages, not tool output or a full transcript.

Only the root can delegate; children cannot spawn grandchildren. Definitions,
parent mode/policy and spawn grants constrain tools. No built-in active/spawn
count cap is imposed, but that is not a reason to spawn unbounded work. Delegate
only separable work whose report is cheaper than carrying its investigation.
See [Capabilities](capabilities.md#the-agent-tool-srcwebagent-delegationts) and
[Harness](harness.md) for lifecycle, model selection and enforcement.

## Project instructions and other configuration

Use `CLAUDE.md` for short project conventions and links to deeper docs, with
`@relative/path` imports when those docs must enter context. `AGENTS.md` is
supported through imports and as a fallback where no CLAUDE.md exists.
Instructions are loaded only when the mode enables workspace instructions.
Do not assume every Markdown file in a project is automatically in context.

Use skills for task-specific procedures, agent definitions for delegated roles,
and memory for durable user/project knowledge rather than duplicate source facts.
Configure modes, hooks and MCP through their documented Settings surfaces;
neither skill text nor instructions can enable an unavailable tool.

## Working on the harness itself

- [Docs index](README.md): architecture and subsystem references.
- [Prompt contract](prompt-contract.md): context order, trust, budget and overrides.
- [Claude format](claude-format.md): instructions, imports, hooks and agent layers.
- [Guides](guides.md): setup, configuration, plugin authoring and testing.
- Run `pnpm test`, `pnpm run typecheck`, and `pnpm run build:web` as relevant.
  Start with affected tests, then run the full test suite for behavior changes.
- Keep runtime guidance short. Full docs stay on disk; skill bodies load on demand.
  Test that new guidance reaches root/child context and does not widen permissions.
