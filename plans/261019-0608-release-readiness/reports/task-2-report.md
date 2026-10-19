# Task 2 report: macOS terminal support (zsh and bash)

Status: DONE_WITH_CONCERNS (only minor concerns, listed at the end)

## Commits (branch `dev`, pushed fast-forward)
- `ee2465c` feat(web): support macOS terminals under zsh and bash
- `65fa752` docs: claim macOS terminal support with zsh and bash probe evidence

## What was wrong on macOS (root causes, all seen on real macOS 26.6.2 arm64, Bun 1.4.3)
I made `scripts/pty-probes.mjs` portable and ran it against the old code (RED).
Results: 8/31 passed with bash, 8/31 with zsh.
1. **The session inspector keyed on the controlling tty.** `ps` on macOS always shows `sess` as 0, so the old inspector used `tty:<name>`. I tested this: once the shell (session leader) exits, the kernel revokes the tty, and any background job left behind shows `??` with ppid 1. So a natural-exit sweep missed those jobs. They leaked (`sleep 1301` survived; I killed the leaked processes I had started). The findShell check also showed the shell was never seen as the session leader (session=`tty:ttysNNN`). That is the "ps/tty fields unverified" item from the earlier report.
   - Fix: `createDarwinInspector` lists processes with `ps -o pid=,ppid=,stat=,lstart=` and gets each process's session with getsid(2), called through `bun:ffi` on `/usr/lib/libSystem.B.dylib`. I checked that getsid still returns the dead leader's session id for orphaned jobs. It is now `sessionStable: true`, the same as Linux, because XNU does not reuse a PID that is still a session id. `ps -A` scans are shared for 20 ms, as on Linux. Outside Bun, `platformInspector()` returns `null` on darwin; terminals only run under Bun anyway.
2. **Login shell.** The catalog started zsh with `-i` only, so `/etc/zprofile` (path_helper) and `~/.zprofile` (Homebrew PATH) were never read. The old code also always put zsh first, even when the login shell was bash.
   - Fix: `darwinShellOptions` (pure, tested) starts both shells with `-l -i`, the way Terminal.app does. It puts the account's login shell (from dscl) first, at its exact path. An explicit `DNT_HARNESS_BASH` still decides which bash is used. Linux is unchanged (`bash -i`).
3. **UTF-8 input under a host with no locale.** This host (and launchd- or IDE-started hosts) has `LANG=""`, which leaves the shell in the C locale. bash 3.2's readline then mangled typed UTF-8: the probe showed 0 groups. zsh produced U+FFFD characters.
   - Fix: on darwin, `ptyEnv` sets `LC_CTYPE=UTF-8` only when `LC_ALL`, `LC_CTYPE` and `LANG` are all empty. An explicit locale is kept.

zsh job control needed no product fix. The natural-exit probe runs `setopt no_hup no_check_jobs` under zsh. Without it, zsh hangs up its own jobs on exit, so the probe would pass whether or not the service's sweep worked.

## Probe script changes (`scripts/pty-probes.mjs`)
- Runs on Linux and macOS. Adds `--shell zsh|bash` (default bash). Clean shells: `zsh -f -i` and `bash --noprofile --norc -i`.
- Uses `platformInspector()` throughout, so the production inspector is what gets tested. Command lines and fd counts are read in a platform-aware way.
- New probes: an input/output + resize probe (`echo $((6*7))`, then `stty size` before and after resizing to 132x41). On macOS only, a probe that the default terminal is the catalog's first shell and is started as a login shell (`[[ -o login ]]` / `shopt -q login_shell`).
- `tests/web/terminals-posix.spec.ts` runs the probes for bash, and for zsh when it is installed, on Linux and macOS.

## TDD evidence
- RED (probes, old code, local macOS): natural exit `left=[pid]` for both shells; shells not recognised as session leaders; UTF-8 groups=0 (bash) and replacementChars=4 (zsh); `default macOS terminal ... login shell` false (`/bin/zsh -i`).
- RED (unit tests against stashed old `src/`): `createDarwinInspector is not a function`; `darwinShellOptions is not a function`; zsh args `['-i']` instead of `['-l','-i']`.
- GREEN: local `bun scripts/pty-probes.mjs --require --shell bash` 11/11 and `--shell zsh` 11/11.
- New unit tests:
  - In `tests/web/terminals-lifecycle.spec.ts`: macOS inspector with an orphaned `??`/ppid-1 job, zombies, vanished session id, and ownsSession; ptyEnv locale rules; the `parsePsListing` test updated for the new format.
  - In `tests/capabilities/bash.spec.ts`: login-shell ordering and paths, the `DNT_HARNESS_BASH` pin, and Linux staying non-login.

