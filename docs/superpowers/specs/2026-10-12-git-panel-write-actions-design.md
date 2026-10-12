# Git panel: stage, commit, sync and discard (Zed-style)

Status: design approved in brainstorming 2026-10-12, awaiting written-spec review.

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
| Architecture | Extend the server's git module with write operations behind POST routes; the UI never shells out |
| Authentication | No credential prompt in the browser. Git runs with `GIT_TERMINAL_PROMPT=0`; an SSH key, agent or credential helper already configured on the host works, anything else fails with git's message |
| Hooks | Stay disabled (`core.hooksPath=/dev/null`), as for the read-only queries. The commit box says so |

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
   message and the button becomes "Amend". A one-line note under the field
   reads "Git hooks are not run from this panel."
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

The existing read path keeps its hardening unchanged.

### Write operations (`src/web/project-git-write.ts`, new)

One exported function per action. All run through the module's `git()` runner,
which gains an options argument for a timeout, extra environment and a
`network` flag. Every path from the client passes through `contain()`, so a
path outside the project is refused before git sees it.

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

Every successful action answers with a fresh `GitStatusReport`, so the panel
updates without a second request.

**Safety configuration for write calls.** They keep `core.hooksPath=/dev/null`,
`core.fsmonitor=false`, `core.pager=cat`, `diff.external=` and
`core.quotepath=false`. Network calls (`fetch`, `pull`, `push`) replace
`protocol.allow=never` with `protocol.ext.allow=never`, so https, ssh, git and
file remotes work and `ext::` command remotes never do. The environment adds
`GIT_TERMINAL_PROMPT=0` and `SSH_ASKPASS_REQUIRE=never`, and stdin is closed.
Repository settings that run programs on the user's behalf (credential helper,
commit signing, `core.sshCommand`) are honored, as they would be in the
Terminal tab: these actions are the user's own clicks on their own checkout.

**Timeouts.** Local operations use the existing 20 s. Network operations use
120 s, and a timeout reports "git did not finish in 120 s (is it waiting for a
password?)".

**Serialization.** A per-project-root promise queue runs one write at a time.
When the agent or a terminal holds `index.lock`, git's failure is mapped to 409
"Another git process is using this repository; try again."

**Errors.** A failed action raises `ProjectGitError` with git's stderr, trimmed
to its last 2 KB. The route answers 400 for bad input, 409 for lock and
diverged-branch conflicts, and 502 for remote failures (auth, network,
rejected push). The panel shows the message in an `ErrorNotice` above the
footer until the next action or a dismiss.

### Route (`src/web/server.ts`)

`POST /api/workspaces/:wid/projects/:pid/git/:action`, where `:action` is one of
`stage|unstage|discard|trash|commit|fetch|pull|push` and the body is JSON. It
sits next to the existing read-only route, uses `requireWorkspace(…, true)`
(active workspace), and goes through the same CSRF and origin checks as every
other POST. Other methods answer 405 and an unknown action answers 404. The
`GET …/git` route is unchanged.

## Web client

- `web/lib/api.ts`: the new fields on `GitChange` and `GitStatusReport`, plus
  `gitAction(workspaceId, projectId, action, body?) → Promise<GitStatusReport>`.
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
| Nothing to commit | git's message, 400 |
| Missing author identity | git's message, telling the user to set `user.name`/`user.email` |
| `index.lock` held | 409, retry |
| Diverged on pull | 409 with the Terminal hint |
| Auth or network failure, rejected push | 502 with git's stderr |
| Timeout | 502 with the password hint |

## Testing

- `tests/web/project-git-write.spec.ts` uses temporary repositories and a local
  bare remote. It covers stage/unstage (paths and all, and a repository with
  no commit), partial staging in status, commit, Commit Tracked, amend,
  discard (modified, staged-new, renamed, all tracked), trash, path escape
  refusal, the `index.lock` mapping to 409, fetch/pull/push/publish, pull
  `--ff-only` divergence, and force-with-lease.
- `tests/web/project-git-hardening.spec.ts` gains checks that write calls still
  run no hooks and that network calls refuse an `ext::` remote.
- A server route test covers 405, 404 for an unknown action, 400 for a bad
  body, and a successful POST returning a status report.
- Web: `git-panel-model.spec.ts` for the pure helpers. The existing
  `git-panel-filter.spec.tsx` is extended for grouping, checkbox states,
  filtered-mode hiding of the commit box and footer, and confirmations.
- Verification: affected tests, `pnpm test`, `pnpm run typecheck`,
  `pnpm run build:web`, and a manual pass in the browser on this repository.

## Documentation

- `docs/web.md`: the route table row for git (line 187), the workbench
  component row (line 867), and the Git paragraph (line 931) no longer say
  "read-only / never stages, commits, or discards".
- The header comment of `src/web/project-git.ts` points to the write module.

## Non-goals

- History tab, commit details, branch switching or creation, stash.
- Hunk- or line-level staging.
- A project-wide combined diff view ("View Diff").
- Interactive credential prompts, merge or rebase on pull, conflict resolution
  editor.
- Live file-watch refresh (refresh is on action, button and window focus).
