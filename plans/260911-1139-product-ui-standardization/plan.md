---
title: "Product UI standardization"
description: "Repository-verified plan to turn the raw MVP into a coherent English workbench without changing harness safety contracts."
status: superseded
priority: P1
effort: 15d
branch: main
tags: [web, ui, ux, accessibility, english, design-system]
created: 2026-09-11
blockedBy: []
blocks: []
---

# Product UI standardization

## Superseded (2026-09-24)

Not cooked phase by phase. Its execution record
(`docs/ux-ui-standardization-checklist.md`, 68/68, now marked historical) was
overtaken by `plans/260917-1608-chatgpt-style-ui-rebuild/` and
`plans/260918-1007-warm-studio-workbench/`, both completed. The outcomes this
plan owned are verified on the current tree rather than claimed from here:

- English migration: `web/index.html` is `lang="en"`; no Vietnamese string
  remains in non-test `web/` sources.
- Browser acceptance: `npm run test:browser` 71/71 — axe (WCAG 2.1 AA), no
  horizontal overflow at 320/375/768/1024/1440/1920, keyboard and focus-trap
  paths, 44 px touch targets, light/dark, and the screenshot matrix.
- Safety semantics (approvals, lifecycle, settings dirty/conflict) are held by
  the chat-workflows and settings suites.

The representative-mockup gate (phase 2) was never run and is not claimed.
The MCP plan already owns MCP-specific UI evidence in its phases 9–10.

## Decision

Build a neutral, coherent workbench around the existing product. Use the supplied mature screenshot as a density, hierarchy, and multi-pane reference only. Do not copy its terminal, Git, marketplace, upload, repository, or other unsupported chrome.

The preceding `plans/ux-ui-standardization.md` remains the engineering baseline for race handling, durable lifecycle projection, immutable project scope, approvals, and settings capabilities. Its own browser-acceptance caveats mean it is not proof that production visual design is complete (`plans/ux-ui-standardization.md:15-23`, `plans/ux-ui-standardization.md:38-45`). This plan owns the design audit, visual contract, English migration, representative mockup gate, and browser acceptance.

## Evidence-based baseline

- The app currently mixes Vietnamese and English in primary chrome, statuses, settings, ARIA labels, and toasts (`web/App.tsx:39-43`, `web/App.tsx:298-317`, `web/components/layout/TopBar.tsx:81-123`, `web/components/settings/SettingsModal.tsx:24-30`).
- The document declares Vietnamese locale (`web/index.html:1-10`), while time formatting delegates to ambient browser locale (`web/lib/format.ts:2-5`).
- Workspace selection has two permanent owners: app bar and sidebar (`web/components/layout/TopBar.tsx:72-126`, `web/components/layout/Sidebar.tsx:93-103`). Project registration is a raw path field in permanent navigation (`web/components/layout/Sidebar.tsx:104-121`).
- Model selection is editable in composer and inspector (`web/components/composer/Composer.tsx:95-113`, `web/components/layout/EnvPanel.tsx:90-105`), conflicting with a read-only inspector.
- The current geometry is 42/234/252 rather than the audited 48/264/304 contract (`web/styles/tokens.css:65-71`); transcript width is 900px (`web/styles/chat.css:7-15`).
- Tool/thinking/status/settings content relies on repeated bordered surfaces and card grids (`web/styles/chat.css:72-132`, `web/styles/settings-management.css:69-90`) instead of a calm prose-first hierarchy.
- Full settings capabilities exist and must remain writable: provider CRUD/test/sync (`web/components/settings/SettingsModal.tsx:180-276`), agents/children/import (`web/components/settings/ManagementPanels.tsx:67-315`), MCP lifecycle/import (`web/components/settings/ManagementPanels.tsx:319-513`), hooks (`web/components/settings/ManagementPanels.tsx:532-603`), and secrets (`web/components/settings/ManagementPanels.tsx:605-716`).

## Locked product contract

1. Product-owned UI is English. Never translate user messages, project/workspace names, provider/model/tool IDs, tool output, paths, custom mode names, or imported content.
2. Naming glossary: **Conversation** is the user-facing durable thread; **Workspace** is the control/configuration boundary; **Project** is a registered filesystem root. Do not use Chat/Task/Session interchangeably in product copy. Technical API/type names may remain `session`.
3. App bar is the only workspace control owner. Sidebar owns project filtering and conversation history, not workspace switching.
4. Project registration moves into a workspace-management surface reachable from New Conversation. Existing project API remains unchanged.
5. Composer is the only inline owner for editable workspace model and mode. Inspector displays effective values and manifests read-only.
6. Preserve exact event-derived lifecycle and one-request approval semantics. No automatic retry, replay, remembered grant, or broadened scope.
7. Display timestamps only where a verified contract exists. Event timestamps are real (`web/lib/types.ts:9-13`); workspace/project creation times exist (`web/lib/types.ts:101-119`); session listing does not currently expose `createdAt` or `updatedAt` (`web/lib/types.ts:45-59`, `src/web/server.ts:2878-2895`). Adding conversation-list timestamps therefore requires a narrowly scoped response-field extension, not fabricated client times.
8. Performance/virtualization is conditional on measurement. Do not add it without captured transcript/list thresholds and observed frame or memory failure.

