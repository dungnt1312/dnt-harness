# How Zed's Git panel works (source research)

Source: `zed-industries/zed` @ `c66312b` (2026-10-12), crates `git`, `git_ui`,
`project`, `askpass`. Line numbers refer to that commit.

## 1. Execution model

Zed runs the **system git CLI** for every panel action (no libgit2 for writes).
All commands go through one builder, `GitBinary::build_command`
(`crates/git/src/repository.rs:3994`):

- Always added, trusted or not: `-c core.fsmonitor=false`,
  `-c log.showSignature=false`, `--no-optional-locks`, `--no-pager`.
- Added **only when the worktree is untrusted** (Zed's "Restricted Mode"):
  `core.hooksPath=/dev/null`, `core.sshCommand=ssh`, `credential.helper=`,
  `protocol.ext.allow=never`, `diff.external=`, and `--no-ext-diff` on `diff`.
- Trusted worktree: hooks, credential helpers, sshCommand and external diff all
  run normally.

So the split is **trusted vs untrusted project**, applied to reads and writes
alike, not "automatic reads hardened, writes plain".

Hooks are separately gated: `run_hook` (`repository.rs:3345`) runs a hook only
when `is_trusted`.

## 2. Environment

The git binary and env come from the **user's login shell environment for that
directory** (`LocalRepositoryState::new`, `crates/project/src/git_store.rs:774`,
`local_directory_environment(&Shell::System, …)`). Git is found on that `PATH`
(`which_in`). Hooks therefore see the same `PATH` as the user's terminal
(nvm, pnpm, mise, …).

## 3. Credentials and passphrases (askpass)

For commit, push, pull and fetch (`run_git_command`, `repository.rs:4047`):

- Sets `GIT_ASKPASS` and `SSH_ASKPASS` to a generated script and
  `SSH_ASKPASS_REQUIRE=force`. The script talks to Zed over a socket and Zed
  opens a **password modal** (`AskPassModal`). Cancelling kills the operation.
- Sets `gpg.program` to a wrapper (via `GIT_CONFIG_COUNT`) so a GPG signing
  passphrase is also asked in the UI.
- No timeout: completion is the git process exiting ("hooks and large fetches
  can legitimately run long").
- Push runs with `stdin` closed.

## 4. Command per action

| Action | Command (code) |
|---|---|
| Stage | `git update-index --add --remove -- <paths>` (`:2569`) |
| Stage All | `git add --all` (tooltip `git_panel.rs:6639`) |
| Unstage | `git reset --quiet -- <paths>` (`:2596`) |
| Discard tracked | unstage staged entries, then `git checkout HEAD -- <paths>`, then reload open buffers (`git_panel.rs:2899`, `:3036`) |
| Trash untracked | moves files to the **OS trash** (`project.trash_file`), not `git clean` (`git_panel.rs:3011`, `:3162`) |
| Commit | `git commit --quiet -m <msg> --cleanup=strip [--amend] [--signoff] [--allow-empty] [--no-verify] [--author]` (`:2759`) |
| Commit Tracked | stage all tracked changed files, then commit (not `-a`) (`git_panel.rs:3915`) |
| Uncommit | `git reset --soft HEAD^`, message back into the editor, warns if the commit is pushed (`git_panel.rs:3963`) |
| Push | `git push [--set-upstream \| --force-with-lease] <remote> <branch>:<upstream-branch>` (`:2830`) |
| Pull | `git pull [--rebase] <remote> [<branch>]`, **no `--ff-only`**; merge vs rebase follows the user's git config unless "Pull (Rebase)" (`:2874`) |
| Fetch | `git fetch <remote>` or `--all` (`:2917`) |

All repository operations go through a per-repository job queue
(`send_job` / `send_keyed_job`), and staging is shown optimistically
(pending ops) before git returns.

## 5. UI behaviour

- **Commit button** (`configure_commit_button`, `git_panel.rs:6501`): disabled
  with a reason for conflicts, nothing to commit, commit in progress, empty
  message, no write access. Title is Commit / Commit Tracked / Amend / Amend
  Tracked.
- **Commit menu** (`git_panel.rs:6423`): toggles **Amend**, **Signoff**,
  **Skip Hooks** (`--no-verify`, resets after each commit).
- **Remote button** (`git_ui.rs:944`), chosen from upstream tracking:
  0/0 → Fetch; ahead only → Push ↑n; behind (± ahead) → Pull; upstream gone →
  Republish; no upstream → Publish. Menu: Fetch, Fetch From, Pull,
  Pull (Rebase), Push, Push To, Force Push.
- **Confirmations**: Discard and Trash ask (with up to 5 file names, "and N
  more…"); Uncommit of a pushed commit asks. **Push and Force Push do not ask.**
- **Output** (`remote_output.rs`): failures are an error toast with git's
  stderr. Successes are short toasts ("Pushed main to origin", "Fetch: Already
  up to date", "Received 3 file changes from origin"), optionally with "view
  log". After a push, a `remote:` PR/MR link from GitHub, GitLab or Bitbucket
  becomes a "Create Pull Request" button.

## 6. Differences from our current spec

| Topic | Our spec (rev. 2) | Zed |
|---|---|---|
| Hardening split | reads hardened, writes plain | trusted project: everything plain (except fsmonitor/pager); untrusted: everything hardened |
| Env / PATH | server process env | login shell env of the directory |
| Credential prompt | none, `GIT_TERMINAL_PROMPT=0` | askpass modal in the UI (SSH, HTTPS, GPG) |
| Timeout | 30 s / 10 min | none (process exit) |
| Pull | `--ff-only` | plain `pull`, plus Pull (Rebase) |
| Trash untracked | `git clean -f` (permanent) | OS trash (recoverable) |
| Push confirm | yes (user choice) | no |
| Commit options | Amend | Amend, Signoff, Skip Hooks |
| Extra | — | Uncommit, Republish, Fetch From / Push To, PR link after push |
| Locks | — | `--no-optional-locks` on every call |
