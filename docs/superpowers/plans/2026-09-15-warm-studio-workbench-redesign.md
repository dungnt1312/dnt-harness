# Warm Studio Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the existing dnt-harness web client as the approved Warm Studio coding workbench while preserving every current route, REST/SSE contract, event projection, draft/queue/stop flow, approval guard, and settings safety behavior.

**Architecture:** Execute a serial vertical-slice migration: establish Tailwind/Radix/CVA foundations, migrate the responsive shell, then transcript/workbench, composer/approvals, Context/Artifacts, settings, and finally remove obsolete CSS. `App.tsx` remains the server-state and routing orchestrator; new hooks/components own only presentation state, panel geometry, and read-only projections from the existing durable event array.

**Tech Stack:** React 19 · TypeScript 5.9 strict · Vite 6 · Tailwind CSS 4 with `@tailwindcss/vite` · Radix UI React primitives · class-variance-authority · clsx · tailwind-merge · Vitest/jsdom · Playwright · axe-core.

**Spec:** `docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md`

## Global Constraints

- Work only in `C:\Users\DungNguyen\workspace\dnt-harness`.
- The worktree is already very dirty with user changes. Before each task run `git status --short` and `git diff -- <task-owned paths>`; never reset, stash, clean, delete, overwrite, or mass-format unrelated changes.
- Do not commit. This plan intentionally contains no commit steps.
- Product-owned copy remains English. Preserve user/assistant text, names, identifiers, paths, commands, imported content, custom mode names, and raw diagnostics verbatim.
- Preserve all REST/SSE contracts and server behavior. `web/lib/api.ts` and `web/lib/types.ts` may receive client-only types/helpers only when listed; do not add an endpoint or change request/response bodies.
- Preserve `projectItems(events)` behavior (`web/lib/project.ts:54-65`, `web/lib/project.ts:66-253`), routing validation (`web/App.tsx:141-145`, `web/lib/route.ts:17-45`), draft acceptance (`web/lib/interaction.ts:8-17`, `web/App.tsx:401-450`), queue/stop/reconnect, approval submission locks (`web/components/chat/ApprovalBar.tsx:23-52`), and settings dirty/conflict behavior (`web/components/settings/SettingsModal.tsx:157-190`, `web/lib/api.ts:375-441`).
- Context/Artifacts render existing data only. Do not build an editor, file tree, terminal, diff viewer, repository browser, upload flow, rerun action, or backend contract.
- Tailwind utilities + CVA own component visuals. Radix owns accessible overlays/tabs/collapsibles/menus. Retained manual CSS is limited to `web/styles/app.css`, `web/styles/markdown.css`, and `web/styles/motion.css`.
- Runtime CSS variables are allowed only for values that are truly dynamic: panel widths, popup geometry if Radix cannot own it, textarea measured height, and budget percentage.
- Type-only imports use `import type`; imports retain explicit `.ts`/`.tsx` extensions where local code already does so.
- Every task must finish with its targeted tests passing before the next task starts.

## File Structure and Ownership Map

No two subagents may edit the same file concurrently. Tasks are serial by default. A worker receives only its task-owned paths plus read-only access to dependencies.

### Create

| File | Responsibility | Owner task |
|---|---|---|
| `web/lib/cn.ts` | `clsx` + `tailwind-merge` helper | 1 |
| `web/lib/workbench-preferences.ts` | Versioned local preference schema, parse, clamp, serialize | 1 |
| `web/lib/workbench-preferences.spec.ts` | Preference unit tests | 1 |
| `web/hooks/useWorkbenchPreferences.ts` | Browser-local preference state/persistence | 1 |
| `web/hooks/useResizablePanel.ts` | Pointer/keyboard panel resizing | 1 |
| `web/hooks/useResizablePanel.spec.tsx` | Resizer hook interaction tests | 1 |
| `web/components/ui/ResizableSeparator.tsx` | Accessible separator control | 1 |
| `web/components/ui/TooltipProvider.tsx` | App-wide Radix tooltip provider | 1 |
| `web/components/layout/WorkbenchShell.tsx` | Desktop grid and mobile drawer composition | 2 |
| `web/components/layout/InspectorPanel.tsx` | Right panel frame and Context/Artifacts tabs | 5 |
| `web/components/layout/ContextPanel.tsx` | Existing context/manifest/compaction presentation | 5 |
| `web/components/artifacts/artifact-projector.ts` | Pure existing-event-to-artifact mapping | 5 |
| `web/components/artifacts/artifact-projector.spec.ts` | Artifact mapping tests | 5 |
| `web/components/artifacts/ArtifactsPanel.tsx` | Read-only artifact list and empty state | 5 |
| `web/components/chat/WorkbenchSurface.tsx` | Elevated active/recent tool/delegation presentation | 3 |
| `web/components/chat/workbench-projector.ts` | Select active/recent workbench item from `ViewItem[]` | 3 |
| `web/components/chat/workbench-projector.spec.ts` | Workbench selection tests | 3 |
| `web/styles/app.css` | Tailwind import/theme, root/reset | 1 |
| `web/styles/markdown.css` | Markdown and highlight.js selectors | 3 |
| `web/styles/motion.css` | Keyframes, scrollbar, reduced motion | 1 |
| `tests/browser/warm-studio-shell.e2e.ts` | Width/drawer/resizer/preference/visual coverage | 2, then 7 final extension |
| `tests/browser/warm-studio-workflows.e2e.ts` | Conversation/approval/context/artifact/settings workflows | 3–6 serial extension |

### Modify

