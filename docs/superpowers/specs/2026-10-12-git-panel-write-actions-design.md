# Git panel: stage, commit, sync and discard (Zed-style)

Status: design approved in brainstorming 2026-10-12, awaiting written-spec review.

## Revision 2026-10-12 (user: "git tool nên làm theo hướng run command")

Write actions run git **as a command, the way the user would type it in a
terminal**. The user's and the repository's git config, hooks (pre-commit,
commit-msg, pre-push), commit signing, credential helpers and `core.sshCommand`
all work normally. The harness only builds the command, runs it, parses the
result and shows it. The first draft disabled hooks and overrode config for
write calls; that is dropped. Auth stays as it is for every other route.

## Goal

The workbench Git panel (`web/components/workbench/GitPanel.tsx`) today only
lists changed files and shows their diff against HEAD. It should become a
working source-control panel modelled on Zed's Git panel: the user stages
files, writes a commit message, commits, and syncs with the remote without
leaving the workbench.

Success means a user can go from "the agent changed 12 files" to "committed and
pushed" in the panel alone, and every action that can lose work or publish it
asks first.

## Decisions (chosen by the user)

| Topic | Decision |
|---|---|
| Scope | Stage/Unstage with grouped list, Commit, Push/Pull/Fetch, Discard/Restore |
| Out of scope | History tab, branch switcher, project-wide "View Diff" multibuffer |
| Permissions | Panel actions are the user's own clicks, so they run immediately in every session mode. Discard, Trash untracked, Push, Force push and Amend of a pushed commit ask for confirmation |
| Architecture | A thin command runner: each POST action maps to one plain `git` command line run in the project root. The harness parses and displays; git does the work |
| Git config and hooks | Untouched for write actions: no `-c` overrides, hooks run, signing and helpers apply. Hook output is shown in the panel |
| Credentials | Whatever the host already has (SSH agent/key, credential helper, keychain). There is no terminal to type into, so `GIT_TERMINAL_PROMPT=0` makes a missing credential fail fast with git's message instead of hanging |
| Route auth | Same as every other API route (session cookie + CSRF/origin); no extra gate |

## Layout

Top to bottom, matching the Zed screenshot the user supplied:

1. **Filter banner** (unchanged) when the panel was opened from a turn card with
   `pathFilter`.
2. **Header row**: `Changes (N)`, the total `+added −removed`, a refresh button,
   and a split button. Its main action is **Stage All**, or **Unstage All** when
   every change is staged. Its menu holds Stage All, Unstage All, Discard
   Tracked Changes, and Trash Untracked Files.
3. **Change list** in up to three groups, each with a collapsible header and a
   group checkbox:
   - **Conflicts** (only when present). Staging a conflicted file marks it
     resolved (`git add`).
   - **Tracked**: modified, added, deleted, renamed and copied files.
   - **Untracked**.

   Each row keeps today's chevron, status mark, file icon, name, directory,
   line counts, hover-revealed opener and inline diff. It gains a checkbox on
   the right edge with three states: staged, unstaged, and partially staged
   (index and worktree both differ). Clicking a partial checkbox stages the
   whole file. The row's hover menu (same hover-reveal contract as the opener)
   adds **Discard changes** or, for an untracked file, **Trash file**.
4. **Commit box**: a multi-line message field (Cmd/Ctrl+Enter commits) and a
   split **Commit** button. The label is "Commit" when something is staged and
   "Commit Tracked" when nothing is (this stages every tracked change, like
   `git commit -a`). The button is disabled when the message is empty, or when
   nothing is staged and there are no tracked changes. The menu holds **Amend**: it fills the field with HEAD's
   message and the button becomes "Amend". While a commit runs (hooks may take
   a while) the button shows "Committing…".
5. **Footer**: branch icon and name on the left. On the right is a split remote
   button whose main action follows Zed:
   - no remote: no button;
   - no upstream: **Publish** (`push -u <remote> <branch>`);
   - behind > 0: **Pull ↓n** (also when ahead);
   - ahead > 0: **Push ↑n**;
   - otherwise **Fetch**.

   Its menu always lists Fetch, Pull, Push, and Force Push (with lease).

**Filtered mode** (`pathFilter` set): rows and group checkboxes act on the shown
files only. The header action reads "Stage shown". The commit box and footer are
hidden, because a commit takes the whole index and not only the shown files.
**Show all** brings them back.

A detached HEAD shows the short SHA in the footer and disables Publish and Push.
A folder that is not a repository keeps today's empty state with no controls.

## Server

### Status report additions (`src/web/project-git.ts`)

