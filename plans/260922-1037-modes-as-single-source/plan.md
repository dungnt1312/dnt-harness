# Modes as the single source of permission

Status: **completed** (verified 2026-09-24; see Delivery)
Branch: `feat/workbench-terminal` (38 files dirty; see Risks)
Created: 2026-09-22

## Delivery (verified 2026-09-24)

Shipped on `main` through `a932b97` and the Settings follow-ups `c8b91db` /
`51d1f94`. Checked against the acceptance criteria on the current tree:

1. Modes authoring lives in Settings — now a nested subtab of **Permissions**
   (`c8b91db` merged Modes and Dangerous Commands there), with view-on-click
   detail (`51d1f94`). This is the only deviation from "a Modes tab".
2. `PolicyPopover.tsx` is gone; the composer carries the mode menu only.
3. `web/components/chat/ApprovalBar.tsx` offers exactly Allow once / Deny.
4. `effectivePolicy` (`src/web/server.ts`) reads only the selected mode's
   `permissionDefaults`; `PUT /api/workspaces/:id/policy` and `PUT /api/policy`
   are 404 (`tests/web/server-g3.spec.ts`). A non-empty `policy.json` is
   renamed to `policy.json.migrated` once, with collision/malformed/empty
   cases preserved and logged, as decided under Migration.
5. `--yolo` maps `ask → allow` and keeps `deny`.
6. `permissionDefaults` keys accept `mcp__<server>__<tool>`,
   `mcp__<server>__*`, and `*` (`src/harness/modes/service.ts`).
7. `npm test`, `npm run typecheck`, `npm run build:web`, and
   `npm run test:browser` (69/69) are green.

## Outcome

A mode is the only thing that decides whether a tool runs, asks, or is denied.
Modes are authored in Settings. The composer selects one and shows nothing else.
The workspace permission-override layer (`policy.json`, `PUT
/api/workspaces/:id/policy`, `overlayPolicy`, `PolicyPopover`, approval
Always-allow) is removed entirely.

## Why

Permission is resolved today by two stacked layers plus a host flag:

```
mode.permissionDefaults  ⊕  workspace policy.json  ⊕  --yolo
```

`overlayPolicy` (`src/web/server.ts:324`) merges them per key. The cost of the
second layer is visible:

- the composer edits permission mid-conversation while the mode menu sits next
  to it, so neither control is the answer to "what may this thing do";
- `--yolo` drops the mode's defaults wholesale, which silently converts a custom
  mode's explicit `deny` into `allow` (`server.ts:329`, reachable because
  `modes/service.ts:206` accepts `deny`);
- a `*` override never reaches a tool the mode names, because `modeFor` matches
  the exact key first (`harness/approval/policy.ts:113`), so the same override
  means different things depending on the mode and the `--yolo` flag.

One layer removes all three at once.

## Constraints

- The three hard gates above approval are untouched: host `blockedTools`, mode
  `toolExposure`, child agent ceilings (`server.ts:1243-1296`).
- `forceAsk` (MCP `requiresUserInteraction`) keeps overriding everything.
- Bundled modes stay read-only; customizing duplicates into the workspace
  (`modes/service.ts:110`).
- No permission capability may be lost. MCP tools are the sharp edge: they are
  unreachable from `permissionDefaults` today, so phase 1 precedes any removal.
- The new authoring home ships **before** the old one is removed, so there is
  never a commit where permission cannot be changed at all.

## Non-goals

- `toolExposure` semantics, host `blockedTools`, MCP exposure rules, child
  agent ceilings.
- The known issue that `reevaluate` cancels a pending MCP approval on any mode
  change, because `Reevaluation.toolExposure` never lists `mcp__*` names
  (`policy.ts:283`). It fails in the safe direction (cancel, never run) and its
  only remaining trigger after phase 4 is a mode change. Logged, not fixed here.

## Acceptance criteria

1. Settings has a **Modes** tab: list, view, duplicate, edit, delete workspace
   modes; bundled modes render read-only with a Duplicate action.
