---
name: create-skill
description: Use when the user asks to create, write, fix, or improve a skill ("make me a skill for X", "write a skill", "this skill never fires", "how do skills work here") — covers the SKILL.md format, the four skill layers, naming rules, and validation before delivering.
---

# Creating a dnt-harness skill

A skill is a folder containing a `SKILL.md` (Markdown + minimal frontmatter) plus optional resource files. The model's catalog shows only the name and one-line description; the body loads on demand through the `Skill` tool and is hash-pinned for the rest of the turn. Full reference: `docs/skills.md` in the dnt-harness repo.

## 1. Pick the layer

| Layer | Location | Notes |
|---|---|---|
| workspace | `<data-dir>/workspaces/<wid>/skills/<name>/SKILL.md` | The default answer. Editable in Settings → Skills or `PUT /api/workspaces/:wid/skills/:name` |
| user | `~/.claude/skills/<name>/SKILL.md` | Shared across every workspace of this machine user; read-only inside the app |
| bundled | repo `skills/<name>/SKILL.md` | Ships with dnt-harness; never edited in place — copy into the workspace layer to customize |
| project | `<project>/.claude/skills/` or `<project>/.agents/skills/` | Team skills bound to one registered project |

When two skills share a name the resolution order is project > workspace > user > bundled (first hit wins). Workspaces can hide any skill from discovery (`.hidden.json` sidecar); an explicit load by name still works.

## 2. Write the SKILL.md

The format contract is enforced by `parseSkill` in `src/harness/skills/service.ts`:

```markdown
---
name: my-skill
description: Use when <the phrases the user would actually say>. <What the skill delivers.>
---

<Imperative instructions to the model.>
```

- `name` — kebab-case, at most 64 characters (`/^[a-z0-9][a-z0-9-]{0,63}$/`), matching the folder name.
- `description` — the only text the model sees when deciding whether to load the skill. Write it as "Use when …" with the concrete trigger phrases; a vague description produces a skill that never fires. State what it delivers, not how.
- Body — instructions addressed to the model, imperative mood. Keep it under ~150 lines: when the context budget runs out, skills are trimmed FIRST (before memory and oldest turns). Put deep detail in a linked doc or a resource file and have the body route to it.
- Extra files may sit beside `SKILL.md` (≤200 files, text previews capped at 512 KB); the body should name them explicitly so the model knows to `Read` them.

## 3. Validate before delivering

A skill with an empty body or broken frontmatter never appears in the catalog and fails `Skill load` with "invalid frontmatter". Check:

1. `npx vitest run tests/harness/skill-layers.spec.ts` still passes if you touched skill code.
2. For a new file: parse it — the frontmatter keys must be `name:`/`description:` lines (JSON-parsable or plain values), and something after the closing `---`.
3. Prove discovery: `GET /api/workspaces/:wid/skills` must list the new name, and a `Skill` tool `catalog` call in a fresh session must show it.

## 4. Make it fire

The description is the trigger surface. Test it the way the user will phrase it: the catalog block injected into context shows `name — description`, and the model loads only on a plausible match. If a test session does not load it, sharpen the description with the user's actual words before adding body text.