| File | End-state responsibility | Owner task(s), serialized |
|---|---|---|
| `package.json` | Add UI dependencies; preserve scripts except explicit test additions | 1 |
| `package-lock.json` | Lock dependency graph | 1 |
| `vite.config.ts` | Add Tailwind Vite plugin | 1 |
| `web/main.tsx` | Providers and three allowed CSS imports | 1, 7 |
| `web/index.html` | Warm theme metadata/favicon | 1 |
| `web/App.tsx` | Existing data/routing orchestration + new shell composition; no domain rewrite | 2, 3, 4, 5, 6 serially |
| `web/components/common/Icon.tsx` | Any missing panel/resizer/tab icons | 2 |
| `web/components/ui/Button.tsx` | CVA button primitive | 1 |
| `web/components/ui/IconButton.tsx` | CVA icon button + Radix tooltip integration | 1 |
| `web/components/ui/Badge.tsx` | CVA badge | 1 |
| `web/components/ui/Chip.tsx` | CVA chip | 1 |
| `web/components/ui/Field.tsx` | Tailwind field composition | 1 |
| `web/components/ui/TextInput.tsx` | Tailwind input variants | 1 |
| `web/components/ui/Select.tsx` | Radix Select or approved Radix menu composition | 1 |
| `web/components/ui/Menu.tsx` | Radix DropdownMenu wrapper | 1 |
| `web/components/ui/Modal.tsx` | Radix Dialog wrapper | 1 |
| `web/components/ui/Segmented.tsx` | CVA segmented control | 1 |
| `web/components/ui/Switch.tsx` | Radix Switch + CVA | 1 |
| `web/components/ui/ui.spec.tsx` | Primitive contracts and accessibility structure | 1 |
| `web/components/layout/TopBar.tsx` | Global controls only | 2 |
| `web/components/layout/Sidebar.tsx` | Navigation drawer/docked panel | 2 |
| `web/components/layout/WorkspacePopover.tsx` | Radix popover/menu migration | 2 |
| `web/components/session/SessionList.tsx` | Warm navigation rows and Radix collapsibles | 2 |
| `web/components/chat/Transcript.tsx` | Transcript + workbench placement | 3 |
| `web/components/chat/MessageParts.tsx` | Tailwind message/tool/delegation/audit/status views | 3 |
| `web/components/chat/ThinkingPanel.tsx` | Radix Collapsible disclosure | 3 |
| `web/Markdown.tsx` | Tailwind structure classes; preserve sanitization/highlighting | 3 |
| `web/components/composer/Composer.tsx` | Fixed dock content; preserve send/queue/stop/IME | 4 |
| `web/components/composer/ModelMenu.tsx` | Radix menu styling/behavior parity | 4 |
| `web/components/composer/ThinkingMenu.tsx` | Radix menu styling/behavior parity | 4 |
| `web/components/composer/PolicyPopover.tsx` | Radix popover; preserve dirty/save semantics | 4 |
| `web/components/composer/FolderPickerModal.tsx` | Radix Dialog styling/keyboard parity | 4 |
| `web/components/chat/ApprovalBar.tsx` | Dock-safe approval cards; preserve lock and scope copy | 4 |
| `web/components/chat/TaskStatus.tsx` | Warm status strip; preserve durable-state copy | 4 |
| `web/components/layout/EnvPanel.tsx` | Temporary source for extraction, then deleted in Task 5 | 5 |
| `web/components/settings/SettingsModal.tsx` | Radix/Tailwind settings shell; preserve provider state | 6 |
| `web/components/settings/ManagementPanels.tsx` | Tailwind management panels; preserve conflicts and operations | 6 |
| `web/components/settings/ProjectsPanel.tsx` | Tailwind project management | 6 |
| `web/components/settings/management.spec.tsx` | Management operation parity | 6 |
| `web/components/settings/scope-race.spec.tsx` | Scoped async/reset behavior | 6 |
| `web/lib/product-ui.spec.tsx` | Cross-surface semantic regression tests | 1–6 serially |
| `web/lib/workflow.spec.tsx` | Durable workflow regression tests | 3–5 serially |
| `tests/browser/workbench.e2e.ts` | Keep existing regression fixture until split is proven; trim duplication in Task 7 | 7 |
| `docs/design-guidelines.md` | Replace old dark visual contract with Warm Studio contract | 7 |
| `docs/design-system.md` | Update component construction contract | 7 |
| `docs/web.md` | Document final shell/data/artifact behavior | 7 |

### Delete only in Task 7 after zero-import/zero-selector verification

- `web/components/layout/EnvPanel.tsx`
- `web/styles/base.css`
- `web/styles/tokens.css`
- `web/styles/ui.css`
- `web/styles/shell.css`
- `web/styles/chat.css`
- `web/styles/settings.css`
- `web/styles/settings-management.css`

Do not delete unrelated untracked `.tsxn`, `.cssn`, artifact, asset, or documentation files. They pre-exist in the dirty tree and are outside this plan.

## Dependency Graph and Execution Boundaries

```text
Task 1 Foundation
  └─ Task 2 Shell/navigation
       └─ Task 3 Transcript/workbench
            └─ Task 4 Composer/approval
                 └─ Task 5 Context/artifacts
                      └─ Task 6 Settings
                           └─ Task 7 Cleanup/full verification
```

- Tasks 1–7 are serial because `web/App.tsx`, `web/main.tsx`, cross-surface tests, and migration CSS overlap.
- Within Task 5, the pure artifact projector and the Context panel extraction may be assigned to separate subagents only if neither edits `web/App.tsx`, `InspectorPanel.tsx`, or the same test file; a lead integrates after both pass.
- Task 7 cannot start until all converted components have no dependency on legacy class selectors.

---

### Task 1: Foundation — Tailwind, Radix, CVA, Preferences, and Resizers

**Files:**
- Modify: `package.json:10-42`, `package-lock.json`, `vite.config.ts:1-11`, `web/main.tsx:1-27`, `web/index.html:1-16`
- Create: `web/lib/cn.ts`, `web/lib/workbench-preferences.ts`, `web/lib/workbench-preferences.spec.ts`, `web/hooks/useWorkbenchPreferences.ts`, `web/hooks/useResizablePanel.ts`, `web/hooks/useResizablePanel.spec.tsx`, `web/components/ui/ResizableSeparator.tsx`, `web/components/ui/TooltipProvider.tsx`, `web/styles/app.css`, `web/styles/motion.css`
- Modify: listed `web/components/ui/*.tsx`, `web/components/ui/ui.spec.tsx`

**Interfaces:**
- Consumes: React/Vite entry (`web/main.tsx:1-27`), existing popup/focus primitives (`web/components/ui/Menu.tsx:4-29`, `web/components/ui/Modal.tsx:8-24`).
- Produces:

```ts
export function cn(...inputs: ClassValue[]): string

export interface WorkbenchPreferencesV1 {
  readonly leftWidth: number
  readonly rightWidth: number
  readonly leftCollapsed: boolean
  readonly rightCollapsed: boolean
  readonly inspectorTab: 'context' | 'artifacts'
}

export const WORKBENCH_DEFAULTS: WorkbenchPreferencesV1
export function parseWorkbenchPreferences(raw: string | null): WorkbenchPreferencesV1
export function clampPanelWidth(side: 'left' | 'right', value: number): number

export function useWorkbenchPreferences(): {
  readonly preferences: WorkbenchPreferencesV1
  readonly patchPreferences: (patch: Partial<WorkbenchPreferencesV1>) => void
  readonly resetPanelWidth: (side: 'left' | 'right') => void
}

export function useResizablePanel(options: {
  readonly side: 'left' | 'right'
  readonly value: number
  readonly min: number
  readonly max: number
  readonly onChange: (value: number) => void
  readonly onCommit: (value: number) => void
}): {
  readonly separatorProps: React.HTMLAttributes<HTMLDivElement>
  readonly dragging: boolean
}
```

