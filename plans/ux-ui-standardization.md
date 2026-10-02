# UX/UI standardization

## Approved production UX implementation — 2026-09-11
Outcome: task-first navigation and honest execution workflows, beyond visual standardization.
Constraints/non-goals: preserve dirty work, immutable session projects, backend permission/API contracts and cliproxy/gpt5.5 configuration; no auto-retry, scope grants, commits or unrelated server edits.

Reviewed concrete plan (self-review; delegation unavailable):
1. Replace next-session picker with a deliberate modal requiring project or explicit chat-only selection; guard duplicate creation and stale navigation. Project attachment stays workspace management, never mutates an existing conversation.
2. Sidebar exposes workspace selection, projects as history filters, and work history. Inspector defaults closed and only fetches manifests when opened.
3. Derive preparing/running/waiting/completed/failed/interrupted and other terminal reasons from durable events and pending approvals; show reconnect separately. Ended streams cannot leave assistant text falsely live. Recovery guidance never automatically replays tools.
4. Composer exposes fixed project context, real workspace model/mode scope and policy details. Rootless sessions offer new project conversation CTA without claiming all tools are disabled.
5. Approval cards show exact JSON arguments, target, project scope and one-request permission semantics. Lock submission, expose failures, retain durable resolved decisions in history.
6. Settings explicitly distinguish global provider storage, workspace activation/runtime management and session child inspection, saved state versus connection checks.
7. Shared responsive long-content/focus styling; regressions for lifecycle, creation validation, scope and approvals. Run full tests/typecheck/build/diff check, restart only dnt-harness, verify HTTP. Controller handles independent review and real browser acceptance.

Implementation status: steps 1–7 implemented and self-reviewed; browser/independent controller acceptance remains pending.

Final evidence: backend/frontend typecheck passed. Full suite passed 36 files / 313 tests with `npm test -- --maxWorkers=1` (77.12s), including 15 new workflow regressions. An earlier parallel run passed 312 tests before the last added regression; later parallel validation exposed the existing Bash process-tree timeout test leaving escaped-marker.txt. A repeat was contaminated by that marker; removed only the generated marker and ran all tests with one worker, without modifying backend code or assertions. This process-kill intermittency remains a separate backend investigation.
Production build passed: 345 modules, 1.81s; JS chunk 505.69 kB triggers Vite's 500 kB advisory. diff --check passed (CRLF conversion warnings only). Restarted only dnt-harness id 11, restart count 7 → 8, online; dsh-web stayed online at restart count 0. Root, built JS/CSS and /api/workspaces returned HTTP 200 on port 3082.
Configuration observation: read-only post-deploy API reports the sole Default workspace using kiro-go / auto, not the request's expected cliproxy / gpt5.5. No provider/model config was changed by this implementation or verification; controller should reconcile this mismatch rather than silently overwrite live configuration.
Controller handoff: independently inspect new-dialog cancel/create/double-click/navigation races, approval submitting/expiry flows, keyboard focus restoration, project-filtered history and responsive long arguments at 390/768/1440 widths. No browser or delegated review was available here. Full sequential test log is outside the repository at C:/Users/DungNguyen/workspace/dnt-harness-test-final.log.

Acceptance: no silent rootless creation; history filters do not change execution scope; lifecycle is event-grounded; permission buttons never grant broader scope; interrupted/failed outcomes have safe guidance; existing tests stay green and build is served on 3082.
Review result: approved for implementation; no server contract change needed. Creation uses existing createSessionIn; decisions use existing boolean answerApproval; model/mode remain workspace controls. Browser/delegation limitation explicitly retained.

## Relationship to the production design plan — 2026-09-11

This document is the preceding engineering baseline for lifecycle truthfulness, race handling, immutable project scope, approval semantics, and settings capability preservation. It is not evidence that production visual design, English product copy, responsive browser acceptance, or a mature design system is complete; the browser/independent-review limitations above remain historical facts. The follow-on plan is `plans/260911-1139-product-ui-standardization/plan.md`, with the repository audit and locked visual/content contract in `plans/260911-1139-product-ui-standardization/design-contract.md`.

## Contract
Deliver a coherent Sharp dark workspace and repair session lifecycle/onboarding UX. Preserve all existing dirty changes, user data, permissions and server API contracts. No fake chrome or invented backend features. No commit/reset/push.

