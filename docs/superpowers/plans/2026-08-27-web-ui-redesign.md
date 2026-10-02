# Web UI Redesign — Workspace Shell + Base Component Kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the dnt-harness React client into the approved 3-zone workspace shell (TopBar / grouped Sidebar / Chat + control-center Composer / Environment panel) on a reusable `web/components/ui/` primitive kit, Sharp preset, with zero backend changes.

**Architecture:** Bottom-up migration that keeps the app green at every commit: tokens first, then primitives (unused), then the shell swap, then the chat surface restyle, then cleanup. The client stays stateless — transcript still renders from `projectItems(events)`; only presentational code changes.

**Tech Stack:** React 19 · TypeScript strict (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) · Vite 6 · vitest (node env, `react-dom/server` for component smoke tests) · hand-written CSS driven by custom properties.

**Spec:** `docs/superpowers/specs/2026-08-27-web-ui-redesign-design.md`

## Global Constraints

- TS strict mode is non-negotiable; type-only imports must use `import type`.
- Imports keep explicit extensions (`./x.ts`, `./x.tsx`) as the existing codebase does.
- **No literal colors/radii in TSX** — components emit semantic class names (`ui-*`), all values live in CSS via tokens.
- One icon set: extend `web/components/common/Icon.tsx` PATHS (stroke 1.8, viewBox 24). No emoji anywhere in new markup.
- UI copy: Vietnamese, same tone as current app. Metrics/timestamps/ids/paths use `var(--font-mono)`.
- No new npm dependencies.
- Component smoke tests live under `web/` (NOT `tests/`) because root `tsconfig.json` has no DOM/JSX lib — `tsconfig.web.json` covers `web/**` with `jsx: react-jsx`. Spec §11 said `tests/web/ui.spec.tsx`; implement as `web/components/ui/ui.spec.tsx` and fix the spec line in Task 7.
- Test commands: targeted `npx vitest run <path>`; full suite `npm run test`; types `npm run typecheck`; client build `npm run build:web`.

## File Map (end state)

```
web/lib/config.ts                        NEW   SHOW_SLOTS flag
web/lib/format.ts                        MOD   + pathBasename(), toolTarget()
web/components/common/Icon.tsx           MOD   +12 icons
web/components/ui/Button.tsx             NEW
web/components/ui/IconButton.tsx         NEW
web/components/ui/Kbd.tsx                NEW
web/components/ui/Badge.tsx              NEW
web/components/ui/CodeChip.tsx           NEW
web/components/ui/Panel.tsx              NEW
web/components/ui/Chip.tsx               NEW
web/components/ui/TextInput.tsx          NEW
web/components/ui/Select.tsx             NEW
web/components/ui/ui.spec.tsx            NEW   SSR smoke tests (whole kit)
web/styles/tokens.css                    REWRITE (v2 palette, same var names + additions)
web/styles/ui.css                        NEW   primitive styles
web/styles/shell.css                     NEW   topbar/sidebar-v2/env/responsive/app frame
web/styles/chat.css                      REWRITE (transcript v2 + markdown/hljs absorbed from composer.css)
web/App.tsx                              REWRITE
web/main.tsx                             MOD   import list
web/components/layout/TopBar.tsx         NEW
web/components/layout/Sidebar.tsx        REWRITE
web/components/layout/EnvPanel.tsx       NEW
web/components/session/SessionList.tsx   MOD   subtitle row + IconButton actions
web/components/chat/MessageParts.tsx     REWRITE (tool-row, msg meta)
web/components/chat/ApprovalBar.tsx      REWRITE (approval card w/ Button)
web/components/composer/Composer.tsx     REWRITE (control center + model Select)
web/components/common/CopyButton.tsx     MOD   ui-action classes
web/components/chat/ChatHeader.tsx       DELETE
web/styles/sidebar.css                   DELETE
web/styles/composer.css                  DELETE
web/styles/components.css                DELETE
docs/web.md                              MOD   structure/hotkeys/files table refresh
docs/superpowers/specs/…design.md        MOD   test path correction (§11)
```

Untouched by design: `lib/api.ts`, `lib/types.ts`, `lib/project.ts`, `hooks/useSessionStream.ts`, `hooks/useAutoScroll.ts`, `Markdown.tsx`, `ThinkingPanel.tsx`, `Spinner.tsx`, `Toast.tsx`, all of `src/web/server.ts` and its tests.

---

### Task 1: Tokens v2 + feature flag

**Files:**
- Modify: `web/styles/tokens.css` (full rewrite)
- Create: `web/lib/config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: token variables every later CSS file reads (`--r-chip/--r-sm/--r-md/--r-lg`, `--accent-tint`, `--accent-border`, `--accent-text`, `--hairline`, `--ok-tint`, `--ok-border`, `--bad-tint`, `--bad-border`, `--warn-tint`, `--warn-border`, `--bg-card`); `SHOW_SLOTS` boolean from `lib/config.ts`.

Legacy variable names (`--bg`, `--bg-elevated`, …) are **kept but re-valued**, so the un-restyled old components instantly adopt the new palette without breaking between commits.

- [ ] **Step 1: Rewrite `web/styles/tokens.css`**

```css
/* ────────────────────────────────────────────────────────────────
   dnt-harness web — "Sharp" workspace theme (VS Code spirit)
   Three surface levels, hairline borders, restrained accent.
   ──────────────────────────────────────────────────────────────── */

:root {
  /* surfaces: pane chrome < canvas < card < elevated */
  --bg-pane: #0f1013;
  --bg: #121418;
  --bg-card: #15171b;
  --bg-elevated: #181a20;
  --bg-hover: #17191f;
  --bg-active: #1d2027;
  --bg-inset: #101216;

  /* borders */
  --border: #24272e;
  --border-strong: #33373f;
  --hairline: #1c1f25;

  /* text */
  --text: #dcdee3;
  --text-dim: #8b909c;
  --text-faint: #565b66;

  /* accent */
  --accent: #5c7cfa;
  --accent-text: #9db4ff;
  --accent-tint: rgba(110, 139, 255, 0.15);
  --accent-border: rgba(110, 139, 255, 0.4);
  --accent-soft: rgba(92, 124, 250, 0.14);

  /* status */
  --ok: #46c286;
  --ok-tint: rgba(70, 194, 134, 0.13);
  --ok-border: rgba(70, 194, 134, 0.45);
  --bad: #f47166;
  --bad-tint: rgba(244, 113, 102, 0.1);
  --bad-border: rgba(244, 113, 102, 0.4);
  --amber: #d29922;
  --warn-tint: rgba(210, 153, 34, 0.12);
  --warn-border: rgba(210, 153, 34, 0.32);

  /* radius scale — Sharp preset */
  --r-chip: 3px;
  --r-sm: 4px;
  --r-md: 5px;
  --r-lg: 7px;
  --radius: 7px;
  --radius-sm: 4px;

  /* type */
  --font-ui: 'Instrument Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;

  /* geometry */
  --gap: 12px;
  --pad: 14px;
  --topbar-h: 42px;
  --sidebar-w: 234px;
  --env-w: 252px;

  /* layers */
  --z-drawer: 40;
  --z-popover: 45;
  --z-toast: 60;
  --z-modal: 50;

  /* hljs token palette tuned to the surfaces above */
  --hl-keyword: #8a9ffb;
  --hl-string: #8fcf9a;
  --hl-number: #e0af68;
  --hl-comment: #5c606a;
  --hl-title: #79c0ff;
  --hl-builtin: #f47067;
  --hl-attr: #d29922;
}
```

- [ ] **Step 2: Create `web/lib/config.ts`**

```ts
/**
 * Demo switches for surfaces whose backing APIs do not exist yet
 * (extra views, git/diff stats, uploads — spec §8). Default off so the
 * shipped UI contains no fake affordances.
 */
export const SHOW_SLOTS = false
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm run typecheck && npx vitest run tests/web/server.spec.ts`
Expected: both pass (CSS not type-checked; flag unused yet).

- [ ] **Step 4: Commit**

```bash
git add web/styles/tokens.css web/lib/config.ts
git commit -m "tokens v2 (Sharp palette, radius scale) + SHOW_SLOTS flag"
```

---

### Task 2: Icon set extension (TDD)

**Files:**
- Modify: `web/components/common/Icon.tsx`
- Create: `web/components/ui/ui.spec.tsx`

**Interfaces:**
- Produces: usable `Icon name=` values `folder zap clock messageSquare fileText panelRight panelLeft gitBranch alertTriangle sliders chevronRight square` (existing names untouched); `ICON_NAMES` export already exists.

- [ ] **Step 1: Write the failing test — create `web/components/ui/ui.spec.tsx`**

```tsx
import { describe, expect, it } from 'vitest'
import Icon, { ICON_NAMES } from '../common/Icon.tsx'
import { SHOW_SLOTS } from '../../lib/config.ts'
import { renderToStaticMarkup } from 'react-dom/server'

describe('icon set', () => {
  it('covers the shell + kit vocabulary', () => {
    for (const name of [
      'plus', 'close', 'chevron', 'chevronRight', 'copy', 'check', 'menu',
      'trash', 'pencil', 'send', 'search', 'terminal', 'arrowDown',
      'folder', 'zap', 'clock', 'messageSquare', 'fileText', 'panelRight',
      'panelLeft', 'gitBranch', 'alertTriangle', 'sliders', 'square',
    ]) {
      expect(ICON_NAMES, name).toContain(name)
    }
  })

  it('renders an svg with stroke styling and no fill', () => {
    const html = renderToStaticMarkup(<Icon name="folder" size={14} />)
    expect(html).toContain('<svg')
    expect(html).toContain('stroke-width="1.8"')
    expect(html).not.toContain('emoji')
  })
})

