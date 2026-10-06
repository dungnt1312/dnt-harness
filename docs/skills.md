# Skills

A skill is a folder with a `SKILL.md` (Markdown + minimal frontmatter) plus
optional resource files. Skills are file-native and editable by external
editors: loading validates and hashes the file each time, so an external edit
is picked up immediately — the hash pins what a turn saw, it never blocks a
read.

Skills exist because the model only gets the catalog (name + one-line
description) in context. Everything else — procedures, conventions, deep
reference — stays on disk and enters context only when the model decides it
is relevant and loads it through the `Skill` tool.

## Layers and resolution

The catalog merges four layers. When two skills share a name, the first layer
in this order wins:

| Order | Source | Location | Writable in-app |
|---|---|---|---|
| 1 | project | `<project>/.claude/skills/` or `<project>/.agents/skills/` (rule-configurable) | via file tools, when granted |
| 2 | workspace | `<data-dir>/workspaces/<wid>/skills/<name>/SKILL.md` | yes — Settings → Skills, or the skills API |
| 3 | user | `~/.claude/skills/` | no (read-only layer) |
| 4 | bundled | repo `skills/` (ship with the app) | no — copy into the workspace layer to customize |

The project and user layers are configurable per workspace through
`sources.json` (see below); the default rule list is
project-claude, project-agents, workspace, user. The bundled layer is not a
rule: it is appended last whenever the server was built with a bundled skills
directory, so every rule layer shadows it and a custom rule list can never
accidentally drop it.

Bundled skills ship in the repository's `skills/` folder. The web bin passes
it as `bundledSkillsDir`; a workspace skill with the same name shadows it,
and a workspace can hide it from discovery (below) without deleting
anything.

### Hiding (per-workspace curation)

A hidden set persisted in `<ws>/skills/.hidden.json` removes names from the
discovery surfaces (the injected catalog block and the `Skill` tool's
`catalog` action) while an explicit `Skill load` by name still works —
demand-only, not disabled. The set may name absent skills; those entries are
ignored everywhere. This is the only curation the read-only user/bundled
layers admit.

## The Skill tool

- `catalog` — re-lists the visible catalog (name, source, one-line
  description) with an optional query filter. Empty result says
  `no skills available`.
- `load` — loads one skill by name. The body enters context for the rest of
  the turn (turn-local snapshot: the first load in a turn pins the content
  and hash; later loads of the same name in the same turn return the pinned
  copy). Unknown names suggest the closest catalog names.

Loading is mode-gated: only modes whose `sources.skills` is `on-demand` can
load; otherwise the tool errors and the model should switch modes.

When `sources.skills` is `on-demand`, the context builder also injects the
catalog block (name — description rows) so the model can choose to load a
skill the user never named. Bodies never enter context un-loaded.

Budget interaction: when the context budget is exceeded, skills are trimmed
FIRST (before memory, before oldest completed turns) — keep skill bodies
small enough to survive, or accept that a large skill may be dropped under
pressure.

## SKILL.md format

The contract is enforced by `parseSkill` (`src/harness/skills/service.ts`):

```
---
name: my-skill
description: Use when <trigger phrases the user would actually say>. <What it delivers.>
---

<Imperative instructions to the model.>
```

- Frontmatter keys are parsed line-by-line: a `name:` and/or `description:`
  line whose value is JSON-parsable (quoted string) or a plain non-empty
  value. Unknown keys are ignored.
- `name` becomes the title; the catalog row's name is the folder name, which
  must be kebab-case, at most 64 characters (`/^[a-z0-9][a-z0-9-]{0,63}$/`).
  Keep the folder name and `name:` equal.
- The body must be non-empty — a file with no body is invalid and never
  served; `Skill load` reports `invalid frontmatter`.
- Resource files may sit beside `SKILL.md` (up to 200 files per skill;
  text preview capped at 512 KB, binary files are refused in previews).
  The body must name them explicitly — the model cannot see a file it was
  never told about.

## Writing a skill that fires

The description is the trigger surface: it is the only text the model sees
when deciding whether to load. Write it as "Use when …" with the concrete
phrases the user would actually say ("make me a skill", "write a skill",
"this skill never fires") plus what the skill delivers.

Body guidance:

- Address the model in imperative mood; state procedure, not philosophy.
- Keep it under ~150 lines. Budget pressure trims skills first, and a giant
  body crowds out memory and recent turns.
- Deep detail goes in a linked doc (`docs/…` in the repo) or a resource file
  next to `SKILL.md`, with the body routing to it.
- Validate before delivering: the name passes the pattern, the body is
  non-empty, `GET /api/workspaces/:wid/skills` lists it, and a fresh test
  session's `Skill catalog` shows it. See the bundled `create-skill` skill,
  which walks through this end to end.

## Storage and API

Per workspace, under `<data-dir>/workspaces/<wid>/skills/`:

- `<name>/SKILL.md` — the skill; writes are atomic
  (`replaceFileAtomic`), and saves can pass `expectedHash` to refuse
  clobbering an external edit (409 conflict).
- `sources.json` — the ordered rule list; missing or corrupt degrades to the
  defaults. Absolute rule folders join the file tools' protected roots, so
  rules can never be granted to Read/Write/Edit.
- `.hidden.json` — `{ "hidden": [names] }`; absent file means none hidden.

HTTP surface (workspace-scoped, ownership-checked):

| Route | Method | Purpose |
|---|---|---|
| `/api/workspaces/:wid/skills` | GET | Catalog rows (hidden included, flagged) for Settings; `?projectId=` adds the project's rule layers |
| `/api/workspaces/:wid/skills/:name` | GET | One skill's raw instructions + hash (editor load) |
| `/api/workspaces/:wid/skills/:name` | PUT | Create/replace raw SKILL.md (400 invalid, 409 conflict) |
| `/api/workspaces/:wid/skills/:name` | DELETE | Remove a workspace skill |
| `/api/workspaces/:wid/skills/:name/hidden` | PUT | `{ "hidden": boolean }` — curation toggle |
| `/api/workspaces/:wid/skills/sources` | GET/PUT | Read/replace the rule list (refreshes protected roots on PUT) |
| `/api/workspaces/:wid/skills/:name/files` | GET | Recursive file tree of the skill folder |
| `/api/workspaces/:wid/skills/:name/file?path=` | GET | One file's text content (contained, size-capped) |

## Related

- [harness.md](harness.md) — where skills sit in the context builder's trim
  order and the turn flow.
- The bundled `create-skill` skill — the step-by-step authoring procedure
  this document is the reference for.
