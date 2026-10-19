# Task 4 report: full Vitest suite on Linux, promotion of stable suites

Status: DONE_WITH_CONCERNS (concerns at the end; none block)

## What was done

1. Added `.github/workflows/linux-suite.yml` (job `full-suite`): ubuntu-24.04, Bun 1.4.3,
   Node 22.20.0, `bun install --frozen-lockfile`, `bun run test` (30 min timeout).
   Triggers: `pull_request` and `workflow_dispatch`. It is its own workflow so the
   fast `runtime-probes.yml` gate never waits on it. `concurrency` cancels stale runs
   per ref. Action SHAs are the same pins as runtime-probes/release (checkout v7.0.1,
   setup-bun v2.2.0, setup-node v7.1.0).
   `workflow_dispatch` returns 404 until the file exists on `main`, so every Linux
   run here came from `pull_request` on PR #1 (plus `gh run rerun`).
2. First Linux run (39179322778) had **1 failure** out of 5125 tests:
   `tests/harness/processes/command-lifecycle.spec.ts` "foreground root exit does not
   turn a held pipe into a retained background tree".
3. Added a temporary `candidate-suites` job (matrix attempt 1..3, each candidate spec in
   its own `vitest run`, `CANDIDATE PASS/FAIL` per file) to measure the 18 excluded suites.
4. A rerun exposed a second, load-dependent failure in the full suite:
   `tests/harness/mcp-client-fixes.spec.ts` "keeps a caller transport connected while
   recovery teardown is suspended" (`server 'fx' is disabled by the circuit breaker`).
5. After both fixes: 3 consecutive green runs, then all 18 suites promoted into
   `deterministic-suites`, checklist updated, candidate job removed.

## Root causes and fixes

### command-lifecycle held-pipe case: test timing (test-only fix)
- Cause: the case gave `bash -lc 'sleep 5 & exit 0'` an 80 ms foreground budget. A
  login bash on a loaded runner can take longer than that to start. `isBareSleep`
  treats the command as a bare `sleep`, so on deadline it is killed, giving
  `[terminated by timeout; killed]`.
- The old case also never checked the property it names. A mutant where root exit no
  longer seals the foreground (registry `exit` handler returns early) still passed,
  because the drain path waited the full 5 s for the pipe holder.
- Fix (c468220): a 2 s budget for the shell to start, plus
  `expect(Date.now() - started).toBeLessThan(4_000)`.
  - RED: with the mutant, it fails with `expected 5021 to be less than 4000`.
  - GREEN: 12/12 pass on the real code.
  - The assertion is stricter than before, not weaker.

### MCP breaker recovery: real product race (product fix)
- Cause: `scheduleRecovery` arms a `setTimeout` for `breakerUntil - Date.now()`. Node
  timers run on the event loop's cached clock, so the timer can fire a few ms before
  `Date.now()` reaches `breakerUntil`. Recovery then enters half-open and starts the
  teardown. A caller arriving in that gap was rejected by `callTool`'s
  `Date.now() < breakerUntil` check instead of sharing the half-open connect.
- Fix (a625583, `src/harness/mcp/client.ts`): set `breakerUntil = 0` when recovery
  enters half-open, since the open window ends there. A failed probe still re-opens
  the breaker through `openBreaker`, which sets a new deadline.
- New test in `tests/harness/mcp-client-fixes.spec.ts` freezes `Date.now` so the
  recovery timer fires "early":
  - RED: fails with exactly the CI error (`McpDispatchError: server 'fx' is disabled by
    the circuit breaker`).
  - GREEN: passes after the fix.
  - The existing case is unchanged.

No host-limit skips were needed. The 3 Linux skips are pre-existing explicit conditions:
- `tests/capabilities/bash.spec.ts:211` runs on win32 only.
- `tests/web/git-askpass.spec.ts:429` runs on win32 only.
- The zsh PTY probe in `tests/web/terminals-posix.spec.ts` runs only when zsh is
  installed. The runner has none; `macos-pty-probes` covers zsh.

## CI evidence

