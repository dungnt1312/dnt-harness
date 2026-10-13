# Git panel v2: branch picker, hunk staging, AI commit message, conflicts, usability

Status: approved 2026-10-13 (user: "làm theo đề xuất, không cần hỏi lại").
Builds on `2026-10-12-git-panel-write-actions-design.md` and the port on `main`
(`src/web/project-git*.ts`, `web/components/workbench/Git*.tsx`).

Source of truth for behaviour and copy: `zed-industries/zed@c66312b`, checked out at
`/tmp/zed-src` (crates `git`, `git_ui`, `project`). Research notes:
`plans/reports/research-261012-2326-zed-git-panel.md` and the 2026-10-13 explorer
report summarised in each section below. **Port, do not invent.** Where this spec
departs from Zed it says so and why.

## Goals

1. Branch picker (list, switch, create, delete) — Zed `branch_picker.rs`.
2. Stage / unstage / restore one hunk — Zed `git_store.rs` index writes.
3. AI commit message — Zed `generate_commit_message`.
4. Conflicts — Zed `conflict_view.rs` / `conflict_set.rs` + `MERGE_MSG`.
5. Usability: split diff pane (collapsible), visible row actions and a context
   menu, compact commit area with an expanded editor, tree view.

## Non-goals

- Merge/rebase **Abort / Continue** UI: Zed has none (verified, no argv in `git`,
  `git_ui`, `project`). Not added.
- "Resolve with Agent" conflict button, stash, history, file history, blame,
  multi-select (Cmd/Shift-click marks), Sort By / Group By menu entries,
  `commit_title_max_length` warning, project-rules blocks in the commit prompt.
- `git apply`: Zed never applies patches for hunks; neither do we.

## Global constraints (unchanged from v1)

- Every command goes through `buildGitCommand` / `runGitCommand` (trust flags,
  login-shell env, no timeouts). Mutations run inside `runProjectGitOperation`'s
  per-repository queue and return the fresh status in `done`.
- Client paths pass `contain()` and follow `--`; client ref names are validated
  (`check-ref-format`, `show-ref`) before they reach an argv; nothing a client
  sends may start with `-`.
- New ops are added to `GIT_OPERATIONS`/`GIT_QUERIES` and `parseGitOperation` in
  `src/web/server.ts`, reuse the NDJSON `done` frame and existing auth/CSRF.

---

## 1. Branch picker

### Server

Query `branches` (in `GIT_QUERIES`, answered in `done.branches`):

```
git for-each-ref refs/heads/**/* refs/remotes/**/* \
  --format=%(HEAD)%00%(objectname)%00%(parent)%00%(refname)%00%(upstream)%00%(upstream:track)%00%(committerdate:unix)%00%(authorname)%00%(contents:subject)
```

Parsed into `GitBranch { name, remote: boolean, current: boolean, upstream?: string,
unixTime?: number, author?: string, subject?: string }` (`name` short: `main`,
`origin/main`; `refs/remotes/*/HEAD` skipped). If the list is empty, fall back to
`git symbolic-ref --quiet HEAD` → one current branch with no commit. Also returns
`defaultBranch` from
`git for-each-ref --format=%(refname)\t%(symref) refs/remotes/upstream/HEAD refs/remotes/origin/HEAD`
(first symref target, short form) or absent.

Operations (queued, non-prompting):

| op | body | argv (Zed `repository.rs:2370-2477`) |
|---|---|---|
| `switch-branch` | `{ name }` | local `refs/heads/<name>` exists → `checkout <name>`. Else `refs/remotes/<name>` exists → split at first `/` into remote/b; if `refs/heads/<b>` exists `branch --set-upstream-to <remote>/<b> <b>` else `branch --track <b> <remote>/<b>`; then `checkout <b>`. Else error `Branch '<name>' not found`. |
| `create-branch` | `{ name, base? }` | `switch -c <name> [<base>]` |
| `delete-branch` | `{ name, remote, force }` | `branch -d|-D|-dr|-Dr <name>` |

`name` is trimmed and spaces become `-` client-side (Zed `:918`); the server
validates with `check-ref-format --branch` and refuses a leading `-`. `base` must be
an existing ref (`show-ref --verify` on `refs/heads/` or `refs/remotes/`).

### UI (`GitBranchPicker.tsx`, popover anchored to the branch name in the footer)

- Search input, placeholder `Switch or type to create a branch…`; fuzzy, smart-case
  match on name (reuse an existing fuzzy helper if one exists in `web/lib`, else a
  subsequence matcher).