- `ResizableSeparator` renders `role="separator"`, `aria-orientation="vertical"`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`.
- CVA primitives preserve current prop names wherever possible so domain callers migrate without behavior edits.

- [ ] **Step 1: Capture the pre-task boundary**

Run:

```bash
git status --short
git diff -- package.json package-lock.json vite.config.ts web/main.tsx web/index.html web/components/ui web/styles
```

Expected: dirty paths are visible; no command changes them. Save the output in the subagent response, not a repository file.

- [ ] **Step 2: Add the approved dependencies**

Run:

```bash
npm install class-variance-authority clsx tailwind-merge @radix-ui/react-collapsible @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-popover @radix-ui/react-scroll-area @radix-ui/react-select @radix-ui/react-separator @radix-ui/react-switch @radix-ui/react-tabs @radix-ui/react-tooltip
npm install --save-dev tailwindcss @tailwindcss/vite
```

Expected: `package.json` and `package-lock.json` add only these packages and their transitive dependencies; install exits 0.

- [ ] **Step 3: Write failing preference tests**

Add cases in `web/lib/workbench-preferences.spec.ts` for:

```ts
expect(parseWorkbenchPreferences(null)).toEqual(WORKBENCH_DEFAULTS)
expect(parseWorkbenchPreferences('{broken')).toEqual(WORKBENCH_DEFAULTS)
expect(parseWorkbenchPreferences(JSON.stringify({ leftWidth: 9999, rightWidth: -1, leftCollapsed: true, rightCollapsed: false, inspectorTab: 'artifacts' }))).toMatchObject({
  leftWidth: 420,
  rightWidth: 280,
  leftCollapsed: true,
  rightCollapsed: false,
  inspectorTab: 'artifacts',
})
```

Also assert invalid booleans/tab values fall back field-by-field rather than invalidating valid width values.

- [ ] **Step 4: Run preference tests and verify failure**

Run: `npx vitest run web/lib/workbench-preferences.spec.ts`

Expected: FAIL because the module/exports do not exist.

- [ ] **Step 5: Implement preference parsing and persistence**

Use constants:

```ts
export const WORKBENCH_STORAGE_KEY = 'dnt-harness.workbench.v1'
export const WORKBENCH_DEFAULTS = {
  leftWidth: 280,
  rightWidth: 336,
  leftCollapsed: false,
  rightCollapsed: false,
  inspectorTab: 'context',
} as const

export const PANEL_LIMITS = {
  left: { min: 232, max: 420, default: 280 },
  right: { min: 280, max: 520, default: 336 },
} as const
```

`useWorkbenchPreferences` must read once, catch storage exceptions, merge functional updates, and persist the complete validated object. It must not key preferences by workspace or conversation.

- [ ] **Step 6: Write failing resizer tests**

Cover:

- pointer delta direction for left and right panels;
- clamp at min/max;
- Arrow = 8px, Shift+Arrow = 32px;
- Home/End min/max;
- double-click default reset;
- `onCommit` on pointer release and keyboard action;
- pointer capture and cleanup of the temporary document selection guard.

- [ ] **Step 7: Run resizer tests and verify failure**

Run: `npx vitest run web/hooks/useResizablePanel.spec.tsx`

Expected: FAIL because hook/separator do not exist.

- [ ] **Step 8: Implement the hook and separator**

Keep arithmetic pure inside the hook module and export it for direct unit assertions:

```ts
export function resizeValue(side: 'left' | 'right', origin: number, deltaX: number): number {
  return side === 'left' ? origin + deltaX : origin - deltaX
}
```

The separator must expose an invisible 12px hit area around a 1px visual rule. Pointer movement updates immediately; persistence occurs on pointer-up. Do not animate while dragging.

- [ ] **Step 9: Configure Tailwind and the three-file CSS boundary**

Update `vite.config.ts` to include `tailwindcss()` beside `react()`. Create `web/styles/app.css` with `@import "tailwindcss"`, semantic `@theme` values, root sizing/reset, bundled-font variables, and Warm Studio colors. Create `motion.css` for keyframes, scrollbar, and reduced-motion override. Keep legacy CSS imports temporarily after the new files so unmigrated components still render; Task 7 removes them.

- [ ] **Step 10: Convert UI primitives to Radix/CVA without changing caller contracts**

Convert Button/IconButton/Badge/Chip/Field/TextInput/Segmented with CVA. Convert Modal, Menu, Select, Switch to Radix. Preserve current labels, disabled behavior, focus restoration, portal behavior, and callback timing. Wrap the app with `TooltipProvider` in `web/main.tsx`.

Do not move provider/workspace/approval state into primitives.

- [ ] **Step 11: Verify foundation**

Run:

```bash
npx vitest run web/lib/workbench-preferences.spec.ts web/hooks/useResizablePanel.spec.tsx web/components/ui/ui.spec.tsx web/lib/interaction.spec.tsx
npm run typecheck
npm run build:web
```

Expected: all tests PASS; typecheck and Vite build exit 0; no new endpoint calls; the existing app remains usable under legacy CSS.

**Success criteria:**

- [ ] Tailwind/Radix/CVA dependencies installed and build-integrated.
- [ ] Preferences survive remount and reject malformed values.
- [ ] Resizer has pointer and keyboard semantics with clamping.
- [ ] Primitive public props used by current callers remain source-compatible or every caller is explicitly updated in this task.
- [ ] No domain behavior changed.

**Risk / rollback:** Medium × High. Radix wrapper incompatibility can break many controls. If targeted tests fail, restore the affected primitive API and defer its Radix conversion; do not change domain callers to compensate. Dependency removal is safe only if no converted file imports it.

---

### Task 2: Shell — Global Bar, Resizable Navigation, Responsive Drawers

**Files:**
- Create: `web/components/layout/WorkbenchShell.tsx`, `tests/browser/warm-studio-shell.e2e.ts`
- Modify: `web/App.tsx:57-145`, `web/App.tsx:392-399`, `web/App.tsx:606-788`, `web/components/layout/TopBar.tsx`, `web/components/layout/Sidebar.tsx`, `web/components/layout/WorkspacePopover.tsx`, `web/components/session/SessionList.tsx`, `web/components/common/Icon.tsx`, `web/lib/product-ui.spec.tsx`

**Interfaces:**
- Consumes: `useWorkbenchPreferences`, `ResizableSeparator`, existing `sidebarOpen`/`envOpen` callbacks, session/project props currently wired in `App` (`web/App.tsx:613-652`).
- Produces:

```ts
interface WorkbenchShellProps {
  readonly topBar: ReactNode
  readonly navigation: ReactNode
  readonly conversation: ReactNode
  readonly inspector: ReactNode
  readonly leftOpen: boolean
  readonly rightOpen: boolean
  readonly leftWidth: number
  readonly rightWidth: number
  readonly onLeftOpenChange: (open: boolean) => void
  readonly onRightOpenChange: (open: boolean) => void
  readonly onLeftWidthChange: (width: number) => void
  readonly onRightWidthChange: (width: number) => void
}
```

- Desktop breakpoints: left docks at `>=1024px`; right docks at `>=1280px`.
- Drawer state is transient; persisted collapse state controls docked visibility only.

- [ ] **Step 1: Extend shell E2E fixture with initial geometry assertions**

At 1440px assert top bar spans viewport, left panel is 280px by default, right panel can open at 336px, and the center does not overflow. At 768px assert both panels use modal drawers and are absent from grid flow.

- [ ] **Step 2: Run the new shell spec and verify failure**

Run: `npx playwright test tests/browser/warm-studio-shell.e2e.ts --project=chromium`

Expected: FAIL because `WorkbenchShell`, new geometry, and resizers are absent. If no named Chromium project exists, run without `--project=chromium` and record that exact adjustment.

- [ ] **Step 3: Implement `WorkbenchShell`**

Use CSS grid through Tailwind arbitrary values backed by dynamic properties:

```tsx
<div
  className="grid h-dvh grid-rows-[var(--topbar-height)_minmax(0,1fr)] overflow-hidden bg-canvas text-ink"
  style={{ '--left-panel-width': `${leftWidth}px`, '--right-panel-width': `${rightWidth}px` } as React.CSSProperties}