| Run | Commit | Result |
|---|---|---|
| [39179322778](https://github.com/dungnt1312/dnt-harness/actions/runs/39179322778) | 9630c98 | full suite: 1 failed / 5121 passed / 3 skipped (command-lifecycle) |
| [39179875153](https://github.com/dungnt1312/dnt-harness/actions/runs/39179875153) attempt 1 | 8d18cc2 | full suite 5122 passed / 3 skipped; candidates 3/3 legs green |
| 39179875153 attempt 2 | 8d18cc2 | full suite: 1 failed (mcp-client-fixes breaker race); candidates green |
| [39181016471](https://github.com/dungnt1312/dnt-harness/actions/runs/39181016471) attempts 1, 2, 3 | a625583 | **3 consecutive green**: full suite 5123 passed / 3 skipped each; candidates 18/18 files PASS in all 9 legs, 0 FAIL |
| [39182208153](https://github.com/dungnt1312/dnt-harness/actions/runs/39182208153) | cf8275d (head) | Linux full suite green |
| 39182208144 / 39182208216 | cf8275d | Runtime probes green / Windows smoke green |

Promoted into `release.yml` `deterministic-suites`, all 18 (none left out):
- `tests/web/terminals-posix.spec.ts`
- `tests/web/terminals.spec.ts`
- `tests/web/server-terminals.spec.ts`
- `tests/web/server-models.spec.ts`
- `tests/bins/headless.spec.ts`
- `tests/harness/image-tools.spec.ts`
- `tests/harness/image-tools-mode-exposure.spec.ts`
- `tests/harness/video-tools.spec.ts`
- `tests/harness/mcp-oauth.spec.ts`
- `tests/harness/mcp-oauth-config.spec.ts`
- `tests/harness/mcp-oauth-discovery.spec.ts`
- `tests/harness/mcp-oauth-registration.spec.ts`
- `tests/web/mcp-oauth-connect.spec.ts`
- `tests/web/mcp-oauth-paste.spec.ts`
- `tests/web/mcp-oauth-races.spec.ts`
- `tests/web/mcp-oauth-redirect.spec.ts`
- `tests/web/mcp-shutdown-oauth.spec.ts`
- `tests/harness/mcp-client-fixes.spec.ts`

## Local verification (macOS)
- `npx vitest run tests/harness/processes/command-lifecycle.spec.ts`: 12/12 pass; the
  mutant RED is described above.
- `npx vitest run tests/harness/mcp-client-fixes.spec.ts`: 23/23 pass.
  `npx vitest run mcp`: 34 files, 317 tests pass.
- `bun run typecheck`: clean.
- `bun run test -- --maxWorkers=3`: 372 files, 5124 passed, 2 skipped.
- The exact 28-file list from the release gate, extracted from `release.yml`:
  28 files, 579 tests pass.
- All three workflows parse (`Bun.YAML.parse`).

## Commits (on `dev`, pushed fast-forward)
- 9630c98 ci: run the full Vitest suite on Linux
- c468220 test: bound the held-pipe lifecycle case by root exit, not a tight shell-start budget
- 8d18cc2 ci: run the release-gate candidate suites three times on Linux
- a625583 fix(mcp): end the breaker window when recovery starts
- cf8275d ci: promote the Linux-proven suites into the release gate

## Files changed
- `.github/workflows/linux-suite.yml` (new)
- `.github/workflows/release.yml` (18 suites added; comment updated)
- `.github/workflows/runtime-probes.yml` (stale "known host-environment failures" comment updated)
- `docs/release-checklist.md` (gate list, "Linux full suite and promoted suites" section, item ticked, full-suite pre-tag item mentions `linux-suite.yml`)
- `src/harness/mcp/client.ts`
- `tests/harness/processes/command-lifecycle.spec.ts`
- `tests/harness/mcp-client-fixes.spec.ts`

## Concerns
- `release.yml` runs only on tags, so the expanded 28-file `deterministic-suites`
  command itself has not run on Linux in that exact combination. Every file passed
  3/3 on Linux in isolation and inside the full suite, and the combined list passes
  locally. The first real tag run is the remaining proof, as the checklist already says.
- The Linux full suite takes about 4 minutes and runs on every PR push in parallel with
  the other workflows. It is not marked required, so nothing waits on it unless branch
  protection makes it so.
- The breaker race was seen once in 6 full-suite runs. It is fixed at the cause, but
  the 3-run promotion window is a small sample for a timing-class bug.
