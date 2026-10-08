---
phase: 2
title: "Modes editor lossless round-trip"
status: completed
depends_on: [1]
---

# Phase 2: Modes editor lossless round-trip

## Context

- `web/lib/mode-form.ts:8-11` `KNOWN_MODE_TOOLS` (stale: `MemorySearch/Read/Create/Update/Forget`;
  missing `BashOutput`, `KillShell`, `TodoWrite`, `AskUserQuestion`). Server truth:
  `src/harness/modes/bundled.ts:102-105`.
- `parseModeForm` (`mode-form.ts:63-87`) filters exposure through that list → silent drop.
- `serializeModeForm` (`mode-form.ts:105-118`) must stay byte-compatible with
  `serializeModeFile` (`src/harness/modes/service.ts:431-439`).
- `web/components/settings/ModesPanel.tsx` view (363-420) and editor (480-557) render
  `KNOWN_MODE_TOOLS` switches and an `outOfGrant` switch.
- Existing test `web/components/settings/settings-panels.spec.tsx:340-356` pins exact serialized bytes.

## Design

- Replace the web `KNOWN_MODE_TOOLS` with the server list by importing
  `KNOWN_MODE_TOOLS` from `src/harness/modes/bundled.ts` (the web already imports harness
  modules, e.g. `DangerousCommandsPanel.tsx` imports `src/harness/guard/defaults.ts`), removing
  the duplication that caused the drift. Re-export from `mode-form.ts` so callers stay unchanged.
- `ModeForm.mcpExposure?: 'none' | 'read-safe' | 'all'`; parse when valid; serialize after
  `outOfGrant` in the same position the server serializer uses (server and web must emit
  identical key order — Phase 1 serializer appends `mcpExposure` after `outOfGrant`).
- Editor: a `Select` "MCP tools" with options `Default (derived)`, `None`, `Read-safe allowlisted only`,
  `All allowlisted`; hint explains default derivation (read-only modes → read-safe).
  View: badge in Context sources grid.

## Files

- Modify: `web/lib/mode-form.ts`, `web/components/settings/ModesPanel.tsx`.
- Tests: `web/components/settings/settings-panels.spec.tsx`.

## Steps (TDD)

0. Also carry `description` (Red Team F2): `ModeForm.description?: string`, parse when string,
   serialize right after `name` exactly like the server serializer. Add a CUSTOM fixture
   (description, `mcpExposure`, `outOfGrant`, MCP permission keys in non-alphabetical insertion
   order, padded instructions) to the round-trip test, server serializer vs form serializer.
1. RED: for each `BUNDLED_MODES` entry, `parseModeForm(serializeModeFile(mode))` then
   `serializeModeForm` equals `serializeModeFile(mode)` (byte-identical, covers Plan's
   `mcpExposure` and Full access `outOfGrant`, and the four previously dropped tools).
2. RED: `permissionKeyError('BashOutput')` is null; `permissionKeyError('MemorySearch')` non-null.
3. GREEN: implement; adjust ModesPanel.
4. Run `npx vitest run web/components/settings/settings-panels.spec.tsx` and `npm run typecheck`.

## Success Criteria

- Round-trip test passes for all four bundled modes; existing serialize test still passes.
