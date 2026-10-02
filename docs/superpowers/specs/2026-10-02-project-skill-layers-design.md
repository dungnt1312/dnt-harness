# Project Skill Layers with Custom Load Rules — Design

Date: 2026-10-02
Status: Approved (brainstorming session, design approved by user)
Reference: Claude Code project skills (`.claude/skills`), agents skill-folder convention (`.agents/skills`); mini-dsh skills service `src/harness/skills/service.ts`

## Problem

`SkillsService` resolves skills from three layers — workspace (`workspaces/<ws>/skills`),
user (`~/.claude/skills`), bundled — keyed on `workspaceId` only. There is no project
layer: a session bound to a project sees the same catalog as an unbound one, skills
authored inside a project folder (Claude Code convention `.claude/skills`, agents
convention `.agents/skills`) never surface, and which folders get scanned is fixed in
code. The adjacent G3 resources already outgrow this: instructions read a project
companion file, memory is project-scoped.

## Decisions (from the brainstorming dialogue)

1. **Scan target**: the bound project's folder (`ProjectRecord.path`) — `.claude/skills`
   and `.agents/skills` by default. A session without a bound project skips project
   rules entirely. No workspace-root fallback.
2. **Customization**: an ordered rule list editable in Settings — add/remove/toggle
   each rule, reorder to change precedence. Default rules: `.claude/skills`,
   `.agents/skills` (project-relative), the workspace skills dir, `~/.claude/skills`
   (absolute).
3. **Storage scope**: per-workspace, like every other G3 resource (modes, MCP, memory,
   system prompts). One rule list applies to all projects of the workspace.
4. **Precedence**: list order = precedence, first hit wins (shadowing, no conflict
   error). Default order realizes project > workspace > user; between `.claude/skills`
   and `.agents/skills` of the same project, the earlier list entry wins. Bundled
   stays implicit last and is not a rule.
5. **Settings UI**: rebuild the Skills panel in the dntspace two-tab/two-pane
   structure — a "Skills" tab (layer-grouped catalog tree + detail pane with
   preview/edit) and a "Source folders" tab (the rule editor). The catalog tree
   scans ALL projects of the workspace (one group per project × rule, project name
   in the group header) rather than requiring a project selector.

## Architecture

Approach A (rules-as-data, service stays mechanism-only): the server resolves the
workspace's rules plus the bound project's path into an **ordered layer list** and
hands it to `SkillsService`. The service keeps doing exactly what it does today —
readdir per layer, parse `SKILL.md`, sha256, first-hit-wins, hidden filtering — and
never learns what a project is.

### Rule model

File `workspaces/<wsId>/skills/sources.json`, beside the existing `.hidden.json`.
Missing file, unreadable file, or invalid JSON falls back to the defaults (same
degrade pattern as `.hidden.json`).

```jsonc
{
  "rules": [
    { "id": "r1", "kind": "project",  "path": ".claude/skills", "enabled": true },
    { "id": "r2", "kind": "project",  "path": ".agents/skills", "enabled": true },
    { "id": "ws", "kind": "workspace",                            "enabled": true },
    { "id": "r3", "kind": "absolute", "path": "~/.claude/skills", "enabled": true }
  ]
}
```

- `kind: 'project'` — `path` is relative (no drive, no UNC, no leading absolute
  segment, no `..`); resolved against the bound project's `path` at read time.
- `kind: 'absolute'` — an absolute folder path; `~` expands via `os.homedir()` at
  read time. The current user layer becomes the default rule of this kind, seeded
  from the server's `userSkillsDir` option; a host without that option (hermetic
  memory-mode tests) gets defaults without this row.
- `kind: 'workspace'` — exactly one such row; its path is the managed skills dir,
  locked (toggle and position only, never edited or removed).
- `id` — server-assigned opaque string (e.g. `r<random>`); used as the UI key.
- A rule pointing at a missing directory is skipped, like any absent layer today.
  A disabled rule is skipped.

### Service boundary

`SkillSource` gains `'project'`. `SkillsService` gains layer-list-taking entry
points (e.g. `listIn(layers)` / `loadIn(layers, name)` / `listVisibleIn(layers, wsId)`);
the existing `list(workspaceId)` / `load(workspaceId, name)` / `listVisible(wsId)`
become thin delegates that build the default layer list (workspace, user, bundled),
so current callers and tests keep working. A pure helper
`resolveSkillLayers(rules, projectPath?) → Array<[base, source]>` lives beside the
service (unit-testable without fs) and is the only place that understands rule kinds.
`.hidden.json` filtering stays workspace-keyed regardless of layers.

Precedence is positional: the resolver emits layers in rule order; both catalog
listing and load return the first hit. `save`/`delete` still target the workspace
layer only — project and absolute layers are read-only, edited with external editors,
and re-read fresh with a new hash (no hot reload within a turn: active skills stay
hash-pinned per turn exactly as today).

### Injection and Skill tool

The catalog injection point (`src/web/server.ts`, the `agent/context` handler) and
the Skill tool's `catalog`/`load` actions already hold `scope.projectId`: fetch the
project record, run `resolveSkillLayers`, call the layer-aware listing. The catalog
block text is unchanged; entry rows gain `[project]` as a possible `source` tag in
Skill tool output and any UI that renders sources. A workspace-scoped session with no
project resolves project rules to nothing — behavior identical to today.

### Settings UI and REST

REST:

- `GET /api/workspaces/:wsId/skills/sources` returns `{ rules }` with defaults
  materialized (so the panel shows the effective list); `PUT` with the full rule
  list validates and writes atomically. Last-write-wins, like modes/MCP config —
  no CAS hash (small list, single operator surface).
