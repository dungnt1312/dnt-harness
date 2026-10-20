# Task 3 report: Windows release smoke in CI

Status: DONE

## What was done
- New workflow `.github/workflows/windows-smoke.yml` (windows-2025, Bun 1.4.3, Node 22.20.0, pm2 7.0.4). Triggers: `pull_request` (every PR, no path filter, so each dev head gets a run), `workflow_dispatch`, `workflow_call`. Uses the exact action pins in runtime-probes.yml (checkout v7.0.1, setup-bun v2.2.0, setup-node v7.1.0). No new actions, no secrets, `permissions: contents: read`.
  Steps: `bun install --frozen-lockfile`; `npm pack` + `bun add -g <tarball>` (global bin added to PATH); `dnt-harness --version` == package.json version; installed bun-pty DLL SHA-256 == reviewed hashes (fails on mismatch, missing, or unreviewed DLL); `bun scripts/pty-smoke-windows.mjs --require`; `npm i -g pm2@7.0.4`; `dnt-harness start pm2 --name dnt-smoke --port 3982 --data-dir <tmp>`; `bun scripts/pm2-smoke-windows.mjs`; headless chat against the existing fake gateway; `pm2 logs` on failure; `pm2 delete` + `pm2 kill` always.
- New script `scripts/pm2-smoke-windows.mjs` (Windows-only, exits 1 elsewhere): pm2 app online, `exec_interpreter` is an absolute `bun.exe` (`pm2 describe` printed), `/api/health` 200; workbench terminals over the server's HTTP API for bash/PowerShell/cmd (input -> output with a marker the typed command does not contain, resize 200, DELETE 200, natural exit with exactly one exit event via the SSE stream); `pm2 restart` and `pm2 stop` each <= 15 s while a cmd terminal runs `start /b ping`, and none of the old server's descendants (conhost/cmd/PING) survive; health 200 after restart; status `stopped` after stop.
- Headless chat: reuses `scripts/e2e/fake-gateway.mjs` (mode `plain`) with a temporary `--config` providers file (same store shape as `scripts/e2e/run-fake-e2e.mjs`); asserts `e2e-plain-ok` on stdout.
- `release.yml`: new `windows-smoke` job (`uses: ./.github/workflows/windows-smoke.yml`, `permissions: contents: read`) added to `pack.needs`. Publish job and its permissions unchanged. Header comment updated.
- Docs: `docs/release-checklist.md` (gate list + Windows section rewritten as automated, run links, remaining manual items), `docs/guides.md`, `docs/web.md`, `README.md` (Windows evidence is now the CI gate).

## Dispatch
`gh workflow run windows-smoke.yml --ref dev` was refused: `HTTP 404: workflow windows-smoke.yml not found on the default branch`. Fallback chosen: `pull_request` trigger on PR #1, always (no `paths` filter), so the dev head is always covered.

## CI results (all green, Windows Server 2025 10.0.26100)
- https://github.com/dungnt1312/dnt-harness/actions/runs/39178325530 (1f8be0c)
- https://github.com/dungnt1312/dnt-harness/actions/runs/39178618295 (4b1ee46)
- https://github.com/dungnt1312/dnt-harness/actions/runs/39178857380 (7346497, current dev head)
Each: version 0.3.0 == 0.3.0; both DLL hashes OK (`C:\Users\runneradmin\.bun\install\global\...\bun-pty\rust-pty\target\release\`); ConPTY smoke 14/14; PM2 smoke 27/27 (interpreter `C:\Users\runneradmin\.bun\bin\bun.exe`; restart ~1.5 s, stop ~0.8 s; survivors none); chat `e2e-plain-ok`. Runtime probes also green on 4b1ee46 and 7346497.

## TDD evidence
- RED: `bun scripts/pm2-smoke-windows.mjs` on macOS -> `FAIL pm2-smoke-windows: needs Windows and Bun`, exit 1 (fails rather than skipping off Windows).
- GREEN: three consecutive green Windows runs above. No failing run was needed to iterate; the first run passed. The DLL-mismatch and leftover-process failure branches were not exercised by a deliberately failing run.

## Commits (pushed to origin dev, fast-forward)
- 1f8be0c ci: add Windows release smoke workflow
- 4b1ee46 ci: gate release on the Windows smoke and document its coverage
- 7346497 docs: link green Windows smoke runs

## Files changed
- /Users/dungnt/workspace/dnt-harness/.github/workflows/windows-smoke.yml (new)
- /Users/dungnt/workspace/dnt-harness/scripts/pm2-smoke-windows.mjs (new)
- /Users/dungnt/workspace/dnt-harness/.github/workflows/release.yml
- /Users/dungnt/workspace/dnt-harness/docs/release-checklist.md
- /Users/dungnt/workspace/dnt-harness/docs/guides.md
- /Users/dungnt/workspace/dnt-harness/docs/web.md
- /Users/dungnt/workspace/dnt-harness/README.md

No product code changed, so the full suite was not run.

## Still manual (listed in the checklist)
- Workbench terminal in the browser UI (xterm rendering, keyboard, shell picker); the job drives the same routes without a page.
- Windows on ARM64: x64 runner, so `rust_pty_arm64.dll` is hash-checked but never loaded.
- Headless chat against a real provider (optional).

## Concerns
- Release gating: windows-smoke is in `pack.needs` after 3/3 green runs; if it turns out flaky on tag runs it blocks the release (by design, deterministic so far).
- Every PR push now runs a ~3.5 min Windows job.
- The checklist links runs 39178325530 and 39178618295; the run on the final head (39178857380) is recorded here, not in the checklist, to avoid an endless link-commit loop.
- The tarball smoked is packed in the Windows job from the same commit, not the `pack` job's artifact.
