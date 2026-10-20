# Task 8 report: release preparation (stopped before tagging)

Status: DONE_WITH_CONCERNS

## Done
- Removed the 6 merged worktrees (`git worktree remove --force`; each held only the dependency symlink, found with `find <wt> -maxdepth 1 -type l`). Branches kept. Main repo still resolves dependencies: `bun run typecheck` passes afterwards. `.worktrees/` is empty.
- Before-tagging checks, local macOS arm64: `preflight:node` OK (Node 24.15.0); `probe:runtime` 8/8 (16/16 outbound-http probes); full suite `--maxWorkers=3`: 374 files, 5160 passed, 2 skipped; `npm pack --dry-run`: 1955 files (bin, src, web-dist, skills, commands, README, package.json), no `.env`, keys, token-shaped strings, data dirs, tests, plans or transcripts (name matches on "secret"/"transcript" are source modules only).
- Release notes: no changelog existed and README links none, so created root `CHANGELOG.md` (0.3.0) with the required behavior changes (hooks Settings preservation and save-blocking, STT 413, macOS terminals zsh/bash with login shell and LC_CTYPE, new CI gates), plus Bun/bun-pty, features and fixes.
- Workflows: renamed job `linux-runtime-probes` to `runtime-probes`; `linux-suite.yml` now also runs on push to `main`; `release.yml` has a `pull_request` dry-run trigger (paths: release.yml only). Tag-equals-version steps and `publish` are `if: github.ref_type == 'tag'`. The dry run ran every gate job and `pack`, `publish` skipped, green (run 39193207914), so the new upload-artifact/setup-node majors and the 28-file suite list are proven.
- `docs/release-checklist.md`: ticked proven items with run links, admin items (environment `release`, ruleset `release-tags` 25362958; note "Prevent self-review" is off), pack audit, pending-wording removed; user-owned items marked **User**; added exact OAuth refresh/revoke smoke steps. Also fixed the stale "pending first green CI run" text in `docs/guides.md`, and CLAUDE.md gate-status line (rule sentence kept).
- `plans/261017-runtime-provider-hardening/plan.md`: status stays `in-review` (gates not all met); added a dated release-status line.

## CI
- First push 3d2e9f5: Linux full suite failed once on `tests/web/server-compaction.spec.ts` ("context accounting rebuilds nonzero full estimate after trimmed history"): JSON.parse of a half-written line of a ~460 KB growing session log (test race, not product; untouched by this task, passed locally, rerun-class flake). Fixed the test to count only newline-terminated lines (2 spots, commits 992ab5c, b966de3); 32/32 pass locally, typecheck passes.
- Evidence head b966de3 (code/workflow): Linux full suite 39193207887, Runtime probes 39193207884, Windows smoke 39193207918, Release dry run 39193207914, all green. Checklist links point to b966de3.
- Final head 009bd03 (docs-only commit): same four workflows green (39193634363/406/419/476). PR #1 MERGEABLE, CLEAN, up to date.

## Commits
- 3d2e9f5 ci(release): add a non-publishing dry run and run the Linux suite on main pushes
- 992ab5c, b966de3 test(compaction): ... (flake fix)
- 009bd03 docs(release): link the green runs on the release head and the dry-run workflow

## Concerns / user-owned
- Not merged, not tagged, not published. Open for the user: npm trusted publisher, OAuth refresh/revoke live smoke (steps in checklist), environment approval, merge PR #1, push v0.3.0 tag.
- Linux suite had one race flake (fixed in test); first real tag run remains the final proof of `publish`.
- CHANGELOG claim "web terminal uses Bun's built-in PTY on POSIX" is from commit subject `feat(web): run the terminal on Bun's built-in PTY`; not re-verified in source.