- Filter menu: `All Branches` / `Local Branches` / `Remote Branches`. With All,
  section headers `Local Branches`, `Remote Branches`.
- Hide a remote branch that a local branch tracks. Order: current first, then
  newest committer date; locals before remotes.
- Row: check icon (current) / branch icon (local) / server icon (remote); name;
  meta line `relative time • subject` (no author: Zed's `show_author_name` is off by
  default); `No commits found` when no commit. Hover trash on non-current rows;
  holding Alt makes it force-delete.
- Query not an exact name → extra row `Create Branch: "<name>"…`, subtitle
  `Based off <current>`; plus button `Create New From: <defaultBranch>` when a
  default branch exists.
- Selecting current closes. Errors use the existing toast + View Log, titles
  `Failed to change branch`, `Failed to create branch`. `delete-branch` failing with
  "not fully merged" → confirm `Branch "<x>" is not fully merged. Force delete it?`
  [`Force Delete`, `Cancel`] → retry with `force: true`.
- Keyboard: ↑/↓ move, Enter confirm, Esc close.

## 2. Hunk staging

### Model

Three texts per file: HEAD (`git show HEAD:<path>`, empty if absent), index
(`git show :<path>`, empty if absent), worktree (file bytes, empty if deleted).
Hunks come from git with zero context so ranges are exact:

- uncommitted hunks U: `git diff -U0 --no-color --no-ext-diff HEAD -- <path>` (HEAD↔worktree),
- unstaged hunks W: `git diff -U0 … -- <path>` (index↔worktree),
- staged hunks S: `git diff -U0 … --cached HEAD -- <path>` (HEAD↔index).

Hunk controls are offered only for a tracked, non-conflicted, text file in a
repository that has a HEAD. Untracked and newly added files, conflicted files,
binaries and no-HEAD repositories stage per file (their checkbox), as today.

The unit a button acts on is a **displayed hunk** H: one `@@` block of the existing
reading diff (`gitDiff`, `--unified=3`, HEAD↔worktree). Its HEAD range is
`[oldStart, oldStart+oldLines)` and its worktree range `[newStart, newStart+newLines)`.
Zed's `secondary_status` per hunk (`project_diff.rs:354-366`), computed with the
zero-context W and S hunks above:

- `staged` — no W hunk overlaps H's worktree range,
- `unstaged` — no S hunk overlaps H's HEAD range,
- `partial` — both overlap.

A zero-length git range `start,0` means "between line `start` and `start+1`"; it
overlaps a range `[s, e)` when `s <= start+1 <= e`.

`GitDiffReport` gains `hunks: GitHunk[]` (empty when hunk controls are not offered):
`{ oldStart, oldLines, newStart, newLines, status, fingerprint }`, one per `@@`
block in display order; `fingerprint` = sha1 (hex) of the block's `-`/`+` lines
joined with `\n`, each prefixed by its marker.

### Operations (queued; body `{ path, hunk: { oldStart, oldLines, newStart, newLines, fingerprint } }`)

The server recomputes the displayed hunks and refuses unless one matches all five fields
(`ProjectGitError('The file changed since the diff was shown. Refresh and try again.')`).

- `stage-hunk`: new index text = index text with every W hunk whose worktree range
  intersects H's worktree range replaced by the worktree lines (Zed
  `git_store.rs:1424-1533`).
- `unstage-hunk`: new index text = index text with every S hunk whose HEAD range
  intersects H's HEAD range replaced by the HEAD lines.
- Index write (Zed `set_index_text`, `repository.rs:1693-1766`):
  `git hash-object -w --stdin --path <path>` (content on stdin) then
  `git update-index --add --cacheinfo <mode>,<sha>,<path>`; mode `100755` when the
  worktree file is executable, else `100644`. New index text for a file not in HEAD
  and empty after unstage → `git update-index --force-remove -- <path>`. Errors
  surface as `Failed to stage:\n<stderr>`.
- `restore-hunk`: worktree text with H's worktree range replaced by H's HEAD lines,
  written in place (same bytes otherwise, mode kept). Refused for created files
  (Zed disables Restore there). Not confirmed (Zed does not confirm). The index is
  not touched.

Line handling works on byte buffers split after `\n`, so CRLF and a missing final
newline survive. Binary files have no hunks.

The queue runner needs a stdin-capable git call: extend the `GitRunner` options
with `stdin: Buffer` (today it is always `'ignore'`).

### UI (in the diff pane)

