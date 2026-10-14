# Workbench Files: UI consistency + CodeMirror 6 editor

Branch: feat/subagent-mcp-inherit (unrelated WIP in chat/ui specs is left untouched).

## Contract

- **Outcome:** the workbench file viewer reads and edits through one lazy-loaded
  CodeMirror 6 pane, with consistent chrome, in-app confirmations, a status bar,
  diff review and conflict compare, agent-write awareness, per-tab view mode,
  markdown split preview and Cmd+P quick open.
- **Constraints:** keep the save contract (expectedHash, 409 + currentHash,
  settleDraft across tab/project switches); keep the workbench memo comparator
  cheap; CodeMirror never enters the main bundle; theme from existing tokens
  (`--bg`, `--line`, `--hl-*`); chat code blocks keep highlight.js.
- **Non-goals:** IntelliSense/LSP, editing skill or memory tabs, detecting
  writes by Bash or external processes, Git panel restyle.
- **Acceptance:** `pnpm test`, `pnpm run typecheck`, `pnpm run build:web` pass;
  CodeMirror lands in its own chunks; browser check in light and dark themes.

## Phase 1: UI consistency

- Path bar `h-10` → `h-9`; Copy button at the standard 32px; Copy copies the draft when editing.
- Unsaved dot on file tabs uses `bg-warn`.
- Files empty state gets a title and a body line, like the other views.
- One shared `TruncationNotice` (it was duplicated 3×).
- Non-editable files show a "Read-only" chip with the reason instead of a missing pencil.
- Tree sub-folder load error uses `ErrorNotice` + Retry, like the root.
- `DiffLines` 12px → 12.5px, so diffs match the file viewer.
- `window.confirm` → `ConfirmDialog` in FileViewer (cancel, reload, overwrite) and tab close.
- CSV cells get `title`; Reload is disabled while saving; ProcessPanel header `h-10` → `h-9`.

## Phase 2: CodeMirror 6 pane

- `web/components/workbench/CodePane.tsx` (lazy): one EditorView with compartments
  for editable, language, indent unit and compare. Line numbers, folding, bracket
  matching, close brackets, search (Cmd+F), history, multi-cursor, active line,
  highlight selection matches. Cmd/Ctrl+S saves, Escape cancels (closing search
  first), Tab/Shift+Tab indent, IME composition never triggers them.
- `web/lib/code-languages.ts`: languageOfFile → dynamically imported CM language.
- Focus band for tool reads becomes a line decoration plus scroll.
- Status bar: Ln/Col, selection, indent, EOL, encoding, size.
- Vite `manualChunks`: CM core in `codemirror-vendor`; language packs stay split.

## Phase 3: features

- Edit-mode **Diff** toggle: unified merge view against the opened text (per-chunk revert).
- Conflict **Compare**: unified merge view against the current disk text.
- Agent writes: App derives `{relativePath: seq}` for landed Edit/Write calls
  incrementally; the viewer reloads silently when clean, or shows a banner
  (Compare / Reload) when a draft exists.
- Per-tab view mode stored in `useWorkbenchFiles` (moves on rename, dropped on close).
- Code | Split | Preview for markdown/html/csv; Split previews the live draft.
- Cmd/Ctrl+P quick open dialog (reuses `useFileSearch`) plus a button in the tree header.

## Verification

Rewrite `file-editor.spec.tsx` → `code-pane.spec.tsx`; adapt the viewer specs to
CodeMirror and ConfirmDialog; add specs for the write tracker, view modes, and quick open.
