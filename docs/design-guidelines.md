# Web client design guidelines

## Product contract

dnt-harness is an English developer chat client, not a terminal, file editor, diff viewer, or repository dashboard. Product-owned navigation, controls, errors, ARIA labels, lifecycle labels, and built-in copy are English. User and assistant text, names, identifiers, paths, commands, imported content, custom modes, and raw diagnostics stay verbatim. APIs keep the term `session`; the UI calls the durable thread a **Conversation**.

## Visual direction

The client follows a ChatGPT-style layout with a neutral palette in **light and dark** themes. Appearance is **System** by default and can be forced to Light or Dark from the sidebar Preferences menu (browser-local key `dnt-harness.theme`; a pre-paint script in `index.html` avoids a theme flash). Primary actions use the foreground color (black on light, near-white on dark); semantic ok/warn/bad colors are reserved for state. No gradients, glossy effects, copied branding, terminal chrome or decorative statistics.

UI text uses bundled Instrument Sans at 13–14px; assistant prose is 15px with a ~1.7 line height. JetBrains Mono is used for code, paths, IDs, commands and durations.

## Layout

- **Sidebar (left, 280px default; 232–420px)**: brand + collapse, New conversation, conversation search, project-grouped history, and a footer with the workspace switcher, Preferences (appearance + approval notifications) and Settings. It docks at **≥768px**, supports pointer/keyboard resizing, and persists collapse + width in `dnt-harness.workbench.v1`; below that it is a modal drawer.
- **Workbench (right, 560px default; 360–1100px)**: dock widths and collapse persist in `dnt-harness.workbench.v1`; the opened view tabs and the selected one are remembered **per conversation** under `dnt-harness.workbench.tabs.v1` (key `<workspaceId>:<sessionId>`, or `draft` before the first message).
- **Main column**: a header (sidebar/new-chat buttons when the sidebar is hidden, model picker, connection state, Workbench toggle), the transcript, and the composer section. The reading column is `max-w-3xl` (768px) and the composer shares its width.
- **Empty state**: greeting, the composer and suggestions are centered vertically; the composer's scope chip picks the project for the first message.
- **Transcript**: one scroll container spanning the whole column. Opening a conversation lands at the latest row; new output follows only while the reader is within 80px of the bottom; otherwise a round "Jump to latest" button appears. Nothing is pinned over the transcript.
- **Composer section**: normal document flow below the transcript (never `position: fixed`), stacking the work status line, approval cards, send error and the composer.
- **Workbench (right)**: read-only Files, Git, Context and Trajectory views, a Subagents view that follows the conversation's children, and transient file tabs. Git lists the project's changed files with added and removed line counts and opens a read-only diff; it never stages or commits. Trajectory is Duration, Turns and Calls over the same durable log, with no request of its own; its Duration timeline is one equal slot per step in order, not a clock. It docks at **≥1280px** (360–1100px, resizable, collapsible and expandable) and becomes a modal sheet below that. The selected fixed view and dock width are remembered. A file opened from a recorded call scrolls to the lines that call read and marks them; the body is still the live project file, never the tool's output.
- **Settings**: centered dialog (full screen below 640px) with grouped Global/Workspace tabs on the left, or a section select on narrow screens.
- Required widths **320, 375, 768, 1024, 1440, 1920px** have no document-level horizontal overflow.

## Conversation and safety hierarchy

The durable event log is the source of truth; `projectItems(events)` owns transcript projection. User messages are right-aligned bubbles; assistant answers are plain prose, and each closed assistant turn ends with one hover action row (copying every answer the turn produced, serving model, time) — mid-turn answers show no actions while their turn is open. Tool calls, delegations and audit lines render as compact disclosure rows. A tool row reads **name → target → result**: the target is what the call acted on (a `Read`'s line window, a `Grep`'s pattern and scope, a command kept whole rather than shortened as a path), and the digest is one phrase for what came back (lines read, files matched, `created`, `-3 +7 lines`, `exit 1`, or the first line of an error). Both stay on the row at every width; the chips and the duration are what a narrow screen drops. Every digest is derived from the recorded call and its output — a non-zero exit reads as bad without changing the outcome the log recorded. Expanding a row shows exact arguments — short ones as one JSON block whose copy carries the complete payload, file content (`old`/`new`/`content`) as its own readable block — and the recorded output with its line count. Opening a recorded path in the workbench lands on the window the call read. Consecutive lookups group into one activity run, and a run of four rows or more collapses into one summary line (steps, what ran, duration) once it settles, staying open while anything runs or ended failed/unknown, which the summary also counts. An opened run nests behind a guide line so it reads as the summary's contents. Writes (Edit, Write and the like), delegations and reasoning-only steps never join a run — each keeps its own line. Spacing follows the neighbour: activity sits tight under what it belongs to, messages are a full gap apart. Running, succeeded, failed, cancelled and recovered/unknown outcomes stay distinct, each with an icon **and** text alternative. A normal `completed` turn end renders no marker; other terminal reasons render a quiet status line, and request failures render one retry card.

Connection loss is shown separately from durable running state. Reconnecting never invents a terminal outcome, automatically resends a draft, or replays a request. Queue and Stop use their existing endpoints; while a turn runs the send button becomes Queue (only when a draft exists) next to Stop. Drafts clear only after accepted requests with unchanged edit revisions.

Each closed turn whose Write/Edit calls landed renders one collapsible **files changed** card under its action row, projected by `turnChanges(events)` from the log alone. The collapsed row counts lines from the recorded arguments — exact to this turn — and fetches nothing; expanding loads the project's read-only git status once and marks each file with git's current worktree numbers, which other turns sharing the file also contributed to, so the note names the Git view as the full picture rather than implying per-turn attribution. A write whose outcome the log could not confirm (failed, refused, or a recovery record) shows **outcome unconfirmed** instead of reading as clean. Shell effects and child writes are never claimed by the card. **Review all** opens the Git view over the whole project.

Approvals appear above the composer, oldest first. **Allow once** and **Deny** apply to one request and keep synchronous duplicate-submit protection; standing permission is the workspace's mode, authored in Settings → Modes.

Context is read-only except for confirmed manual compaction. Its manifest request runs only while the sheet is open, Context is selected, a valid conversation is selected, and the turn is settled. Trajectory is a client-only projection of existing events; its exact empty state is **“No recorded activity for this conversation yet.”** Subagents lists Running and Ended children only; it has no delegation form.

## Accessibility

- Axe (`wcag2a`, `wcag2aa`, `wcag21aa`) is clean in both themes for the shell, drawer, Context sheet, approvals and all eight Settings sections.
- Text tokens (`fg`, `fg-muted`, `fg-faint`) meet 4.5:1 on every neutral surface in both themes (`tests/web/product-copy.spec.ts`).
- Dialogs, drawers and sheets trap focus, close on Escape/scrim/close button and restore focus to the control that opened them; nested menus close one layer per Escape.
- Touch (`pointer: coarse`) targets are at least 44×44px.
- `prefers-reduced-motion: reduce` collapses animation while running state stays readable as text.
- Status is never conveyed by color alone; icon-only controls have accessible names.

## Verification

```sh
npm test
npm run typecheck
npm run build:web
npm run test:browser
```

Browser suites intercept `/api/**` with fixtures and never touch real settings. Screenshot evidence is written to `artifacts/product-ui/chat/` (light/dark shell) and `artifacts/product-ui/chat/matrix/` (state matrix); it is evidence, not an approved baseline.