## Commands / results
- `npx vitest run tests/web/terminals-posix.spec.ts tests/web/terminals.spec.ts tests/web/server-terminals.spec.ts tests/web/terminals-lifecycle.spec.ts` (local macOS): 4 files, 77/77 passed (posix spec: bash and zsh probes both real).
- `bun run typecheck`: clean.
- `bun run test -- --maxWorkers=3`: 372 files, 5123 passed, 2 skipped, 0 failed.
- CI `runtime-probes` on `ee2465c`: https://github.com/dungnt1312/dnt-harness/actions/runs/39177692003, green.
  - linux-probes: 10/10. The macOS-only login probe does not run on Linux.
  - macos-pty-probes (macos-15-arm64, macOS 15.7.9, zsh 5.9, bash 3.2.57): zsh 11/11, bash 11/11.
  - The runner account's login shell is bash, so CI covered the "bash leads, `/bin/bash -l -i`" branch. Locally the login shell is zsh, which covered the zsh branch.
- CI on the docs commit `65fa752`: https://github.com/dungnt1312/dnt-harness/actions/runs/39177849797, both jobs green.
- Process hygiene: I killed the leaked `sleep 1301` processes from the RED runs (my own probe processes, checked by command line and ppid 1). Final `pgrep` found no probe processes left.

## Files changed
- `/Users/dungnt/workspace/dnt-harness/src/web/pty-session.ts`: getsid-based darwin inspector; `parsePsListing` now returns `PsRow`.
- `/Users/dungnt/workspace/dnt-harness/src/web/terminals.ts`: `ptyEnv` is exported and gives macOS a UTF-8 LC_CTYPE.
- `/Users/dungnt/workspace/dnt-harness/src/capabilities/shell/detect.ts`: `darwinShellOptions`, `darwinUserShell`; macOS login shells.
- `/Users/dungnt/workspace/dnt-harness/scripts/pty-probes.mjs`
- `/Users/dungnt/workspace/dnt-harness/tests/web/terminals-posix.spec.ts`, `tests/web/terminals-lifecycle.spec.ts`, `tests/capabilities/bash.spec.ts`
- `/Users/dungnt/workspace/dnt-harness/.github/workflows/runtime-probes.yml`: new `macos-pty-probes` job on `macos-15`, using the same SHA pins as the Linux job (checkout v7.0.1 `3d3c42e5…`, setup-bun v2.2.0 `0c5077e5…`).
- `/Users/dungnt/workspace/dnt-harness/.github/workflows/release.yml`: gate name and comment only. The job id `linux-runtime-probes` is unchanged; it now gates on the macOS job too, through `workflow_call`.
- Docs: `README.md`, `docs/web.md`, `docs/guides.md`, `docs/release-checklist.md` (macOS section, and the gate description), and `docs/migration-runtime-hardening.md` (its support line also said macOS was unverified).

## Concerns
- The job id `linux-runtime-probes` in release.yml now covers macOS too. I left the id alone so the `needs:` list and the checklist keep working; its display name now says "Linux, macOS".
- In the docs paragraphs I touched, I replaced "Linux pending first green run" with the green run link. I did not change the separate Linux checklist line ("green on the release tag") or the release-wide "gates pending" sentence; those are Task 8's consolidation.
- `CLAUDE.md` still says "Do not claim macOS terminal support without evidence" and that the Linux gate is pending. I did not edit project instructions; the controller or user may want to update it.
- The `LC_CTYPE=UTF-8` default applies to macOS only. A Linux host with no locale would have the same input problem; I left Linux unchanged to keep the scope tight.
- On macOS, process identity uses `ps lstart`, which has one-second resolution. That is the same as before. The session id is checked again before every signal, which covers the remaining PID-reuse window.