## Target geometry and visual rules

- App bar 48px; navigation 264px; inspector 304px; inspector closed by default; dock only at viewport >=1360px.
- Transcript and composer share `max-width: 760px`; mobile margin 16px; tablet margin 24px.
- UI text 13px; prose 14px with 22px line height.
- Desktop controls 32px; coarse-pointer hit targets at least 44px.
- Semantic tokens only. Radius set limited to 6/8/10px. No gradients, decorative marks, fake panes, or card-stack overload.
- Text contrast >=4.5:1; large text/non-text UI >=3:1.

## Data flows

### Navigation and creation
`GET workspaces` -> app-bar workspace selection -> `GET sessions/projects/meta/modes` for active workspace -> sidebar filters local listing only -> New Conversation selects registered project or chat-only -> optional workspace-management project registration -> `POST workspace/session` -> select returned conversation. Project choice is immutable after creation (`src/web/server.ts:1510-1568`).

### Conversation
SSE snapshot/live envelopes -> `useSessionStream` -> durable events/pending approvals -> `projectItems` and `taskPhase` -> transcript/status/approvals (`web/lib/project.ts:36-151`). Composer POSTs content with a request id; draft clears only after acceptance (`web/App.tsx:229-247`).

### Controls and inspector
Workspace meta/modes -> composer editable selectors -> PUT model/mode -> refresh meta. Inspector open -> delayed manifest GET -> read-only effective model/mode/policy/context (`web/App.tsx:195-214`, `web/lib/api.ts:199-210`, `web/lib/api.ts:267-307`).

### Settings
Global provider storage -> workspace activation; workspace-owned agents/MCP/hooks/secrets; child runtime list scoped to current root conversation (`web/components/settings/SettingsModal.tsx:319-333`).

## Phase roadmap

| # | Phase | Depends on | Effort | Measurable gate |
|---|---|---|---|---|
| 1 | [Audit and inventory](./phase-01-start.md) | — | 1d | Surface/state/copy/API/file inventory signed off |
| 2 | [Design contract and visual gate](./phase-02-design-contract-and-visual-gate.md) | 1 | 2d | High-fidelity representative screens approved |
| 3 | [Shell and responsive workspace](./phase-03-shell-and-responsive-workspace.md) | 2 | 2d | 48/264/304 layout and responsive ownership pass |
| 4 | [Conversation transcript and composer](./phase-04-conversation-transcript-and-composer.md) | 3 | 2.5d | Prose-first 760px conversation and single control owner pass |
| 5 | [Approvals, lifecycle, and errors](./phase-05-approvals-lifecycle-and-errors.md) | 4 | 1.5d | Exact safety states retained in compact UI |
| 6 | [Settings and management surfaces](./phase-06-settings-and-management-surfaces.md) | 3 | 2.5d | All existing settings operations remain available |
| 7 | [English migration and naming](./phase-07-english-migration-and-naming.md) | 4,5,6 | 1.5d | Exhaustive product-copy audit passes with allowlist |
| 8 | [Accessibility, validation, and rollout](./phase-08-accessibility-validation-and-rollout.md) | 7 | 2d | Browser matrix, screenshots, keyboard, zoom, contrast pass |

## Dependency and ownership rules

- Phases are sequential unless file ownership is explicitly split. Phase 6 may proceed after Phase 3 only if Phase 4 does not modify settings files and both avoid `web/App.tsx`; otherwise serialize.
- Phase 3 owns `TopBar`, `Sidebar`, `App.tsx` shell wiring, `tokens.css`, `shell.css`.
- Phase 4 owns transcript/composer/message files and `chat.css` conversation sections.
- Phase 5 owns approval/status projection and their tests; coordinate any shared `chat.css` edit after Phase 4.
- Phase 6 owns settings components/styles/tests.
- Phase 7 owns centralized product-copy/glossary/error mapping, HTML locale, docs, and targeted backend listing fields/default fallback only.
- Phase 8 owns test infrastructure, browser specs, screenshot baselines, and release evidence.

## Backwards compatibility and migration

