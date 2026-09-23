# Phase 3 — UI: role model picker, live child list

## Goal

A user picks a role's model in Settings, sees which model each child is running, and sees
children the model spawned without reloading.

## Files

- `web/components/settings/AgentsPanel.tsx` — model field in the create form + card display
- `web/components/workbench/AgentRunsPanel.tsx` — model select in the spawn form, model per
  child card, refresh on model-spawned children
- `web/components/workbench/Workbench.tsx`, `web/App.tsx` — pass the model options and the
  refresh signal down
- `web/lib/types.ts` — `ChildRow.model`, `AgentDefinitionRow` already carries `definition.model`
- `web/components/settings/management.spec.tsx`, `web/lib/product-ui.spec.tsx`

## Steps

1. `definitionDocument()` writes `model: "provider:model"` when the create form's picker
   has a value, and omits the key otherwise. The parser and importer already accept it.
2. The picker uses the existing `modelOptions(meta)` / `encodeModelChoice` helpers
   (`web/lib/providers.ts`) — the same list the composer shows — plus an explicit
   "Inherit from the conversation" option that writes nothing.
3. The role card shows the model (or "inherits") beside the tool badges.
4. `AgentRunsPanel` spawn form gains the same optional picker; the value rides the
   existing `spawnChild(... )` call as `model`.
5. Each child card shows its `provider:model` and, while running, an "awaiting approval"
   badge when the handle says so.
6. `AgentRunsPanelContent` takes `refreshSignal: number`; `App.tsx` derives it from the
   root session stream (count of `tool/call` events named `Agent`), so a child the model
   spawned appears at once instead of after a manual refresh. Existing polling for running
   children stays as-is.

## Validation

- `npx vitest run web/components/settings/management.spec.tsx web/lib/product-ui.spec.tsx`
- New cases: the create form emits a `model:` line only when chosen; a child row renders
  its model; a bumped `refreshSignal` triggers one refetch.
- `npm run build:web`

## Risk / rollback

Presentation only. If the refresh signal misbehaves, the panel degrades to today's
behaviour (manual refresh + polling).