>
```

The body grid must use docked columns only at relevant breakpoints. Use Radix Dialog for each drawer, sharing the same panel content component rather than duplicating navigation/inspector markup.

- [ ] **Step 4: Rewire `App.tsx` without touching server callbacks**

Retain workspace/session/meta/stream state and callbacks. Replace the outer `.app`/`.app-body` composition only. Keep route-selected session validation before `useSessionStream` exactly as currently ordered (`web/App.tsx:141-145`). Keep `openSession` closing narrow navigation (`web/App.tsx:392-399`).

- [ ] **Step 5: Migrate TopBar and workspace popover**

TopBar remains the sole workspace owner and exposes left/right toggles and settings. Workspace actions retain current server callbacks and warning badges. Radix Popover/DropdownMenu must restore focus on Escape and keep destructive confirmations explicit.

- [ ] **Step 6: Migrate Sidebar and SessionList**

Preserve project grouping, quick-new, search, running/queued metadata, loose conversation grouping, notification control, rename/delete actions, and English copy. Replace project expansion with Radix Collapsible. Do not change `SessionListing` or add content search.

- [ ] **Step 7: Add resizer/collapse E2E**

At 1440 and 1920:

- drag left separator from 280 to approximately 340;
- reload and assert persisted width within ±2px;
- keyboard-adjust separator and assert `aria-valuenow` changes by 8;
- double-click and assert 280;
- repeat right panel with default 336 and bounds 280–520;
- collapse/reopen each panel independently.

At 768/1024 verify drawer focus trap, Escape, scrim close, selection close, and opener focus restoration.

- [ ] **Step 8: Verify shell**

Run:

```bash
npx vitest run web/lib/product-ui.spec.tsx web/lib/route.spec.ts web/lib/interaction.spec.tsx
npx playwright test tests/browser/warm-studio-shell.e2e.ts
npm run typecheck
npm run build:web
```

Expected: PASS; invalid deep links still make zero event-stream request; no horizontal document overflow at 320/375/768/1024/1440/1920.

**Success criteria:**

- [ ] Approved global-bar/left/center/right arrangement exists.
- [ ] Desktop panels are independent, collapsible, resizable, and persistent.
- [ ] Tablet/mobile use accessible drawers.
- [ ] Navigation data and workspace actions have parity.
- [ ] Routing and SSE membership gate remain unchanged.

**Risk / rollback:** Medium × High. Signal: a foreign route opens SSE, drawer focus escapes, or persisted width breaks mobile. Revert shell composition to the prior outer markup while retaining Task 1 foundations; do not alter routing or stream code.

---

### Task 3: Transcript and Elevated Workbench Surface

**Files:**
- Create: `web/components/chat/WorkbenchSurface.tsx`, `web/components/chat/workbench-projector.ts`, `web/components/chat/workbench-projector.spec.ts`, `web/styles/markdown.css`
- Modify: `web/App.tsx:462-482`, `web/App.tsx:653-730`, `web/components/chat/Transcript.tsx`, `web/components/chat/MessageParts.tsx`, `web/components/chat/ThinkingPanel.tsx`, `web/Markdown.tsx`, `web/lib/project.ts`, `web/lib/product-ui.spec.tsx`, `web/lib/workflow.spec.tsx`, `tests/browser/warm-studio-workflows.e2e.ts`

**Interfaces:**
- Consumes: unchanged `ViewItem` union and `projectItems(events)` (`web/lib/project.ts:3-27`, `web/lib/project.ts:66-253`).
- Produces:

```ts
export type WorkbenchItem = Extract<ViewItem, { kind: 'tool' | 'delegation' }>
export function latestWorkbenchItem(items: readonly ViewItem[]): WorkbenchItem | null

interface WorkbenchSurfaceProps {
  readonly item: WorkbenchItem | null
  readonly workspaceId: string | null
  readonly onOpenChild: (sessionId: string) => void
}
```

Selection rule:

1. newest running tool or running delegation;
2. otherwise newest recovered/failed tool or interrupted/failed delegation;
3. otherwise newest completed tool/delegation;
4. `null` when no tool/delegation exists.

The projector returns the original `ViewItem` reference; it does not clone or mutate it.

- [ ] **Step 1: Write failing projector tests**

Cover empty input, newest running preference, failed-over-older-completed preference, completed fallback, and no mutation of the input array/items.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run web/components/chat/workbench-projector.spec.ts`

Expected: FAIL because the projector does not exist.

- [ ] **Step 3: Implement the pure selector**

Use reverse traversal with explicit predicates; do not alter `projectItems` event folding. Add no fetch.

- [ ] **Step 4: Build the elevated workbench surface**

Render only data already present on the item:

- tool name, argument summary, verdict, duration, exact arguments/output disclosures;
- delegation definition/objective/status and existing child-open callback;
- unknown recovered outcome with the exact existing warning;
- no progress percentage, rerun, command input, editor, terminal, or file-content label.

Share leaf render helpers with transcript rows where practical, but keep one durable transcript row per item. The elevated surface is a second presentation of the selected item, not a second projection or event.

- [ ] **Step 5: Migrate transcript visuals to Tailwind**

Preserve user queued-to-real replacement, assistant controls metadata, thinking, tool result pairing, delegation status, audit lines, failure details, retry behavior, copy/reuse, and jump-to-latest. Current behavior tests in `web/lib/product-ui.spec.tsx:185-301` must remain semantically unchanged.

Move markdown element and highlight.js selector rules to `web/styles/markdown.css`; keep `escapeHtml` and known-language highlighting unchanged (`web/Markdown.tsx:22-40`).

- [ ] **Step 6: Wire through `App.tsx`**

Compute once:

```ts
const projectedItems = useMemo(() => projectItems(events), [events])
const workbenchItem = useMemo(() => latestWorkbenchItem(projectedItems), [projectedItems])
```

Update `Transcript` to accept `items` rather than re-projecting, or pass the same `projectedItems` to both transcript and workbench. Update the existing retry-last lookup to use the same array (`web/App.tsx:462-482`). This prevents duplicate projection logic while preserving semantics.

- [ ] **Step 7: Add workflow E2E**

Fixture states:

- running tool → elevated surface visible and running;
- completed tool → transcript row remains and elevated surface shows recorded output disclosure;
- recovered result → unknown-outcome warning, never success wording;
- delegation → child link opens existing route;
- no tool/delegation → no empty decorative workbench card.

- [ ] **Step 8: Verify transcript/workbench**

Run:

```bash
npx vitest run web/components/chat/workbench-projector.spec.ts web/lib/product-ui.spec.tsx web/lib/workflow.spec.tsx
npx playwright test tests/browser/warm-studio-workflows.e2e.ts -g "transcript|workbench|recovered|delegation"
npm run typecheck
npm run build:web
```

Expected: PASS; `projectItems` outputs match prior assertions; raw content remains escaped/verbatim; no new network request occurs when workbench renders.

**Success criteria:**

- [ ] Transcript semantics are unchanged and projected once.
- [ ] Elevated workbench reflects only existing tool/delegation items.
- [ ] Running/recovered/failed/completed distinctions are truthful.
- [ ] Markdown/code remains safe and readable.