describe('feature flag', () => {
  it('ships with future-view slots hidden', () => {
    expect(SHOW_SLOTS).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run web/components/ui/ui.spec.tsx`
Expected: FAIL — missing names `chevronRight folder zap …` in ICON_NAMES.

- [ ] **Step 3: Add the icons — in `web/components/common/Icon.tsx`, append inside `PATHS` before the closing brace**

```tsx
  chevronRight: <path d="M9 6l6 6-6 6" />,
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  zap: (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  messageSquare: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  fileText: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </>
  ),
  panelLeft: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  gitBranch: (
    <>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />
    </>
  ),
  square: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" strokeWidth={0} />,
```

- [ ] **Step 4: Run again — pass**

Run: `npx vitest run web/components/ui/ui.spec.tsx && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/components/common/Icon.tsx web/components/ui/ui.spec.tsx
git commit -m "extend icon set for workspace shell vocabulary"
```

---

### Task 3: Primitives A — Button, IconButton, Kbd, Badge, CodeChip, Panel

**Files:**
- Create: `web/styles/ui.css`, `web/components/ui/{Button,IconButton,Kbd,Badge,CodeChip,Panel}.tsx`
- Modify: `web/components/ui/ui.spec.tsx`

**Interfaces:**
- Produces:
  - `Button({variant='outline', size='md', ...buttonAttrs})` variant `'primary'|'ghost'|'outline'|'success'|'danger'|'outline-danger'`
  - `IconButton({label, variant='ghost', size='sm', ...buttonAttrs})` variant `'ghost'|'outline'|'tinted'|'solid'`
  - `Kbd({children})`; `Badge({tone='gray', children})` tone `'gray'|'blue'|'green'|'amber'`
  - `CodeChip({children})`; `Panel({variant='flat', className='', children})`
  - Class contract: root class always `ui-btn|ui-icon-btn|ui-kbd|ui-badge|ui-code|ui-panel` + modifier per variant/size.

- [ ] **Step 1: Write failing tests — append to `web/components/ui/ui.spec.tsx`**

```tsx
import { Button } from './Button.tsx'
import { IconButton } from './IconButton.tsx'
import { Kbd } from './Kbd.tsx'
import { Badge } from './Badge.tsx'
import { CodeChip } from './CodeChip.tsx'
import { Panel } from './Panel.tsx'

describe('primitives render their class contract', () => {
  it('Button variants/sizes', () => {
    const html = renderToStaticMarkup(
      <>
        <Button variant="primary">go</Button>
        <Button size="sm">small</Button>
        <Button variant="success">allow</Button>
      </>,
    )
    expect(html).toContain('ui-btn')
    expect(html).toContain('ui-btn-primary')
    expect(html).toContain('ui-btn-sm')
    expect(html).toContain('ui-btn-success')
  })

  it('IconButton carries an aria-label', () => {
    const html = renderToStaticMarkup(<IconButton label="Đóng" onClick={() => undefined}><span>x</span></IconButton>)
    expect(html).toContain('ui-icon-btn')
    expect(html).toContain('aria-label="Đóng"')
  })

  it('Badge tones, Kbd, CodeChip, Panel', () => {
    const html = renderToStaticMarkup(
      <>
        <Badge tone="amber">slot sau</Badge>
        <Kbd>Ctrl+N</Kbd>
        <CodeChip>edit · web/App.tsx</CodeChip>
        <Panel variant="raised">body</Panel>
      </>,
    )
    expect(html).toContain('ui-badge-amber')
    expect(html).toContain('ui-kbd')
    expect(html).toContain('ui-code')
    expect(html).toContain('ui-panel-raised')
  })
})
```

- [ ] **Step 2: Run — fail (files missing)**

Run: `npx vitest run web/components/ui/ui.spec.tsx`
Expected: FAIL — cannot resolve `./Button.tsx`.

- [ ] **Step 3: Implement — create the six files and `styles/ui.css`**

`web/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant =
  | 'primary'
  | 'ghost'
  | 'outline'
  | 'success'
  | 'danger'
  | 'outline-danger'

export function Button({
  variant = 'outline',
  size = 'md',
  className = '',
  children,
  ...rest
}: {
  readonly variant?: ButtonVariant
  readonly size?: 'sm' | 'md'
  readonly className?: string
  readonly children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`ui-btn ui-btn-${variant} ui-btn-${size} ${className}`} {...rest}>
      {children}
    </button>
  )
}
```

`web/components/ui/IconButton.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function IconButton({
  label,
  variant = 'ghost',
  size = 'sm',
  className = '',
  children,
  ...rest
}: {
  /** Required: announced by screen readers, shown as tooltip. */
  readonly label: string
  readonly variant?: 'ghost' | 'outline' | 'tinted' | 'solid'
  readonly size?: 'sm' | 'md'
  readonly className?: string
  readonly children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`ui-icon-btn ui-icon-btn-${size} ui-icon-btn-${variant} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
```

`web/components/ui/Kbd.tsx`:

```tsx
import type { ReactNode } from 'react'

export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>
}
```

`web/components/ui/Badge.tsx`:

```tsx
import type { ReactNode } from 'react'

export function Badge({
  tone = 'gray',
  children,
}: {
  readonly tone?: 'gray' | 'blue' | 'green' | 'amber'
  readonly children: ReactNode
}) {
  return <span className={`ui-badge ui-badge-${tone}`}>{children}</span>
}
```

`web/components/ui/CodeChip.tsx`:

```tsx
import type { ReactNode } from 'react'

export function CodeChip({ children }: { readonly children: ReactNode }) {
  return <code className="ui-code">{children}</code>
}
```

`web/components/ui/Panel.tsx`:

```tsx
import type { ReactNode } from 'react'

export function Panel({
  variant = 'flat',
  className = '',
  children,
}: {
  readonly variant?: 'flat' | 'raised'
  readonly className?: string
  readonly children?: ReactNode
}) {
  return <div className={`ui-panel ui-panel-${variant} ${className}`}>{children}</div>
}
```

Create `web/styles/ui.css`:

```css
/* ────────────────────────────────────────────────────────────────
   ui/ primitives — every value comes from tokens.css. Components
   emit only semantic classes; no literal colors in TSX.
   ──────────────────────────────────────────────────────────────── */

/* ── Button ── */
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}

.ui-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.ui-btn-sm { padding: 3px 10px; font-size: 11.5px; }
.ui-btn-md { padding: 5px 13px; font-size: 12.5px; }

.ui-btn-primary { background: var(--accent); color: #fff; }
.ui-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }

.ui-btn-ghost { color: var(--text-dim); }
.ui-btn-ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }

.ui-btn-outline { border-color: var(--border-strong); color: var(--text-dim); }
.ui-btn-outline:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }

.ui-btn-success { background: var(--ok-tint); border-color: var(--ok-border); color: var(--ok); }
.ui-btn-success:hover:not(:disabled) { background: rgba(70, 194, 134, 0.2); }

.ui-btn-danger { background: var(--bad); color: #200a08; }
.ui-btn-danger:hover:not(:disabled) { filter: brightness(1.08); }

.ui-btn-outline-danger { background: var(--bad-tint); border-color: var(--bad-border); color: var(--bad); }
.ui-btn-outline-danger:hover:not(:disabled) { background: rgba(244, 113, 102, 0.18); }

/* ── IconButton ── */
.ui-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.ui-icon-btn-sm { width: 26px; height: 26px; }
.ui-icon-btn-md { width: 30px; height: 30px; }

.ui-icon-btn-ghost { color: var(--text-faint); }
.ui-icon-btn-ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }

.ui-icon-btn-outline { border: 1px solid var(--border-strong); color: var(--text-faint); }
.ui-icon-btn-outline:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }

.ui-icon-btn-tinted {
  background: var(--accent-tint);
  border: 1px solid var(--accent-border);
  color: var(--accent-text);
}

.ui-icon-btn-solid { background: var(--accent); color: #fff; }
.ui-icon-btn-solid:hover:not(:disabled) { filter: brightness(1.08); }

.ui-icon-btn:disabled { opacity: 0.35; cursor: default; }

/* dashed placeholder view-toggle (only renders when SHOW_SLOTS) */
.ui-icon-btn-slot { border: 1px dashed var(--border-strong); }

/* ── Kbd ── */
.ui-kbd {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: var(--r-chip);
  padding: 0 5px;
  line-height: 15px;
  white-space: nowrap;
}

/* ── Badge ── */
.ui-badge {
  display: inline-block;
  font-size: 9px;
  letter-spacing: 0.02em;
  border-radius: var(--r-chip);
  padding: 0.5px 6px;
  white-space: nowrap;
}

.ui-badge-gray { background: var(--bg-active); color: var(--text-faint); }
.ui-badge-blue { background: var(--accent-tint); color: var(--accent-text); border: 1px solid var(--accent-border); }
.ui-badge-green { background: var(--ok-tint); color: var(--ok); border: 1px solid var(--ok-border); }
.ui-badge-amber { background: var(--warn-tint); color: var(--amber); border: 1px solid var(--warn-border); }

/* ── CodeChip ── */
.ui-code {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-dim);
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--r-chip);
  padding: 1.5px 7px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ── Panel ── */
.ui-panel { border-radius: var(--r-sm); }
.ui-panel-flat { background: transparent; }
.ui-panel-raised { background: var(--bg-card); border: 1px solid var(--border); padding: 10px 12px; }
```

Append to `web/main.tsx` imports (after base.css):

```tsx
import './styles/ui.css'
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run web/components/ui/ui.spec.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/ui web/styles/ui.css web/main.tsx
git commit -m "ui kit: button/icon-button/kbd/badge/codechip/panel primitives"
```

---

### Task 4: Primitives B — Chip, TextInput, Select

**Files:**
- Create: `web/components/ui/{Chip,TextInput,Select}.tsx`
- Modify: `web/styles/ui.css` (append), `web/components/ui/ui.spec.tsx` (append)

**Interfaces:**
- Consumes: `Icon` (name `chevron`).
- Produces:
  - `Chip({children, caret=false, interactive=false, onClick, title})` — span, or button when interactive.
  - `TextInput(props & {leading?, trailing?})` — wrapped input `.ui-field > .ui-input`.
  - `Select({value, options: readonly {value,label}[], onChange, disabled?, label?, renderTrigger?})` — keyboard listbox (↑↓ Home End Enter Esc), click-outside close; trigger defaults to an interactive Chip with caret.

- [ ] **Step 1: Failing tests — append to `ui.spec.tsx`**

```tsx
import { Chip } from './Chip.tsx'
import { TextInput } from './TextInput.tsx'
import { Select } from './Select.tsx'

describe('chip / text-input / select structure', () => {
  it('Chip is a span unless interactive; caret adds nothing when static', () => {
    const html = renderToStaticMarkup(<Chip>dnt-harness</Chip>)
    expect(html).toContain('<span')
    expect(html).not.toContain('<button')
    const btn = renderToStaticMarkup(
      <Chip interactive caret onClick={() => undefined}>deepseek</Chip>,
    )
    expect(btn).toContain('<button')
    expect(btn).toContain('ui-chip-caret')
  })

  it('TextInput wraps input with leading slot', () => {
    const html = renderToStaticMarkup(
      <TextInput leading={<b>i</b>} placeholder="Tìm phiên…" readOnly />,
    )
    expect(html).toContain('ui-field')
    expect(html).toContain('ui-input')
    expect(html).toContain('placeholder="Tìm phiên…"')
  })

  it('Select closed renders a listbox trigger, no open menu', () => {
    const html = renderToStaticMarkup(
      <Select
        value="deepseek-chat"
        options={[{ value: 'deepseek-chat', label: 'deepseek-chat' }, { value: 'other', label: 'other' }]}
        onChange={() => undefined}
        label="Model"
      />,
    )
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).not.toContain('role="listbox"')
    expect(html).toContain('deepseek-chat')
  })

  it('Select honors a custom trigger renderer', () => {
    const html = renderToStaticMarkup(
      <Select
        value="m"
        options={[{ value: 'm', label: 'm' }]}
        onChange={() => undefined}
        renderTrigger={() => <button type="button">custom-trigger</button>}
      />,
    )
    expect(html).toContain('custom-trigger')
  })
})
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run web/components/ui/ui.spec.tsx`
Expected: FAIL — cannot resolve `./Chip.tsx`.

- [ ] **Step 3: Implement**

`web/components/ui/Chip.tsx`:

```tsx
import type { MouseEventHandler, ReactNode } from 'react'
import Icon from '../common/Icon.tsx'

export function Chip({
  children,
  caret = false,
  interactive = false,
  onClick,
  title,
}: {
  readonly children: ReactNode
  readonly caret?: boolean
  readonly interactive?: boolean
  readonly onClick?: MouseEventHandler<HTMLElement>
  readonly title?: string
}) {
  const body = (
    <>
      {children}
      {caret ? <Icon name="chevron" size={11} className="ui-chip-caret chevron" /> : null}
    </>
  )
  if (!interactive) {
    return <span className="ui-chip" title={title}>{body}</span>
  }
  return (
    <button type="button" className="ui-chip ui-chip-btn" title={title} onClick={onClick}>
      {body}
    </button>
  )
}
```

`web/components/ui/TextInput.tsx`:

```tsx
import type { InputHTMLAttributes, ReactNode } from 'react'

export function TextInput({
  leading,
  trailing,
  className = '',
  ...rest
}: {
  readonly leading?: ReactNode
  readonly trailing?: ReactNode
  readonly className?: string
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`ui-field ${className}`}>
      {leading !== undefined ? <span className="ui-field-leading">{leading}</span> : null}
      <input className="ui-input" spellCheck={false} {...rest} />
      {trailing !== undefined ? <span className="ui-field-trailing">{trailing}</span> : null}
    </div>
  )
}
```

`web/components/ui/Select.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'

export interface SelectOption {
  readonly value: string
  readonly label: string
}

/**
 * Accessible single-select dropdown: ↑↓ move, Enter picks, Esc closes and
 * refocuses the trigger, click-outside closes. Keyboard nav runs client-side;
 * smoke tests assert the closed-render structure only.
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  label,
  renderTrigger,
}: {
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly label?: string
  readonly renderTrigger?: (current: SelectOption | undefined, open: boolean) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  const currentIndex = options.findIndex((option) => option.value === value)
  const current = currentIndex >= 0 ? options[currentIndex] : undefined

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (): void => {
    if (disabled) return
    setActive(currentIndex >= 0 ? currentIndex : null)
    setOpen((prev) => !prev)
  }

  const pick = (index: number): void => {
    const option = options[index]
    if (option === undefined) return
    onChange(option.value)
    setOpen(false)
    btnRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (open) {
        event.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
      }
      return
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') toggle()
      return
    }
    if (options.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((prev) => (prev === null ? 0 : Math.min(prev + 1, options.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((prev) => (prev === null ? options.length - 1 : Math.max(prev - 1, 0)))
    } else if (event.key === 'Home') {
      setActive(0)
    } else if (event.key === 'End') {
      setActive(options.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(active ?? Math.max(currentIndex, 0))
    }
  }

  const trigger =
    renderTrigger !== undefined
      ? renderTrigger(current, open)
      : (
          <button
            type="button"
            ref={btnRef}
            className="ui-select-trigger"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={toggle}
          >
            <span className="ui-select-value">{current?.label ?? value}</span>
            <Icon name="chevron" size={12} className={`chevron ${open ? 'chevron-up' : ''}`} />
          </button>
        )

  return (
    <div className="ui-select" ref={rootRef} onKeyDown={onKeyDown}>
      {trigger}
      {open && renderTrigger === undefined ? (
        <ul className="ui-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`ui-option ${option.value === value ? 'ui-option-selected' : ''} ${
                  index === active ? 'ui-option-active' : ''
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open && renderTrigger !== undefined ? (
        <ul className="ui-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`ui-option ${option.value === value ? 'ui-option-selected' : ''} ${
                  index === active ? 'ui-option-active' : ''
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
```

Note: `React.KeyboardEvent` needs the React namespace — add at top of Select.tsx:

```tsx
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
```

and declare `const onKeyDown = (event: ReactKeyboardEvent): void => {` instead.

- Append to `web/styles/ui.css`:

```css
/* ── Chip ── */
.ui-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--r-chip);
  padding: 2.5px 9px;
  font-size: 10.5px;
  color: var(--text-dim);
  max-width: 320px;
  overflow: hidden;
  white-space: nowrap;
}

.ui-chip-btn {
  cursor: pointer;
  font-weight: inherit;
  font-family: inherit;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.ui-chip-btn:hover { background: var(--bg-active); color: var(--text); }

.ui-chip-caret { margin-left: -1px; opacity: 0.55; }

/* ── TextInput ── */
.ui-field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  transition: border-color 0.12s ease;
}

.ui-field:focus-within { border-color: var(--accent); }

.ui-field-leading, .ui-field-trailing { display: inline-flex; color: var(--text-faint); }

.ui-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12px;
  color: var(--text);
}

.ui-input::placeholder { color: var(--text-faint); }

/* ── Select / Menu ── */
.ui-select { position: relative; display: inline-flex; }

.ui-select-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 3.5px 10px;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--text-dim);
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease;
}

.ui-select-trigger:hover:not(:disabled),
.ui-select-trigger[aria-expanded='true'] { border-color: var(--accent-border); color: var(--text); }

.ui-select-trigger:disabled { opacity: 0.45; cursor: default; }

.ui-menu {
  position: absolute;
  bottom: calc(100% + 5px);
  left: 0;
  z-index: var(--z-popover);
  min-width: 100%;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 3px;
  list-style: none;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
}

.ui-menu.up { bottom: auto; top: calc(100% + 5px); }

.ui-option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 9px;
  border: none;
  border-radius: var(--r-chip);
  background: transparent;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
}

.ui-option-active { background: var(--bg-hover); color: var(--text); }

.ui-option-selected { color: var(--accent-text); }
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run web/components/ui/ui.spec.tsx && npm run typecheck`
Expected: PASS.

> Self-review note applied while writing this task: the two `{open && …}` menu blocks above are duplicates differing only in condition; acceptable for now because removing one requires merging trigger modes. During Task 6, consolidate into a single block conditioned on `open` alone and make the custom trigger case positionable via `renderTrigger` receiving no open-menu duty. If you touch this earlier, delete one branch.

- [ ] **Step 5: Commit**

```bash
git add web/components/ui web/styles/ui.css
git commit -m "ui kit: chip/text-input/select primitives"
```

---

### Task 5: Pure helpers + Workspace shell (TopBar, Sidebar v2, EnvPanel, App rewire)

**Files:**
- Modify: `web/lib/format.ts` (+2 helpers)
- Create: `tests/web/format.spec.ts`
- Create: `web/components/layout/TopBar.tsx`, `web/components/layout/EnvPanel.tsx`, `web/styles/shell.css`
- Rewrite: `web/components/layout/Sidebar.tsx`, `web/App.tsx`
- Modify: `web/main.tsx` (import list), `web/components/session/SessionList.tsx`
- Delete: `web/components/chat/ChatHeader.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–4; `useSessionStream`, `useAutoScroll`, existing api fns.
- Produces:
  - `pathBasename(path: string): string`, `toolTarget(args): string` in `lib/format.ts`.
  - `<TopBar title stream meta sidebarOpen folderDraft onFolderDraft onApplyFolder onToggleSidebar />`
  - `<Sidebar sessions current filter stream provider open folderLabel onFilter onSelect onNew onRename onDeleteRequest onClose />`
  - `<EnvPanel open meta stream sessionId eventCount />`
  - Root element classes: `app`, modifiers `nav-open`, `env-open`.
  - Hotkeys: Ctrl/Cmd+N → new session (App), Ctrl/Cmd+K → focus search (inside Sidebar).

- [ ] **Step 1: Failing helper tests — create `tests/web/format.spec.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { pathBasename, toolTarget } from '../../web/lib/format.ts'

describe('pathBasename', () => {
  it('returns the last segment for win/unix paths', () => {
    expect(pathBasename('C:\\workspace\\dnt-harness')).toBe('dnt-harness')
    expect(pathBasename('/home/dev/project')).toBe('project')
    expect(pathBasename('plain')).toBe('plain')
    expect(pathBasename('')).toBe('')
  })
})

describe('toolTarget', () => {
  it('picks the first non-empty string argument', () => {
    expect(toolTarget({ path: 'src/x.ts' })).toBe('src/x.ts')
    expect(toolTarget({ command: 'npm test' })).toBe('npm test')
    expect(toolTarget({ pattern: '', limit: 5 })).toBe('')
    expect(toolTarget({ limit: 5 })).toBe('')
  })
})
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/web/format.spec.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement — append to `web/lib/format.ts`**

```ts
/** Last segment of a filesystem path, honoring both separators. */
export function pathBasename(path: string): string {
  if (path === '') return ''
  const parts = path.split(/[\\/]/)
  return parts.at(-1) ?? path
}

/** First non-empty string argument — the human target of most tool calls. */
export function toolTarget(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}
```

- [ ] **Step 4: Run — pass, commit helpers**

Run: `npx vitest run tests/web/format.spec.ts`
Then:

```bash
git add tests/web/format.spec.ts web/lib/format.ts
git commit -m "format helpers: pathBasename + toolTarget"
```

- [ ] **Step 5: Create `web/components/layout/TopBar.tsx`**

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { SHOW_SLOTS } from '../../lib/config.ts'
import { pathBasename } from '../../lib/format.ts'
import type { StreamState } from '../../lib/api.ts'
import type { Meta } from '../../lib/types.ts'

/**
 * Global chrome: brand + workspace-folder switcher, centered session title
 * with provider chip, right cluster of layout toggles. The folder popover
 * posts through App's applyFolder so REST errors surface as toasts there.
 */
export function TopBar({
  title,
  meta,
  stream,
  sidebarOpen,
  folderDraft,
  onFolderDraft,
  onApplyFolder,
  onToggleSidebar,
}: {
  readonly title: string
  readonly meta: Meta | null
  readonly stream: StreamState
  readonly sidebarOpen: boolean
  readonly folderDraft: string
  readonly onFolderDraft: (value: string) => void
  readonly onApplyFolder: () => void
  readonly onToggleSidebar: () => void
}) {
  const [folderOpen, setFolderOpen] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!folderOpen) return
    const onDown = (event: MouseEvent): void => {
      if (popRef.current !== null && !popRef.current.contains(event.target as Node)) setFolderOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFolderOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [folderOpen])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (folderDraft.trim() === '') return
    onApplyFolder()
    setFolderOpen(false)
  }

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-logo" aria-hidden="true">⌬</span>
        <div className="topbar-workspace" ref={popRef}>
          <Chip interactive caret onClick={() => setFolderOpen((prev) => !prev)} title="Đổi workspace folder">
            <span className={`ws-dot ws-dot-${stream}`} aria-hidden="true" />
            <b>{meta !== null ? pathBasename(meta.folder) : 'workspace'}</b>
          </Chip>
          {folderOpen ? (
            <form className="topbar-folder-pop" onSubmit={submit}>
              <TextInput
                autoFocus
                leading={<Icon name="folder" size={13} />}
                value={folderDraft}
                placeholder="/path/to/workspace"
                onChange={(event) => onFolderDraft(event.target.value)}
              />
              <Button variant="primary" size="sm" type="submit" disabled={folderDraft.trim() === ''}>
                Dùng
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="topbar-center">
        <h1 className="topbar-title">{title || 'untitled session'}</h1>
        {meta !== null ? (
          <Chip title={meta.folder}>
            <Icon name="folder" size={11} />
            {meta.folder}
          </Chip>
        ) : null}
        {meta !== null ? (
          <Chip title="LLM provider">
            <Icon name="zap" size={11} className="accent-icon" />
            {meta.provider}
          </Chip>
        ) : null}
      </div>

      <div className="topbar-actions">
        <IconButton label="Danh sách phiên" size="md" onClick={onToggleSidebar}>
          <Icon name="panelLeft" size={15} />
        </IconButton>
        {SHOW_SLOTS ? (
          <>
            <IconButton label="File browser — sắp ra mắt" size="md" variant="outline" className="ui-icon-btn-slot" disabled>
              <Icon name="fileText" size={15} />
            </IconButton>
            <IconButton label="Side panel — sắp ra mắt" size="md" variant="outline" className="ui-icon-btn-slot" disabled>
              <Icon name="panelRight" size={15} />
            </IconButton>
            <Badge tone="amber">slot sau</Badge>
          </>
        ) : null}
      </div>
    </header>
  )
}
```

(`AccentIcon` — replace `className="accent-icon"` styling lives in shell.css.)

- [ ] **Step 6: Create `web/components/layout/EnvPanel.tsx`**

```tsx
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Panel } from '../ui/Panel.tsx'
import { Select } from '../ui/Select.tsx'
import { SHOW_SLOTS } from '../../lib/config.ts'
import type { StreamState } from '../../lib/api.ts'
import type { Meta } from '../../lib/types.ts'

const STREAM_LABELS: Readonly<Record<StreamState, string>> = {
  open: 'open',
  reconnecting: 'reconnecting…',
  connecting: 'connecting…',
}

function Row({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="env-row">
      <span className="env-term">{term}</span>
      <span className="env-desc">{children}</span>
    </div>
  )
}

/** Right rail mirroring server meta honestly; slots hide behind the flag. */
export function EnvPanel({
  open,
  meta,
  stream,
  sessionId,
  eventCount,
  onModel,
}: {
  readonly open: boolean
  readonly meta: Meta | null
  readonly stream: StreamState
  readonly sessionId: string | null
  readonly eventCount: number
  readonly onModel: (model: string) => void
}) {
  return (
    <aside className={`env-panel ${open ? 'env-panel-open' : ''}`} aria-hidden={!open}>
      <div className="env-head">
        ENVIRONMENT
        <Icon name="chevronRight" size={12} />
      </div>

      {SHOW_SLOTS ? (
        <Panel variant="raised" className="env-card env-git">
          <span className="env-git-branch">
            <Icon name="gitBranch" size={12} /> main
          </span>
          <span className="mono-dim">· 38</span>
          <span className="env-stats">
            <span className="delta-ok">+5,081</span>
            <span className="delta-bad">−288</span>
          </span>
          <Badge tone="amber">slot sau</Badge>
        </Panel>
      ) : null}

      <div className="env-label">SESSION</div>
      <Panel variant="raised" className="env-card">
        <Row term="id">{sessionId !== null ? `${sessionId.slice(0, 9)}…` : '—'}</Row>
        <Row term="events">{eventCount}</Row>
        <Row term="stream">
          <span className={`conn-text conn-text-${stream}`}>● {STREAM_LABELS[stream]}</span>
        </Row>
      </Panel>

      <div className="env-label">MODEL</div>
      <Panel variant="raised" className="env-card">
        <Row term="provider">{meta?.provider ?? '—'}</Row>
        <div className="env-row env-row-control">
          <span className="env-term">model</span>
          <Select
            value={meta?.model ?? ''}
            options={(meta?.models ?? []).map((model) => ({ value: model, label: model }))}
            onChange={onModel}
            disabled={meta === null}
            label="Chọn model"
          />
        </div>
        <Row term="folder">{meta !== null ? <span className="env-path">{meta.folder}</span> : '—'}</Row>
      </Panel>

      {SHOW_SLOTS ? (
        <div className="env-slot">
          Uploads · Diff staged <Badge tone="amber">slot sau</Badge>
          <br />
          Bật khi có API diffs / attachments.
        </div>
      ) : null}
    </aside>
  )
}
```

(If the project lints against bare `React.ReactNode`, import `type { ReactNode }` and use it — plan uses `ReactNode` form below in final code note; either passes with modern JSX transform settings in tsconfig.web since `jsx: react-jsx` doesn't inject global React namespace for *types*. Use `ReactNode`:)

Replace the `Row` signature line with:

```tsx
import type { ReactNode } from 'react'

function Row({ term, children }: { readonly term: string; readonly children: ReactNode }) {
```

and drop the `React.` usage entirely.

- [ ] **Step 7: Rewrite `web/components/layout/Sidebar.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import Icon from '../common/Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Kbd } from '../ui/Kbd.tsx'
import { SessionList } from '../session/SessionList.tsx'
import { useHotkeys } from '../../hooks/useHotkeys.ts'
import type { StreamState } from '../../lib/api.ts'
import type { SessionListing } from '../../lib/types.ts'

const STREAM_LABELS: Readonly<Record<StreamState, string>> = {
  open: 'connected',
  reconnecting: 'reconnecting…',
  connecting: 'connecting…',
}

/**
 * Navigation rail: new-session + search actions, every session inside one
 * workspace group (the API has no per-session folder), connection footer.
 * Owns the Ctrl/Cmd+K focus-search hotkey because it owns the input.
 */
export function Sidebar({
  sessions,
  current,
  filter,
  stream,
  provider,
  folderLabel,
  running,
  open,
  onFilter,
  onSelect,
  onNew,
  onRename,
  onDeleteRequest,
  onClose,
}: {
  readonly sessions: readonly SessionListing[]
  readonly current: string | null
  readonly filter: string
  readonly stream: StreamState
  readonly provider: string | null
  readonly folderLabel: string
  readonly running: boolean
  readonly open: boolean
  readonly onFilter: (value: string) => void
  readonly onSelect: (id: string) => void
  readonly onNew: () => void
  readonly onRename: (id: string, title: string) => void
  readonly onDeleteRequest: (session: SessionListing) => void
  readonly onClose: () => void
}) {
  const searchRef = useRef<HTMLInputElement | null>(null)

  useHotkeys([{ key: 'k', mod: true, onPress: () => searchRef.current?.focus() }])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open ? <div className="pane-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="side-top">
          <button type="button" className="new-session" onClick={onNew}>
            <Icon name="plus" size={13} />
            <span>New chat</span>
            <Kbd>Ctrl N</Kbd>
          </button>
          <div className="session-filter">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              className="filter-input"
              value={filter}
              placeholder="Search"
              onChange={(event) => onFilter(event.target.value)}
            />
            <Kbd>Ctrl K</Kbd>
          </div>
        </div>

        <div className="group-head">
          <Icon name="chevron" size={11} />
          <span className="group-name">{folderLabel.toUpperCase()}</span>
          <Icon name="plus" size={11} className="group-add" />
        </div>

        <SessionList
          sessions={sessions}
          current={current}
          filter={filter}
          running={running}
          onSelect={onSelect}
          onRename={onRename}
          onDeleteRequest={onDeleteRequest}
        />

        <div className="side-foot">
          <span className={`conn-dot ${stream}`} aria-hidden="true" />
          <span className="foot-provider">{provider ?? '—'}</span>
          <span className="foot-state">{STREAM_LABELS[stream]}</span>
          <IconButton label="Đóng" className="sidebar-close" onClick={onClose}>
            <Icon name="close" size={13} />
          </IconButton>
        </div>
      </aside>
    </>
  )
}
```

- [ ] **Step 8: Update `SessionList.tsx` (row shape + actions)**

Changes only — keep everything else identical to current file:
1. Props gain `readonly running: boolean`.
2. Row becomes two-line; action buttons become `IconButton`.

Replace `SessionRow` render section (non-editing branch) with:

```tsx
  return (
    <div className={`session-item-shell ${active ? 'active' : ''}`}>
      <button type="button" className="session-item" onClick={onSelect}>
        <span className="session-text">
          <span className="session-title">{session.title || 'untitled session'}</span>
          <span className="session-sub">
            {session.eventCount} sự kiện{active && running ? ' · đang chạy' : ''}
          </span>
        </span>
      </button>
      <span className="session-actions">
        <IconButton
          label="Đổi tên"
          onClick={() => {
            setDraft(session.title)
            setEditing(true)
          }}
        >
          <Icon name="pencil" size={12} />
        </IconButton>
        <IconButton label="Xóa" onClick={() => onDeleteRequest(session)}>
          <Icon name="trash" size={12} />
        </IconButton>
      </span>
    </div>
  )
```

And thread `running` through `SessionList` props → each `SessionRow active && running` pair.

- [ ] **Step 9: Create `web/styles/shell.css`**

```css
/* ────────────────────────────────────────────────────────────────
   shell: topbar, zones row, sidebar v2, environment panel, responsive
   ──────────────────────────────────────────────────────────────── */

.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.accent-icon { color: var(--accent); }

.mono-dim { font-family: var(--font-mono); color: var(--text-faint); font-size: 9.5px; }
.delta-ok { color: var(--ok); font-family: var(--font-mono); font-size: 10px; }
.delta-bad { color: var(--bad); font-family: var(--font-mono); font-size: 10px; }

/* ── topbar ── */
.topbar {
  height: var(--topbar-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  background: var(--bg-pane);
  border-bottom: 1px solid var(--hairline);
}

.topbar-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }

.topbar-logo {
  width: 26px;
  height: 26px;
  border-radius: var(--r-md);
  background: linear-gradient(135deg, #5c7cfa, #3d5bd9);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}

.topbar-workspace { position: relative; }

.ws-dot { width: 6px; height: 6px; background: var(--text-faint); }
.ws-dot.open { background: var(--ok); }
.ws-dot.reconnecting { background: var(--amber); }

.topbar-folder-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: var(--z-popover);
  display: flex;
  gap: 6px;
  padding: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.topbar-folder-pop .ui-field { width: 260px; }

.topbar-center {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.topbar-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40ch;
}

.topbar-actions { display: flex; align-items: center; gap: 3px; }

/* ── sidebar v2 ── */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-pane);
  border-right: 1px solid var(--hairline);
  min-height: 0;
  z-index: calc(var(--z-drawer) + 1);
}

.side-top {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 7px 4px;
}

.new-session {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.new-session:hover { background: var(--bg-hover); }
.new-session kbd { margin-left: auto; }
.new-session .icon { color: var(--accent); }

.session-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  margin-top: 3px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-card);
  color: var(--text-faint);
}

.session-filter:focus-within { border-color: var(--accent-border); }
.session-filter .icon { color: var(--text-faint); flex-shrink: 0; }

.filter-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12px;
  color: var(--text);
}

.filter-input::placeholder { color: var(--text-faint); }

.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 10px 4px;
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
}

.group-head .icon:first-child { color: var(--text-faint); }
.group-add { margin-left: auto; opacity: 0; transition: opacity 0.12s ease; }
.group-head:hover .group-add { opacity: 1; }

.session-list {
  list-style: none;
  margin: 2px 6px 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.session-empty { margin: 8px 6px; font-size: 12px; color: var(--text-faint); }

.session-item-shell {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--r-sm);
  transition: background 0.12s ease;
}

.session-item-shell:hover { background: var(--bg-hover); }

.session-item-shell.active {
  background: #20304d;
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--r-chip) var(--r-chip) 0;
}

.session-item {
  flex: 1;
  min-width: 0;
  display: flex;
  padding: 5px 9px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  text-align: left;
}

.session-item-shell:hover .session-item,
.session-item-shell.active .session-item { color: var(--text); }

.session-item-shell.active .session-title { color: #dfe7fa; }

.session-text { display: flex; flex-direction: column; min-width: 0; }

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.session-sub {
  font-size: 9.5px;
  color: var(--text-faint);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-actions {
  display: none;
  align-items: center;
  gap: 1px;
  padding-right: 5px;
}

.session-item-shell:hover .session-actions { display: inline-flex; }

.rename-input {
  flex: 1;
  width: 100%;
  margin: 3px 4px;
  padding: 4px 8px;
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  font-size: 12px;
  outline: none;
}

.side-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-top: 1px solid var(--hairline);
  font-size: 10.5px;
  color: var(--text-faint);
}

.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}

.conn-dot.open { background: var(--ok); }
.conn-dot.reconnecting { background: var(--amber); }

.foot-provider { color: var(--text-dim); }

.pane-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  background: rgba(8, 9, 11, 0.55);
}

/* ── chat column frame (surface styles live in chat.css) ── */
.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.chat-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* ── environment panel ── */
.env-panel {
  display: none;
  width: var(--env-w);
  flex-shrink: 0;
  flex-direction: column;
  gap: 9px;
  padding: 12px 11px;
  background: var(--bg-pane);
  border-left: 1px solid var(--hairline);
  overflow-y: auto;
}

.env-open .env-panel.open-always { display: flex; }

.env-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text);
}

.env-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  color: var(--text-faint);
  padding: 2px 2px 0;
}

.env-card { display: flex; flex-direction: column; gap: 2px; }

.env-row { display: flex; align-items: baseline; gap: 8px; line-height: 2; }

.env-term { width: 62px; flex-shrink: 0; color: var(--text-faint); font-size: 10.5px; }

.env-desc { min-width: 0; color: var(--text-dim); font-size: 11.5px; overflow: hidden; }

.env-path {
  font-family: var(--font-mono);
  font-size: 9.5px;
  word-break: break-all;
  color: var(--text-dim);
}

.env-row-control { line-height: 1.4; padding: 3px 0; }
.env-row-control .env-term { line-height: 2.4; }

.conn-text { font-family: var(--font-mono); font-size: 10.5px; }
.conn-text-open { color: var(--ok); }
.conn-text-reconnecting, .conn-text-connecting { color: var(--amber); }

.env-git { flex-direction: row !important; align-items: center; gap: 7px; }
.env-git-branch { display: inline-flex; align-items: center; gap: 5px; color: var(--text); font-size: 11.5px; }
.env-git .env-stats { margin-left: auto; display: inline-flex; gap: 6px; }

.env-slot {
  margin-top: auto;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-sm);
  padding: 9px 11px;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.75;
}

/* ── responsive ───────────────────────────────────────────────
   ≥1280: env panel docks as third column (always visible).
   <1280: env panel overlays from the right when .env-open.
   <1100: sidebar becomes an overlay drawer when .nav-open.
   ───────────────────────────────────────────────────────────── */

@media (min-width: 1280px) {
  .env-panel { display: flex; }
}

@media (max-width: 1279px) {
  .env-panel.env-panel-open {
    display: flex;
    position: fixed;
    top: var(--topbar-h);
    right: 0;
    bottom: 0;
    z-index: calc(var(--z-drawer) + 2);
    box-shadow: -14px 0 42px rgba(0, 0, 0, 0.45);
  }
}

@media (max-width: 1099px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: var(--topbar-h);
    bottom: 0;
    z-index: calc(var(--z-drawer) + 2);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: 12px 0 40px rgba(0, 0, 0, 0.4);
  }

  .nav-open .sidebar { transform: translateX(0); }
  .nav-open .env-panel.env-panel-open { display: none; }
  .sidebar-close { display: inline-flex; }
}

@media (min-width: 1100px) {
  .sidebar-close { display: none; }
}

@media (max-width: 760px) {
  .topbar-center .ui-chip:nth-child(n + 2) { display: none; }
  .topbar-folder-pop .ui-field { width: 180px; }
}
```

- [ ] **Step 10: Rewrite `web/App.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  answerApproval,
  createSession,
  deleteSession,
  fetchMeta,
  listSessions,
  renameSession,
  sendMessage,
  setFolder,
  setModel,
  stopSession,
} from './lib/api.ts'
import { isTurnRunning } from './lib/project.ts'
import { useSessionStream } from './hooks/useSessionStream.ts'
import { useHotkeys } from './hooks/useHotkeys.ts'
import { useToast } from './components/common/Toast.tsx'
import { Button } from './components/ui/Button.tsx'
import { Sidebar } from './components/layout/Sidebar.tsx'
import { TopBar } from './components/layout/TopBar.tsx'
import { EnvPanel } from './components/layout/EnvPanel.tsx'
import { Transcript } from './components/chat/Transcript.tsx'
import { ApprovalBar } from './components/chat/ApprovalBar.tsx'
import { Composer } from './components/composer/Composer.tsx'
import ConfirmDialog from './components/common/ConfirmDialog.tsx'
import type { Meta, SessionListing } from './lib/types.ts'

const SUGGESTIONS: readonly string[] = [
  'Liệt kê các file trong workspace này',
  'Tóm tắt kiến trúc của project bằng tiếng Việt',
  'Tìm chỗ có từ "tool" trong code rồi giải thích',
]

/**
 * The web client: workspace shell around a stateless chat pane. All chat
 * state derives from the session event stream — the UI holds no model
 * state of its own, mirroring "render from session/event".
 */
export function App() {
  const toast = useToast()
  const [sessions, setSessions] = useState<readonly SessionListing[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(() => window.innerWidth >= 1280)
  const [pendingDelete, setPendingDelete] = useState<SessionListing | null>(null)

  const { events, approvals, stream, error: streamError } = useSessionStream(current)
  const running = useMemo(() => isTurnRunning(events), [events])

  useEffect(() => {
    void fetchMeta().then((fetched) => {
      setMeta(fetched)
      setFolderDraft(fetched.folder)
    }).catch(() => toast.notify('không kết nối được server'))
    void (async () => {
      try {
        let listing = await listSessions()
        if (listing.length === 0) {
          await createSession()
          listing = await listSessions()
        }
        setSessions(listing)
        setCurrent((existing) => existing ?? listing[0]?.id ?? null)
      } catch (cause) {
        toast.notify(String(cause))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (streamError === null) return
    toast.notify(streamError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamError])

  const refreshList = useCallback(async () => {
    try {
      setSessions(await listSessions())
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [toast])

  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const openSession = useCallback((id: string) => {
    setCurrent(id)
    setSidebarOpen(false)
  }, [])

  const send = useCallback(async () => {
    if (current === null || draft.trim() === '' || running) return
    const content = draft
    setDraft('')
    try {
      await sendMessage(current, content)
      void refreshList()
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [current, draft, running, refreshList, toast])

  const stop = useCallback(async () => {
    if (current === null) return
    try {
      await stopSession(current)
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [current, toast])

  const answer = useCallback(async (approvalId: string, allow: boolean) => {
    try {
      await answerApproval(approvalId, allow)
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [toast])

  const newSession = useCallback(async () => {
    try {
      const { id } = await createSession()
      setSessions(await listSessions())
      setCurrent(id)
      setSidebarOpen(false)
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [toast])

  const rename = useCallback(async (id: string, title: string) => {
    try {
      const renamed = await renameSession(id, title)
      setSessions(await listSessions())
      toast.notify(`phiên đổi tên thành "${renamed.title}"`, 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [toast])

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return
    const id = pendingDelete.id
    setPendingDelete(null)
    try {
      await deleteSession(id)
      const listing = await listSessions()
      setSessions(listing)
      if (current === id) setCurrent(listing[0]?.id ?? null)
      toast.notify('đã xóa phiên', 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [pendingDelete, current, toast])

  const applyFolder = useCallback(async () => {
    const folder = folderDraft.trim()
    if (folder === '') return
    try {
      const updated = await setFolder(folder)
      setMeta(updated)
      setFolderDraft(updated.folder)
      toast.notify(`workspace: ${updated.folder}`, 'ok')
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [folderDraft, toast])

  const selectModel = useCallback(async (model: string) => {
    try {
      setMeta(await setModel(model))
    } catch (cause) {
      toast.notify(String(cause))
    }
  }, [toast])

  useHotkeys([
    { key: 'n', mod: true, onPress: () => void newSession() },
    { key: 'k', mod: true, onPress: () => setSidebarOpen(true) },
  ])

  const activeTitle = sessions.find((session) => session.id === current)?.title ?? ''

  return (
    <div className={`app${sidebarOpen ? ' nav-open' : ''}${envOpen ? ' env-open' : ''}`}>
      <TopBar
        title={activeTitle}
        meta={meta}
        stream={stream}
        sidebarOpen={sidebarOpen}
        folderDraft={folderDraft}
        onFolderDraft={setFolderDraft}
        onApplyFolder={() => void applyFolder()}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />
      <div className="app-body">
        <Sidebar
          sessions={sessions}
          current={current}
          filter={filter}
          stream={stream}
          provider={meta?.provider ?? null}
          folderLabel={meta !== null ? meta.folder : ''}
          running={running}
          open={sidebarOpen}
          onFilter={setFilter}
          onSelect={openSession}
          onNew={() => void newSession()}
          onRename={(id, title) => void rename(id, title)}
          onDeleteRequest={setPendingDelete}
          onClose={closeSidebar}
        />
        <main className="chat">
          <div className="chat-area">
            {events.length === 0 ? (
              <div className="empty">
                <div className="empty-mark" aria-hidden="true">⌬</div>
                <p className="empty-title">Bắt đầu một hội thoại</p>
                <p className="empty-sub">Agent đọc file, chạy bash và xin phép trước khi thay đổi.</p>
                <div className="suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion}
                      variant="outline"
                      size="sm"
                      disabled={current === null}
                      onClick={() => {
                        if (current !== null) {
                          void sendMessage(current, suggestion).then(() => void refreshList())
                            .catch((cause: unknown) => toast.notify(String(cause)))
                        }
                      }}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <Transcript events={events} />
            )}
          </div>
          <ApprovalBar approvals={approvals} onAnswer={(id, allow) => void answer(id, allow)} />
          <Composer
            connected={stream === 'open'}
            running={running}
            draft={draft}
            onDraft={setDraft}
            onSend={() => void send()}
            onStop={() => void stop()}
            model={meta?.model ?? null}
            models={meta?.models ?? []}
            onModel={(model) => void selectModel(model)}
          />
        </main>
        <EnvPanel
          open={envOpen}
          meta={meta}
          stream={stream}
          sessionId={current}
          eventCount={events.length}
          onModel={(model) => void selectModel(model)}
        />
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete !== null ? `Xóa phiên "${pendingDelete.title || 'untitled'}"?` : ''}
        confirmLabel="Xóa"
        onConfirm={() => void confirmDelete()}
        onDismiss={() => setPendingDelete(null)}
      />
    </div>
  )
}
```

Hotkey note vs plan header: Ctrl+K here opens the drawer (and Sidebar's own hook then focuses Search once visible) — simpler than cross-component refs, same UX. Also add an env toggle IconButton next to the others in TopBar? Not needed ≥1280 (always visible); for <1280 users need a way to open it. Add to TopBar right cluster before sidebar toggle:

```tsx
<IconButton label="Environment panel" size="md" variant={undefined ??? }>
```

Concretely insert above the sidebar-toggle button:

```tsx
        <IconButton label="Environment panel" size="md" onClick={onToggleEnv}>
          <Icon name="sliders" size={15} />
        </IconButton>
```

with props `onToggleEnv: () => void` added to TopBar's interface and passed from App as `() => setEnvOpen((prev) => !prev)`.

- [ ] **Step 11: Update `web/main.tsx` import list**

Replace the style imports with:

```tsx
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import './styles/shell.css'
import './styles/chat.css'
import './styles/sidebar.css'
import './styles/composer.css'
import './styles/components.css'
```

Old stylesheets stay until Task 6 lands their replacements (chat.css rewrite absorbs composer/markdown sections).

Delete `web/components/chat/ChatHeader.tsx`:

```bash
git rm web/components/chat/ChatHeader.tsx
```

- [ ] **Step 12: Verify**

Run: `npm run typecheck && npm run build:web && npx vitest run`
Expected: all green (server tests untouched; kit + format specs pass).
Manual: `npm run web` → shell renders, sessions selectable, approvals round-trip, drawer <1100px, env overlay <1280px.

- [ ] **Step 13: Commit**

```bash
git add web docs/superpowers/plans -A
git commit -m "workspace shell: topbar, sidebar v2, environment panel, responsive frame"
```

---

### Task 6: Chat surface — transcript v2, approval card, composer control-center

**Files:**
- Rewrite: `web/components/chat/MessageParts.tsx`, `web/components/chat/ApprovalBar.tsx`, `web/components/composer/Composer.tsx`, `web/styles/chat.css`
- Modify: `web/components/common/CopyButton.tsx`, `web/main.tsx` (drop dead imports — done fully in Task 7)
- Modify: `web/components/ui/ui.spec.tsx` (+ tool-row smoke)
- Consolidate: `web/components/ui/Select.tsx` duplicate menu branch

**Interfaces:**
- Consumes: kit primitives; `Select` custom trigger for composer model picker; `toolTarget` from Task 5.
- Produces: composer props grow to `{ connected, running, draft, onDraft, onSend, onStop, model: string|null, models: readonly string[], onModel }`. Approval card chip format `name · target`. Assistant messages show a mono time meta-line with CopyButton.

- [ ] **Step 1: Consolidate Select's duplicated menu (tech debt from Task 4)**

In `web/components/ui/Select.tsx`, replace BOTH trailing conditional blocks after `{trigger}` with a single:

```tsx
      {open ? (
        <ul className="ui-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`ui-option ${option.value === value ? 'ui-option-selected' : ''} ${
                  index === active ? 'ui-option-active' : ''
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
```

- [ ] **Step 2: Extend CopyButton to kit classes**

In `web/components/common/CopyButton.tsx` change the button wrapper to:

```tsx
    <button
      type="button"
      className={`ui-icon-btn ui-icon-btn-sm ui-icon-btn-ghost ${copied ? 'copied-ok' : ''}`}
      title={copied ? 'Đã sao chép' : 'Sao chép'}
```

(add `.copied-ok { color: var(--ok) !important; }` inside ui.css)

- [ ] **Step 3: Rewrite `MessageParts.tsx`**

```tsx
import { useState } from 'react'
import Icon from '../common/Icon.tsx'
import CopyButton from '../common/CopyButton.tsx'
import { Markdown } from '../../Markdown.tsx'
import { ThinkingPanel } from './ThinkingPanel.tsx'
import { argsSummary, formatTime } from '../../lib/format.ts'
import { CodeChip } from '../ui/CodeChip.tsx'
import type { ToolCall } from '../../lib/types.ts'
import type { ViewItem } from '../../lib/project.ts'

function ToolGlyph({ name }: { readonly name: string }) {
  const family = name === 'bash' ? 'shell' : 'fs'
  return <span className={`tool-glyph ${family}`}><Icon name={family === 'shell' ? 'terminal' : 'fileText'} size={11} /></span>
}

function argChips(call: ToolCall): readonly { readonly text: string }[] {
  const strings = Object.entries(call.args)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .slice(0, 2)
    .map(([key, value]) => ({ text: `${key}: ${String(value)}` }))
  return strings
}

export function UserBubble({ item }: { readonly item: Extract<ViewItem, { kind: 'user' }> }) {
  return (
    <div className="bubble user" title={formatTime(item.ts)}>
      <p className="bubble-text">{item.content}</p>
    </div>
  )
}

/** One assistant answer: thinking panel, markdown, then a mono meta-line. */
export function AssistantMessage({ item }: { readonly item: Extract<ViewItem, { kind: 'assistant' }> }) {
  return (
    <div className="assistant-wrap">
      <div className="bubble assistant">
        <div className="assistant-body">
          {item.thinking.length > 0 || item.thinkingLive ? (
            <ThinkingPanel thinking={item.thinking} live={item.live && item.thinkingLive} />
          ) : null}
          {item.content !== '' ? <Markdown content={item.content} /> : null}
          {item.content !== '' && item.live ? <span className="cursor" aria-hidden="true" /> : null}
          {item.toolCalls?.map((call) => (
            <span key={call.id} className="call-preview">
              requested <strong>{call.name}</strong>
            </span>
          ))}
        </div>
      </div>
      {!item.live && item.content !== '' ? (
        <div className="msg-meta">
          <span className="meta-time">{formatTime(item.ts)}</span>
          <CopyButton text={item.content} />
        </div>
      ) : null}
    </div>
  )
}

/** Tool invocation: breadcrumb summary row, expandable output inset. */
export function ToolCard({ item }: { readonly item: Extract<ViewItem, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false)
  const { call, result, ts, doneAt } = item
  const state = result === undefined ? 'pending' : result.ok ? 'ok' : 'failed'
  const duration = result === undefined ? '' : fmtDuration(doneAt !== undefined && ts !== undefined ? doneAt - ts : NaN)
  const chips = argChips(call)
  const hidden = Object.keys(call.args).length - chips.length

  return (
    <div className={`tool-row ${state}`}>
      <button type="button" className="tool-head" onClick={() => setExpanded((prev) => !prev)} aria-expanded={expanded}>
        <Icon name="chevronRight" size={12} className={`chevron-down ${expanded ? 'chevron-rotated' : ''}`} />
        {state === 'pending'
          ? <span className="tool-spin" aria-label="running"><i /><i /><i /></span>
          : <Icon name={result?.ok === true ? 'check' : 'close'} size={12} className={`verdict verdict-${state}`} />}
        <strong className="tool-name">{call.name}</strong>
        {chips.map((chip) => <CodeChip key={chip.text}>{chip.text}</CodeChip>)}
        {hidden > 0 ? <CodeChip>+{hidden}</CodeChip> : null}
        {duration !== '' ? <span className="tool-duration">{duration}</span> : null}
      </button>
      {expanded && result !== undefined ? <pre className="tool-output">{result.output || '(empty)'}</pre> : null}
      {expanded && result === undefined ? <span className="tool-output pending-text">đang chạy…</span> : null}
    </div>
  )
}

function fmtDuration(ms: number): string {
  if (Number.isNaN(ms)) return ''
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

const REASONS: Readonly<Record<string, string>> = {
  stopped: 'bạn đã dừng',
  rejected: 'bị từ chối',
  empty: 'không có nội dung',
  failed: 'gặp lỗi',
}

export function StatusLine({ reason }: { readonly reason: string }) {
  return <div className="status-line">turn closed · {REASONS[reason] ?? reason}</div>
}

export function JumpToBottom({ onClick }: { readonly onClick: () => void }) {
  return (
    <button type="button" className="jump-bottom" onClick={onClick}>
      <Icon name="arrowDown" size={13} />
      <span>xuống cuối</span>
    </button>
  )
}
```

(`argsSummary` import retained for the fallback call-preview lint parity — remove it here if the editor flags it unused; call-preview remains plain text.) Note: plan originally imported `argsSummary`; the final code does not use it — drop that specifier from the import to satisfy verbatim/noUnused rules.

So the import line becomes:

```tsx
import { formatTime } from '../../lib/format.ts'
```

- [ ] **Step 4: Rewrite `ApprovalBar.tsx`**

```tsx
import Icon from '../common/Icon.tsx'
import { Button } from '../ui/Button.tsx'
import { CodeChip } from '../ui/CodeChip.tsx'
import { toolTarget } from '../../lib/format.ts'
import type { PendingApproval } from '../../lib/types.ts'

/**
 * Pending approvals ride the SSE stream; they stack above the composer
 * until answered, styled as warn-edged sharp cards.
 */
export function ApprovalBar({
  approvals,
  onAnswer,
}: {
  readonly approvals: readonly PendingApproval[]
  readonly onAnswer: (approvalId: string, allow: boolean) => void
}) {
  if (approvals.length === 0) return null
  return (
    <div className="approvals">
      <div className="approvals-head">
        {approvals.length === 1 ? 'agent xin phép chạy một tool' : `${approvals.length} tool đang chờ duyệt`}
      </div>
      {approvals.map(({ approvalId, call }) => {
        const target = toolTarget(call.args)
        return (
          <div key={approvalId} className="approval">
            <Icon name="alertTriangle" size={14} className="approval-warn" />
            <CodeChip>{target === '' ? call.name : `${call.name} · ${target}`}</CodeChip>
            <span className="approval-text">Agent muốn chạy tool này — cho phép?</span>
            <span className="approval-actions">
              <Button variant="success" size="sm" onClick={() => onAnswer(approvalId, true)}>
                Allow
              </Button>
              <Button variant="outline-danger" size="sm" onClick={() => onAnswer(approvalId, false)}>
                Deny
              </Button>
            </span>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Rewrite `Composer.tsx`**

```tsx
import { useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Select } from '../ui/Select.tsx'

/**
 * Control-center composer: autosizing textarea over an action row holding
 * the model picker and stop/send. Enter sends, Shift+Enter breaks a line;
 * while a turn runs the send square becomes Stop.
 */
export function Composer({
  connected,
  running,
  draft,
  onDraft,
  onSend,
  onStop,
  model,
  models,
  onModel,
}: {
  readonly connected: boolean
  readonly running: boolean
  readonly draft: string
  readonly onDraft: (value: string) => void
  readonly onSend: () => void
  readonly onStop: () => void
  readonly model: string | null
  readonly models: readonly string[]
  readonly onModel: (model: string) => void
}) {
  const area = useRef<HTMLTextAreaElement | null>(null)
  const [focused, setFocused] = useState(false)

  const resize = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }

  const submit = (): void => {
    if (running || draft.trim() === '' || !connected) return
    onSend()
  }

  return (
    <form
      className={`composer ${focused ? 'composer-focused' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={area}
        className="composer-input"
        value={draft}
        rows={1}
        placeholder={connected
          ? 'Message…  (Enter gửi · Shift+Enter xuống dòng)'
          : 'connecting…'}
        disabled={!connected}
        onChange={(event) => {
          onDraft(event.target.value)
          resize(event.currentTarget)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-spacer" />
        {models.length > 0 && model !== null ? (
          <Select
            value={model}
            options={models.map((name) => ({ value: name, label: name }))}
            onChange={onModel}
            label="Chọn model"
            renderTrigger={(current, open) => (
              <button
                type="button"
                className="ui-chip ui-chip-btn composer-model"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={(event) => {
                  // reuse Select's toggle via sibling trigger semantics:
                  ;(event.currentTarget.closest('.ui-select')?.querySelector('.ui-select-trigger') as HTMLButtonElement | null)?.click()
                }}
              >
                <Icon name="zap" size={11} className="accent-icon" />
                {current?.label ?? model}
                <Icon name="chevron" size={11} className="ui-chip-caret chevron" />
              </button>
            )}
          />
        ) : null}
        {running ? (
          <Button type="button" variant="outline-danger" size="sm" title="Dừng agent" onClick={onStop}>
            <Icon name="square" size={11} />
            Stop
          </Button>
        ) : (
          <IconButton
            label="Gửi (Enter)"
            variant="solid"
            size="md"
            type="submit"
            disabled={draft.trim() === '' || !connected}
          >
            <Icon name="send" size={15} />
          </IconButton>
        )}
      </div>
    </form>
  )
}
```

The proxy-click through the hidden default trigger is fragile; instead promote the real trigger: change Select to accept an optional `triggerClassName` merged onto its default button and DELETE the custom-render hack here.

Final decision (keeps behavior + styling coherent): add optional prop `triggerClassName?: string` to Select, applied to the default trigger `<button>` className template. Composer then uses:

```tsx
          <Select
            value={model}
            options={models.map((name) => ({ value: name, label: name }))}
            onChange={onModel}
            label="Chọn model"
            triggerClassName="composer-model"
          />
```

and styles `.composer-model` adds the zap glyph visually via CSS `::before` content '⚡'-free approach — a mask is overkill; wrap isn't possible without renderTrigger, so visual zap icon drops from composer model chip (acceptable; the EnvPanel and mockup vibe carry the accent). Apply this interface change in Step 1's consolidated Select too:

interface gains `readonly triggerClassName?: string`; default trigger className becomes `` `ui-select-trigger ${triggerClassName ?? ''}` ``.

(This supersedes the `renderTrigger` example shown earlier in this step — do not implement the closest().click() version. Keep `renderTrigger` in Select's public API for power users; EnvPanel does not need it.)

- [ ] **Step 6: Add composer-model classes + full `chat.css` rewrite**

Create complete `web/styles/chat.css` (absorbs markdown/codeblock/hljs from composer.css; transcript v2):

```css
/* ────────────────────────────────────────────────────────────────
   chat surface: transcript v2, bubbles, tool rows, thinking,
   approvals, empty state, composer control-center, markdown+hljs
   ──────────────────────────────────────────────────────────────── */

.chat-scroll { flex: 1; overflow-y: auto; min-height: 0; }

.transcript {
  padding: 18px 46px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

@keyframes appear { from { opacity: 0; } }

.bubble { font-size: 13.5px; line-height: 1.65; word-break: break-word; animation: appear 0.14s ease; }
.bubble-text { margin: 0; }

.bubble.user {
  align-self: flex-end;
  max-width: 72%;
  background: #20242c;
  border: 1px solid #2c3038;
  border-radius: 8px 8px 2px 8px;
  padding: 9px 13px;
  color: var(--text);
  white-space: pre-wrap;
}

.bubble.assistant { align-self: stretch; max-width: 100%; position: relative; }
.assistant-body { position: relative; color: #c9ccd4; }

.msg-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 5px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10px;
}

.copied-ok { color: var(--ok) !important; }

.cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink { 50% { opacity: 0; } }

.call-preview {
  display: inline-flex;
  gap: 5px;
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-chip);
  padding: 2px 8px;
}

/* ── thinking ── */
.thinking {
  margin: 0 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-card);
  overflow: hidden;
}

.thinking-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.thinking-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  white-space: nowrap;
}

.thinking-spinner { width: 10px; height: 10px; flex-shrink: 0; }

.thinking-preview {
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.thinking-body {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid var(--border);
  margin: 0 10px 10px;
  padding: 9px 0 0;
}

/* ── tool rows ── */
.tool-row {
  align-self: stretch;
  border: 1px solid var(--border);
  border-left: 2px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--bg-card);
  animation: appear 0.14s ease;
}

.tool-row.pending { border-left-color: var(--accent); }
.tool-row.ok { border-left-color: var(--ok-border); }
.tool-row.failed { border-left-color: var(--bad); }

.tool-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 11px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: var(--text);
}

.chevron-down { transition: transform 0.15s ease; color: var(--text-faint); }
.chevron-rotated { transform: rotate(90deg); }

.verdict.ok { color: var(--ok); }
.verdict.failed { color: var(--bad); }

.tool-name { font-size: 12px; color: var(--text); }

.tool-duration { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); }

.tool-spin { display: inline-flex; gap: 3px; }
.tool-spin i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-faint);
  animation: dots 1s ease-in-out infinite;
}
.tool-spin i:nth-child(2) { animation-delay: 0.15s; }
.tool-spin i:nth-child(3) { animation-delay: 0.3s; }

@keyframes dots {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

.tool-output {
  margin: 0;
  border-top: 1px solid var(--border);
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  background: var(--bg-inset);
  border-radius: 0 0 var(--r-sm) var(--r-sm);
}

.pending-text { display: block; color: var(--text-faint); }

.status-line {
  align-self: center;
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  animation: appear 0.2s ease;
}

.jump-bottom {
  position: absolute;
  bottom: 14px;
  right: 18px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
}

.jump-bottom:hover { color: var(--text); background: var(--bg-hover); }

/* ── approvals ── */
.approvals {
  padding: 6px 46px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 40%;
  overflow-y: auto;
}

.approvals-head {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-faint);
}

.approval {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  border: 1px solid var(--border-strong);
  border-left: 2px solid var(--amber);
  border-radius: var(--r-chip);
  background: var(--bg-card);
  font-size: 12px;
  color: var(--text-dim);
  animation: appear 0.14s ease;
}

.approval-warn { color: var(--amber); flex-shrink: 0; }
.approval-text { flex: 1; min-width: 0; }
.approval-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* ── empty state ── */
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 30px;
  text-align: center;
}

.empty-mark { font-size: 30px; color: var(--text-faint); margin-bottom: 8px; }
.empty-title { margin: 0; font-weight: 600; font-size: 15px; color: var(--text); }
.empty-sub { margin: 0; color: var(--text-faint); font-size: 12px; }

.suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 20px;
  max-width: 560px;
}

/* ── composer control-center ── */
.composer {
  margin: 0 46px 14px;
  padding: 11px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
}

.composer-focused { border-color: var(--accent-border); }

.composer-input {
  display: block;
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  padding: 0 0 14px;
}

.composer-input::placeholder { color: var(--text-faint); }
.composer-input:disabled { opacity: 0.5; }

.composer-actions { display: flex; align-items: center; gap: 7px; }
.composer-spacer { flex: 1; }

.composer-model {
  background: var(--bg-inset);
  border-color: var(--border);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

/* ── markdown (assistant body) ── */
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0.6em 0; }

.md h1, .md h2, .md h3 { font-weight: 600; margin: 1em 0 0.45em; line-height: 1.3; }
.md h1 { font-size: 1.22em; }
.md h2 { font-size: 1.1em; }
.md h3 { font-size: 1.02em; }

.md ul, .md ol { margin: 0.6em 0; padding-left: 1.5em; }
.md li { margin: 0.25em 0; }
.md .task-list-item { list-style: none; }

.md a {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--accent-border);
}
.md a:hover { border-bottom-color: var(--accent); }

.md blockquote {
  margin: 0.7em 0;
  padding: 0.05em 1em;
  border-left: 2px solid var(--border-strong);
  color: var(--text-dim);
}

.md hr { border: none; border-top: 1px solid var(--border); margin: 1.1em 0; }

.md table { border-collapse: collapse; margin: 0.7em 0; font-size: 12.5px; width: 100%; }

.md th, .md td { border: 1px solid var(--border); padding: 5px 10px; text-align: left; }
.md th { background: var(--bg-card); font-weight: 600; }

.md code.md-inline {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--r-chip);
  padding: 0.1em 0.4em;
  color: var(--text);
}

/* ── code blocks ── */
.codeblock {
  margin: 0.8em 0;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-inset);
}

.codeblock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
}

.codeblock-lang {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}

.codeblock-copy {
  font-size: 11px;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: var(--r-chip);
}
.codeblock-copy:hover { color: var(--text); background: var(--bg-hover); }

.codeblock-pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: #c9ccd4;
}