Each hunk header row: `Stage` / `Unstage` (tooltip `Stage Hunk` / `Unstage Hunk`)
and `Restore` (tooltip `Restore Hunk`, hidden for created files). A staged hunk is
rendered dimmed with a hollow left bar; partial shows a half bar. After an op the
pane re-fetches the diff; the list updates from `done.status`.

## 3. AI commit message

### Model setting

New model pair `commit-message` in `MODEL_PAIR_NAMES` (route `/api/commit-message`),
shown in Settings → Providers & Models next to Image understanding, label
`Commit message`, helper text "Empty uses the `fast` model alias." Resolution: the
pair if set; else the alias named `fast` if it exists and validates; else error
`No commit message model is configured.`

### Route

`POST …/projects/:pid/git/commit-message` (NDJSON, same auth). Body `{ subject?: string }`.
Frames: `{ type: 'delta', text }`…, then `{ type: 'done', ok, error? }`. Client
disconnect aborts the model request. Not queued (read-only). Usage recorded with
`kind: 'commit-message'`.

Diff input (Zed `git_panel.rs:4303-4348`, `4114-4183`): `git diff --staged` if
anything is staged, else `git diff` (untracked excluded). Cap `MAX_DIFF_BYTES = 20_000`:
first cut every line longer than 256 bytes to its first 256 bytes + `...[truncated]`;
if still too big, repeatedly drop the last hunk of the file with the most hunks
(keeping ≥ 1 per file), appending `[...skipped N hunks...]`; no hard cut (Zed
`compress_commit_diff`, `git_panel.rs:4155`).

Prompt: one user message, no tools, no thinking:
the verbatim text of `/tmp/zed-src/crates/git_ui/src/commit_message_prompt.txt`
(copy into `src/web/git-commit-message-prompt.txt`), then
`\nHere is the user's subject line:\n<subject>` when the first line of the draft is
non-empty, then `\nHere are the changes in this commit:\n<diff>`.

### UI

Button with the sparkle icon left of Commit; tooltip `Generate Commit Message`, or
`No Changes to Commit` (disabled) when nothing is staged or tracked. While running
it becomes a stop button (`Cancel Commit Message Generation`) and the textarea shows
`Generating Commit…` as placeholder. Deltas append to the end of the draft; a
non-empty draft gets `\n` first. Errors → toast with the message.

## 4. Conflicts

### Status

`GitStatusReport` gains `mergeMessage?: string` (contents of `<gitdir>/MERGE_MSG`,
via `git rev-parse --git-path MERGE_MSG`) and `mergeHeads: boolean` (any of
`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REBASE_HEAD`, `REVERT_HEAD`, `APPLY_HEAD`
resolves). The Conflicts section already exists; it keeps Zed's rule that staging a
conflicted file marks it resolved (checkbox then disabled with tooltip
`Conflicts marked as resolved`; header `All conflicts marked as resolved`).

### Resolution

`GitDiffReport` for a conflicted file gains `conflicts: GitConflict[]` parsed from
the worktree file (Zed `conflict_set.rs:204-259`): `{ index, startLine, endLine,
ours: string, theirs: string, oursName, theirsName, fingerprint }`; names are the
text after `<<<<<<< ` / `>>>>>>> `, defaulting to `HEAD` / `Origin`; a diff3
`|||||||` base section is parsed and dropped.

Op `resolve-conflict` `{ path, index, fingerprint, choice: 'ours'|'theirs'|'both' }`:
re-parse, match by index+fingerprint, replace the whole region with the kept side(s)
(`both` = ours then theirs), write the file. No stage (Zed edits the buffer only).

### UI

For a conflicted file the diff pane shows each conflict region (ours block, theirs
block) with buttons `Use <oursName>`, `Use <theirsName>`, `Use Both`, then the rest of
the diff. The commit textarea placeholder becomes `mergeMessage` when present, and
Commit with an empty draft uses it (Zed `:3816-3819`, `:5868-5873`). Commit stays
blocked while conflicts are unstaged (existing rule).

## 5. Usability

### 5.1 Split diff pane

- `GitPanel` body becomes list | diff. Width ≥ 720 px (container query on the panel):
  side by side, list default 40 %; narrower: stacked, list on top; one stored ratio serves both.
  A drag handle resizes (keyboard: focus the handle, ←/→ or ↑/↓ by 5 %).
- A toggle button (`Hide Diff` / `Show Diff`, icon) collapses the pane; the list then
  takes the full height. Ratio and collapsed state persist per project in
  localStorage (`dnt-harness.git.split.<projectId>`).