2. The composer's control row holds the mode menu and no permission control;
   `PolicyPopover.tsx` no longer exists.
3. The approval card offers exactly **Allow once** and **Deny**.
4. Effective permission for a call = selected mode's `permissionDefaults`,
   resolved by the existing exact → `mcp__server__*` → `*` → default-mode chain,
   with `forceAsk` above it. No `policy.json` is read or written.
5. `--yolo` maps a mode's `ask` to `allow` and **preserves** its `deny`.
6. A mode can express MCP permission (`mcp__server__*`, `mcp__server__tool`) and
   a catch-all (`*`).
7. `pnpm test` green (harness + web + web-ui), browser e2e green, docs updated.

## Phases

| # | Phase | Owns | Depends on |
|---|-------|------|-----------|
| 1 | [Mode permission schema](phase-01-mode-permission-schema.md) | `harness/modes/*`, `tests/harness/modes.spec.ts` | — |
| 2 | [Mode CRUD REST + client](phase-02-modes-rest-api.md) | `src/web/server.ts` (routes), `web/lib/api.ts`, `docs/web.md` | 1 |
| 3 | [Settings Modes panel](phase-03-settings-modes-panel.md) | `web/components/settings/ModesPanel.tsx`, `SettingsModal.tsx` | 2 |
| 4 | [Remove the override layer](phase-04-remove-override-layer.md) | `src/web/server.ts`, `docs/harness.md`, server tests | 3 |
| 5 | [Composer + approval cleanup](phase-05-composer-approval-cleanup.md) | `web/App.tsx`, `Composer.tsx`, `ApprovalBar.tsx`, `lib/*`, e2e | 4 |

Phases 1-3 are additive and independently shippable. Phase 4 is the breaking
one; phase 5 must land in the same commit or immediately after, because the
frontend reads `meta.policy` until it does.

## Blast radius

`policy` appears 107 times across 21 files and 61 times across 12 test files.
The heaviest test owners: `tests/harness/g1-approval.spec.ts` (14),
`tests/web/server-g3.spec.ts` (12), `tests/web/server-g2.spec.ts` (8),
`tests/harness/tools.spec.ts` (9), `web/lib/product-ui.spec.tsx` (18),
`tests/browser/chat-workflows.e2e.ts` (5).

## Migration of existing `policy.json`

**Decision: drop, do not auto-convert.** On the first load of a workspace whose
`policy.json` is non-empty, the server logs one line naming the entries that no
longer apply and renames the file to `policy.json.migrated`. No mode is
generated.

Rationale: the only behavior change a dropped override can cause is
`allow → ask` (tightening) or `deny → ask` (loosening). Loosening stops at
`ask`, which still requires a human decision before any side effect, so nothing
runs unattended. Auto-generating a migrated mode per workspace would add a
permanent conversion path to buy back a prompt the operator can answer once.

## Risks

- **Dirty branch.** `feat/workbench-terminal` has 38 modified files plus
  untracked plans. This work is unrelated to the terminal. Recommend a separate
  branch off the current HEAD, or landing the terminal work first.
- **Test churn.** Phase 4 breaks every test that PUTs a policy. Budget the
  rewrite into phase 4/5 rather than treating it as cleanup.
- **Discoverability.** After phase 5 nothing in the chat surface states what the
  current mode permits. Phase 5 adds a read-only one-line summary per mode row
  in `ModeMenu`; see that phase's judgment-call note if this should be cut.

## Unresolved questions

1. Should the Modes panel edit raw Markdown (mirroring `SkillsPanel`, which
   round-trips a file with `expectedHash`) or offer structured fields for
   `toolExposure` / `permissionDefaults`? Phase 3 proposes raw Markdown first
   with a structured permission table, and states the cut line.
2. Does `--yolo` keep existing as a host flag once modes are the only layer, or
   does it become "select Full access"? Phase 4 keeps the flag and only fixes
   its `deny` handling; removing it is a separate decision.