`GitChange` gains `staging: 'staged' | 'unstaged' | 'partial'`, read from the
porcelain v1 XY code. The rules: X is blank or `?` gives unstaged; X is set and
Y is blank gives staged; both set gives partial. Conflicts are unstaged.

`GitStatusReport` gains:

- `upstream?: string`, from the `## branch...remote/branch` header;
- `remote?: string`, which is `origin` when present and otherwise the first
  entry of `git remote` (absent when there is none);
- `detached: boolean`;
- `head?: { sha: string; message: string; pushed: boolean }`. It comes from
  `git log -1 --format=%H%x00%B`, and is absent in a repository with no
  commit. `pushed` is true when an upstream exists and ahead is 0. Amend uses
  it to prefill the message and to decide whether to warn.

The read path (`git status`, `git diff` when the panel opens or refreshes) keeps
its current hardening. Those queries run automatically, without a click, so
opening the panel on a freshly cloned repository still cannot execute the
repository's code. Only the explicit write actions below run git unmodified.

### Write operations (`src/web/project-git-write.ts`, new)

One exported function per action. They share a small runner,
`runGitCommand(root, args, { timeoutMs })`, separate from the hardened read
runner. It spawns `git <args>` with `cwd` = project root, the host process
environment plus `GIT_TERMINAL_PROMPT=0`, stdin closed, and **no** `-c`
overrides or extra flags. It captures stdout and stderr together (in order)
and the exit code. Every path from the client passes through `contain()` and
is placed after `--`, so a path outside the project is refused before git runs
and a path can never be read as an option.

| Action | Body | Git |
|---|---|---|
| `stage` | `{ paths }` or `{ all: true }` | `add -- <paths>` / `add -A` |
| `unstage` | `{ paths }` or `{ all: true }` | `restore --staged -- <paths>`; with no HEAD, `rm --cached -r -- <paths>`; `all` uses `.` |
| `discard` | `{ paths }` or `{ all: true }` | tracked: `restore --source=HEAD --staged --worktree -- <paths>`; a file added in the index with no HEAD version: `rm -f -- <path>`; a rename restores both paths. `all` covers tracked files only |
| `trash` | `{ paths }` or `{ all: true }` | `clean -f -- <paths>` (untracked files only; `all` means every untracked file) |
| `commit` | `{ message, amend?, tracked? }` | `commit -m <message>` plus `--amend` and/or `-a`. An empty or whitespace-only message is refused with 400 |
| `fetch` | none | `fetch --prune <remote>` |
| `pull` | none | `pull --ff-only`. A diverged branch fails with "Branches have diverged; merge or rebase from the Terminal." |
| `push` | `{ force?: 'with-lease' }` | `push`; `push -u <remote> <branch>` when there is no upstream; `--force-with-lease` when asked |

Every action answers `{ status: GitStatusReport, run: GitRun }`, where
`GitRun = { command: string; output: string; exitCode: number }`. `command` is
the display form (`git commit -m "…"`, message shortened), `output` is the
combined stdout/stderr capped to its last 64 KB. The panel updates from
`status` without a second request and shows `run` as described under Web
client. A non-zero exit is still a 200-family answer carrying the run, except
for the mapped cases in Errors below; the status is re-read either way, since
a failed hook or a rejected push can leave the tree changed.

**Environment.** The server process's environment is used as is. A hook that
needs tools found only on the login shell's `PATH` (for example `pnpm` from a
version manager) fails if the harness was started without that `PATH`; the
hook's own output says so in the panel. The Terminal tab is the fallback.

**Timeouts.** `stage`, `unstage`, `discard`, `trash`: 30 s. `commit`, `fetch`,
`pull`, `push`: 10 min, because hooks may run tests or linters. A timeout kills
the process and reports "git did not finish in N (a hook still running, or
waiting for a password?)".

**Serialization.** A per-project-root promise queue runs one panel action at a
time. Git's own `index.lock` still guards against the agent or a terminal
running git at the same moment (see Errors).

