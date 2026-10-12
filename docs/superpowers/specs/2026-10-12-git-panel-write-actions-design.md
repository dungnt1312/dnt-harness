# Git panel: 1:1 port of Zed's Git panel

Status: revision 3, awaiting written-spec review.

## Decision

The user asked for a **1:1 port of Zed's Git panel, no invention**
(2026-10-12 23:30). Every behaviour below is taken from Zed's source at
`zed-industries/zed@c66312b`; each section names the Zed file and line it
ports. The research notes are in
`plans/reports/research-261012-2326-zed-git-panel.md`.

Revisions 1 and 2 of this spec, which had their own hardening split, timeouts,
`--ff-only` pull, `git clean` and push confirmation, are replaced entirely.

Zed reference paths (abbreviated below):

- `repo.rs` = `crates/git/src/repository.rs`
- `store.rs` = `crates/project/src/git_store.rs`
- `panel.rs` = `crates/git_ui/src/git_panel.rs`
- `ui.rs` = `crates/git_ui/src/git_ui.rs`
- `out.rs` = `crates/git_ui/src/remote_output.rs`
- `askpass.rs` = `crates/askpass/src/askpass.rs`

## Scope

**In:**

- the change list with Conflicts / Tracked / Untracked sections;
- stage and unstage, per file, per section, and all;
- discard, restore and trash;
- commit with Commit Tracked, Amend, Signoff and Skip Hooks;
- Uncommit;
- Fetch, Fetch From, Pull, Pull (Rebase), Push, Push To, Force Push, Publish
  and Republish;
- askpass prompts (SSH, HTTPS and GPG passphrases);
- project trust (Restricted Mode for git);
- remote output toasts with the pull-request link.

**Out:**

- stash;
- branch picker;
- History / Git Graph / commit view;
- View Diff multibuffer;
- tree view and sorting options;
- co-authors;
- AI commit message;
- add to `.gitignore`;
- `git init` / clone.

These are separate Zed features that the user did not pick in the scope
question. The existing turn filter (`pathFilter`) and inline diff of
`GitPanel.tsx` stay.

## 1. Git command builder (`repo.rs:3994`)

Every git call, reads included, goes through one builder:
`buildGitCommand(project, args)` in `src/web/project-git.ts`. It replaces
today's `SAFE_CONFIG` and `hardenSubcommand`.

**Always added:**

```
-c core.fsmonitor=false -c log.showSignature=false --no-optional-locks --no-pager
```

**Added only when the project is not trusted:**

```
-c core.hooksPath=/dev/null -c core.sshCommand=ssh -c credential.helper=
-c protocol.ext.allow=never -c diff.external=
```

When the project is not trusted, `--no-ext-diff` is also inserted right after a
`diff` subcommand.

**Process:** `cwd` is the project root and `env` is the project environment
(section 2). Git is resolved on that environment's `PATH` (`store.rs:788`).

**Lifetime:** no timeout. A command ends when the git process exits, as in
`run_askpass_command` (`repo.rs:4089`).

## 2. Project environment (`store.rs:774`, `project/src/environment.rs:195`)

The environment is the user's login shell environment for the project
directory, as if they had `cd`'d there in a terminal. It is cached per
(shell, directory) for the server's lifetime. The steps:

1. Spawn the user's login shell (`$SHELL`, falling back to the platform default
   from `src/capabilities/shell/detect.ts`) as a login, interactive shell in
   the directory.
2. In that shell, `cd` into the directory and print `env -0`.
3. Parse the output.

If loading fails, log the error and use an empty map, which means the server
process environment (Zed logs and uses the default).

## 3. Trust (Zed Restricted Mode)

Zed trusts nothing by default. The user grants trust per directory, persisted
(`project/src/trusted_worktrees.rs`).

**Port:**

- `ProjectRecord` gains `gitTrusted?: boolean`. It is absent (untrusted) for
  every existing and new project.
- `PATCH /api/workspaces/:wid/projects/:pid { gitTrusted: true|false }` sets it.
  Like folder grants, this is only accepted from the owning browser session.
- An untrusted project shows a one-line "Restricted Mode" banner at the top of
  the panel, with **Trust**. The panel otherwise works, with the untrusted
  flags from section 1. That means no hooks, no credential helper, and no
  custom `sshCommand`, as in Zed.

## 4. Status (`repo.rs:3767`)

