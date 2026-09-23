# Phase 4 — Remove the workspace override layer

Depends on: phase 3 (the new authoring home must exist first).
This is the breaking phase. Land it together with phase 5.

## Context

Effective permission today is `overlayPolicy(mode.permissionDefaults,
workspace.policy, yolo)` (`src/web/server.ts:324-330`), read live on every tool
call through the `PolicySource` getter (`server.ts:1520-1525`). After this phase
the mode's own map is the whole answer.

**What does not change:** `src/harness/approval/policy.ts`. `modeFor`, the
resolution chain, the durable request/decision records, expiry, abort handling
and `reevaluate` all stay exactly as they are. `attachApproval` takes a
`PolicySource`; this phase only changes what the web host feeds it. Harness
tests that drive `attachApproval` with a literal policy map
(`tests/harness/g1-approval.spec.ts`) remain valid.

## Requirements

- Effective policy = the selected mode's `permissionDefaults`.
- `--yolo` maps `ask` → `allow` and **preserves `deny`**. This closes the hole
  where a custom mode's explicit `deny` became `allow` because `overlayPolicy`
  dropped the defaults wholesale (`server.ts:329`, reachable via
  `modes/service.ts:206`).
- No `policy.json` is read or written. Existing files are retired, not honored.
- `tool/call.policyRevision` keeps tracking the permission regime (see step 4).
- The three hard gates and `forceAsk` are untouched.

## Inventory — everything to delete or retarget

| Location | Action |
|---|---|
| `server.ts:324-330` `overlayPolicy` | replace with `effectivePolicy(defaults, yolo)` |
| `server.ts:358-365` `DEFAULT_POLICY` | delete |
| `server.ts:383` `WorkspaceControls.policy` | delete field |
| `server.ts:447-453` `storedPolicies` + boot read | delete; replace with the retirement sweep (step 5) |
| `server.ts:520-528` policy seeding in `controlsFor` | delete |
| `server.ts:202-207` `options.policy` | delete from `WebOptions` |
| `server.ts:1520-1525` `PolicySource` getter | read the mode only |
| `server.ts:1652-1655`, `:1763` `persistPolicy` | delete dep + implementation |
| `server.ts:2757-2765` legacy `PUT /api/policy` | delete route |
| `server.ts:2796-2807` `PUT /api/workspaces/:id/policy` | delete route |
| `server.ts:2848-2849` reevaluate on mode change | feed `effectivePolicy(...)` |
| `server.ts:3882-3916` `putPolicy` | delete |
| `server.ts:3984-3986` meta payload | drop `policy` + `effectivePolicy`, keep `permissionDefaults` + `yolo` |
| `server.ts:4455-4477` `StoredPolicy`, `readWorkspacePolicyFile`, `writeWorkspacePolicyFile` | delete |
| `src/harness/workspace/service.ts:26` layout doc comment | drop the `policy.json` line |

`options.defaultMode` stays: it is the fallback for a tool no mode names, and
`modeFor`'s last rung still needs it.

## Steps

1. **Replace the overlay** with a single function beside where it stood:

   ```ts
   /**
    * Effective permission is the selected mode's own map. `--yolo` answers
    * every question for the operator; it never lifts a mode's explicit deny,
    * which is a prohibition rather than a prompt.
    */
   function effectivePolicy(
     defaults: Readonly<Record<string, ApprovalMode>>,
     yolo: boolean,
   ): Record<string, ApprovalMode> {
     if (!yolo) return { ...defaults }
     return Object.fromEntries(
       Object.entries(defaults).map(([tool, mode]) => [tool, mode === 'deny' ? 'deny' : 'allow']),
     )
   }
   ```

2. **Retarget the three call sites** (policy getter, mode-change reevaluate,
   workspace meta). All three already have the mode in hand.
3. **Delete the routes, the persistence, and the dead types** per the inventory.
   Removing `PUT /api/policy` and `PUT /api/workspaces/:id/policy` is the
   breaking API change; record it in `docs/web.md` rather than leaving a
   deprecated stub — the whole point is that no second layer exists.
4. **Move `kernel.ctx.tools.bumpPolicyRevision()` into `adoptMode`**
   (`server.ts:1231-1238`). Today only `putPolicy` bumps it (`server.ts:3904`)
   while `adoptMode` bumps only `modeRevision` — so a mode switch already
   changes effective permission without advancing the revision stamped on every
   durable `tool/call` event (`harness/session/events.ts:35`,
   `harness/agent/agent.ts:440-443`). Deleting `putPolicy` without this move
   would freeze the field at 0 and silently gut the audit trail.
5. **Retire existing files.** On boot, for each workspace whose `policy.json`
   parses to a non-empty map: log one line naming the workspace and the entries
   that no longer apply, then rename the file to `policy.json.migrated`. No mode
   is generated — see the plan index for why this is safe (the worst case is
   `deny → ask`, and `ask` still stops for a human before any side effect).

## Validation

- `pnpm vitest run tests/harness` — expected green without edits; if
  `g1-approval.spec.ts` breaks, the harness contract was changed by accident.
- `tests/web/server-g3.spec.ts`: keep the existing `--yolo` test
  (line 284), add its mirror — a custom mode with `Bash: 'deny'` under `--yolo`
  denies and never asks.
- `tests/web/server-g2.spec.ts`: the 8 policy references are workspace-isolation
  assertions. Rewrite them as *mode* isolation: two workspaces, different
  selected modes, a call allowed in one and asked in the other.
- New: a workspace with a seeded `policy.json` boots, logs, renames the file,
  and gates by mode defaults only.
- New: `PUT /api/workspaces/:id/policy` returns 404.
- `pnpm vitest run tests/web` then the full `pnpm test`.

## Docs

- `docs/harness.md:289` (Approval) — one layer, the `--yolo` rule, the
  resolution chain unchanged.
- `docs/web.md` — remove both policy routes, update the meta payload shape and
  the approval bridge section (`docs/web.md:564`).
- `docs/architecture.md` / `docs/capabilities.md` — wherever the two-layer model
  is described.

## Risk

- **A workspace that relied on an override silently changes behavior.** Mitigated
  by the boot log, and bounded by the argument above: nothing runs unattended.
- **Test rewrite volume.** 61 `policy` references across 12 test files. Most are
  harness-level and survive; the web ones are the work. Do not delete an
  assertion because it no longer compiles — port what it was protecting.
- **The `reevaluate` MCP-cancel issue** (plan index, non-goals) now fires only on
  a mode change. Leave it; do not widen this phase.

## Rollback

Revert phases 4 and 5 together. `policy.json.migrated` files must be renamed
back by hand — the retirement sweep is one-way, so take the backup before
running a server build with this phase for the first time.
