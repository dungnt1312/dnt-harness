# Workspace Sources

Settings → Workspace → **Sources** decides which folder layers a workspace reads
skills, agents, hooks and commands from. It is one page and one document, so the
choice no longer lives in four different tabs. Design record:
[specs/2026-10-13-workspace-sources-design.md](superpowers/specs/2026-10-13-workspace-sources-design.md).

## What it controls

| Kind | Layers a workspace can switch | Notes |
|---|---|---|
| Skills | the ordered folder **rules** (project folders, workspace, absolute), plus `plugin` and `bundled` | Rule order is precedence; first match wins. Rules can be added, removed and reordered. |
| Agents | `bundled`, `user`, `plugin`, `workspace`, `project` | A layer that is off is skipped, so a lower layer's role wins again. |
| Hooks | `user`, `plugin`, `workspace`, `project`, `local` | A layer that is off is not read at all: its hooks do not run, and its `disableAllHooks` does not switch other layers off. |
| Commands | `bundled`, `user`, `plugin`, `workspace`, `project` | The project layer covers `.claude/commands` and its ancestors. |

Switching a layer off only stops it being **read**. Files are never edited or
deleted, per-skill hiding and per-hook switches stay as they were, and nothing
here changes instructions (`CLAUDE.md`), `enabledPlugins`, plugin MCP servers,
modes or filesystem grants. Plugin-provided resources are controlled by the
`plugin` layer of each kind; enabling a plugin itself stays in Settings → Plugins.

## Storage

`<data-dir>/workspaces/<wid>/resource-sources.json`, kept out of the Claude-format
files:

```json
{
  "v": 1,
  "skills": { "rules": [{ "id": "workspace", "kind": "workspace", "enabled": true }] },
  "disabled": { "skills": [], "agents": ["user"], "hooks": [], "commands": [] }
}
```

- No file means defaults: every layer on, skill rules as in [skills.md](skills.md).
  A legacy `skills/sources.json` is imported when the shared file does not exist
  yet and is left untouched.
- Writes are atomic and serialized per workspace; a PUT carries the `hash` it
  loaded and a stale one is refused (409).
- An unreadable or unsupported file **never turns layers back on**: the last
  valid copy keeps applying, and with none (a fresh process) every configurable
  layer stays off. Settings shows the problem; saving there replaces the file.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/workspaces/:wid/sources` | GET | `{ doc, hash, error?, layers }`; `layers` describes, per kind, each switchable layer, its path and whether this host has it |
| `/api/workspaces/:wid/sources` | PUT | `{ doc, expectedHash }` replaces the whole document: `400` invalid, `409` stale hash, `401` for a non-browser principal |
| `/api/workspaces/:wid/skills/sources` | GET/PUT | Compatibility adapter over `doc.skills.rules` only |

A PUT also invalidates the workspace's hook snapshots and refreshes the
grant-protected roots from every workspace's absolute skill rules.

## When a change takes effect

Each request and operation reads the policy when it starts. A running model
request, an already spawned child, and a skill already loaded into a turn keep
what they began with; the next request sees the new policy. The per-conversation
catalog snapshot is keyed on a per-workspace revision that moves on every write,
so the skill catalog block is re-read at the next request.

## Code

`src/harness/sources/resource-sources.ts` (store, validation, layer
descriptions); each subsystem takes a `disabledLayers(workspaceId)` callback
(`AgentDefinitionService`, `CommandsService`, `HookHost`) or reads it through
`SkillsService.disabledLayers`. UI: `web/components/settings/SourcesPanel.tsx`.