- PUT validation: ≤ 20 rules; exactly zero or one `workspace` rule (its `path` and
  `kind` are forced server-side); `project` rules require a safe relative path;
  `absolute` rules require an absolute path; ids unique; unknown kinds rejected.
- `GET /api/workspaces/:wsId/skills` and `GET .../skills/:name` gain an optional
  `projectId` query parameter: layers resolve with that project's rules and rows
  carry their `source`. Without the parameter behavior is unchanged. The hidden
  toggle route is unchanged (workspace-keyed tombstones already target any layer).

Panel redesign (dntspace structure, adapted):

- **Two tabs**: "Skills" (the catalog) and "Source folders" (the rule editor).
- **Skills tab, left pane**: `SKILLS` header with refresh and `+` (create a
  workspace-layer skill, opening the detail pane in edit mode); a search input and
  a layer filter dropdown (All / Project / Workspace / User / Bundled, with
  counts); a catalog tree grouped by layer — one group per project × rule with the
  project name in the header (the panel scans ALL workspace projects, no project
  selector), then `Workspace`, `User (~/.claude/skills)`, and `Bundled` (only when
  the host configures bundled). Hidden rows render dimmed with an eye-off marker.
- **Skills tab, right pane (detail)**: title + source badge; the "In catalog"
  switch (the existing hidden toggle — works for any layer since tombstones are
  workspace-level); the `/SKILL.md` path line; preview (rendered markdown, the
  existing renderer) and edit (raw SKILL.md) toggles. Editing is enabled only for
  workspace rows — other layers show a read-only notice pointing at external
  editors. Workspace rows get a delete affordance (route exists). Reuse the
  existing load/save-with-hash editor logic; the flat panel it replaces is removed.
- **Source folders tab**: one row per rule — kind badge, path, enabled checkbox
  (native accent-primary, the existing row-toggle idiom), ↑/↓ reorder buttons (no
  drag-reorder), remove button (absent on the workspace row), and an "Add rule"
  affordance (kind picker + path input).
- The two-pane layout stacks when the settings modal is narrow. Skills render as
  single SKILL.md rows — no resource-file tree under a skill (no load API for
  resource files yet).

### Security

- `project` rule paths are validated as relative at save time AND resolved with a
  containment check at read time (`path.resolve(projectPath, rel)` must stay inside
  the real project path) — a stored rule cannot escape the project folder.
- Reads touch only `<base>/<name>/SKILL.md`, the same surface the user layer uses
  today; project folders are already granted to file tools, so no new file-tool
  authority opens. Skill content continues through `wrapUntrusted`.
- `absolute` rule folders join `protectedRoots` in the folder-grants policy (like
  `options.userSkillsDir` at server construction today), so they can never be
  granted as additional directories to file tools. The policy must reflect the
  CURRENT rules at grant-validation time — either derived per validation or updated
  by the PUT handler — because rules change at runtime while the server runs.
- Rules are a host/settings surface: no tool mutates them; the model can only read
  skills through `Skill load`.

## Error handling

- Missing/unreadable/invalid `sources.json` → defaults, no error surfaced to
  sessions (operator sees defaults in the panel and can re-save).
- Rule folder absent → layer skipped (catalog and load both).
- Skill with invalid frontmatter in a project folder → skipped from catalog,
  surfaces `SkillError('invalid')` only on direct load — same as today's layers.
- Unreadable project record for a bound session → project rules contribute nothing,
  catalog degrades to workspace/user layers (omission, never a wrong request).

## Testing

- **Unit**: rule validation (reject `..`, absolute-in-`project`, drive/UNC,
  duplicate ids, >20 rules, second `workspace` row); `resolveSkillLayers` order and
  `~` expansion; first-hit-wins shadowing across project rules and against
  workspace/user; hidden filtering still applies; invalid frontmatter skip.
- **Server integration**: GET/PUT sources round-trip and validation failures;
  catalog injection with a fixture project folder containing `.claude/skills` and
  `.agents/skills` (precedence between the two via list order); `Skill catalog`
  and `Skill load` resolving project layers; unbound session ignores project rules;
  containment check rejects an escaping stored rule at read time.
- **Web**: SkillsPanel spec — the two tabs render; catalog tree groups by project ×
  rule then Workspace/User/Bundled with counts; search and layer filter narrow the
  tree; detail pane previews rendered markdown and edits raw with hash CAS; hidden
  switch toggles and dims the row; read-only notice on non-workspace layers; delete
  on workspace rows; reorder buttons move the rule row and persist via PUT;
  add/remove rule round-trips; validation errors surface inline.

## Non-goals (v1)

- Per-project rule overrides (one list per workspace only).
- Drag-and-drop reorder (↑/↓ buttons only).
- Drag-and-drop or file-picker import of skills from a folder into the workspace
  layer (the dntspace "import" affordance — deferred).
- Resource-file tree under a skill: INITIALLY deferred, pulled into scope the
  same day — the catalog is a FILE TREE (layer group > skill folder > the
  skill's files, descriptions as tooltips), backed by `GET /skills/:name/files`
  (list, owning layer) and `GET /skills/:name/file?path=` (utf8 read,
  containment-checked, 512 KB cap, binary refused). Files are view-only; only
  SKILL.md in the workspace layer stays editable.
- Editing project/absolute-layer skills through the UI (read-only by design).
- A warning when `save` writes a name shadowed by a higher layer (deferred; source
  tags make the situation inspectable).
- Hot reload of active skills mid-turn (hash-pinning unchanged).
