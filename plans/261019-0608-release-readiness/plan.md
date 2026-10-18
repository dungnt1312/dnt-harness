---
title: "Release readiness for v0.3.0"
status: in-progress
branch: dev
created: 2026-10-19
---

# Release readiness for v0.3.0

Goal: every gate and evidence item in [docs/release-checklist.md](../../docs/release-checklist.md) is green or explicitly owned by the user, so v0.3.0 (`package.json` already says 0.3.0; last tag v0.2.0) can be tagged.

User decisions (2026-10-19):

- Stop at "ready": do not merge PR #1, do not create or push tags. The user merges and tags.
- Repository admin setup (environment `release`, tag ruleset) is done by the controller via `gh`.
- macOS terminal support with zsh (and bash) must work and be proven, then claimed in the docs.
- OAuth refresh/revoke live smoke is done manually by the user; the release docs carry the steps.

## Global Constraints

- Branch `dev` in `/Users/dungnt/workspace/dnt-harness`; PR https://github.com/dungnt1312/dnt-harness/pull/1 (dev → main) is open. Push fast-forward to `origin dev` when a task's checks pass; never force-push, never merge the PR, never create tags.
- Use Bun 1.4.3. `bun run test` (not `bun test`), `bun run typecheck`, `bun run build:web` when web code changes. Node >= 22.19 first on PATH for Vitest. Local full suite: `--maxWorkers=3`; re-run a single failing spec once to separate load flakes and report which.
- Conventional commits, no AI references, no Co-Authored-By trailer, no plan/phase/finding IDs in code, test names, workflow names or commit messages.
- Workflow actions stay pinned to full commit SHAs with a version comment. Resolve SHAs from the action's real release tag via `gh api`, never invent one.
- Never print, log or commit secrets. CI jobs must not need provider keys.
- Never stop processes you did not start; stop every server/PTY/PM2 app you start. PM2: only throwaway apps with unique names.
- A shell hook blocks commands that contain the word `node_modules`; do not try to bypass it.
- Reports go under `plans/261019-0608-release-readiness/reports/`.

## Tasks

### Task 1: CI runner and action hygiene

- Pin every `runs-on: ubuntu-latest` in `.github/workflows/*.yml` to `ubuntu-24.04` (GitHub moves `ubuntu-latest` to Ubuntu 26 from 2026-10-19).
- Remove the Node 20 actions deprecation warning: bump `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`/`download-artifact` and any other JavaScript action flagged in the latest run's annotations (`gh run view 39144804342` or the newest run) to the newest release that runs on Node 24, pinned by SHA with a version comment. Keep `oven-sh/setup-bun` on a Node-24-capable release too if flagged.
- Push and confirm the PR's `runtime-probes` run is green and has no Node 20 deprecation annotation.

Acceptance: green run on the pushed head, no deprecation annotation, every action SHA-pinned to a real tag.

### Task 2: macOS terminal support (zsh and bash)

