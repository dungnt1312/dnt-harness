# Phase 4 — Docs, full suite, deploy

## Goal

The delegation contract is documented where maintainers already look, the whole suite is
green, and the running instance serves the change.

## Files

- `docs/harness.md` — the `agents/` section: the `Agent` tool, the lifecycle, the child
  model resolution order, the `session/model` stamp
- `docs/web.md` — the route table entry for the shared helpers; the built-in tool list;
  the Workbench Agents view
- `docs/capabilities.md` — `Agent` beside `Skill` and the memory tools, with its mode
  exposure and permission defaults

## Steps

1. Document the resolution order (spawn argument > definition > parent session) and the
   `provider:model` format once, in `docs/harness.md`, and link to it from the other two
   rather than restating it.
2. Record the two fixed defects (child ignoring the parent's pin; cross-provider role
   model) in the plan's outcome notes — they are behaviour changes a maintainer could
   otherwise read as a regression.
3. Full gates: `npm test`, `npm run typecheck`, `npm run build:web`,
   `npm run test:browser`.
4. Rebuild and restart pm2 (`pm2 restart dnt-harness`), then verify live: spawn a child from
   a real conversation with an explicit model and confirm the child card shows that model.

## Validation

All four gates exit 0; the live check above passes; `docs/` claims match the code they
describe (resolution order, tool names, mode exposure).

## Risk / rollback

Docs-only except the deploy. If the live check fails, `pm2 restart` the previous build
and keep the branch unmerged.