## Scout
React 19 / TypeScript / Vite frontend, Vitest tests, TypeScript harness backend. Existing UI primitives in web/components/ui; shell/chat/settings styles share tokens. App owns workspace metadata, draft and navigation; useSessionStream projects SSE snapshots and approval frames. Existing docs/web.md and G1–G5 plans cover stable workspace/session/mode contracts. Proven defects: initial workspace load skips modes and lacks cancellation; draft cleared before POST succeeds; null stream stays connecting; approval frames append without reconciliation; desktop inspector ignores open; project form disappears after first project.

## Reviewed implementation plan
Self-reviewed against acceptance and existing contracts; independent specialist delegation unavailable in this tool surface.
- [x] Repair idle/reset/reconnect stream and approval lifecycle with four projection regressions.
- [x] Guard obsolete workspace metadata loads, load modes initially, preserve failed drafts, add explicit empty-session/project onboarding and inline errors.
- [x] Implement responsive shell scrims/close/Escape/focus boundaries and searchable provider-grouped selection using existing primitives; browser acceptance pending.
- [x] Apply shared typography across shell/chat/settings/management; expose transcript identities and expanded arguments.
- [x] Run tests/typecheck/build, self-review touched call sites and update docs/web.md.
- [ ] Independent specialist review and full desktop/mobile/settings browser acceptance: blocked by this subagent tool surface (no delegation tool; browser reports `Browser is not available in subagent`).
- [x] Build then explicitly restart only pm2 dnt-harness; HTTP root, workspace API and built JS/CSS respond 200.

## Verification evidence
Full suite: 34 files / 290 tests passed (30.89s), including four new approval projection tests. Typecheck passed for backend/frontend. Production build passed (341 modules). git diff --check passed with only existing line-ending conversion warnings. Service dnt-harness id 11 online; dsh-web untouched. No data changes, commits, pushes or resets.

## Handoff limits
Browser screenshots and interactive behavior are not verified here. Specialist review/testing delegation was not available. The review blockers below are implemented with helper/markup regressions; end-to-end delayed requests, focus interactions and popup layout still require controller browser acceptance. Do not claim complete acceptance until these are inspected in the controller browser.

## Review notes
Keep SSE wire formats unchanged. Reconcile approvals from durable request/decision/result events, with ephemeral deduplication. Never auto-retry accepted turns; failed POST must retain draft. Guard workspace async completions. Hidden drawers must not leave keyboard-focusable controls offscreen. Use actual model provider grouping rather than fabricated categorization.

## Remaining-blocker implementation — 2026-09-11
- [x] Desktop sidebar state defaults open at ≥1100px; desktop CSS honors closed state; normal desktop navigation no longer collapses it.
- [x] Workspace/session composer state isolates drafts, send locks and errors; acceptance checks edit revision rather than text equality.
- [x] Navigation generations guard create/delete/list completions and A → B → A navigation; metadata/control request tokens guard refresh races.
- [x] Select uses a body portal, viewport positioning, outside-target checks and nested Escape ownership. Modal dismissal uses a stable callback reference and only the top dialog handles keys.
- [x] Settings tabs support arrows/Home/End, roving tabindex, aria-controls and linked panels. Tab changes retain provider drafts; close/provider changes use ConfirmDialog. Busy provider operations prevent destructive navigation.
- [x] Drawer focus boundaries subscribe to media-query changes and yield Escape to popups/dialogs.
- [x] Eight production-helper regressions plus expanded settings accessibility markup assertions. No jsdom/happy-dom/react-test-renderer is installed; no browser used and no DOM interaction acceptance claimed.
- [x] Final full suite: 35 files, 298 tests passed, 35.28s; backend/frontend typecheck passed; production build 343 modules, 1.65s; diff --check passed (existing CRLF warnings only).
- [x] Restarted only dnt-harness (pm2 id 11, restart count 6 → 7, online). dsh-web remained online with restart count 0. HTTP root/workspace API returned 200.

One intermediate test run passed 298 assertions but exited nonzero due to an unhandled EPIPE in the existing MCP CPU-watchdog test (src/harness/mcp/client.ts:175). The final rerun passed without unhandled errors; that backend intermittent issue was not modified in this frontend pass. Existing dirty changes preserved; no commits/reset/push. Independent delegation unavailable; browser acceptance remains unchecked above.