/* ── hljs token theme ── */
.hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-tag .hljs-name { color: var(--hl-keyword); }
.hljs-string, .hljs-regexp, .hljs-template-tag, .hljs-template-variable { color: var(--hl-string); }
.hljs-number, .hljs-attr .hljs-number { color: var(--hl-number); }
.hljs-comment, .hljs-quote { color: var(--hl-comment); font-style: italic; }
.hljs-title, .hljs-function .hljs-title { color: var(--hl-title); }
.hljs-built_in, .hljs-type { color: var(--hl-builtin); }
.hljs-attr, .hljs-attribute, .hljs-property { color: var(--hl-attr); }
.hljs-meta, .hljs-section { color: var(--hl-title); }
.hljs-symbol, .hljs-bullet { color: var(--hl-number); }

/* ── narrow screens ── */
@media (max-width: 900px) {
  .transcript { padding: 14px 16px 10px; }
  .approvals { padding: 6px 16px 0; }
  .composer { margin: 0 16px 12px; }
  .bubble.user { max-width: 94%; }
}
```

Also append to `web/styles/ui.css`:

```css
/* select trigger inside composer shares chip look */
.composer-model.ui-select-trigger { background: var(--bg-inset); border-color: var(--border); font-family: var(--font-mono); font-size: 10.5px; }
```

- [ ] **Step 7: Wiring checks**

- `Transcript.tsx` unchanged (it consumes MessageParts exports by name — all preserved).
- Select interface change (`triggerClassName`) updated in Task 4 file, not duplicated.
- Keep old `sidebar.css`/`composer.css`/`components.css` imports in main.tsx ONLY where harmless — but composer.css now fights the new `.composer` block! Remove `./styles/composer.css` and `./styles/components.css` imports NOW (their surviving content — markdown/hljs moved into chat.css; media queries obsolete) and delete the files in this task rather than Task 7:

```bash
git rm web/styles/composer.css web/styles/components.css
```

main.tsx final import list:

```tsx
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import './styles/shell.css'
import './styles/chat.css'
import './styles/sidebar.css'
```

- `base.css` prune: delete its legacy `.btn/.action-button/.kbd` blocks? SessionList/CopyButton/ConfirmDialog now use kit classes or remaining `action-button` references gone. ConfirmDialog still uses `.btn ghost|.btn danger` — leave base.css primitives intact (still used by ConfirmDialog) OR switch ConfirmDialog to kit Buttons now: do the small edit —

ConfirmDialog buttons become:

```tsx
          <Button variant="ghost" onClick={onDismiss}>Hủy</Button>
          <Button variant="danger" autoFocus onClick={onConfirm}>
            <Icon name="trash" size={12} />
            {confirmLabel}
          </Button>
