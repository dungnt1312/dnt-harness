# Phase 5 — The composer selects; it does not decide

Depends on: phase 4. Lands in the same commit or immediately after — the
frontend reads `meta.policy` until it does.

## Context

The composer's control row holds the mode menu and the permission popover side
by side (`web/components/composer/Composer.tsx:504-515`), and the approval card
offers a third way to change permission through **Always allow**
(`web/components/chat/ApprovalBar.tsx:134-138`, writing the workspace policy via
`App.tsx:827-832`). All three go.

## Requirements

- The composer control row: attach, mode, thinking, model, stop/send. No
  permission control.
- The approval card: **Allow once** and **Deny**. Nothing else.
- No frontend module imports or defines a policy-mutating call.
- The user can still find out what the current mode permits, and where to change
  it (see the judgment call below).

## Inventory

| Location | Action |
|---|---|
| `web/components/composer/PolicyPopover.tsx` | delete the file |
| `Composer.tsx:93-107` props, `:508-515` render | drop `policy`, `effectivePolicy`, `onPolicySaved` |
| `Composer.tsx:77-91` doc comment | "attach, mode, thinking and permissions" no longer true |
| `ApprovalBar.tsx:16-20` `ALWAYS_ALLOW_RISK` | delete |
| `ApprovalBar.tsx:37,42-45,68-86,98,134-138,145-164` | delete the Always-allow action, its confirm dialog, and `confirming`/`confirmError`/`confirmBusy`/`confirmLock` state |
| `ApprovalBar.tsx:127-131` footer copy | drop the Always-allow sentence |
| `App.tsx:29` `setPolicy` import, `:826-832` `alwaysAllow`, `:1089-1094` props | delete |
| `web/lib/api.ts:426-433` `setPolicy` | delete |
| `web/lib/types.ts:143-148`, `:213-217` | drop `policy` + `effectivePolicy` from `Meta` and `WorkspaceMeta`; keep `permissionDefaults`, `yolo`, and `PolicyMode` (the Modes panel uses it) |
| `web/lib/product-ui.spec.tsx` (18 refs), `tests/browser/chat-workflows.e2e.ts` (5 refs) | rewrite |
| `docs/web.md`, `docs/ux-ui-standardization-checklist.md:85`, `docs/design-system.md` | drop `PolicyPopover` from the composer inventory |

## Judgment call — the mode menu summary

Deleting the popover removes the only place the chat surface stated what the
agent may do. This phase therefore adds, in `ModeMenu`
(`web/components/composer/ComposerControls.tsx`), a one-line read-only summary
per mode row, fed by `meta.permissionDefaults` and `meta.yolo`, plus a link-like
hint pointing at Settings → Modes.

**This is the one thing in the plan not strictly requested.** The argument for
it: "composer only switches modes" is about *authority*, not about *visibility*,
and a mode picker that does not say what each mode permits makes the switch a
guess. The argument against: it is new UI in a phase whose job is deletion.

Cut it if the mode names alone are judged clear enough; nothing else in the plan
depends on it. Decide before implementing.

## Steps

1. Delete `PolicyPopover.tsx` and its import/render in `Composer.tsx`; fix the
   component doc comment.
2. Strip the Always-allow path from `ApprovalBar.tsx`. Keep the submit lock
   (`locks` / `submitting`), the expiry ticker, and the arguments disclosure —
   those are unrelated safety affordances.
3. Remove `alwaysAllow` and the policy props from `App.tsx`; drop `setPolicy`
   from `api.ts` and the two payload fields from `types.ts`.
4. Add the mode summary (or cut it, per the judgment call).
5. Rewrite the UI tests. `product-ui.spec.tsx` carries 18 policy references —
   port what each was protecting (the popover's draft/dirty/reset behavior is
   gone; the approval card's lock behavior is not).
6. Update the docs listed above.

## Validation

- `pnpm vitest run web` — unit/UI suites.
- `pnpm vitest run tests/browser/chat-workflows.e2e.ts` — the flow that
  exercised the permission popover must be re-pointed at Settings → Modes.
- Manual, end to end: select `Ask before changes`, ask for a file write, confirm
  the card shows only Allow once / Deny; switch to `Edit automatically` in the
  composer and confirm the next write does not ask.

## Risk

The e2e suite drives the composer chip by its accessible name; removing a chip
shifts the control row. Run the browser suite before assuming the change is
frontend-local.

Users who relied on Always-allow now take a detour through Settings. That is the
accepted trade: a standing grant to a shell was one click away from a running
turn, which is exactly what the risk copy at `ApprovalBar.tsx:16-20` was written
to warn about.

## Rollback

Revert with phase 4. The frontend cannot be reverted alone — it would call
routes that no longer exist.