```
git status --porcelain=v1 --untracked-files=all --no-renames -z -- .
```

`-b` is not used. Branch, upstream and ahead/behind come from:

```
git for-each-ref --format=… refs/heads/<HEAD branch>
```

This gives `branch`, `upstream` and `upstreamTrack`. `upstreamTrack` is one of
`tracked {ahead, behind}`, `gone`, or none. The latest commit (sha, subject,
has-parent) comes from `git log -1`.

Each entry has a status and a staging state: staged, unstaged, or partially
staged (from the XY code).

Diff line counts stay as they are today (`diff --numstat HEAD`).

### Sections (`panel.rs:602`)

| Section | Contains |
|---|---|
| Conflicts | conflicted entries only |
| Tracked | everything not created |
| Untracked | created (untracked) entries |

## 5. Operations

Each operation runs through a per-repository serial job queue (`store.rs`
`send_job`). The panel marks staging changes optimistically: the checkbox
flips at once and reverts if the job fails (`store.rs:8094`
`spawn_job_with_tracking`).

| Operation | Command | Zed |
|---|---|---|
| Stage paths | `git update-index --add --remove -- <paths>` | `repo.rs:2569` |
| Unstage paths | `git reset --quiet -- <paths>` | `repo.rs:2596` |
| Stage All | stage every entry not fully staged | `store.rs:8234` |
| Unstage All | unstage every entry not fully unstaged | `store.rs:8268` |
| Discard (tracked) | unstage the staged ones, then `git checkout HEAD -- <paths>` | `panel.rs:2899`, `:3036`, `repo.rs:1602` |
| Trash (untracked) | move each file to the OS trash | `panel.rs:3011`, `:3162` |
| Commit | `git commit --quiet -m <msg> --cleanup=strip [--amend] [--signoff] [--no-verify]` | `repo.rs:2759` |
| Commit Tracked | stage all tracked (non-created) entries, then Commit | `panel.rs:3915` |
| Uncommit | `git reset --soft HEAD^`; the old message returns to the editor | `panel.rs:3963`, `repo.rs:1573` |
| Fetch | `git fetch --all` | `ui.rs:196`, `repo.rs:2917` |
| Fetch From | remote picker (adds "--all" when more than one), then `git fetch <remote>` | `panel.rs:4460` |
| Pull | `git pull <remote> [<branch> if no upstream]` | `panel.rs:4653`, `repo.rs:2874` |
| Pull (Rebase) | same with `--rebase` | same |
| Push | `git push [--set-upstream] <remote> <branch>:<upstream-branch or branch>` | `panel.rs:4717`, `repo.rs:2830` |
| Push To | remote picker, then Push | `ui.rs:220` |
| Force Push | `git push --force-with-lease …` | same |

**Remote resolution** (`store.rs:9134`):

- Push uses `git rev-parse --abbrev-ref <branch>@{push}`.
- Pull uses `git config --get branch.<branch>.remote`.
- If neither gives a remote, list all remotes (`git remote -v`) and show the
  picker. A picker with one option picks it without showing.
- `--set-upstream` is used when there is no upstream or the upstream is gone.

**OS trash** (Zed `fs.trash`): Node has no built-in, so a small
`trashPath(path)` per platform:

- macOS: Finder `delete` via `osascript`;
- Linux: `gio trash`;
- Windows: `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile` with
  `SendToRecycleBin`.

## 6. Askpass (`repo.rs:4047`, `askpass.rs`)

Commit, Fetch, Pull and Push run with askpass. For each operation the server:

1. Creates a temporary directory with a Unix socket (a named pipe on Windows)
   and an executable `askpass.sh`. The script is
   `printf '%s\0' "$@" | <node> <askpass-client> --askpass=<socket>`, the same
   shape as `generate_askpass_script` (`askpass.rs:480`). The client sends the
   prompt over the socket and prints the answer.
2. Sets `GIT_ASKPASS` and `SSH_ASKPASS` to the script and
   `SSH_ASKPASS_REQUIRE=force`.
3. If `GIT_CONFIG_COUNT` is not already in the environment, sets
   `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=gpg.program` and
   `GIT_CONFIG_VALUE_0=<gpg-wrapper.sh>`. The wrapper is a port of
   `generate_gpg_wrapper_script` (`askpass.rs:505`): only signing calls are
   intercepted. It tries `--pinentry-mode error`, then the default pinentry,
   then loopback with the passphrase from askpass.
