# Warm Studio Workbench Redesign — Design Specification

- **Date:** 2026-09-15
- **Status:** Approved
- **Scope:** React web client presentation and client-side projections only. Preserve all REST/SSE contracts and harness semantics.
- **Implementation plan:** `docs/superpowers/plans/2026-09-15-warm-studio-workbench-redesign.md`

## 1. Objective

Redesign mini-dsh as a warm, focused coding workbench with the approved arrangement:

1. global top bar;
2. left navigation containing projects and conversations;
3. central conversation column;
4. a visually elevated task/workbench surface associated with active tool/delegation work;
5. right panel with **Context** and **Artifacts** tabs;
6. composer fixed to the bottom of the conversation region.

The reference image governs information hierarchy and workspace arrangement only. The shipped visual language is **Warm Studio**: warm neutral surfaces, restrained terracotta accent, calm editorial density, and original mini-dsh component construction. It must not copy the reference's branding, colors, decoration, unsupported panes, or product-specific chrome.

## 2. Verified baseline

- `App` currently owns route/navigation state, workspace/session/project loading, per-conversation drafts, settings state, stream hookup, send/queue/stop, approval actions, and inspector wiring (`web/App.tsx:57-145`, `web/App.tsx:183-224`, `web/App.tsx:401-500`, `web/App.tsx:613-788`).
- Routes are limited to root, workspace, and workspace-session URLs; invalid or foreign session routes fail closed before SSE subscription (`web/lib/route.ts:1-45`, `web/App.tsx:141-145`, `web/App.tsx:386-399`).
- The durable event log remains the conversation source of truth. `useSessionStream` replaces state from snapshots, appends unseen sequenced events, reconciles approvals, and exposes connection state without treating reconnect as execution completion (`web/hooks/useSessionStream.ts:4-18`, `web/hooks/useSessionStream.ts:21-61`).
- `projectItems(events)` currently projects queued and accepted user messages, streamed/final assistant messages, tool calls/results, approvals, hooks, delegation, and turn outcomes (`web/lib/project.ts:54-65`, `web/lib/project.ts:66-253`). `isTurnRunning` and `taskPhase` derive lifecycle from durable events (`web/lib/project.ts:255-285`).
- Drafts and send errors are keyed by workspace/session; accepted requests clear only the submitted revision. First-message session creation is guarded against stale navigation (`web/lib/interaction.ts:1-17`, `web/App.tsx:114-121`, `web/App.tsx:401-450`).
- The composer already preserves IME handling, queueing during a running turn, stop, workspace model/mode/thinking/policy controls, and immutable scope after conversation creation (`web/components/composer/Composer.tsx:11-19`, `web/components/composer/Composer.tsx:43-80`, `web/components/composer/Composer.tsx:90-105`, `web/components/composer/Composer.tsx:106-270`).
- Approval submission has a synchronous per-request lock, keeps failures visible, and preserves one-request **Allow once**/**Deny** semantics; persistent allow remains a separate confirmed workspace-policy action (`web/components/chat/ApprovalBar.tsx:7-28`, `web/components/chat/ApprovalBar.tsx:29-52`, `web/components/chat/ApprovalBar.tsx:53-93`).
- Settings protects provider dirty drafts and blank-key retention (`web/components/settings/SettingsModal.tsx:64-76`, `web/components/settings/SettingsModal.tsx:157-190`, `web/components/settings/SettingsModal.tsx:231-264`). Skills and memory use `expectedHash` conflict handling through existing APIs (`web/lib/api.ts:375-441`).
- Current CSS is split across six broad hand-written stylesheets imported globally (`web/main.tsx:11-17`); the largest are `chat.css`, `shell.css`, and settings styles. Existing isolated inline style use is limited to textarea auto-height, portaled popup geometry, and manifest budget width (`web/components/composer/Composer.tsx:82-88`, `web/components/ui/Menu.tsx:109-123`, `web/components/layout/EnvPanel.tsx:133-144`).
- Current browser coverage already includes the required width list, accessibility checks, route validation, draft preservation, approval safety, settings operations, drawers, and coarse targets, but it is concentrated in one fixture-heavy spec and does not yet cover the new resizers, right-panel tabs, Artifacts mapping, or reduced-motion behavior (`tests/browser/workbench.e2e.ts:102-144`, `tests/browser/workbench.e2e.ts:146-210`, `tests/browser/workbench.e2e.ts:212-297`).
- Tailwind CSS, Radix UI, CVA, `clsx`, and `tailwind-merge` are not currently declared (`package.json:20-42`).

## 3. Locked product and scope constraints

1. Product-owned UI copy remains English. User messages, assistant content, project/workspace/provider/model/tool names, paths, commands, imported content, and raw diagnostics remain verbatim.
2. Preserve all current REST routes, request/response shapes, SSE envelopes, durable event semantics, workspace/project/session ownership, and approval transport. No backend contract is added or changed.
3. Preserve the `projectItems` transcript projection and its semantics. New workbench/artifact projections may derive from the same immutable event array but must not mutate, reorder, reinterpret, or replace `projectItems`.
4. Preserve routing, stale-generation guards, drafts, first-send session creation, queueing, stop, reconnect, running-turn truth, approval locks, settings dirty state, and optimistic conflict behavior.
5. Context and Artifacts are read-only projections over data already available to the client. Do not build a file editor, file tree, terminal, diff viewer, repository browser, attachment system, or new server endpoint.
6. Desktop left and right panels are independently resizable and collapsible. Width/collapse preference is local presentation state only. Tablet/mobile use modal drawers rather than squeezed docked panels.
7. Use Tailwind CSS for layout and styling, Radix UI for accessible interactive primitives, and CVA for variant contracts. Remove ad-hoc component/manual CSS.
8. Retain narrowly scoped CSS only for root/reset, markdown and syntax highlighting, animations/reduced-motion behavior, and scrollbar rules when equivalent utilities are unsuitable.
9. Preserve the dirty worktree. Implementation must inspect diffs before each task; never reset, stash, delete, rename, overwrite, or format unrelated user changes.
10. No commit step is part of this work unless the user separately authorizes commits.

## 4. Information architecture

### 4.1 Global top bar

The top bar spans the viewport and remains the only workspace switch/manage owner. It contains:

- left navigation toggle;
- mini-dsh wordmark;
- workspace switcher and existing workspace status/approval indicators;
- right-panel toggle;
- settings entry.

Conversation identity stays in the selected navigation row; no duplicate center title. Existing workspace management actions remain available through the current popover behavior.

### 4.2 Left navigation

The left region owns:

- New conversation;
- conversation search;
- project sections and project-bound conversation rows;
- unbound conversation history;
- live running/queued states;
- connection/notification footer.

Desktop behavior:

- default width: **280px**;
- allowed range: **232–420px**;
- resizer uses Pointer Events and keyboard adjustments;
- collapse leaves only the top-bar reopen control;
- width and collapsed state persist in `localStorage` under versioned UI preference keys.

Tablet/mobile behavior:

- at viewport `< 1024px`, navigation is a Radix Dialog drawer;
- width preference is retained but does not determine drawer width;
- drawer closes on selection, scrim, close action, or Escape;
- focus is trapped and restored by Radix.

### 4.3 Conversation and workbench center

The center region is the primary reading and working axis. It contains:

- lifecycle/status strip;
- transcript;
- active workbench surface;
- approvals and send errors;
- fixed composer dock.

The transcript remains prose-first and event-derived. The workbench surface is not a new execution environment. It is a raised presentation of existing active or recent tool/delegation items:

- while a tool or delegated child is running, show its name, target/summary, state, elapsed/recorded duration when available, and disclosure control;
- after completion, keep the normal transcript row as durable history and allow the elevated surface to settle to the most recent actionable work item;
- raw arguments/output remain the same escaped event data already exposed by transcript disclosures;
- no command input, terminal emulation, file editing, or invented progress percentage.

Desktop geometry:

- conversation reading measure remains approximately **760px**;
- workbench surface may widen to **960px** within the center region for structured output;
- composer is fixed/sticky at the bottom of the center region, not the viewport-wide shell;
- transcript receives bottom padding equal to the composer dock height so content is never obscured.

### 4.4 Right Context/Artifacts panel

Desktop behavior:

- default width: **336px**;
- allowed range: **280–520px**;
- docked at viewport `>= 1280px` when open;
- independently resizable/collapsible with local preference persistence.

Tablet/mobile behavior:

- below `1280px`, opens as a right-side Radix Dialog drawer;
- at small mobile widths, drawer occupies the usable viewport width with safe margins;
- active tab persists locally, but opening always reflects the current conversation.

Tabs use Radix Tabs:

#### Context

Retains current read-only data and compaction behavior:

- conversation id, event count, stream state;
- effective provider, model, mode, and project folder;
- last request manifest, context budget, history, tools, skills, memory, omissions;
- confirmed manual compaction, disabled while a turn runs.

Manifest fetching remains lazy: only while the right panel is open, Context is selected, a valid conversation exists, and the turn is settled. This tightens the current `envOpen` condition without changing the endpoint (`web/App.tsx:359-378`, `web/lib/api.ts:338-373`).

#### Artifacts MVP

Artifacts are a client-only projection from existing `SseEvent` tool data. Define a separate pure projector, `projectArtifacts(events)`, returning read-only rows without changing `projectItems`.

| Existing event data | Artifact row | Display rule | Explicit limitation |
|---|---|---|---|
| `tool/call.call.args.path` or `tool/call.call.args.file_path` | File reference | Show exact path, tool name, pending/succeeded/failed/recovered state, recorded timestamp/duration | Path reference only. Do not claim file existence, type, diff, or content. |
| Other non-empty string path-like tool arguments | Resource reference | Show exact argument key/value and originating tool | Treat as an opaque reference; do not infer repository ownership. |
| `tool/call` + matching `tool/result.output` | Tool output | Expandable escaped text labeled “Recorded tool output” | Output is tool output, not a file preview. Do not label it file content. |
| Bash/Shell call with `args.command` + result | Command record | Show exact command, outcome, and expandable recorded output | Read-only history, not a terminal and not re-runnable. |
| `tool/result.recovery === true` | Recovered/unknown row | Amber unknown-outcome state and existing recovery warning | Never display success/failure certainty. |
| No qualifying tool call/result data | Empty state | “No recorded artifacts for this conversation yet.” | Do not synthesize placeholders or fetch new data. |

Deduplicate by durable tool `call.id`. Pair results by `callId`. Preserve event order. A tool call with no result stays pending. Unknown argument shapes remain available through the existing transcript disclosure, but the Artifacts tab does not guess a row type.

Delegation file lists (now `result.filesTouched`, formerly `fileReferences`; the child's final message is `result.report`, formerly `summary`) are not included in this MVP because the durable event mirror does not expose them; they currently arrive only from the child-result REST payload when a delegation card is expanded (`web/components/chat/MessageParts.tsx`, `web/lib/types.ts` `ChildRow`). Adding them to Artifacts would require extra fetching/state or a backend projection and is out of scope.

## 5. Warm Studio visual system

### 5.1 Direction

- Warm neutral canvas, paper-like elevated surfaces, dark brown/charcoal text.
- Terracotta is the single brand/action accent; status colors remain semantic and subdued.
- Soft borders and controlled shadows communicate layer depth.
- Rounded geometry is functional, not decorative.
- No gradients, neon effects, glossy cards, imitation terminal chrome, decorative repository stats, or copied reference ornament.

### 5.2 Token contract

Tailwind theme tokens use semantic names rather than direct component colors:

- `canvas`: warm off-white;
- `surface`: neutral cream;
- `surface-raised`: lighter workbench/composer surface;
- `surface-muted`: subdued navigation/context surface;
- `ink`, `ink-muted`, `ink-faint`;
- `border`, `border-strong`;
- `accent`, `accent-hover`, `accent-soft`, `accent-ink`;
- semantic `success`, `warning`, `danger`, and corresponding soft surfaces;
- widths/heights for top bar, reading column, and panel ranges;
- radii and shadows with a small fixed scale.

Concrete contrast-adjusted values are encoded once in Tailwind theme CSS and verified by tests. `web/index.html` theme color and favicon colors are updated to the same palette.

### 5.3 Typography

Retain bundled Instrument Sans and JetBrains Mono initially (`web/main.tsx:2-7`). Use:

- Instrument Sans for UI and prose;
- JetBrains Mono for paths, IDs, commands, code, durations, and diagnostics;
- 13–14px UI text, 15px transcript prose, line-height 1.65–1.75;
- clear hierarchy through weight/spacing before color.

### 5.4 CSS boundary

Allowed retained CSS files:

- `web/styles/app.css`: Tailwind import/theme, root sizing, minimal reset, color-scheme;
- `web/styles/markdown.css`: markdown element rules and highlight.js token selectors;
- `web/styles/motion.css`: keyframes, reduced-motion overrides, and scrollbar styling.

Component geometry, spacing, state, responsive behavior, typography, colors, borders, shadows, and variants live in Tailwind utility classes and CVA definitions. Runtime geometry may use CSS custom properties set from React for panel widths, popup coordinates, textarea height, and budget percentage; static visual declarations may not return to inline style objects.

## 6. Component architecture

### 6.1 Foundation

- `cn(...inputs)` combines `clsx` and `tailwind-merge`.
- CVA owns variants for Button, IconButton, Badge, Chip, field controls, notices, panel surfaces, and status indicators.
- Radix primitives replace hand-built interaction mechanics:
  - Dialog for modal/settings/drawers/confirmations;
  - DropdownMenu for action menus;
  - Popover for workspace/policy controls;
  - Tabs for Context/Artifacts;
  - Tooltip for icon-only explanations;
  - Collapsible for project groups and transcript/workbench disclosures;
  - Separator/ScrollArea where appropriate.
- Existing domain components continue to receive explicit data/callback props; Radix state does not own domain state.

### 6.2 Shell boundaries

`App.tsx` remains orchestration-only and is split into focused presentation/state helpers:

- `WorkbenchShell`: responsive grid/drawer composition;
- `NavigationPanel`: projects/conversations;
- `ConversationSurface`: status, transcript, workbench, approvals, errors, composer dock;
- `InspectorPanel`: Context/Artifacts tabs;
- `useWorkbenchPreferences`: local panel width/collapse/tab persistence;
- `useResizablePanels`: pointer and keyboard resize behavior with clamping.

`App.tsx` continues to own server-backed state, routing generations, and command callbacks. New hooks own only UI preferences and pointer mechanics.

### 6.3 Preference model

```ts
interface WorkbenchPreferencesV1 {
  readonly leftWidth: number
  readonly rightWidth: number
  readonly leftCollapsed: boolean
  readonly rightCollapsed: boolean
  readonly inspectorTab: 'context' | 'artifacts'
}
```

Rules:

- storage key: `mini-dsh.workbench.v1`;
- validate every parsed field and clamp widths;
- malformed/unavailable storage falls back silently to defaults;
- preferences are browser-local, not workspace/session data;
- narrow viewport drawers do not rewrite collapse preferences merely because docking is unavailable.

## 7. Data flows

### 7.1 Bootstrap and navigation

`window.location.pathname` → `parseRoute` → workspaces → active workspace → parallel sessions/projects/meta/modes load → validate requested session membership → open workspace-scoped SSE only for validated session → navigation renders project/conversation projection.

No redesign component may bypass the membership gate or open an SSE URL directly.

### 7.2 Conversation rendering

Workspace/session SSE → `useSessionStream` snapshot/live reconciliation → immutable `events` + pending approvals + stream state →

- `projectItems(events)` → transcript;
- `taskPhase(events, approvals, sending)` / `isTurnRunning(events)` → lifecycle and controls;
- `projectArtifacts(events)` → right Artifacts tab;
- `latestWorkbenchItem(projectItems(events))` → elevated workbench presentation.

All projectors are pure and deterministic. They do not fetch, mutate events, or manufacture timestamps/results.

### 7.3 Send, queue, stop, and reconnect

Composer draft → existing eligibility and scope validation → optional session creation → `sendMessageIn` with request id → draft clears only after acceptance and unchanged revision → durable queued/user/turn events update projection. During running turns, Enter queues via the same endpoint. Stop uses the existing stop endpoint. SSE reconnect changes only connection presentation; durable events determine whether work is still running.

### 7.4 Approval

SSE approval envelope/durable request → reconciliation → ordered approval cards above composer → synchronous request lock → existing approval POST → durable decision/event reconciliation. Persistent allow remains policy PUT followed by approval answer only after explicit confirmation.

### 7.5 Context and artifacts

Right panel open + valid conversation:

- Context selected and settled → delayed existing manifest GET → context render;
- Artifacts selected → local `projectArtifacts(events)` only → no request;
- panel closed → no manifest request and no background artifact work beyond memoized projection.

### 7.6 Settings

Settings open → existing provider/global and workspace-scoped panel APIs. Provider drafts remain seeded once per open and guarded on leave. Blank key on existing provider remains omission, not deletion. Skills/memory writes retain expected-hash conflicts with explicit reload/overwrite paths.

## 8. Responsive and interaction behavior

| Width | Left navigation | Center | Right panel |
|---|---|---|---|
| 1280+ | Docked, resizable, collapsible | Flexible; transcript 760px, workbench up to 960px | Docked when open, resizable, collapsible |
| 1024–1279 | Docked, resizable, collapsible | Flexible | Drawer |
| 768–1023 | Drawer | Full available width | Drawer |
| 320–767 | Full-height drawer with safe inset | Single column; composer dock wraps controls | Full-height drawer with safe inset |

Resizer requirements:

- separator role with orientation and `aria-valuemin/max/now`;
- 1px visual rule with at least 12px hit target;
- Arrow keys adjust by 8px; Shift+Arrow adjusts by 32px;
- Home/End clamp to min/max;
- double-click restores default width;
- pointer capture prevents dropped drags;
- text selection is suppressed only during an active drag;
- reduced motion disables animated panel transitions, not direct resize feedback.

Layer/Escape order remains one layer per press: nested menu/popover → confirmation/settings dialog → right drawer → left drawer. Focus returns to the opener.

## 9. Accessibility requirements

- WCAG 2.2 AA target for contrast, focus, names, roles, and keyboard operation.
- Every icon-only control has an accessible name and tooltip where useful.
- Radix Dialog provides modal semantics, focus trap, Escape, and restoration; tests verify integration rather than assuming defaults.
- Radix Tabs supports arrow-key tab movement and linked tabpanels.
- Resizers are keyboard-operable separators.
- Status is not conveyed by color alone.
- Running/reconnecting updates do not create repetitive live-region announcements.
- Touch targets are at least 44×44 CSS pixels on coarse pointers.
- At 320px there is no horizontal document overflow; long paths/commands/output scroll or wrap within their own boundaries.
- `prefers-reduced-motion: reduce` removes nonessential transition/animation while preserving state visibility.

## 10. Migration strategy

Vertical slices, each preserving a usable app:

1. **Foundation:** dependencies, Tailwind/Vite integration, semantic theme, `cn`, CVA/Radix primitives, preference/resizer utilities.
2. **Shell:** top bar, responsive dock/drawers, collapsible/resizable panels, navigation migration.
3. **Transcript/workbench:** preserve `projectItems`; migrate transcript and add elevated projection of existing work items.
4. **Composer/approval:** fixed composer dock, queue/stop/control parity, approval safety parity.
5. **Context/artifacts:** tabbed right panel, lazy Context, pure Artifacts MVP mapping and empty state.
6. **Settings:** Radix/Tailwind presentation while preserving all dirty/conflict semantics.
7. **Cleanup/verification:** remove obsolete manual CSS/primitives only after caller inventory reaches zero; update docs and run full matrix.

No big-bang stylesheet deletion. During migration, old CSS may coexist only for components not yet converted. Each phase removes the selectors/files it fully replaces.

## 11. Backwards compatibility and rollback

- No persisted domain data migration.
- No REST/SSE compatibility change.
- Existing local keys (`mini-dsh.scope.<workspace>`, approval notification preference) remain unchanged (`web/App.tsx:91-103`, `web/hooks/useApprovalNotify.ts:8-67`).
- New workbench preference key is additive and disposable; old clients ignore it.
- Rollback is phase-local: restore the prior presentation components/styles and remove the additive preference reader. Server state, logs, routes, drafts, settings records, and approvals remain valid.
- Dependency rollback occurs only after no converted file imports Tailwind/Radix/CVA helpers.
- If a vertical slice fails semantic parity, revert that slice rather than patching domain behavior into presentation code.

## 12. Test matrix

| Layer | Required coverage |
|---|---|
| Unit | preference parse/clamp/fallback; resizer math; `projectArtifacts` ordering/dedup/result pairing/recovery/empty behavior; workbench-item selection; CVA variant contracts; route/project/task projection regressions |
| Mounted integration | Radix dialogs/drawers focus; tabs; collapsibles; composer IME/send/queue/stop; approval double-submit/failure; Context lazy fetch conditions; settings dirty leave and expected-hash conflicts |
| API integration | Existing server suites remain green; assert no new endpoint or changed body is required by redesigned client |
| E2E viewport | 320, 375, 768, 1024, 1440, 1920; no document overflow; dock/drawer breakpoint behavior; composer visibility; left/right collapse and resize persistence |
| E2E workflows | empty/new conversation, routed conversation, invalid deep link, running turn, reconnect snapshot/live recovery, queued follow-up, stop, pending approval, right tabs, artifact empty/data states, settings operations/conflicts |
| Accessibility | axe WCAG A/AA/2.1 AA scan for workbench and every settings section; keyboard-only traversal; focus restoration; separator semantics; coarse targets |
| Motion | reduced-motion emulation; no nonessential animation; running state remains understandable |
| Visual | screenshots at every required width for empty, populated/running, approval, Context, Artifacts, and settings states; verify Warm Studio originality and no reference-copy artifacts |

Required final commands:

```bash
npm test -- --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run build:web
npm run test:browser
```

Expected: all exit 0; Playwright produces no unexpected horizontal overflow, accessibility violation, focus failure, or failed screenshot workflow.

## 13. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation / failure signal / response |
|---|---|---|---|
| Presentation rewrite breaks durable semantics | Medium | High | Freeze behavior tests before migration. Signal: changed REST body, duplicate/missing projected item, wrong running state. Response: revert slice and restore existing callback/projector path. |
| Resizers make layout inaccessible or unstable | Medium | High | Pure clamp math + separator keyboard tests + pointer capture. Signal: width outside bounds, stuck selection, missing focus. Response: disable persistence/animation and restore default width while fixing hook. |
| Fixed composer obscures transcript/approvals | Medium | High | Measured dock spacer and viewport E2E at all widths/states. Signal: last item or approval not scrollable above dock. Response: restore in-flow composer for affected breakpoint until corrected. |
| Artifact panel overstates available data | Medium | High | Strict mapping table and neutral labels. Signal: UI says “file content/diff” without a specific existing payload. Response: relabel/remove row; never add a fetch/endpoint in this scope. |
| Radix conversion changes dirty/conflict behavior | Medium | High | Keep state/callback code; swap shell only; mounted conflict/leave tests. Signal: silent draft loss or overwrite. Response: restore old settings container around unchanged form logic. |
| Tailwind migration leaves duplicate style authority | High | Medium | Selector/import inventory after every slice. Signal: manual CSS selector still controls a converted component. Response: remove obsolete selector before slice completion. |
| Dirty worktree causes user-change loss | High | High | Read before edit, inspect scoped diff, never reset/stash/delete unrelated files. Signal: unrelated path appears in task diff. Response: stop immediately and isolate only intended hunks. |
| Warm palette fails contrast | Medium | High | Token contrast checks + axe/manual focus review. Signal: <4.5:1 text or <3:1 UI boundary. Response: adjust semantic token once, not per component. |
| Browser storage unavailable/corrupt | Low | Medium | Defensive parse/write and defaults. Signal: exception or NaN width. Response: ignore stored value and continue with defaults. |

## 14. Acceptance criteria

- [ ] Approved six-region workbench arrangement is present without copied visual branding/chrome.
- [ ] Warm Studio palette uses warm neutrals and restrained terracotta with verified contrast.
- [ ] Desktop left/right panels resize, collapse, restore defaults, and persist valid preferences locally.
- [ ] Tablet/mobile panels are accessible drawers with correct focus/Escape behavior.
- [ ] Transcript remains generated by unchanged `projectItems` semantics.
- [ ] Workbench surface displays only existing tool/delegation data and adds no execution affordance.
- [ ] Composer stays visible at the bottom without covering transcript, approvals, or errors.
- [ ] Queueing, stop, reconnect/running truth, drafts, routing, and first-send creation remain unchanged.
- [ ] Approval actions retain synchronous lock and exact one-request safety semantics.
- [ ] Context remains read-only and lazily fetched; compaction keeps its existing confirmation/running guard.
- [ ] Artifacts follows the MVP mapping and exact empty state; no file content/diff/editor claim is made.
- [ ] Settings retains provider dirty/blank-key behavior and skills/memory conflict behavior.
- [ ] Tailwind + Radix + CVA are the component styling/interaction foundation.
- [ ] Manual CSS remains only in the narrow allowed files.
- [ ] E2E passes at 320/375/768/1024/1440/1920, including accessibility, keyboard/focus, reduced motion, reconnect/running turn, drawers, resizers, and settings states.
- [ ] Full test, typecheck, build, and browser commands exit 0.
- [ ] No implementation outside intended files is overwritten; no reset, stash, deletion of unrelated changes, or commit occurs.

## 15. Open questions

None. The design and scope are approved.