**Errors.** Invalid input (bad body, path outside the project, empty message)
answers 400 before git runs. When git runs and exits non-zero, the route answers
200 with `run.exitCode ≠ 0` and the fresh status, so the UI always gets git's
real output, hook output included. Two failures are recognised from git's text
only to add a hint: `index.lock` ("another git process is using this
repository; try again") and a non-fast-forward pull ("branches have diverged;
merge or rebase from the Terminal"). Launch failures (git missing, timeout)
answer 502.

### Route (`src/web/server.ts`)

`POST /api/workspaces/:wid/projects/:pid/git/:action`, where `:action` is one of
`stage|unstage|discard|trash|commit|fetch|pull|push` and the body is JSON. It
sits next to the existing read-only route, uses `requireWorkspace(…, true)`
(active workspace), and goes through the same CSRF and origin checks as every
other POST. Other methods answer 405 and an unknown action answers 404. The
`GET …/git` route is unchanged.

## Web client

- `web/lib/api.ts`: the new fields on `GitChange` and `GitStatusReport`, the
  `GitRun` type, plus
  `gitAction(workspaceId, projectId, action, body?) → Promise<{ status; run }>`.
- **Command output.** After an action the footer shows a one-line result:
  the command and a check or cross. A failed run (`exitCode ≠ 0`) expands
  automatically into an output box above the footer with the full text (hook
  messages, push rejection, author identity hints), monospace and scrollable,
  with a dismiss button. A successful run with output (pre-commit summary, push
  URL) can be expanded from the footer line. Only the last run is kept.
- `GitPanel.tsx` stays the container (loading, focus, filter, report state) and
  is split so no file carries everything:
  - `GitChangeList.tsx`: groups, rows, checkboxes, row menu, inline diff;
  - `GitCommitBox.tsx`: message, Commit/Commit Tracked/Amend;
  - `GitRemoteBar.tsx`: branch and the remote split button;
  - `git-panel-model.ts`: pure helpers (grouping, the header action label, the
    footer primary action, checkbox state) with unit tests.
- **Busy state.** One action at a time from the panel. While it runs, controls
  are disabled and the clicked button shows a spinner. A network action also
  shows "Pushing…", "Pulling…" or "Fetching…" in the footer.
- **Confirmations** use `ConfirmDialog`:
  - Discard: "Discard changes to N files? This cannot be undone." with the
    file names when there are 5 or fewer;
  - Trash: "Permanently delete N untracked files?";
  - Push: "Push N commits to `<upstream>`?", or "Publish `<branch>` to
    `<remote>`?";
  - Force push: danger tone, naming the branch;
  - Amend when `head.pushed`: "The last commit is already pushed. Amending
    rewrites it and the next push will need Force Push."
- **Refresh.** After every action (from its response), on the refresh button,
  and when the window regains focus while the panel is mounted. The commit
  message survives refreshes and is cleared only after a successful commit.

## Error handling summary

| Case | Result |
|---|---|
| Path outside the project or denied | 400, nothing runs |
| Empty commit message | 400; the button is also disabled client-side |
| Pre-commit / commit-msg / pre-push hook fails | run with exit ≠ 0, hook output shown, message kept in the box |
| Nothing to commit, missing author identity | run with git's own message |
| `index.lock` held | run with git's message plus the retry hint |
| Diverged on pull | run with git's message plus the Terminal hint |
| Auth or network failure, rejected push | run with git's message |
| git missing, timeout | 502 with the hint |

## Testing

- `tests/web/project-git-write.spec.ts` uses temporary repositories and a local
  bare remote. It covers stage/unstage (paths and all, and a repository with
  no commit), partial staging in status, commit, Commit Tracked, amend,
  discard (modified, staged-new, renamed, all tracked), trash, path escape
  refusal, a path that looks like an option (`-rf`) staying a path,
  fetch/pull/push/publish, pull `--ff-only` divergence, and force-with-lease.
- Hooks run: a failing `pre-commit` hook blocks the commit and its output
  reaches `run.output`; a passing one lets it through; a `commit-msg` hook can
  rewrite the message. Repository config applies (for example `user.name` from
  the repo config appears on the commit).
- `tests/web/project-git-hardening.spec.ts` keeps proving that the automatic
  read path (status, diff) still runs no hooks, fsmonitor or textconv.
- A server route test covers 405, 404 for an unknown action, 400 for a bad
  body, and a POST returning `{ status, run }` both for exit 0 and exit ≠ 0.
- Web: `git-panel-model.spec.ts` for the pure helpers. The existing
  `git-panel-filter.spec.tsx` is extended for grouping, checkbox states,
  filtered-mode hiding of the commit box and footer, and confirmations.
- Verification: affected tests, `pnpm test`, `pnpm run typecheck`,
  `pnpm run build:web`, and a manual pass in the browser on this repository.

## Documentation

- `docs/web.md`: the route table row for git (line 187), the workbench
  component row (line 867), and the Git paragraph (line 931) no longer say
  "read-only / never stages, commits, or discards". The text explains the split:
  automatic reads are hardened, explicit actions run git as typed, with hooks.
- The header comment of `src/web/project-git.ts` points to the write module.

## Non-goals

- History tab, commit details, branch switching or creation, stash.
- Hunk- or line-level staging.
- A project-wide combined diff view ("View Diff").
- Interactive credential or passphrase prompts in the browser, merge or rebase
  on pull, conflict resolution editor.
- Live file-watch refresh (refresh is on action, button and window focus).