- On this Mac (real macOS, Bun 1.4.3) run `bun scripts/pty-probes.mjs --require` with zsh and with bash (find how the probe picks the shell; add a shell selector if missing). Cover input/output, resize, close, idle reap, natural exit, and shutdown teardown of foreground/background jobs and a HUP-trapping job.
- Fix anything macOS-specific that fails (e.g. the process inspector's `ps`/tty fields, session-leader assumptions, zsh job control), each with a test. The default shell on macOS is zsh: make sure the workbench terminal starts the user's login shell correctly.
- Run `tests/web/terminals-posix.spec.ts`, `tests/web/terminals.spec.ts`, `tests/web/server-terminals.spec.ts` locally on macOS and fix failures.
- Add a macOS job (pinned `macos-15` or the current stable macOS runner label) to `runtime-probes.yml` that runs the PTY probes with zsh and bash. Push; it must be green.
- Update README.md, docs/web.md and docs/guides.md to claim macOS terminal support with the evidence, and the release checklist's macOS section.

Acceptance: probes pass locally with zsh and bash, the macOS CI job is green, docs claim macOS with links to the run.

### Task 3: Windows release smoke in CI

The checklist's Windows launcher/PM2 smoke is required and there is no Windows machine. Automate it as a `workflow_dispatch` (and `workflow_call`) workflow on `windows-2025` (or current stable Windows label), Bun 1.4.3:

- `npm pack` the repo, `bun add -g <tarball>`, `dnt-harness --version` equals `package.json` version.
- `pm2` installed in the job; `dnt-harness start pm2 --name dnt-smoke` with an absolute Bun path; `pm2 describe dnt-smoke` shows interpreter bun (absolute) and `/api/health` answers 200.
- `bun scripts/pty-smoke-windows.mjs --require` from the checkout.
- The installed bun-pty DLL SHA-256 values equal the reviewed hashes in docs/release-checklist.md (fail otherwise).
- `pm2 restart dnt-smoke` and `pm2 stop dnt-smoke` each finish within 15 s with no leftover shell processes.
- Headless `chat --message` needs a real provider: replace it with a headless run against a local fake OpenAI-compatible server started in the job (the test suite has fixtures for this), so no secret is needed.
- The workbench terminal manual items (bash/PowerShell/cmd via UI) are covered by pty-smoke-windows where possible; list any item that remains manual.
- Dispatch the workflow on `dev` and make it green. Link it from the release checklist and make `release.yml` depend on it if that keeps the release gate deterministic.

Acceptance: a green Windows smoke run on the dev head, linked in the checklist.

### Task 4: Full Vitest suite on Linux and promotion of stable suites

- Add a Linux (`ubuntu-24.04`) job (workflow_dispatch + pull_request in `runtime-probes.yml` or a new workflow) that runs the full `bun run test` suite under Node 22.20 and Bun 1.4.3.
- Make it green: fix real failures with tests; for genuine host-environment limits (no display, missing native media tool), skip with an explicit, documented condition rather than weakening assertions.
- Then run the suites listed under "Suites left out of the deterministic gate" in docs/release-checklist.md on Linux; add each one that passes reliably (3 consecutive green runs) to `deterministic-suites` in `release.yml`, and tick that checklist item.

Acceptance: full suite green on Linux in CI; promoted suites listed; checklist updated.

### Task 5: Repair the chat-workflows Playwright e2e

`tests/browser/chat-workflows.e2e.ts` fails 19/52. Causes found: selector for the removed "Advanced · edit raw JSON" button (removed 2026-10-08, 55d1a51); exact/ambiguous selectors after the "Providers & Models" rename (e4cb0b2, b188544); unmocked `/api/usage`; keyboard test expects ArrowDown from Providers to land on Advanced but the rail order is Providers, Usage, Advanced; two "advanced limits draft" cases (375 px, 1024 px) from merge 641c0d6 never seen passing. Update selectors/fixtures to the current UI; change product code only for a real UI bug, with a focused unit test. Every API stays mocked; stop the Vite server afterwards.

Acceptance: whole e2e file passes (52/52 or with a documented, justified skip), typecheck and test pass.

### Task 6: Behavioral prompt eval

Spec `plans/261017-spec-runtime-provider-hardening.md` §11.3 requires, besides string tests, a small eval: a misspelled symbol, a wrong alias/path that needs a changed search, and a task about something that does not exist that must stop; measure recall together with tool count, not tool count alone. Implement it as an opt-in script (like `scripts/smoke-deepseek-reasoning.ts`, skipping without a key) plus deterministic fixture tests for the scoring logic. Run it once live through the `ocproxy-2` provider (`deepseek-v4.1-flash-free`) with the key loaded at runtime from `~/.dnt-harness/providers.json` and passed only via the child environment. Record results in the hardening final report and mark §11.3 met or explain the gap.

Acceptance: eval script + scoring tests committed; one live run recorded; final report updated.

### Task 7: Deferred minors from the previous run

- `src/harness/agents/executor.ts` boot recovery computes `currentRun(parentEvents, childEvents, childId)` twice per child — compute once.
- `tests/web/mcp-runtime-reconciliation.spec.ts` ~784: assert exactly one live process while the transport is stdio instead of `toBeLessThanOrEqual(1)`.
- `src/web/server.ts` ~274: comment that `resultHash` covers the model-visible text including the in-flight note.
- docs/web.md speech-to-text: an oversized transcribe body also returns 502 (`readBytes` inside the `try`) — either return 413 for oversize (preferred, with a test) or document it.
- `plans/260922-1139-mcp-production-completion/phase-06-process-ownership-and-resource-policy.md` PM2 drill checkbox: scope the wording to "direct child" or add a grandchild to the drill fixture and re-run.

Acceptance: each item done with focused test runs; typecheck and test pass.

### Task 8: Release preparation (stop before tagging)

- Remove the 6 merged worktrees left last run (`compact-fast-stable`, `compact-live-acceptance`, `feat-zed-git-panel`, `session-load-baseline`, `session-load-perf`, `speech-to-text` under `.worktrees/`). Detect a link with `find <wt> -maxdepth 1 -type l` (do not name the directory in commands). On macOS `git worktree remove --force` unlinks a symlink without following it; verify the main repo's dependencies still resolve afterwards (`bun run typecheck`).
- Run the "Before tagging" checklist locally: `bun run preflight:node`, `bun run probe:runtime`, full suite, `npm pack --dry-run` audit (no secrets, transcripts, `.env`, data dirs, `route-identity.secret`).
- Write release notes for v0.3.0 (since v0.2.0) in the repo's existing changelog/notes location (create `CHANGELOG.md` only if none exists and README links nothing else).
- Update docs/release-checklist.md: tick what is now proven with links, keep user-owned items (npm trusted publisher, OAuth manual smoke, environment approval) clearly marked, and add exact manual OAuth refresh/revoke smoke steps for the user.
- Update `plans/261017-runtime-provider-hardening/plan.md` status if all its gates are now met.

Acceptance: worktrees removed, local before-tagging checks pass, release notes and checklist updated, PR #1 green and up to date.
