---
status: completed
branch: feat/warm-studio-workbench
spec: docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md
superPlan: docs/superpowers/plans/2026-09-15-warm-studio-workbench-redesign.md
---

# Warm Studio Workbench — Full UI Restyle

## Outcome
Rebuild `web/` as the approved Warm Studio workbench (top bar + left nav + center conversation/workbench + right Context/Artifacts + fixed composer dock) with warm neutral + terracotta tokens, Tailwind + Radix + CVA, resizable/collapsible panels, pure artifact projection — preserving all REST/SSE contracts, `projectItems`, routing, drafts, queue/stop, approval, and settings safety semantics. Scope is **entire UI** (user-confirmed 2026-09-18).

## Decisions (user-accepted 2026-09-18)
- Scope: whole client, not incremental.
- Work on current branch `feat/warm-studio-workbench`.
- Serial vertical slices (1→7); each task typechecks + tests green before next.

## Constraints / non-goals
- No backend/REST/SSE change; `web/lib/api.ts` and `web/lib/types.ts` client-local only when listed.
- Preserve `projectItems`, routing validation, draft acceptance, queue/stop/reconnect, approval locks, settings dirty/conflict.
- Context/Artifacts are read-only projections of existing data; no editor/file-tree/terminal/diff/upload/rerun.
- Tailwind + CVA own visuals, Radix owns overlays/tabs/collapsible/menus; retained CSS only `app.css`, `markdown.css`, `motion.css`.
- Dynamic CSS vars only for panel widths, popup geometry, textarea height, budget %.
- No commit until user authorizes.

## Phases

| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 1 | Foundation — deps, Tailwind/Vite, warm tokens, cn, CVA/Radix primitives, preferences, resizers | done | — |
| 2 | Shell — TopBar, WorkbenchShell grid/drawers, resizable navigation, responsive breakpoints | done | 1 |
| 3 | Transcript + elevated Workbench surface | done | 2 |
| 4 | Fixed Composer dock + Approval safety | done | 3 |
| 5 | Right panel — Context + Artifacts (pure projector) | done (pre-existing; see note) | 4 |
| 6 | Settings — Radix/Tailwind migration with dirty/conflict parity | done (pre-existing; see note) | 5 |
| 7 | Cleanup, docs, full matrix + self-review | done (2026-09-24; see Outcome) | 6 |

Each phase must `typecheck` and keep its targeted suite green before the next starts.

### Deviation to review (Phase 5)

The inspector is functionally complete: `ContextPanel` extracted, `projectArtifacts` matching the
mapping contract with the exact empty/label copy, `inspectorTab` persisted, and the manifest fetch
already gated on `!open || tab !== 'context' || activeFile !== null || workspace === null ||
session === null || running`. `EnvPanel.tsx` is gone with zero live callers (only historical docs
mention it).

Two departures from the super plan's literal Task 5 shape, both pre-existing:

1. `web/components/workbench/Workbench.tsx` hosts the views with a `role="toolbar"` +
   `aria-pressed` button group rather than Radix `Tabs`, and no separate `InspectorPanel.tsx`
   exists. Semantics are accessible, but Radix's arrow-key tab traversal is absent.
2. There is a third `Files` view (browser + read-only viewer) plus a closable per-file tab strip,
   which the two-tab Context/Artifacts contract did not anticipate. This is what makes a
   straight Radix `Tabs` swap awkward.

Kept as-is rather than rewritten, because the file views are working scope the spec predates.
Converting to Radix `Tabs` for keyboard parity is a reasonable follow-up if the user wants strict
spec conformance.

### Deviation to review (Phase 6)

`SettingsModal.tsx` was already on Radix `Dialog` (via `ui/Modal.tsx`) + Radix `Tabs`, with the
provider-draft-survives-tab-change and discard-before-leave guards intact (`leave()` gates every
tab switch, provider switch, and close behind a `ConfirmDialog` when `dirty`). `expectedHash`
conflict parity (Reload server version / Overwrite anyway, overwrite re-reads the fresh hash first)
was already correct in Skills and Memory panels.

The one gap: `ManagementPanels.tsx` (Agents/MCP/Hooks/Secrets/Skills/Memory) and `ProjectsPanel.tsx`
render through semantic `manage-*`/`hooks-binding`/`memory-*`/`project-*` classes defined in
`app.css`'s `@layer components` block, not Tailwind utilities/CVA directly on the elements — a
pre-existing pattern, already using warm design tokens (`var(--line)`, `var(--fg-muted)`, etc.),
documented in `app.css` as "Workspace management panels keep semantic hooks; their visuals live
here so the panel modules stay free of repeated utility strings." Converting ~127 class usages
across a 1300-line file to inline Tailwind would be a pure churn/regression-risk change with no
visual or behavioral difference, since the classes already resolve to the same tokens Tailwind
would apply. Fixed the one real inconsistency instead: the memory search input used a raw
`filter-input`-classed `<input>` instead of the shared `TextInput` primitive (mismatched focus ring
and leading-icon layout vs. every other text field in Settings); swapped it to `TextInput` with a
leading search icon, then removed the now-dead `.session-filter` rule from `app.css`.

Kept the `manage-*` semantic-class pattern as-is rather than rewriting it, for the same reason as
the Phase 5 deviation: it is working, token-correct, pre-existing scope the spec predates, and a
literal component-by-component Tailwind rewrite is a reasonable follow-up if the user wants strict
"Tailwind utilities directly on every element" conformance rather than the semantic-class layer.

## Outcome (2026-09-24)

Phase 7 closed on the current `main`. `web/styles/` holds exactly `app.css`,
`markdown.css`, `motion.css`. `npm run test:browser` 69/69 (axe, overflow,
keyboard, touch-target and the 6-width screenshot matrix included);
`npm test`, `npm run typecheck`, `npm run build:web` exit 0. The browser
suite had drifted behind later work and was realigned, not weakened: fixtures
now answer the per-conversation `GET …/grants` route, the settings-conflict
matrix state picks tabs vs the mobile section select by viewport width
instead of racing the dialog's first paint, and the manifest assertions
follow the composer context meter (read once per settled conversation, not
lazily per workbench view). The Phase 5/6 deviations above stand as accepted.

## Acceptance
- Warm Studio palette (warm neutrals + terracotta) with verified contrast; no copied reference chrome.
- Left 280px (232–420), right 336px (280–520), both persist, keyboard accessible; left drawer <1024, right drawer <1280; no overflow at 320/375/768/1024/1440/1920.
- `projectItems` unchanged; transcript + workbench + composer + approval + context/artifacts + settings semantics unchanged.
- Artifacts exact empty copy and mapping; no file-content/diff claim.
- Tailwind/Radix/CVA own UI; only three CSS files remain; full `npm test` / `typecheck` / `build:web` / `test:browser` green.

## Verification
- Per-phase: targeted `vitest` + `typecheck` + `build:web` (+ Playwright where listed).
- Final: `npm test -- --maxWorkers=1 --no-file-parallelism`, `npm run typecheck`, `npm run build:web`, `npm run test:browser` all exit 0; axe/keyboard/focus/coarse/reduced-motion/reconnect gates pass.
