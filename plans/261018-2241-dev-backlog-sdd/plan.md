---
title: "Dev backlog after runtime hardening"
status: completed
branch: dev
created: 2026-10-18
---

# Dev backlog after runtime hardening

Closes the open work found on `dev` on 2026-10-18 (status scan). Decisions by the user:

- POSIX terminals use Bun's built-in PTY (go decision); Linux CI provides the evidence.
- Live DeepSeek smoke uses the existing `ocproxy` provider (`~/.dnt-harness/providers.json`, entry `ocproxy-2`, model `deepseek-v4.1-flash-free`).
- Merge the unmerged feature branches into `dev`, continue MCP Production Completion, fix stale plan statuses and clean merged worktrees.

## Global Constraints

- Work on branch `dev` in `/Users/dungnt/workspace/dnt-harness`. Use Bun; `bun run test` (not `bun test`) and `bun run typecheck`; `bun run build:web` when web code changes. Node >= 22.19 must be first on PATH for Vitest (`bun run preflight:node`). Local suite may need `--maxWorkers=3`.
- Never print, log, commit or write API keys/tokens anywhere. Secrets come from `~/.dnt-harness` at runtime only.
- Conventional commits, no AI references, no plan/phase/finding IDs in code, test names or commit messages.
- Never touch PM2 apps you did not create. Never stop processes you did not start.
- Never delete untracked user files. A `node_modules` inside a worktree may be a link to the main repo's `node_modules`: remove such a link with `rm` on the link itself (no trailing slash) and verify it is gone before `git worktree remove`; never `--force` over a worktree that still contains it.
- Reports go under `plans/261018-2241-dev-backlog-sdd/reports/`.

## Tasks

### Task 1: Merge unmerged feature branches into dev

Merge, in this order, each with `git merge --no-ff` into `dev`: `fix/ctx-meter-a11y` (1 commit), `feat/session-load-perf` (1), `feat/speech-to-text` (1), `feat/subagent-resume-background` (6), `feat/app-config-slice` (20 commits, 302 behind dev — expect conflicts).

- Before each merge, read the branch diff (`git diff dev...<branch>`) and confirm it is a finished change (tests included, no debug leftovers). If a branch is clearly unfinished, skip it and record why.
- Resolve conflicts by keeping `dev`'s newer behavior and re-applying the branch's intent; never drop either side silently.
- `feat/app-config-slice` has 2 uncommitted doc edits in worktree `.worktrees/core-config` (`docs/superpowers/plans/2026-10-06-global-configuration-advanced-settings.md`, `docs/superpowers/specs/2026-10-06-core-stabilization-configuration-contract.md`). Inspect them; if they are finished doc corrections, commit them on that branch before merging; otherwise leave them and merge the committed branch only.
- After all merges: `bun run typecheck`, `bun run test`, `bun run build:web` all pass on `dev`. Fix integration breakage with focused commits.
- Do not push.

Acceptance: every listed branch is merged or explicitly skipped with a reason; `git rev-list --count dev..<branch>` is 0 for merged ones; typecheck, test and build:web pass.

### Task 2: Live smokes (DeepSeek reasoning via ocproxy, public HTTPS MCP under Bun)

