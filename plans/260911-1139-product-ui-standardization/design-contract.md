---
title: "Product UI audit and design contract"
description: "Repository-verified audit, information architecture, visual rules, content ownership, and pre-implementation design gate."
status: pending
created: 2026-09-11
source: "reference screenshot plus current dirty working tree"
---

# Product UI audit and design contract

## Summary

The latest source is functionally much stronger than the visual result: durable lifecycle, guarded creation, immutable project binding, approval detail, and full management capabilities exist. The UI still reads as an accumulated engineering console because ownership is duplicated, copy is bilingual, geometry is undersized, technical surfaces compete with prose, and settings repeat card/form patterns without one information architecture.

The supplied screenshot is useful for hierarchy: stable app bar, narrow navigation, centered work, optional context rail, compact disclosures, and high information density. It is not a feature specification. dnt-harness must not fabricate Git, terminal, marketplace, upload, repository branch, tab, or agent-monitoring chrome.

## Observed surface flaws

| Surface | Observation | Evidence | Contract response |
|---|---|---|---|
| Global shell | 42px app bar, 234px nav, 252px inspector; gradient logo | `web/styles/tokens.css:65-71`, `web/styles/shell.css:23-48` | 48/264/304; semantic surfaces; no gradient decoration |
| Workspace control | App bar and sidebar both switch workspace | `web/components/layout/TopBar.tsx:76-126`, `web/components/layout/Sidebar.tsx:93-97` | App bar only |
| Projects | Permanent raw path field in nav | `web/components/layout/Sidebar.tsx:104-121` | Workspace management reached from New Conversation |
| Conversation | Transcript width 900px and status/composer stack consume vertical space | `web/styles/chat.css:7-15`, `web/styles/chat.css:239-261`, `web/styles/chat.css:323-347` | Transcript/composer align at 760px; compact status and scope disclosures |
| Controls | Model editable in composer and inspector | `web/components/composer/Composer.tsx:95-113`, `web/components/layout/EnvPanel.tsx:90-105` | Composer editable; inspector read-only |
| Tool/thinking | Repeated bordered cards around secondary technical content | `web/styles/chat.css:72-132` | Compact disclosure rows; prose remains primary |
| Settings | Strong capability breadth but mixed-language labels and card-grid repetition | `web/components/settings/SettingsModal.tsx:24-30`, `web/components/settings/ManagementPanels.tsx:147-315`, `web/styles/settings-management.css:69-90` | Full-height grouped settings with explicit scope and operation parity |
| Language | Vietnamese document locale and extensive bilingual product copy | `web/index.html:1-10`, `web/App.tsx:39-43`, `web/components/chat/TaskStatus.tsx:1-12` | English product copy and `lang="en"`; preserve external/user data |
| Time | Event timestamps exist; session list omits summary times | `web/lib/types.ts:9-13`, `web/lib/types.ts:45-59`, `src/harness/session/service.ts:255-260` | Real timestamps only; additive listing contract if approved |
| Errors | API helper exposes raw `HTTP status: body` directly | `web/lib/api.ts:2-7` | Known product mapping + expandable raw detail; never hide unknown raw detail |

## Surface and state inventory

### App shell
- App bar: workspace switch/create, active conversation title, fixed project label, settings, nav/inspector toggles.
- Navigation: New Conversation, project history filter, search, conversation rows, stream footer.
- Main: task state, empty/onboarding, transcript, approvals, send error, composer.
- Inspector: session coordinates, effective controls, context manifest; optional and read-only.
- Dialogs: New Conversation, workspace/project management, delete confirmation.

### Conversation states
- No workspace data / workspace loading / workspace error.
- No conversation selected.
- Empty chat-only conversation.
- Empty project-bound conversation.
- Preparing/queued, running model, running tool, waiting approval.
- Completed, failed, interrupted, cancelled/stopped, rejected, empty, limit.
- SSE connecting/open/reconnecting independent of durable task state.
- Pending approval, submitting, failed submission, resolved durable decision.
- Send accepted, uncertain send failure with preserved draft.
- Recovered unknown tool outcome.

### Settings states
- Global providers: list/new/edit/dirty/save/test/sync/activate/enable/delete/error.
- Workspace agents: definitions, spawn packet, children running/terminal, wait/cancel, import/block report.
- Workspace MCP: empty/list/status/breaker, add/update, enable/disable/reconnect, import disabled.
- Workspace hooks: loading/editor/parse error/dirty/save/revert.
- Workspace secrets: empty/list/add/rotate/delete/reconnect result.
- No workspace/no current conversation limitations must be explicit without reducing capability.

## Information architecture

### Desktop textual wireframe

```text
┌──────────────────────────── App bar 48 ────────────────────────────┐
│ [Nav] [Workspace ▾]     Conversation title · Project      [Settings] [Inspector] │
├──── Navigation 264 ────┬──────────────── Workbench ────────────────┬─ Inspector 304 ─┤
│ New conversation       │ compact durable task state                │ Context             │
│ Projects (filter only) │                                           │ Effective model     │
│ Search                 │ transcript / prose max 760                │ Effective mode      │
│ Conversation history   │ compact thinking/tool disclosures         │ Policy / manifest   │
│                        │ approvals/errors when present              │ read-only           │
│ connection             │ composer max 760: mode · model · send     │                     │
└────────────────────────┴───────────────────────────────────────────┴─────────────────────┘
```