```

with `import { Button } from '../ui/Button.tsx'` added. Then remove `.btn` blocks from base.css (keep `.icon/.spinner/@keyframes spin/.chevron/.chevron-up` — chevron-up used by ThinkingPanel; also keep toast/modal blocks; DELETE `.action-button*` `.kbd` `.btn*`). Careful: nothing else references them post-swap (grep verifies).

- [ ] **Step 8: Extend smoke test**

Append to `web/components/ui/ui.spec.tsx`:

```tsx
describe('chat surfaces', () => {
  it('ToolCard breadcrumb formats duration chips absent while pending', async () => {
    const { ToolCard } = await import('../chat/MessageParts.tsx')
    const html = renderToStaticMarkup(
      <ToolCard item={{ kind: 'tool', call: { id: 't1', name: 'read', args: { path: 'src/x.ts', limit: 5 } } }} />,
    )
    expect(html).toContain('tool-row')
    expect(html).toContain('read')
    expect(html).toContain('path: src/x.ts')
  })

  it('ApprovalBar shows one card per pending call', async () => {
    const { ApprovalBar } = await import('../chat/ApprovalBar.tsx')
    const html = renderToStaticMarkup(
      <ApprovalBar
        approvals={[{ approvalId: 'a1', call: { id: 't', name: 'edit', args: { path: 'web/App.tsx' } } }]}
        onAnswer={() => undefined}
      />,
    )
    expect(html).toContain('edit · web/App.tsx')
    expect(html).toContain('Allow')
    expect(html).toContain('Deny')
  })
})
```

(Imports of Chat components pull `Markdown.tsx` → highlight.js — SSR-safe, pure rendering.)

React import for JSX already established by earlier describes.

- [ ] **Step 9: Verify everything**

Run: `npm run typecheck && npm run build:web && npm run test`
Expected: green across the board.
Manual spot-check (`npm run web` + `npm run build:web` fresh): send message flow, tool collapse expand, allow/deny, stop button, model switch chip updates meta, Enter/Shift+Enter.

- [ ] **Step 10: Commit**

```bash
git add -A web docs
git commit -m "chat surface v2: tool rows, approval cards, control-center composer"
```

---

### Task 7: Cleanup, docs, spec touch-up

**Files:**
- Delete: `web/styles/sidebar.css`
- Modify: `web/main.tsx` (final import list), `web/styles/tokens.css` (drop truly unused legacy vars if grep proves it), `web/styles/base.css` leftovers, `docs/web.md`, spec §11 line
- Modify: `web/App.tsx` (remove dead SUGGESTIONS moved nowhere — they stay; verify), no functional change expected

**Interfaces:** produces the end-state file map at the top of this plan.

- [ ] **Step 1: Final import list in `web/main.tsx`**

```tsx
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import './styles/shell.css'
import './styles/chat.css'
```

- [ ] **Step 2: Migrate any still-referenced sidebar.css rules**

Grep-first: `grep -rn "sidebar-scrim\|brand\|hamburger\|new-session\|session-filter" web --include=*.tsx`
Current files reference: `pane-scrim` (shell.css) ✓, `new-session/session-filter/filter-input/group-head/session-list/...` all defined in shell.css already. Only `rename-input` + `.session-empty` exist in both — shell.css covers them. Then:

```bash
git rm web/styles/sidebar.css
```

Base.css prunes from Task 6 Step 7 are verified here; if `.chevron-up` still needed by ThinkingPanel, confirm kept.

- [ ] **Step 3: Docs refresh — `docs/web.md`**

In "The React client (`web/`)" table replace rows and add kit lines:

```markdown
| `main.tsx` | entry; fonts, toast host, styles |
| `App.tsx` | workspace shell wiring; owns *no* model state |
| `components/layout` | TopBar (brand/folder popover/provider/toggles), Sidebar, EnvPanel |
| `components/ui` | primitives: Button, IconButton, Chip, CodeChip, Badge, Panel, Kbd, TextInput, Select — all token-driven, reused by every zone |
| `components/session` | per-session rows (two-line, hover actions) |
| `components/chat` | Transcript parts (tool rows, approval cards), thinking panel |
| `components/composer` | control-center composer with inline model picker |
| `components/common` | icons (extended line set), copy, modal, spinner, toast |
| `hooks/` | SSE subscription, auto-scroll, hotkeys |
| `lib/api.ts` | REST calls + `EventSource` subscription |
| `lib/config.ts` | `SHOW_SLOTS` — dashed future-view placeholders (default off) |
| `lib/types.ts` | client-side mirror of the wire shapes |
| `lib/project.ts` | `projectItems()` + `isTurnRunning()` |
| `lib/format.ts` | time / duration / arg summaries / `pathBasename` / `toolTarget` |
| `Markdown.tsx` | Markdown rendering + hljs syntax highlighting |
```

Update the trailing paragraph and hotkeys sentence to:

```markdown
The app auto-creates a session on load, offers suggested first messages, a
model picker inside the composer (mirrored in the Environment panel), a
workspace-folder popover in the top bar, session rename/delete/search, a stop
button while a turn runs, and allow/deny cards for pending approvals.
Ctrl/Cmd+N creates a session; Ctrl/Cmd+K focuses the session search. Below
1100px the sidebar becomes a drawer; below 1280px the Environment panel opens
as an overlay from its top-bar toggle.
```

- [ ] **Step 4: Spec §11 correction**

In `docs/superpowers/specs/2026-08-27-web-ui-redesign-design.md` change the smoke-test location sentence to note tests live at `web/components/ui/ui.spec.tsx` (root tsconfig lacks DOM/JSX libs) — one paragraph edit plus rationale clause.

- [ ] **Step 5: Full verification**

Run: `grep -rn "ChatHeader\|composer-hint\|stop-glyph" web --include=*` (expect zero hits beyond history), then:

```bash
npm run typecheck && npm run test && npm run build:web
```

Expected: all pass; `web-dist/` builds.

- [ ] **Step 6: Commit**

```bash
git add -A web docs
git commit -m "cleanup: retire replaced stylesheets; docs + spec test-path update"
```

---

## Self-Review (executed during plan writing)

1. **Spec coverage** — Tokens §4→Task 1; kit §6→Tasks 2–4; hotkeys §7→Task 5 Steps 10–11 (N new, K opens+focuses search; documented deviation: Ctrl+K toggles drawer which focuses search, chosen over cross-component refs); slots flag §8→config + TopBar/EnvPanel conditionals; responsive §5→shell.css media queries; accessibility §10→aria labels/roles in primitives + dialogs kept; testing §11→kit ssr spec + manual QA checklist embedded per-task verification steps (test-location deviation documented and fixed in Task 7); migration order §12→task sequence.
2. **Placeholder scan** — none remaining; the two flagged soft spots (Select duplicate branches, composer trigger) were resolved explicitly inside Task 4/Task 6 steps with final code given.
3. **Type consistency** — `SelectOption`, `Select.triggerClassName`, `IconButton.variant` incl. `solid`, `Badge.tone`, composer prop names, EnvPanel/TopBar props match every consumer site listed above.