**Risk / rollback:** Medium × High. Signal: duplicate items, stale active surface, altered recovery verdict, or unsafe HTML. Remove the elevated surface and restore `Transcript`'s current `projectItems` call while retaining Tailwind styling; never change durable event interpretation to fit the surface.

---

### Task 4: Fixed Composer Dock and Approval Safety

**Files:**
- Modify: `web/App.tsx:401-500`, `web/App.tsx:653-730`, `web/components/composer/Composer.tsx`, `web/components/composer/ModelMenu.tsx`, `web/components/composer/ThinkingMenu.tsx`, `web/components/composer/PolicyPopover.tsx`, `web/components/composer/FolderPickerModal.tsx`, `web/components/chat/ApprovalBar.tsx`, `web/components/chat/TaskStatus.tsx`, `web/lib/product-ui.spec.tsx`, `web/lib/workflow.spec.tsx`, `tests/browser/warm-studio-workflows.e2e.ts`

**Interfaces:**
- Consumes: existing Composer props (`web/components/composer/Composer.tsx:20-80`), existing send/stop/approval callbacks (`web/App.tsx:401-500`).
- Produces: `ConversationDock` markup within `App` or a focused local component that orders `ApprovalBar` → send error → `Composer` and exposes its measured/known height as bottom scroll padding.

No callback signature changes are required. If extracted:

```ts
interface ConversationDockProps {
  readonly approvals: ReactNode
  readonly sendError: ReactNode
  readonly composer: ReactNode
}
```

- [ ] **Step 1: Add failing mounted tests for fixed-dock invariants**

Assert:

- IME Enter and Shift+Enter do not send;
- eligible Enter sends;
- running Enter queues and stop remains available;
- reconnect retains editable draft and does not imply stopped work;
- approval double-click submits once;
- approval failure remains visible;
- policy dirty state survives popover interaction;
- first-send failure preserves draft in created conversation.

Reuse current semantic assertions (`web/lib/product-ui.spec.tsx:64-109`, `web/lib/product-ui.spec.tsx:125-183`). Add only dock-specific DOM/order assertions.

- [ ] **Step 2: Migrate composer controls to Warm Studio/Radix**

Keep textarea autosize; replace direct `element.style.height` with a runtime custom property or retain it as the explicitly allowed measured dynamic height. Preserve placeholder rules, disabled-only-without-model behavior, model/mode/thinking/policy ownership, immutable scope display, and new-conversation scope picker.

- [ ] **Step 3: Implement center-region fixed/sticky dock**

The dock is anchored to the center region bottom, has its own warm raised surface and backdrop treatment, and never spans beneath side panels. Add sufficient transcript scroll padding. At mobile widths controls may wrap, but Message textarea and Send/Queue remain visible without horizontal overflow.

- [ ] **Step 4: Migrate approval and status presentation**

Keep approval order, exact arguments, project scope, one-request copy, synchronous `Set` lock, and confirmed persistent allow sequence. Keep `TaskStatus` connection text separate from durable running/terminal state.

- [ ] **Step 5: Extend E2E**

At all six widths assert:

- composer bounding box remains within viewport and center region;
- last transcript item can scroll above dock;
- approval actions can scroll into view and are not covered;
- running queue and stop work;
- reconnect fixture keeps running state and draft;
- Escape closes the innermost composer menu/popover before a drawer.

- [ ] **Step 6: Verify composer/approval**

Run:

```bash
npx vitest run web/lib/product-ui.spec.tsx web/lib/workflow.spec.tsx web/hooks/useSessionStream.spec.tsx
npx playwright test tests/browser/warm-studio-workflows.e2e.ts -g "composer|queue|stop|approval|reconnect"
npm run typecheck
npm run build:web
```

Expected: PASS; approval POST count remains one; queue uses the existing messages endpoint; stop uses the existing stop endpoint; no draft is lost.

**Success criteria:**

- [ ] Composer is fixed/sticky without covering content.
- [ ] Queue/stop/reconnect/draft semantics are unchanged.
- [ ] Approval safety is unchanged.
- [ ] Menus/popovers are accessible and layer correctly.

**Risk / rollback:** Medium × High. Signal: hidden approval, lost draft, duplicate approval POST, or disabled input during reconnect. Restore the prior in-flow center layout and current component logic; keep only styles that pass parity tests.

---

### Task 5: Right Panel — Context and Existing-Data Artifacts

**Files:**
- Create: `web/components/layout/InspectorPanel.tsx`, `web/components/layout/ContextPanel.tsx`, `web/components/artifacts/artifact-projector.ts`, `web/components/artifacts/artifact-projector.spec.ts`, `web/components/artifacts/ArtifactsPanel.tsx`
- Modify: `web/App.tsx:129-145`, `web/App.tsx:359-378`, `web/App.tsx:731-746`, `web/lib/types.ts:8-54` only if a local artifact view type is not kept in the projector, `web/lib/product-ui.spec.tsx`, `web/lib/workflow.spec.tsx`, `tests/browser/warm-studio-shell.e2e.ts`, `tests/browser/warm-studio-workflows.e2e.ts`
- Delete at end of task only after extraction is complete: `web/components/layout/EnvPanel.tsx`

**Interfaces:**
- Consumes: current manifest/compaction inputs (`web/components/layout/EnvPanel.tsx:37-65`), existing `SseEvent` fields (`web/lib/types.ts:8-54`).
- Produces:

```ts
export type ArtifactKind = 'file-reference' | 'resource-reference' | 'command' | 'tool-output'
export type ArtifactState = 'pending' | 'succeeded' | 'failed' | 'unknown'

export interface ArtifactItem {
  readonly id: string              // tool call id
  readonly kind: ArtifactKind
  readonly toolName: string
  readonly label: string
  readonly argumentKey?: string
  readonly reference?: string
  readonly command?: string
  readonly output?: string
  readonly state: ArtifactState
  readonly timestamp?: number
  readonly durationMs?: number
}

export function projectArtifacts(events: readonly SseEvent[]): readonly ArtifactItem[]
```

Mapping contract:

- pair `tool/call` and `tool/result` by call id/callId;
- `path` or `file_path` string → `file-reference`;
- other path-like string args → `resource-reference` with the exact key/value;
- Bash/Shell `command` → `command`;
- non-empty matching result output may be shown on that row as recorded tool output; if no reference/command qualifies but output exists, use `tool-output`;
- `recovery: true` → `unknown` regardless of `ok`;
- result `ok: true/false` → succeeded/failed; absent result → pending;
- preserve call order; dedupe by call id;
- do not infer file content, diff, MIME type, existence, project ownership, or rerun ability.

- [ ] **Step 1: Write failing artifact projector tests**

Include exact fixtures for:

1. Read `{ path: 'C:/repo/README.md' }` + successful output → file reference with output labeled separately;
2. Bash `{ command: 'npm test' }` + failed result → command/failed;
3. recovered successful result → unknown;
4. duplicate result frames do not duplicate call row;
5. output-only custom tool → tool-output;
6. unknown object-only args and empty output → no artifact row;
7. no qualifying events → empty array;
8. stable event order and no event mutation.

