---
phase: 1
title: "MCP exposure as a mode property"
status: completed
---

# Phase 1: MCP exposure as a mode property

## Context

- `src/web/execution-authority.ts:99-126` `exposureRefusal` — MCP branch: zero exposure → none;
  Explorer child → none; server enabled check; `mode.id === 'plan'` → explicit allowlist +
  `READ_SAFE_TOOL_NAME`; otherwise `mcpToolExposed` (empty allowlist = all).
- `src/harness/modes/types.ts:10-35` `ModeDefinition`; `ModeFrontmatter` 51-63.
- `src/harness/modes/service.ts:286-289` `KNOWN_FRONTMATTER_KEYS`; `parseModeFile` 313-410;
  `serializeModeFile` 431-439; `duplicate` 168-174 (serialize → save, so a serialized field survives).
- `src/harness/modes/bundled.ts:57-72` Plan.
- `src/harness/approval/policy.ts:217-220` `exposedBy` (pending re-evaluation) — only checks
  zero exposure for MCP; the host `authorityResolver` re-runs `exposureRefusal`, so a newly
  hidden MCP tool is denied there. No change needed (verify by test).
- `src/web/execution-authority.ts:40` `ExposureMode` = Pick<id,name,toolExposure> & Partial<permissionDefaults,outOfGrant>.
- Durable snapshots: `src/harness/session/events.ts:92` stores the full `ModeDefinition`
  object; legacy snapshots lack the new field.

## Design

New optional field `ModeDefinition.mcpExposure?: 'none' | 'read-safe' | 'all'`.

Effective value (single helper `effectiveMcpExposure(mode)` exported from `execution-authority.ts`):

1. `'none'` when `toolExposure.length === 0` — UNCONDITIONAL, checked before the explicit field
   (the builder sends no schemas for a zero ceiling, `src/harness/context/builder.ts:390-391`;
   an explicit `all` must not let a fabricated call execute). <!-- Red Team: F1 -->
2. else explicit `mode.mcpExposure` when set;
3. else `'read-safe'` when `mode.id === 'plan'` (legacy snapshot compatibility, belt-and-braces);
4. else `'read-safe'` when the mode exposes none of `Write`, `Edit`, `Bash` (a mode that cannot
   mutate the workspace does not get mutating remote tools by default);
5. else `'all'`.

`exposureRefusal` MCP branch becomes: Explorer check (unchanged, first), server-enabled check
(unchanged), then switch on effective value:
- `none` → `mode '<name>' exposes no MCP tools`
- `read-safe` → existing Plan rule (explicit allowlist entry AND read-safe name) with message
  `mode '<name>' does not expose MCP tool '<full>' without a read-safe allowlist entry`
  (identical text for Plan, so existing `/^denied: mode 'Plan' does not expose MCP tool/` tests hold).
- `all` → existing `mcpToolExposed` filter.

Order note: today zero-exposure is checked BEFORE the Explorer and server checks; keep `none`
first to preserve the existing messages for zero modes.

Bundled Plan gets `mcpExposure: 'read-safe'` explicitly. Other bundled modes leave it unset
(derive to `all`, unchanged).

Parser: accept `mcpExposure` key with values `none|read-safe|all`; reject others (strict, like
`outOfGrant`). Serializer: emit `mcpExposure: <v>` when set, after `outOfGrant`.

Also (Red Team F2): `description` is an accepted frontmatter key but is dropped by
`parseModeFile` (`service.ts:401-408`), so `duplicate` loses it. Add optional
`ModeDefinition.description`, parse it (string only, else invalid), serialize it right after
`name` when present. Bundled modes have none → their serialized bytes are unchanged. `ExposureMode` adds `mcpExposure`
to the Partial pick.

## Files

- Modify: `src/harness/modes/types.ts`, `src/harness/modes/service.ts`, `src/harness/modes/bundled.ts`,
  `src/web/execution-authority.ts`.
- Tests: `tests/web/permission-hardening.spec.ts` (hermetic matrix), `tests/harness/modes.spec.ts`.

## Steps (TDD)

1. RED `permission-hardening.spec.ts`:
   - `PLAN_COPY` = Plan with id `plan-copy`, `mcpExposure: 'read-safe'` → same refusals as Plan.
   - `READ_ONLY_CUSTOM` = `{ id:'ro', toolExposure:['Read','Glob','Grep'] }` (no field) → read-safe.
   - `READ_ONLY_OPT_IN` = same + `mcpExposure:'all'` → all exposed.
   - `LEGACY_PLAN` = `{ id:'plan', toolExposure:[...] }` without field → read-safe.
   - `FULL` unchanged → all exposed; `mcpExposure:'none'` on FULL → none.
   - `ZERO` + `mcpExposure:'all'` → still refused (`exposes no MCP tools`). <!-- Red Team: F1 -->
   - `{ toolExposure:['Agent'] }` (no field) → read-safe (child of such a root inherits it via `rootModeOf`).
2. RED `modes.spec.ts`: `ModesService.duplicate(ws,'plan','plan-copy')` resolves with
   `mcpExposure === 'read-safe'`; parse rejects `mcpExposure: sometimes`; serialize/parse round-trip.
3. GREEN: implement types, parser, serializer, bundled Plan, helper, `exposureRefusal`.
4. Run `npx vitest run tests/web/permission-hardening.spec.ts tests/harness/modes.spec.ts tests/web/server-g3.spec.ts`.

## Success Criteria

- All new matrix cases pass; existing Plan host tests (`real host Plan MCP`, final-gate) pass unchanged.

## Risks

- Behavior change for existing custom read-only modes (including already-stamped durable
  snapshots — derivation is computed at evaluation time, not stored): they lose mutating MCP
  tools at their next request until the mode adds `mcpExposure: all` and is reselected.
  Accepted as a fail-closed narrowing, the same contract as "later narrowing denies unstarted
  calls" (`docs/capabilities.md:249-250`). Not versioned (Red Team F4 rejected); documented in Phase 4.