1. DeepSeek reasoning smoke: run `scripts/smoke-deepseek-reasoning.ts` under Bun with `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` taken at runtime from the `ocproxy-2` provider in `~/.dnt-harness/providers.json` (decrypt via the product's own provider-store code if the key is stored encrypted), model argument `deepseek-v4.1-flash-free`. Pass the key through the environment of the child process only. If the base URL needs `/v1` or not, determine it from how `DeepSeekProvider` builds request URLs. If the script fails because of a real product bug, fix the bug with a test; if it fails because the proxy model lacks thinking mode, record that precisely.
2. Public HTTPS MCP under Bun: exercise the real outbound transport (custom Undici connect) against one public, unauthenticated, read-only Streamable HTTP MCP endpoint over real TLS: connect, list tools, call one read-only tool. OAuth refresh/revoke needs a real account — mark it not run unless a configured OAuth MCP server already exists in `~/.dnt-harness`.
3. Update `plans/261017-runtime-provider-hardening/reports/phase-06-final-report.md` rows PH4-G and RH1-G with the dated result (pass/fail, model, what was exercised, nothing secret), and commit.

Acceptance: both smokes were run (or a precise reason recorded); the report rows reflect real evidence; no secret in any file or commit.

### Task 3: Linux CI evidence via PR dev → main

1. Push `dev` to `origin` and open a PR `dev` → `main` (title: "Runtime hardening, merged feature branches and live smokes"). The `runtime-probes` workflow runs on `pull_request`.
2. Wait for the `runtime-probes` run to finish (use `gh run watch` in a bounded way). Read results for RH1-B Linux DNS, RH2-C POSIX names, RH3-A/C/E PTY probes (`scripts/pty-probes.mjs --require`).
3. If a job fails due to a product bug, fix it on `dev` with a test, push, and re-check. Bun's built-in PTY stays the POSIX backend (user decision); if RH3-A fails because Bun's PTY child is not a session leader, fix within the built-in PTY path if possible and record the outcome.
4. Update the final report's Linux rows and the "Pending gates" section with run URL and results; commit and push.

Acceptance: a green (or precisely explained) `runtime-probes` run on the PR; report updated with run URL; do not merge the PR.

### Task 4: MCP Production Completion — finish phase 06, continue phase 07

Plan: `plans/260922-1139-mcp-production-completion/plan.md`; phases `phase-06-process-ownership-and-resource-policy.md` and `phase-07-desired-state-runtime-reconciliation.md`.

1. Phase 06 open items: Windows Job Object and Linux cgroup v2 hard limits stay refused (not claimed) — confirm the refusal is tested and the checkbox text states that the item is closed as "refused, not claimed" only if the phase's own acceptance allows it; otherwise leave it open with the reason. PM2 drill: run the shutdown/restart drill against a throwaway PM2 app you create (unique name, removed afterwards), only if host load is low (check `uptime`/`vm_stat`); record evidence.
2. Phase 07 open items (lines 74-82): implement and test each, keeping existing permission/mode/child/workspace contracts green. Tick a checkbox only with a passing test that proves it.
3. Run `bun run typecheck` and `bun run test`; commit per coherent item; update phase checkboxes and plan progress.

Acceptance: every phase 07 checkbox is either ticked with a named test or left open with a one-line reason; full suite and typecheck pass.

### Task 5: Plan status hygiene and merged worktree cleanup

1. Update status frontmatter/lines: `plans/261008-subagent-model-alias/plan.md` → completed, `plans/261008-1643-usage-stats-tab/plan.md` → completed, `plans/261001-fs-tool-reliability/plan.md` → completed if its change is on `dev` (verify by grepping for `fs-text-document.spec.ts`), `plans/260922-1037-modes-as-single-source/plan.md` already completed (add frontmatter `status: completed` if missing), `plans/261012-2228-session-switch-sdd/plan.md` → completed if `feat/session-load-perf` is merged into dev. Set `plans/261017-runtime-provider-hardening/plan.md` status to reflect Task 2/3 results. Commit.
2. Remove worktrees whose branch is fully merged into `dev` (`git rev-list --count dev..<branch>` = 0) and whose only untracked content is `node_modules` or SDD scratch files (`*-review-package.txt`, `progress.md` under plans). Copy any untracked plan file that is not already on dev into the same path on dev first. Follow the node_modules rule in Global Constraints. Keep `.worktrees/core-config` if Task 1 left uncommitted edits there, and keep `/Users/dungnt/workspace/dnt-harness-wait-progress` unless merged and clean. Do not delete branches.

Acceptance: plan statuses match reality; removed worktrees list recorded in the report; main repo `node_modules` intact (`bun run typecheck` still runs).