- No migration of session logs, workspace/project records, provider IDs, mode IDs, MCP config, hooks, secrets, or approval wire formats.
- Built-in mode display names may be mapped to English at the presentation boundary without changing IDs (`src/harness/modes/bundled.ts:8-71`). Custom mode names remain untouched.
- Existing derived titles from user content remain untouched. Change only the product-owned empty fallback `new session` if needed (`src/web/server.ts:2887-2889`, `src/web/server.ts:3114-3123`).
- If session list timestamps are approved, add optional `createdAt`/`updatedAt` fields from existing `SessionSummary`; old clients ignore them. Roll back by removing UI consumption first, then fields.
- Preserve dirty working tree; implementation must edit only phase-owned files and never reset unrelated changes.

## Test matrix

| Layer | Required coverage |
|---|---|
| Unit | Copy classifier/allowlist, error mapping, date formatting, mode label mapping, state projection, contrast-token assertions |
| Mounted interaction | Workspace popover, drawers, New Conversation + project management, composer selectors, read-only inspector, approvals, settings tab/forms/destructive confirmations, keyboard/focus restoration |
| API integration | Optional session timestamps/default title, known UI error mapping inputs, archived/running safety failures, scope ownership |
| E2E/browser | Empty/onboarding, populated transcript/tools/thinking, approvals/errors, every settings tab, mobile drawers; keyboard-only and 200% zoom |
| Visual | 320, 375, 768, 1024, 1440, 1920 widths; light/dark only if both exist; explicit no-card-overload check |
| Copy | Scan rendered/product-owned strings; fail non-English outside reviewed allowlist; preserve user/provider/project/tool/custom-mode content fixtures |

## Rollout and rollback

- Land behind a temporary presentation flag only if review needs old/new comparison; do not fork domain behavior.
- Merge in phase order after each visual/regression gate. Keep API extension optional and additive.
- Roll back per phase by reverting that phase's presentation files. Safety/data behavior remains on the preceding engineering baseline.
- If a high-impact regression appears, stop rollout, restore the last approved screenshot baseline, and replan rather than patching contradictory ownership.

## Plan-level risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Visual redesign weakens safety semantics | Medium | High | Freeze lifecycle/approval behavior first; mounted and E2E assertions use exact states/actions |
| English sweep translates user/backend data | Medium | High | Product-owned classifier + explicit preserve allowlist + fixtures |
| Settings redesign drops advanced capability | Medium | High | Operation-by-operation parity matrix before/after |
| Dirty tree causes accidental overwrite | High | High | File ownership, pre-edit diff capture, no reset, phase-scoped review |
| Screenshot copied too literally | Medium | Medium | Explicit unsupported-chrome denylist in visual review |
| Timestamp UI invents recency | Medium | High | Render only verified server fields; omit until contract extension lands |

## Final acceptance

- [ ] Representative high-fidelity screens approved before feature migration.
- [ ] All product-owned rendered copy is English; allowlist audit passes.
- [ ] No user/project/workspace/provider/model/tool/custom-mode content is translated.
- [ ] One workspace owner in app bar; no duplicate sidebar selector.
- [ ] Inspector read-only and closed by default; composer owns model/mode edits.
- [ ] Existing agents/MCP/hooks/secrets/provider operations remain writable and tested.
- [ ] Approval and lifecycle semantics exactly match durable contracts.
- [ ] Numeric geometry, contrast, viewport, zoom, pointer, keyboard, and screenshot gates pass.
- [ ] No fake reference chrome and no card-stack overload.
- [ ] No virtualization unless measured evidence justifies it.

## Unresolved gates

- Visual direction requires human approval of Phase 2 mockups before implementation migration.
- Conversation-list timestamps require approval of the additive API fields; until then omit timestamps from that surface.
- Browser baseline tooling is not currently declared in `package.json:10-18`; Phase 8 must select and install a real browser runner before claiming E2E acceptance.

## Execution handoff (2026-09-11)

All eight implementation areas have been addressed. Automated validation: 326 unit/mounted/API tests across 38 files; 8 Chromium browser tests; typecheck and build pass. Product code and representative screenshots are implemented, not human-approved. Design references predate migration. Current screenshots, logs, copy inventory, and machine-readable acceptance status live under `artifacts/product-ui/`.

The user authorized the additive timestamp extension. Inspection found empty summaries fabricate current fallback times, so the response omits timestamps until real events exist. No stored data migration, permission changes, provider configuration changes, commits, resets, or pushes were performed.

Remaining acceptance gates: human visual approval, independent reviewer delegation (unavailable in this execution environment), native browser 200% zoom and screen-reader review, exhaustive advanced-operation error/stale-result matrix, and measured long-history performance. Do not mark the complete plan accepted until these gates are observed.
