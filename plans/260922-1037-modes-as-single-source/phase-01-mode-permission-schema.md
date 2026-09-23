# Phase 1 — A mode can express every permission an override could

Depends on: nothing. Additive and independently shippable.

## Context

`parseModeFile` accepts a `permissionDefaults` key only when it is in
`KNOWN_MODE_TOOLS` (`src/harness/modes/service.ts:204`), i.e. the 13 built-in
capability names. The approval gate, however, resolves a call through
exact → `mcp__<server>__*` → `*` → default mode
(`src/harness/approval/policy.ts:112-121`).

So two of the four rungs are reachable only from the workspace override map that
this plan removes. Without this phase, removing the override layer would make
every MCP tool ask forever and would delete the catch-all row entirely.

## Requirements

- `permissionDefaults` accepts exactly the keys the gate can match:
  - a name in `KNOWN_MODE_TOOLS`;
  - `mcp__<server>__*`;
  - `mcp__<server>__<tool>`;
  - `*`.
- Anything else is rejected with the existing `invalid.push(...)` message shape,
  naming what would have matched. This is the rule that lives in the UI today
  (`web/components/composer/PolicyPopover.tsx:25-29`) and must survive the
  deletion of that file — validation belongs on the server anyway.
- Values stay `allow | ask | deny` (`service.ts:206`), unchanged.
- Legacy lowercase names (`bash`) stay rejected. The known-tool list is
  canonical and the error already prints it; silently up-casing a hand-written
  file hides a typo.
- `serializeModeFile` round-trips the new keys unchanged.
- `toolExposure` validation is untouched — MCP exposure is governed by the MCP
  config allowlist and the per-mode rules at `src/web/server.ts:1255-1279`, not
  by a mode's tool list.

## Files

- `src/harness/modes/service.ts` — `parseModeFile`, the `permissionDefaults`
  loop at 198-213.
- `src/harness/modes/types.ts` — the `permissionDefaults` doc comment on
  `ModeDefinition` (line 21) and `ModeFrontmatter` (line 47) state the accepted
  key shapes.
- `tests/harness/modes.spec.ts` — new cases.

## Steps

1. Extract a small predicate beside the loop, e.g.
   `isPermissionKey(tool: string): boolean`, covering the four accepted shapes.
   Keep it in `service.ts`; it has one caller and moving it to its own module
   would buy nothing.
2. Replace the `!KNOWN_MODE_TOOLS.includes(tool)` guard with it, and reword the
   error to name all four shapes.
3. Extend the doc comments in `types.ts` so the frontmatter contract is
   readable without opening the validator.

## Validation

`pnpm vitest run tests/harness/modes.spec.ts`, asserting:

- `permissionDefaults: { '*': 'ask' }` parses;
- `mcp__github__*: 'allow'` and `mcp__github__create_issue: 'ask'` parse;
- `mcp__*__read`, `Ba*h`, `bash` are each rejected with a message naming the
  accepted shapes;
- a parsed-then-serialized mode with all four key shapes round-trips byte-identical.

Then the harness suite: `pnpm vitest run tests/harness`.

## Risk

Acceptance is widened only, so every mode file that parses today still parses.
The single hazard is an over-broad regex letting through a key the gate cannot
match (e.g. `mcp__*__read`), which would store a rule that silently never
applies — exactly the failure the UI rule was written to prevent. The rejection
tests above are the guard.

## Rollback

Revert the validator diff. Any workspace mode file already using a new key shape
then fails validation with a clear message, and mode selection falls back
through the existing `ModeError` path.