4. Push runs with stdin closed.

**Prompts reach the browser through the action's response.** The POST
answers `application/x-ndjson`:

```
{"type":"askpass","promptId":"…","operation":"git push origin","prompt":"Password for 'https://…':"}
{"type":"done","ok":true,"stdout":"…","stderr":"…","status":{…}}
```

The panel shows an askpass modal (Zed `AskPassModal`): the operation name, the
prompt and a password field. The answer goes to
`POST …/git/askpass/:promptId { password }`. **Cancel** sends `{ cancel: true }`,
which kills git and ends the stream with `{"type":"done","ok":false,"cancelled":true}`
(Zed `REMOTE_CANCELLED_BY_USER`). The password is never logged or stored.

## 7. HTTP API

```
POST /api/workspaces/:wid/projects/:pid/git/:op            (NDJSON response)
POST /api/workspaces/:wid/projects/:pid/git/askpass/:promptId
```

`:op` is one of `stage`, `unstage`, `stage-all`, `unstage-all`, `discard`,
`trash`, `commit`, `uncommit`, `fetch`, `pull`, `push`, `remotes`, `pushed-to`.

- `remotes` lists the remotes for a picker.
- `pushed-to` lists the remote refs that contain HEAD:
  `git for-each-ref --format=%(refname) --contains HEAD refs/remotes/`,
  dropping `*/HEAD` (`repo.rs:3055`).

Bodies carry `paths`, `message`, `amend`, `signoff`, `noVerify`, `remote`,
`rebase`, `force`, `all`. Paths pass through `contain()`. Auth and CSRF are the
same as every other POST. The final `done` frame carries a fresh status report.

`GET …/git` and `GET …/git?path=` (status and diff) stay. They now use the
section 1 builder and the section 4 status shape.

## 8. Panel UI

**Header** (`panel.rs:6670`, `:6637`):

- `Changes (N)` and the total `+added −removed`.
- A split button. Its main action is **Stage All**, or **Unstage All** when
  nothing is unstaged (`primary_changes_action_stages`, `panel.rs:6031`). It is
  disabled with no entries.
- Its menu (`panel.rs:301`, stash entries omitted): Stage All, Unstage All,
  Restore All Changes, then a separator, then Discard Tracked Changes and
  Trash Untracked Files. Each entry is disabled when it does not apply.

**List:**

- Section headers carry a checkbox that stages or unstages the section
  (`panel.rs:3389`).
- Rows have a checkbox with three states. Toggle rules follow
  `toggle_staged_for_entry` (`panel.rs:3355`).
- Rows have a context menu: Stage/Unstage, Discard Changes / Restore File /
  Trash, and Open File.
- The existing inline diff on click stays.

**Commit area** (`panel.rs:6765`):

- A multi-line message editor.
- A split **Commit** button. Its title and disabled reasons are ported as is
  (`configure_commit_button`, `panel.rs:6501`):
  - "You must resolve conflicts before committing";
  - "No changes to commit";
  - "Commit in progress";
  - "No commit message".

  The title is Commit / Commit Tracked / Amend / Amend Tracked
  (`panel.rs:6519`).
- Its menu (`panel.rs:6423`) has three toggles: **Amend** (shown only with a
  previous commit), **Signoff** (remembered for the panel), and **Skip Hooks**
  (`git commit --no-verify`, reset after each successful commit).
- Amend on: the editor's text is saved, and HEAD's message is loaded.
  Amend off: the saved text returns (`panel.rs:9099`, `:9234`).
- After a successful commit the editor is cleared. After an amend, amend
  mode is turned off.
- Commit with unstaged conflicts shows "There are still conflicts. You must
  stage these before committing".
- Below the editor: the last commit's subject, plus an **Uncommit** icon when
  the commit has a parent (`panel.rs:7080`). If `pushed-to` is not empty, it
  asks "Are you sure?" with "This commit was already pushed to …"
  (`panel.rs:4007`).

**Footer:**

- Branch name.
- The remote split button (`ui.rs:944`):

  | Upstream | Button |
  |---|---|
  | tracked, 0/0 | Fetch |
  | tracked, ahead only | Push ↑n |
  | tracked, behind (any ahead) | Pull ↑n ↓m |
  | gone | Republish |
  | none | Publish |