- [ ] **Step 2: Run artifact tests and verify failure**

Run: `npx vitest run web/components/artifacts/artifact-projector.spec.ts`

Expected: FAIL because the projector does not exist.

- [ ] **Step 3: Implement the pure projector**

Use maps for calls/results while retaining an ordered id list. Path-like detection must be conservative:

```ts
const PATH_KEYS = new Set(['path', 'file_path'])
const PATH_LIKE_KEY = /(?:^|_)(?:path|file|folder|directory|cwd|root)$/i
```

Only non-empty string values qualify. Prefer command over generic resource for shell calls; prefer canonical file keys over generic resource keys.

- [ ] **Step 4: Extract `ContextPanel` from `EnvPanel`**

Move rendering and compaction state unchanged. Replace inline budget width with `style={{ '--budget-percent': `${percent}%` }}` and consume it through a Tailwind arbitrary width or the allowed dynamic CSS boundary. Preserve confirmation text and running disable guard (`web/components/layout/EnvPanel.tsx:72-89`, `web/components/layout/EnvPanel.tsx:115-197`).

- [ ] **Step 5: Build `InspectorPanel` with Radix Tabs**

Tabs: `Context`, `Artifacts`. Use persisted `inspectorTab`. Context panel has the existing `aria-label="Conversation context"`; Artifacts panel has an explicit list label. The right panel frame/drawer is supplied by `WorkbenchShell`, not duplicated here.

- [ ] **Step 6: Tighten manifest fetch conditions in `App.tsx`**

Change the existing condition from panel-open to:

```ts
if (!rightOpen || inspectorTab !== 'context' || activeWs === null || current === null || running) return
```

Keep the 600ms settled delay and cancellation. Switching to Artifacts must not fetch manifest. Switching back to Context may fetch once after settling.

- [ ] **Step 7: Build ArtifactsPanel empty/data states**

Exact empty copy: **“No recorded artifacts for this conversation yet.”**

Labels:

- path rows: **“File reference”**;
- generic rows: **“Resource reference”**;
- command rows: **“Command record”**;
- output disclosure: **“Recorded tool output”**;
- recovered note: reuse **“Outcome unknown — the host restarted before this result was recorded.”**

Never render “file content”, “diff”, “changed files”, or “terminal”.

- [ ] **Step 8: Add mounted and E2E coverage**

Assert Context lazy fetch only under exact conditions. Assert Artifacts makes no additional API request. Exercise empty, file reference, command failed, output-only, pending, and recovered rows. Verify tab keyboard navigation and drawer focus at 320/375/768/1024.

- [ ] **Step 9: Delete `EnvPanel.tsx` only after caller verification**

Run:

```bash
grep -RIn --exclude-dir=node_modules --exclude-dir=.git "EnvPanel" web tests docs
```

Expected before delete: no production/test import except the file itself and historical docs. Then delete only `web/components/layout/EnvPanel.tsx`.

- [ ] **Step 10: Verify right panel**

Run:

```bash
npx vitest run web/components/artifacts/artifact-projector.spec.ts web/lib/product-ui.spec.tsx web/lib/workflow.spec.tsx
npx playwright test tests/browser/warm-studio-shell.e2e.ts tests/browser/warm-studio-workflows.e2e.ts -g "Context|Artifacts|right panel|manifest"
npm run typecheck
npm run build:web
```

Expected: PASS; Artifacts causes zero new endpoint calls; Context compaction behavior remains unchanged.

**Success criteria:**

- [ ] Context and Artifacts tabs work in dock and drawer.
- [ ] Context fetch is lazy and unchanged in contract.
- [ ] Artifact projection follows the exact MVP mapping and empty state.
- [ ] No unsupported file/delegation data claim appears.
- [ ] Old EnvPanel has zero callers before deletion.

**Risk / rollback:** Medium × High. Signal: Artifacts claims file content, extra fetch appears, compaction is enabled while running, or manifest fetches on Artifacts. Remove Artifacts tab and restore Context-only panel using the extracted component; do not add backend data.

---

### Task 6: Settings — Radix/Tailwind Migration with Dirty and Conflict Parity

**Files:**
- Modify: `web/App.tsx:126-130`, `web/App.tsx:748-772`, `web/components/settings/SettingsModal.tsx`, `web/components/settings/ManagementPanels.tsx`, `web/components/settings/ProjectsPanel.tsx`, `web/components/settings/management.spec.tsx`, `web/components/settings/scope-race.spec.tsx`, `web/lib/product-ui.spec.tsx`, `tests/browser/warm-studio-workflows.e2e.ts`

**Interfaces:**
- Consumes: current `SettingsModal` props (`web/components/settings/SettingsModal.tsx:109-136`), provider draft functions/state (`web/components/settings/SettingsModal.tsx:64-102`, `web/components/settings/SettingsModal.tsx:137-190`), current settings APIs (`web/lib/api.ts:92-124`, `web/lib/api.ts:375-597`).
- Produces: same `SettingsModal` public props and same API calls; Radix Dialog/Tabs presentation with responsive grouped navigation.

- [ ] **Step 1: Freeze behavior with targeted failing/retained tests**

Ensure tests explicitly cover:

- provider draft survives tab changes;
- close/provider replacement asks before discarding dirty draft or pending model text;
- blank existing API key is omitted from PATCH;
- provider save/test/sync/activate/delete behavior;
- Skills 409 offers Reload and explicit Overwrite, never silent overwrite;
- Memory 409 offers the same;
- project remove confirmation and bound/running 409 display;
- hooks raw JSON validation and whole-document save;
- agent/MCP/secrets operations and workspace/session scoping;
- stale async completions do not update a new workspace/root scope.

- [ ] **Step 2: Run settings tests before migration**

Run:

```bash
npx vitest run web/components/settings/management.spec.tsx web/components/settings/scope-race.spec.tsx web/lib/product-ui.spec.tsx
```

Expected: current baseline PASS. If not, stop and report pre-existing failures; do not mask them in presentation work.

- [ ] **Step 3: Replace settings container/navigation**

Use Radix Dialog for the full-height modal and Radix Tabs for desktop grouped navigation. Preserve all eight sections and the Global/Workspace grouping (`web/components/settings/SettingsModal.tsx:31-49`). On mobile use a compact Radix Select or accessible native select if Radix Select cannot meet scrolling behavior; do not clip sections.

- [ ] **Step 4: Migrate provider editor without rewriting state**

Retain `draftOf`, `pruneSettings`, `dirty`, `leave`, `save`, `sync`, `test`, `remove`, and activation logic. Change markup/classes only. Do not reseed drafts on background refresh; the current effect intentionally seeds once per open (`web/components/settings/SettingsModal.tsx:157-168`).

- [ ] **Step 5: Migrate management panels slice by slice**

Order: Projects → Skills → Memory → Agents → MCP → Hooks → Secrets. After each panel, run its targeted tests. Keep existing API function signatures and error text rendering. Do not combine separate save operations or infer connectivity from saved configuration.

- [ ] **Step 6: Add settings E2E states**

At 320, 375, 768, 1024, and 1440 verify:

- every section reachable;
- content scrolls above sticky actions;
- keyboard tab/select navigation;
- dirty discard confirmation;
- provider blank-key PATCH;
- injected Skills/Memory 409 conflict actions;
- project/MCP/agent/hook/secret destructive and failure states;
- focus returns to Settings trigger on close.

- [ ] **Step 7: Verify settings**

Run:

```bash
npx vitest run web/components/settings/management.spec.tsx web/components/settings/scope-race.spec.tsx web/lib/product-ui.spec.tsx
npx playwright test tests/browser/warm-studio-workflows.e2e.ts -g "settings|provider|conflict|project|MCP|Hooks|Secrets|Agents"
npm run typecheck
npm run build:web
```

Expected: PASS; captured request bodies match the existing contracts; no draft loss or silent overwrite.

**Success criteria:**

- [ ] All existing settings capabilities remain reachable and writable.
- [ ] Dirty provider behavior and blank-key retention are unchanged.
- [ ] Skills/Memory conflicts remain explicit.
- [ ] Responsive settings are accessible at required widths.

**Risk / rollback:** Medium × High. Signal: draft reseeds, blank key clears secret, conflict overwrites silently, or a settings section disappears. Restore the previous settings container around unchanged state/form code, then migrate one panel at a time.

---

### Task 7: Cleanup, Documentation, Full Matrix, and Self-Review

**Files:**
- Modify: `web/main.tsx`, `web/index.html`, `tests/browser/workbench.e2e.ts`, `tests/browser/warm-studio-shell.e2e.ts`, `tests/browser/warm-studio-workflows.e2e.ts`, `playwright.config.ts`, `docs/design-guidelines.md`, `docs/design-system.md`, `docs/web.md`
- Delete only after verification: legacy CSS files listed in the ownership map
- Review only: all files changed by Tasks 1–6 and both documents in this redesign package

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: one styling authority, complete automated evidence, updated human contracts, and zero unresolved spec/plan ambiguity.

- [ ] **Step 1: Inventory remaining manual styles and inline visual declarations**

Run:

```bash
grep -RIn --exclude-dir=node_modules --exclude-dir=.git -E "className=|style=|\.style\.|#[0-9A-Fa-f]{3,8}|rgba?\(" web
grep -RIn --exclude-dir=node_modules --exclude-dir=.git -E "base\.css|tokens\.css|ui\.css|shell\.css|chat\.css|settings\.css|settings-management\.css" web
```

Expected: remaining manual CSS imports/selectors are either unmigrated defects to fix now or belong to the three allowed CSS files. Dynamic inline styles are limited to approved custom properties/measured values.

- [ ] **Step 2: Remove legacy CSS only after zero-selector dependency**

For each legacy stylesheet, search every selector stem used by remaining JSX. Convert remaining visual classes to Tailwind/CVA, then remove its import and delete the file. Do not delete all files in one command; remove one verified file at a time.

Final `web/main.tsx` CSS imports:

```ts
import './styles/app.css'
import './styles/markdown.css'
import './styles/motion.css'
```

- [ ] **Step 3: Consolidate Playwright fixtures without reducing coverage**

Keep shared API fixture helpers in the existing browser-test file or extract a single `tests/browser/fixtures/workbench-fixture.ts` only if duplication exceeds two specs. If extracted, list it in the task diff and ensure it is test-only. Preserve production API interception; tests must not mutate real settings.

Update Playwright projects or use per-test `page.setViewportSize` so the exact required widths are all executed: **320, 375, 768, 1024, 1440, 1920**.

- [ ] **Step 4: Add complete accessibility and reduced-motion gates**

For shell, drawers, Context, Artifacts, approval, and every settings section:

- axe tags `wcag2a`, `wcag2aa`, `wcag21aa`;
- keyboard-only navigation and focus restoration;
- separator ARIA values and key behavior;
- coarse pointer minimum targets;
- `page.emulateMedia({ reducedMotion: 'reduce' })` and computed-style assertions that nonessential transitions/animations collapse;
- running spinner/status remains visible through non-motion cues.

- [ ] **Step 5: Add reconnect/running-turn E2E**

Fixture sequence: snapshot contains unmatched `turn/start` and running tool; simulate EventSource reconnect or reload with the same durable snapshot; assert:

- UI still says running/reconnecting separately;
- Stop remains available;
- no terminal outcome is invented;
- no automatic resend/replay request occurs;
- later snapshot/live `tool/result` + `turn/end` settles the UI once.

- [ ] **Step 6: Complete screenshot matrix**

Capture deterministic screenshots under `artifacts/product-ui/warm-studio/` for each required width and these states:

- empty/new conversation;
- populated transcript + workbench;
- running/reconnect + queued follow-up;
- pending approval;
- Context tab;
- Artifacts empty and populated;
- settings dirty and conflict states.

Screenshots are evidence, not approved baselines. Verify originality: no copied branding, terminal chrome, repository stats, fake file tree, or unsupported reference controls.

- [ ] **Step 7: Update docs**

`docs/design-guidelines.md` must state Warm Studio palette, 280/336 defaults and ranges, 1024/1280 dock thresholds, fixed composer, allowed CSS boundary, and accessibility matrix.

`docs/design-system.md` must define Radix/CVA/Tailwind component contracts, resizer semantics, Context/Artifacts mapping, and do-not lists.

`docs/web.md` must preserve REST/SSE documentation and update only client structure, responsive behavior, local preferences, Artifacts limitations, and commands.

- [ ] **Step 8: Run targeted regression suites**

Run:

```bash
npx vitest run web/lib/workbench-preferences.spec.ts web/hooks/useResizablePanel.spec.tsx web/components/artifacts/artifact-projector.spec.ts web/components/chat/workbench-projector.spec.ts web/components/ui/ui.spec.tsx web/lib/interaction.spec.tsx web/lib/route.spec.ts web/lib/workflow.spec.tsx web/lib/product-ui.spec.tsx web/components/settings/management.spec.tsx web/components/settings/scope-race.spec.tsx web/hooks/useSessionStream.spec.tsx
```

Expected: all PASS.

- [ ] **Step 9: Run mandatory full verification**

Run exactly:

```bash
npm test -- --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run build:web
npm run test:browser
```

Expected:

- all commands exit 0;
- Vitest reports no failed suites/tests;
- both TypeScript projects are clean;
- Vite produces `web-dist/` successfully;
- Playwright has no failed width, axe, focus, reduced-motion, reconnect, drawer, resizer, artifact, approval, or settings test.

- [ ] **Step 10: Verify no backend/API scope expansion**

Run:

```bash
git diff -- src web/lib/api.ts web/lib/types.ts
grep -RIn --exclude-dir=node_modules --exclude-dir=.git -E "(/api/[^'\"` ]+)" web | sort
```

Expected: no `src/` implementation change from this redesign; no new API route string; any `web/lib/types.ts` change is a client-local view type and is preferably absent because artifact types live with the projector.

- [ ] **Step 11: Verify dirty-tree safety and exact owned changes**

Run:

```bash
git status --short
git diff --stat
git diff -- docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md docs/superpowers/plans/2026-09-15-warm-studio-workbench-redesign.md
```

Expected: unrelated pre-existing changes remain present and untouched; no commit exists; implementation diff is limited to this plan's owned paths.

- [ ] **Step 12: Self-review spec/plan and implementation consistency**

Search for forbidden placeholders and stale decisions:

```bash
grep -RIn -E "TBD|TODO|implement later|file content|diff viewer|terminal|new endpoint|hand-written CSS|ChatGPT dark|#212121|EnvPanel" docs/superpowers/specs/2026-09-15-warm-studio-workbench-redesign-design.md docs/superpowers/plans/2026-09-15-warm-studio-workbench-redesign.md docs/design-guidelines.md docs/design-system.md docs/web.md
```

Expected:

- no `TBD`, `TODO`, or “implement later”;
- “file content”, “diff viewer”, “terminal”, and “new endpoint” appear only in explicit non-goal/limitation statements;
- no stale dark-theme contract;
- `EnvPanel` appears only in migration/history text, not as final architecture;
- all interfaces, names, width ranges, breakpoints, copy, commands, and artifact rules agree.

**Success criteria:**

- [ ] Only three narrowly scoped CSS files remain.
- [ ] Full required viewport/accessibility/keyboard/focus/reduced-motion/reconnect/drawer/resizer/settings matrix passes.
- [ ] Docs match implementation and approved scope.
- [ ] No backend/API change, unsupported artifact claim, unrelated overwrite, or commit occurred.

**Risk / rollback:** Medium × High. Cleanup can remove a still-used selector or hide a regression behind broad tests. Remove legacy files one by one and run build/browser smoke after each. If full verification fails, restore only the last removed stylesheet/import or last migrated component, then isolate the missing contract.

---

## Cross-Phase Test Matrix

| Contract | Unit | Mounted integration | E2E |
|---|---|---|---|
| Preferences and width clamping | `workbench-preferences.spec.ts` | hook remount/storage failure | reload persistence at 1440/1920 |
| Resizers | pure resize math | pointer capture + keyboard separator | drag/keys/double-click/bounds |
| Routing and SSE membership | existing route tests | App fixture | invalid/foreign deep links make no SSE request |
| Durable transcript projection | existing project/workflow tests | message/tool/delegation components | populated/recovered/running transcript |
| Workbench projection | `workbench-projector.spec.ts` | surface disclosure | running/completed/recovered/delegation |
| Draft/send/queue/stop | interaction/project tests | Composer IME and callback locks | first-send, failed send, queue, stop |
| Reconnect truth | approval/stream tests | TaskStatus | reconnect with unmatched turn/start |
| Approval safety | workflow tests | synchronous double-submit/failure | once-only POST, exact args, persistent allow confirmation |
| Context | budget/helper tests | lazy conditions + compaction | tab/drawer, running disable, manifest timing |
| Artifacts | `artifact-projector.spec.ts` | empty/data rendering | zero new API calls, exact labels/states |
| Settings dirty/conflicts | settings tests | all panels | all widths and conflict/destructive states |
| Accessibility | primitive semantics | Radix focus integration | axe, keyboard, coarse targets, reduced motion |

## Backwards Compatibility Strategy

1. No domain persistence migration: event logs, workspaces, projects, sessions, provider records, modes, policies, skills, memory, agents, MCP, hooks, and secrets remain untouched.
2. No REST/SSE change: current API helpers continue to send the same routes/bodies (`web/lib/api.ts:173-373`, `web/lib/api.ts:375-597`).
3. Existing local keys remain valid. The only addition is `dnt-harness.workbench.v1`; malformed or absent values fall back safely.
4. `projectItems` remains the transcript contract. New projectors consume its output or the same events without replacing it.
5. Vertical slices retain legacy CSS only for not-yet-migrated components; cleanup occurs after caller/selector proof.
6. Rollback any phase by restoring that phase's presentation files and leaving server/domain state untouched.

## Phase-Level Risk Summary

| Phase/task | Likelihood | Impact | Primary mitigation |
|---|---:|---:|---|
| 1 Foundation | Medium | High | Preserve primitive prop contracts; targeted tests before shell work |
| 2 Shell | Medium | High | Keep routing/SSE gate untouched; drawer/resizer E2E |
| 3 Transcript/workbench | Medium | High | Project once; pure selector; durable projection regression tests |
| 4 Composer/approval | Medium | High | Retain callback/state code; IME/queue/lock E2E |
| 5 Context/artifacts | Medium | High | Strict pure mapping; zero-new-request assertion |
| 6 Settings | Medium | High | Markup-only migration around retained state/functions; conflict tests |
| 7 Cleanup/verification | High | Medium | One stylesheet at a time; full matrix after each removal |

## Measurable Final Acceptance

- [ ] Shell matches approved top bar / left navigation / center conversation+workbench / right tabs / bottom composer arrangement.
- [ ] Warm Studio is visibly original and uses warm neutrals + terracotta, not the previous dark palette or copied reference chrome.
- [ ] Left 280px default, 232–420 range; right 336px default, 280–520 range; both persist and remain keyboard accessible.
- [ ] Left becomes drawer below 1024px; right becomes drawer below 1280px.
- [ ] Required widths 320/375/768/1024/1440/1920 pass without document overflow.
- [ ] Transcript, routes, drafts, first-send creation, queue, stop, reconnect/running state, and project binding semantics remain unchanged.
- [ ] Approval double-submit remains impossible and one-request decisions remain exact.
- [ ] Context fetches only while open/selected/settled and keeps confirmed compaction.
- [ ] Artifacts maps existing event/tool data only and shows the exact fallback empty state.
- [ ] No UI claims file content when only a path/tool output exists.
- [ ] Settings dirty, blank-key, conflict, stale-scope, and destructive flows pass.
- [ ] Tailwind/Radix/CVA own component UI; only `app.css`, `markdown.css`, `motion.css` remain.
- [ ] Unit, mounted, API, E2E, axe, keyboard/focus, coarse target, reduced-motion, screenshot, and reconnect gates pass.
- [ ] No unrelated dirty-tree change is reset, stashed, deleted, overwritten, or committed.

## Task Decomposition for Subagent-Driven Execution

1. **Foundation worker:** Task 1 only. Returns dependency diff, primitive API compatibility notes, targeted test output.
2. **Shell worker:** Task 2 only after Task 1 review. Returns routing/SSE invariant confirmation and width/drawer evidence.
3. **Conversation worker:** Task 3 only after shell review. Returns `projectItems` parity and workbench projection evidence.
4. **Safety worker:** Task 4 only after conversation review. Returns send/queue/stop/reconnect/approval request-count evidence.
5. **Inspector split:**
   - projector worker owns only `web/components/artifacts/artifact-projector.ts` and its test;
   - Context worker owns only `ContextPanel.tsx` extraction;
   - integration lead owns `InspectorPanel.tsx`, `App.tsx`, E2E, and EnvPanel deletion.
6. **Settings worker:** Task 6 only after right-panel integration. Returns operation-by-operation parity table and conflict evidence.
7. **Verification lead:** Task 7, owns cleanup/docs/full commands; reviews all diffs but does not rewrite unrelated files.

Each worker must stop on a pre-existing failing baseline, unexpected API change, or unrelated-file diff and report it to the lead before continuing.

## Open Questions

None. Design, scope, data mapping, breakpoints, safety behavior, and verification matrix are locked.