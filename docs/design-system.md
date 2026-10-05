# Web client design system

Construction contract for `web/`. Product geometry, behavior and accessibility rules live in [design-guidelines.md](design-guidelines.md).

## Foundation

- **Tailwind v4** utilities own layout, spacing, typography, color, borders, shadows, states and responsive behavior.
- **Tokens** are CSS variables in `web/styles/app.css`: `:root` (light) and `:root[data-theme="dark"]`, exposed to Tailwind through `@theme inline` as `bg`, `sidebar`, `surface`, `muted`, `hover`, `line`, `line-strong`, `fg`, `fg-muted`, `fg-faint`, `primary`, `primary-fg`, `link`, `ok|warn|bad` (+ `-soft`), `scrim`, `composer`, `shadow-pop`, `shadow-composer`. The `dark:` variant targets `[data-theme="dark"]`. Components never use raw color literals.
- **CVA** defines Button, IconButton and Badge variants.
- **Radix** owns interaction mechanics: Dialog (Modal, Sheet), Popover (Menu, Select, workspace switcher), Tabs, Collapsible, Select (mobile Settings section), Switch, Tooltip provider.

## CSS files

`main.tsx` imports exactly `app.css`, `markdown.css`, `motion.css`.

- `app.css`: tokens, base rules (focus ring, coarse-pointer 44px targets), and a small `@layer components` block for the Settings management panels' semantic hooks (`manage-*`, `filter-input`).
- `markdown.css`: assistant markdown and highlight.js token colors.
- `motion.css`: keyframes, `animate-*`/`text-shimmer` helpers, scrollbar styling and the reduced-motion collapse.

Inline styles are limited to runtime values (spinner size, context budget percentage, textarea autosize height).

## Primitives (`web/components/ui`)

| Primitive | Contract |
|---|---|
| `Button` | variants `primary`, `ghost`, `outline`, `success`, `danger`, `outline-danger`; sizes `sm`, `md`; pill shape; defaults to `type="button"` |
| `IconButton` | required `label` (aria-label + title); variants `ghost`, `outline`, `tinted`, `solid`; forwards ref |
| `Menu` / `menuItemClass` | popover with render-prop trigger and `close()`; `panelRole` `menu` or `dialog`; `side`/`align` |
| `Modal` | controlled centered dialog, widths `sm`/`md`/`lg`/`xl`; optional header; restores focus to its opener |
| `Sheet` | edge-attached modal dialog (`left` drawer, `right` Context sheet); restores focus to its opener |
| `Select` | searchable listbox popover (search appears above 8 options) with optional custom trigger |
| `Field`, `TextInput`, `Switch`, `Segmented`, `Badge`, `Panel`, `CodeChip`, `Kbd` | form and display atoms |

`hooks/useRestoreFocus` captures the opener in the layout phase and restores it on close or unmount; `hooks/useStickToBottom` implements transcript following with a `ResizeObserver`; `hooks/useMediaQuery` drives the sidebar dock breakpoint; `hooks/useTheme` applies the appearance preference.

## Composition

- `App.tsx` keeps routing, server-backed state, navigation generations and send/stop/approval/retry logic, and composes `Sidebar`, `ChatHeader` (with the folder `ScopeControl`), `Transcript`, `TaskStatus`, `ApprovalBar`, `Composer` (with `ModelMenu`), `Workbench`, `SettingsModal`, `FolderPickerModal` and `ConfirmDialog`.
- `Transcript` renders `groupBlocks(items)`: every consecutive tool, delegation and audit row shares one activity block, so a delegation never becomes its own block with a different gap; `completed` markers and a bare `failed` after a detailed failure card are dropped. `ActivityBlock` collapses a block of four rows or more behind `summarizeActivity`, opening while it runs, while a row failed or ended unknown, or when the reader says so. Every block takes the same top margin (`mt-2.5 sm:mt-4`), and rows inside a run — collapsed or open — use that same gap.
- `Composer` owns the textarea and the scope, mode (`ModeMenu`, with a read-only summary of what the mode permits) and thinking (`ThinkingMenu`) chips (`composer-chip.ts`). The model picker lives in the header. Permission lives in the mode, authored in Settings → Modes — the composer has no permission chip.
- Settings keeps its request contracts: provider draft seeding, dirty-leave confirmation, blank stored-key omission, activation, test/sync/delete; Skills/Memory 409 require explicit Reload or Overwrite; Hooks raw JSON is validated whole and kept verbatim when invalid.

## Do-not list

- No backend or REST/SSE contract changes for presentation work.
- No fixed-position composer, measured dock geometry, or elements pinned over the transcript.
- No mutable file editor, diff editor, terminal or rerun action. The Workbench file browser/viewer is read-only and attachment references never imply permission or execution.
- No invented terminal outcome during reconnect and no automatic resend/replay.
- No duplicate transcript projection or mutation of durable events.
- No silent Settings conflict overwrite or provider draft loss.
- No new stylesheet outside the three files; no raw color literals in components.
- No status communicated only by color.