- Clicking a row selects it and shows its diff; the old inline expansion is removed.
  ↑/↓ in the list move the selection; Space toggles staging; Enter opens the file.
  `focusPath` from a chat card selects that row (replaces the inline-scroll focus).
- Diff pane header: file name + directory, line counts, `Stage File`/`Unstage File`,
  `Open File`, previous/next hunk buttons. Binary/media previews move here unchanged.
- Turn-filtered view (`pathFilter`) keeps working; commit area stays hidden there.

### 5.2 Row actions and context menu

- The selected row always shows its actions (opener + menu); others keep the
  hover reveal (contract: no layout cost).
- Right-click (and long-press 500 ms on touch) opens the entry menu, Zed order
  (`git_panel.rs:8342-8448`) limited to what we support:
  `Stage File`/`Unstage File` (folder: `Stage Folder`/`Unstage Folder`) ·
  `Discard Changes` / `Trash File` / `Restore File` (folder: `Trash Folder`, `Discard Changes to N Files`) ·
  separator · `Copy Path` · `Copy Relative Path` ·
  separator · `Add to .gitignore` (enabled only for untracked entries; appends
  `/<path>` on its own line to the root `.gitignore`, op `ignore`) ·
  separator · `Open Diff` · `View File`.
- The existing `⋯` row menu shows the same items.

### 5.3 Commit area

- Textarea grows with content from 2 to 6 lines (Zed panel max 6), then scrolls.
- Expand button (`⤢`, tooltip `Expand Commit Editor`) opens a modal editor
  (18 lines, width 50em) sharing the same draft, with the same Commit split button;
  Cmd/Ctrl+Enter commits, Esc closes.
- One action row: Generate (✨) · spacer · Commit split button.
- Last commit row shrinks to a single muted line (`subject` + Uncommit icon).
- Placeholder: `mergeMessage`, else Zed's single-file suggestion when exactly one
  file would be committed (`Create <file>` / `Update <file>` / `Delete <file>`),
  else `Enter commit message`; an empty draft commits the suggestion.

### 5.4 Tree view

- View options button in the header → `View` → `List` / `Tree`
  (localStorage `dnt-harness.git.view`, default List).
- Tree per section; directories before files, name order; directories expanded by
  default; a directory with no files and exactly one child directory is compacted
  (`a/b/c`). Collapse state is in-memory only.
- Directory checkbox: all descendants staged → checked; any staged/partial →
  indeterminate; click stages/unstages only descendants not already in the target
  state (tooltip `Stage Folder` / `Unstage Folder`).
- ←/→ collapse/expand in the tree; ← on a file moves to its parent.

## Files

Server: `src/web/project-git.ts` (hunks, conflicts, merge state in status/diff),
`src/web/project-git-ops.ts` (new ops, stdin), new `src/web/project-git-branches.ts`,
new `src/web/project-git-hunks.ts`, new `src/web/project-git-conflicts.ts`, new
`src/web/git-commit-message.ts` + `git-commit-message-prompt.txt`, `src/web/server.ts`.

Web: `web/lib/api.ts`; `GitPanel.tsx` (layout), new `GitSplit.tsx`, new
`GitDiffPane.tsx` (diff, hunks, conflicts — DiffView moves out of `GitChangeList`),
`GitChangeList.tsx` (selection, tree, context menu), new `git-tree.ts`, new
`GitBranchPicker.tsx`, `GitCommitArea.tsx`, new `GitCommitModal.tsx`,
`git-panel-model.ts`, Settings model-pair UI.

Docs: `docs/web.md` (routes, ops, setting).

## Testing

- Real-repo vitest per op (`tests/web/project-git-*.spec.ts` style): branch list
  parsing incl. remote-tracked hiding inputs, switch local/remote (tracking created),
  create with/without base, delete merged/unmerged; hunk status for staged/unstaged/
  partial, stage/unstage/restore one hunk among several, CRLF and no-final-newline,
  executable mode kept, stale fingerprint refused, new file and no-HEAD repos;
  conflict parse (2-way, diff3, names default), resolve ours/theirs/both,
  `mergeMessage`; commit-message diff truncation and prompt assembly (pure), route
  with a fake provider stream; `ignore` op.
- Server route tests for parsing/validation of every new op (400s).
- Web specs: split layout + persistence, keyboard selection, hunk buttons, conflict
  buttons, branch picker filtering/create/delete-confirm, tree build/compaction/folder
  checkbox, context menu items, commit area autogrow/modal/generate streaming.
- `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`, Playwright smoke on a temp
  server against a scratch repo.
