# Phase 3 — The Modes panel in Settings

Depends on: phase 2.

## Context

Settings has eight tabs and no Modes tab (`web/components/settings/SettingsModal.tsx:33-50`).
`SkillsPanel.tsx` is the closest existing panel by shape — workspace-scoped
Markdown files, bundled rows read-only, an editor that loads real content and
handles `expectedHash` conflicts with Reload / Overwrite (`SkillsPanel.tsx:30-70`).
It is built entirely from `settings-kit.tsx` primitives (`PanelBody`,
`PanelIntro`, `Section`, `ItemList`, `ItemRow`, `CodeArea`, `InlineConfirm`,
`Notice`, `WorkspaceRequired`, `useActionRunner`).

This is the phase that makes "modes are authored in Settings" true, and it must
land before phase 4 removes the old editor.

## Requirements

- A `Modes` tab in the **Workspace** group, after `projects` and before
  `skills` — a mode decides what every conversation may do, so it ranks above
  skills in the nav.
- Rows list bundled modes first with a read-only badge and a **Duplicate**
  action, then workspace modes with **Edit** and **Delete**.
- Each row states, in one line, what the mode permits, read from its parsed
  `permissionDefaults` — this is the information the composer popover carried
  and must not be lost when phase 5 deletes it.
- The row for the workspace's currently selected mode is marked as such.
- The editor edits the raw Markdown file, mirroring `SkillsPanel` exactly:
  load real content + hash, save with `expectedHash`, 409 → Reload / Overwrite.
- The panel states plainly that **a saved change applies when the mode is next
  selected**, because the live selection runs on a cached snapshot
  (`server.ts:2840-2841`). Without this sentence the panel silently lies.
- Deleting the currently selected mode is allowed but warns that the running
  selection keeps its cached snapshot until another mode is chosen.

## Files

- `web/components/settings/ModesPanel.tsx` (new)
- `web/components/settings/SettingsModal.tsx` — `SettingsTab` union (line 33),
  `TABS` (35-44), `TAB_GROUPS` (47-50), and the panel switch.
- `web/components/settings/settings-panels.spec.tsx` — panel tests.
- `docs/web.md` / `docs/capabilities.md` — the Settings surface list.

## Steps

1. Copy the `SkillsPanel` skeleton and retarget it at the phase-2 client
   functions. Keep `useScopedState` and `useActionRunner`; do not introduce a
   new state or fetch idiom in a panel that sits beside seven others.
2. Render the permission summary from the catalog row. `GET /modes` returns
   `{ id, name, source }` today — extend that payload in phase 2 to include
   `permissionDefaults` and `toolExposure` so the list needs no N+1 reads.
   (Fold this into the phase-2 route if it has already shipped; it is one field.)
3. Duplicate flow: prompt for a kebab-case id, call the duplicate route, open
   the editor on the result. Let the server own the id rules
   (`service.ts:86-88`) and surface its message rather than re-validating.
4. Wire the tab, the icon (`shield` matches the permission meaning and is
   already imported by the composer chip being deleted), and the hint text:
   "What a conversation may read, edit, or run".

## Cut line — structured editor

This phase ships the **raw Markdown editor plus a read-only permission
summary**. A structured per-tool Allow/Ask/Deny table that writes frontmatter
back is deliberately out of scope: it duplicates validation that already lives
in `parseModeFile`, and the raw editor is the shape every other file-backed
panel in Settings uses.

If the summary proves too thin in use, the table is a self-contained follow-up
that only touches this panel. It is listed as unresolved question 1 in the plan
index — decide it before implementing, not during.

## Validation

`pnpm vitest run web/components/settings/settings-panels.spec.tsx`, asserting:

- bundled rows expose Duplicate and no Edit/Delete;
- a workspace row opens the editor with the real file content;
- a 409 on save offers Reload / Overwrite and Overwrite re-reads the fresh hash
  first (the `SkillsPanel` behavior this mirrors);
- the permission summary renders `*` and `mcp__server__*` entries, not just the
  built-in tool names;
- the "applies when next selected" notice is present.

Manual: create a mode with `Bash: deny`, select it in the composer, confirm a
Bash call is denied without a question.

## Risk

Panel count is growing; this is the ninth tab. Accepted: modes are the
permission surface now, so they earn a top-level home rather than a section
inside another panel.

The permission summary is a second rendering of the gate's rules and can drift
from `modeFor` (`policy.ts:112-121`). Keep it a plain listing of the mode's own
entries — do not reimplement resolution order in the UI.

## Rollback

Remove the tab from `SettingsModal` and delete the panel file. Phase 2's routes
stay usable by hand; nothing else depends on this phase until phase 5.
