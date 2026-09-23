# Phase 2 — Mode CRUD over REST

Depends on: phase 1.

## Context

`ModesService` already has the whole lifecycle: `list`, `resolve`, `save` (raw
Markdown, validated before the write, atomic replace, `expectedHash` guard),
`duplicate`, `delete` (`src/harness/modes/service.ts:36-121`). None of it is
reachable over HTTP. The only mode route is
`GET/PUT /api/workspaces/:id/mode` — list names and select one
(`src/web/server.ts:2818-2861`).

So a custom mode can only be created by dropping a file into
`<home>/workspaces/<id>/modes/<mode>.md` by hand. That is the gap that makes
"modes are authored in Settings" impossible today.

`/api/workspaces/:id/skills` (`server.ts:2865-2917`) is the template: same
raw-content-with-`expectedHash` shape, same service contract, same error
mapping. Mirror it rather than inventing a second convention.

## Requirements

- New routes, all workspace-scoped, mirroring the skills block:
  - `GET    /api/workspaces/:id/modes` — catalog: `{ id, name, source }[]`,
    bundled first (that is already `ModesService.list` order).
  - `GET    /api/workspaces/:id/modes/:modeId` — raw Markdown + hash + source,
    so the editor never saves blind.
  - `PUT    /api/workspaces/:id/modes/:modeId` — body `{ content, expectedHash? }`.
  - `POST   /api/workspaces/:id/modes/:modeId/duplicate` — body `{ newId }`.
  - `DELETE /api/workspaces/:id/modes/:modeId`.
- The existing singular `/mode` selection route is untouched. Two paths, two
  concerns: `/mode` is the live control, `/modes` is authoring.
- Mutations require an active workspace (`requireWorkspace(deps, wsId, true)`),
  reads do not — same as skills.
- Error mapping: `not-found` → 404, `conflict` → 409, everything else → 400.

## Files

- `src/harness/modes/service.ts` — add `load()`; use a `conflict` code.
- `src/harness/modes/types.ts` — `ModeError` code union (line 59).
- `src/web/server.ts` — new route block beside the skills one.
- `web/lib/api.ts` — client functions beside `listModes`/`setMode` (line 447).
- `web/lib/types.ts` — a `ModeFileRow` type for the raw read.
- `docs/web.md` — REST reference.
- `tests/web/server-g3.spec.ts` — route tests.

## Steps

1. **`ModesService.load(workspaceId, id)`** returning
   `{ id, raw, source, hash? }`. `resolve()` deliberately returns only the
   parsed definition (`service.ts:63-74`), so an editor has nothing to edit.
   For a bundled id, return `serializeModeFile(definition)` with
   `source: 'bundled'` and no hash — that is exactly what Duplicate would
   write, so the panel can show a faithful read-only preview.
2. **Add `'conflict'` to the `ModeError` code union** and throw it at
   `service.ts:99` instead of `'invalid'`. Today a stale-hash save is
   indistinguishable from a malformed file, so the route could only answer 400
   where skills answers 409. One word, and the client can tell "someone else
   edited this" from "your frontmatter is wrong".
3. **Route block** with the `(?:\/([^/]+))?` optional-segment shape of the
   skills matcher, plus a separate `/duplicate` matcher. Validate `content` is a
   non-empty string and `newId` is a non-empty string; let `save()` enforce
   kebab-case and the bundled-id refusal (`service.ts:83-88`) rather than
   duplicating those rules in the handler.
4. **Client functions**: `listModeFiles`, `getModeFile`, `saveModeFile`,
   `duplicateModeFile`, `deleteModeFile`, shaped like `saveSkill`
   (`web/lib/api.ts:513`).
5. **Docs**: add the five routes to the REST reference in `docs/web.md`, next to
   the existing `/mode` entry, and state that editing a mode does not
   hot-reload a live selection (see Risk).

## Validation

`pnpm vitest run tests/web/server-g3.spec.ts`, asserting:

- save a valid custom mode → it appears in `GET /modes` **and** in the
  selection catalog `GET /mode` → selecting it gates a call by its
  `permissionDefaults`;
- save with a stale `expectedHash` → 409, file unchanged on disk;
- save with invalid frontmatter → 400, **no file written** (the validate-before-write
  contract at `service.ts:89`);
- `PUT`/`DELETE` on a bundled id → 400 with the "duplicate it to customize"
  message;
- duplicate a bundled mode → new workspace mode with identical
  `permissionDefaults`, new id;
- a mode carrying the phase-1 key shapes (`*`, `mcp__server__*`) survives the
  save → read → select round trip.

Then `pnpm vitest run tests/web`.

## Risk

**Editing the selected mode does not take effect until it is selected again.**
`controlsFor` caches the validated snapshot at selection time and mode files are
deliberately not hot-reloaded (`server.ts:2840-2841`, `WorkspaceControls.modeDefinition`).
A panel that saves a mode and shows no change is the confusing outcome. This
phase only documents it; phase 3 surfaces it in the UI. Do **not** add
hot-reload here — the snapshot is what makes a running turn's permissions
stable, and changing that is a separate design decision.

Deleting the currently selected mode leaves the live selection running on its
cached snapshot. That is coherent (the turn keeps the rules it started with) but
must be stated in the panel.

## Rollback

The routes are additive; reverting the server diff restores the previous
surface. `ModesService.load` and the `conflict` code are harmless on their own —
if the phase is reverted after phase 3 ships, the panel loses its backend, so
revert phases 2 and 3 together.