- The menu (`ui.rs:1186`): Fetch, Fetch From, Pull, Pull (Rebase), then a
  separator, then Push, Push To, Force Push.
- While a remote operation runs, the button shows a spinner with "Fetch / Pull
  / Push in Progress…". Only one remote operation runs at a time
  (`panel.rs:4944`).

**Confirmations.** Only these, as Zed (`panel.rs:2899`, `:3111`, `:3162`):

- A single file:
  - "Are you sure you want to discard changes to `x`?" with Discard Changes;
  - "Are you sure you want to restore `x`?" with Restore File (for a deleted
    file);
  - "Trash `x`?" with Trash.
- Several files:
  - "Discard changes to N files?";
  - "Trash N files?";
  - "Discard changes to N files and trash M files?";
  - for the menu actions, "Discard changes to these files?" and "Trash these
    files?" with up to 5 names and "and N more…".
- Uncommit of a pushed commit.

Push and Force Push do **not** ask.

**Output** (`out.rs`, `panel.rs:6155`):

- A failed operation shows an error toast with git's stderr.
- A successful remote operation shows a toast. The texts are ported verbatim:
  - "Fetch: Already up to date" / "Synchronized with remotes";
  - "Pull: Already up to date" / "Received N file changes from X" /
    "Fast forwarded from X" / "Merged …" / "Successfully rebased from X";
  - "Push: Everything is up-to-date" / "Pushed B to X".
- A toast "with log" offers **View Log**, which shows stdout and stderr in a
  dialog.
- After a push, a `remote:` line with a GitHub, GitLab or Bitbucket PR/MR URL
  becomes a **Create Pull Request** / **Create Merge Request** /
  **View Merge Request** button in the toast (`extract_pull_request_link`).

## 9. Files

| File | Change |
|---|---|
| `src/web/project-git.ts` | builder (section 1), env loader (section 2), status (section 4) |
| `src/web/project-git-ops.ts` (new) | operations, job queue, remote resolution, trash |
| `src/web/git-askpass.ts` + `src/web/git-askpass-client.mjs` (new) | socket, scripts, gpg wrapper, prompt registry |
| `src/harness/workspace/types.ts` | `gitTrusted?` on `ProjectRecord` |
| `src/web/server.ts` | POST routes, NDJSON streaming, PATCH `gitTrusted` |
| `web/lib/api.ts` | types, `gitOperation()` NDJSON reader, `answerAskpass()` |
| `web/lib/git-remote-output.ts` (new) | port of `out.rs` |
| `web/components/workbench/GitPanel.tsx` + `GitChangeList.tsx`, `GitCommitArea.tsx`, `GitRemoteButton.tsx`, `GitAskpassModal.tsx`, `git-panel-model.ts` (new) | UI |
| `docs/web.md` | Git route rows and the Git paragraph |

## 10. Testing

- **`project-git-ops.spec.ts`** uses temporary repositories and a local bare
  remote. It covers:
  - every operation in the section 5 table;
  - optimistic revert on failure;
  - remote resolution (push remote, branch remote, picker);
  - Publish and Republish;
  - `--force-with-lease`;
  - trash moving a file out of the tree.
- **Trust tests:**
  - An untrusted project runs no `pre-commit` hook and ignores
    `credential.helper`.
  - A trusted project runs the hook, and the hook's failure output reaches the
    error.
- **Askpass test:** a fake `GIT_ASKPASS`-driven remote (an HTTP remote served
  by a test server requiring basic auth). It covers prompt, answer, and
  cancel killing git.
- **Environment test:** a login-shell variable is visible to a hook.
- **`git-remote-output.spec.ts`:** the Zed `out.rs` test cases ported
  verbatim.
- **`git-panel-model.spec.ts`:**
  - commit button title and disabled reasons;
  - remote button choice;
  - primary changes action;
  - section membership;
  - confirmation texts.
- **Existing hardening tests** are rewritten against the untrusted builder.
- **Verification:** affected tests, `pnpm test`, `pnpm run typecheck`,
  `pnpm run build:web`, and a manual pass on this repository.

## Known behaviour changes from today

- Trusted projects run git with no hardening beyond fsmonitor, the pager and
  optional locks. Hooks, credential helpers and custom diff tools run, as in a
  terminal.
- Untrusted diffs no longer pass `--no-textconv`; Zed does not. A
  repository's `textconv` driver could run on diff in an untrusted project.
  This is a Zed parity gap that we inherit.