Inspector docks only at >=1360 and remains closed until requested. At 1024 and below both rails are overlays. At mobile widths, app-bar actions remain reachable, content uses 16px margins, and no horizontal scrolling occurs at 200% zoom.

### New Conversation textual wireframe

```text
New conversation
Workspace: <current, read-only in dialog>
Choose a project
  ○ Registered Project A   /path/a
  ○ Registered Project B   /path/b
  ○ Chat only              no project root
[Manage projects] -> workspace management surface
[Cancel] [Create conversation]
```

Workspace management contains registered projects, add/rename/remove actions supported by actual API, validation, overlap errors, and impact explanations. Do not leave a raw path control permanently in navigation.

### Settings textual wireframe

```text
Settings [full height]
Left navigation                         Main surface
GLOBAL                                  Header: group + scope badge
  Providers                             explanatory scope text
WORKSPACE                               grouped rows/forms, not card heap
  Agents                                complete operations
  MCP servers                           sticky action/footer where needed
  Hooks
  Secrets
SESSION
  Child agents (or nested under Agents with current-conversation scope)
```

Provider storage remains global; active model is workspace-scoped. Agent definitions/MCP/hooks/secrets are workspace-scoped. Child runtime is current-conversation-scoped. The UI must say when it is showing saved configuration versus runtime/connection state.

## Token contract

| Category | Required tokens |
|---|---|
| Surface | canvas, chrome, raised, inset, hover, selected, scrim |
| Text | primary, secondary, muted, inverse, link |
| Border | subtle, default, strong, focus |
| Intent | success, warning, danger, info, each with text/surface/border |
| Geometry | appbar 48, nav 264, inspector 304, content 760 |
| Spacing | 4, 8, 12, 16, 24, 32 |
| Radius | 6, 8, 10 only |
| Typography | UI 13px; body 14px/22px; mono 12/13px |
| Motion | 120-180ms; reduced-motion disables nonessential transitions |
| Target | 32px desktop; >=44px coarse pointer |

No component may introduce raw color, shadow, radius, or width constants except documented one-off media/layout values reviewed into the contract.

## English and content ownership

### Translate
- Product navigation, headings, labels, buttons, hints, validation, toasts, empty/loading/error states.
- ARIA labels, titles, placeholders, date locale, fallback names.
- Product-owned status/reason display names and built-in mode display names.
- Known backend errors when shown as product guidance.

### Preserve verbatim
- User/assistant/tool output and imported content.
- Project/workspace/provider/model/tool IDs and names.
- Paths, commands, arguments, URLs, secret names.
- Custom mode and custom agent names/descriptions unless user edits them.
- Raw backend error detail in expandable diagnostics.

### Glossary
- Conversation: durable user-facing thread. Technical `session` remains code/API vocabulary.
- Workspace: configuration and ownership boundary.
- Project: registered filesystem root within one workspace.
- Task state: temporary status of work inside a conversation, never a synonym for Conversation.
- Chat only: conversation without project binding; not necessarily the bundled Chat mode.

## Visual deliverables required before migration

High-fidelity, annotated designs at minimum:
1. Empty workspace/onboarding with New Conversation and project management.
2. Populated conversation with prose, thinking, multiple tool calls, and long output.
3. Pending approval plus failed/interrupted/error variants.
4. Settings Providers, Agents, MCP, Hooks, Secrets with scope annotations.
5. Mobile 375px conversation/nav/settings and tablet 768px variants.
6. Desktop 1440px with inspector closed and open.

Each design must label tokens, dimensions, control ownership, keyboard order, long-content behavior, and preserved safety semantics. Approval is a hard gate; implementation does not migrate feature surfaces before sign-off.

## Acceptance checklist

- Contrast 4.5:1 normal text; 3:1 large text and UI graphics.
- Widths: 320, 375, 768, 1024, 1440, 1920.
- 200% zoom without lost controls or two-dimensional scrolling.
- Keyboard-only navigation, visible focus, Escape ownership, focus restoration.
- Coarse-pointer targets >=44px.
- Screenshot comparison includes explicit reviewer question: “Does this look like stacked cards rather than one workbench?” Required answer: no.
- Copy audit exhaustive with reviewed allowlist.
- Mounted interactions and browser E2E validate behavior; helper-only tests are insufficient.

## Unresolved gates

- Human selection/approval of the Phase 2 visual direction.
- Whether to extend session listing with real `createdAt`/`updatedAt`; omit conversation timestamps until approved.
- Choice of browser/screenshot runner during Phase 8.

## Implemented reference and acceptance boundary

Representative HTML and PNGs: `assets/designs/product-ui-standardization/`. Production screenshot matrix: `artifacts/product-ui/screenshots/`. The implementing agent observed desktop reference, populated production and Providers screenshots. Human visual approval remains pending. No screenshot has been declared an approved baseline.

The runtime is now a neutral workbench with appbar48/nav264/inspector304 and content760, one workspace owner, full-height settings and compact prose-first transcript. Dates are optional and event-backed; empty summaries are deliberately excluded. Product copy inventory and preserve allowlist: `artifacts/product-ui/copy-inventory.json`. Test boundaries and limitations: `artifacts/product-ui/acceptance.json`.
