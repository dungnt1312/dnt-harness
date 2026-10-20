# Release checklist

A tag push (`v*`) starts `.github/workflows/release.yml`. The publish job runs
only when all of these hold:

1. **Automated gates pass** (`needs:`):
   - `typecheck-build`: `bun run typecheck`, `bun run build:web`, tag equals
     the `package.json` version.
   - `deterministic-suites`: a stable Vitest subset under Node 22.20
     (outbound-http, mcp-outbound-policy, repo-freeze, terminals-lifecycle,
     effective-model, provider-error-classification, reasoning-round-trip,
     llm-openai, bench-metrics, base-prompt-guidance, plus the suites promoted
     below).
   - `runtime-probes` (`runtime-probes.yml` via `workflow_call`): Bun
     1.4.3 runtime/Undici/DNS probes and `bun scripts/pty-probes.mjs --require`
     (real bash PTY teardown) on Linux, plus the `macos-pty-probes` job:
     the same probes with `--shell zsh` and `--shell bash` on macos-15.
   - `windows-smoke` (`windows-smoke.yml` via `workflow_call`): the Windows
     launcher / PM2 smoke below, on windows-2025 with Bun 1.4.3.
   - `pack` (no OIDC token): tag equals version, `bun install
     --frozen-lockfile`, `npm pack` (prepack = `vite build`), tarball uploaded
     as an artifact.
2. **A required reviewer approves the protected `release` environment**,
   after checking the manual evidence below. Only then does `publish`
   (the one job with `id-token: write`) download the tarball and run
   `npm publish <tarball> --ignore-scripts` under Node 24.22.0 (npm 11.19.1;
   trusted publishing needs npm ≥ 11.5.1). No checkout, no install.

Every gate except the tag-only steps (tag equals version, `publish`) is green
on the release pull request, and a pull request that touches `release.yml`
runs the gate jobs and `pack` as a dry run without `publish`. The first real
tag run is still the final proof; link its gate runs under "Manual evidence".
Release notes: [CHANGELOG.md](../CHANGELOG.md).

Evidence head: all links below point to `efbc3c6`, the last code, test and
workflow commit on `dev`; later commits change docs only. The dry run of this workflow
(every gate job and `pack`, `publish` skipped) is [run 39198490636](https://github.com/dungnt1312/dnt-harness/actions/runs/39198490636).

### Linux full suite and promoted suites

`.github/workflows/linux-suite.yml` (ubuntu-24.04, Node 22.20, Bun 1.4.3) runs
the whole `bun run test` suite on every pull request, on every push to `main`
(so the commit a tag is cut from has a run) and on `workflow_dispatch`.
While promoting, it also had a `candidate-suites` job that ran each suite below
in its own Vitest process, three times in parallel. Three consecutive green runs on
`a625583` ([run 39181016471](https://github.com/dungnt1312/dnt-harness/actions/runs/39181016471),
attempts 1–3: full suite 5123 passed, 3 skipped; every candidate file green in
all nine legs) promoted all of these into `deterministic-suites`:

- `tests/web/terminals-posix.spec.ts`, `tests/web/terminals.spec.ts`,
  `tests/web/server-terminals.spec.ts`
- `tests/web/server-models.spec.ts`
- `tests/bins/headless.spec.ts`
- `tests/harness/image-tools.spec.ts`, `tests/harness/image-tools-mode-exposure.spec.ts`,
  `tests/harness/video-tools.spec.ts`
- `tests/harness/mcp-oauth*.spec.ts`, `tests/web/mcp-oauth*.spec.ts`,
  `tests/web/mcp-shutdown-oauth.spec.ts`
- `tests/harness/mcp-client-fixes.spec.ts`

No suite is left out. The three Linux skips are explicit host conditions:
two Windows-only cases (`tests/capabilities/bash.spec.ts`,
`tests/web/git-askpass.spec.ts`) and the zsh PTY probe in
`terminals-posix.spec.ts`, which runs only where zsh is installed (the runner
has none; `macos-pty-probes` covers zsh).

- [x] Run these on the Linux runner and add each one that passes reliably
      (3 consecutive green runs) to the `deterministic-suites` list in `release.yml`.

## Cut the release (maintainer)

Ordered, user-owned steps. Do not skip ahead: each one is the precondition of
the next. `package.json` already holds `0.3.0`, so never run `npm version`.

1. [ ] Configure the npm trusted publisher (repository, workflow `release.yml`,
       environment `release`). See "One-time repository setup".
2. [ ] Merge pull request #1 (`dev` into `main`).
3. [ ] Wait for the `linux-suite` run triggered by the push to `main` to finish
       green. Note the merge commit sha.
4. [ ] Tag that merge commit by hand and push the tag:
       `git tag -a v0.3.0 <main sha> -m v0.3.0 && git push origin v0.3.0`
5. [ ] Watch the tag run of `release.yml`. The Windows (`windows-smoke`) and
       macOS (`macos-pty-probes`, inside `runtime-probes`) gates must be green.
       If `macos-pty-probes` fails, drop the macOS claim from README.md,
       docs/web.md, docs/guides.md and CHANGELOG.md before approving.
6. [ ] Do the manual checks below: the browser terminal and Windows on ARM64
       (under "Still manual"), and the OAuth refresh/revoke smoke if you want
       that claim. Link the tag-run gate runs under "Manual evidence".
7. [ ] Approve the `release` environment deployment. Only then does `publish` run.
8. [ ] If the OIDC publish fails, re-run only the `publish` job from the same
       run (the tarball artifact is kept for 7 days). Do not re-tag.

## One-time repository setup (admin)

The workflow cannot enforce these itself. They must exist before anyone relies
on tag-triggered publish:

- [x] Settings → Environments → `release`: required reviewer `dungnt1312`,
      deployment restricted to `v*` tags. "Prevent self-review" is **off**
      (sole maintainer, who is also the tag author and reviewer).
- [x] Tag ruleset `release-tags` (id 25362958) for `v*`: only maintainers may
      create, update or delete release tags.
- [ ] **User:** npm trusted publisher configured for this repository, workflow
      `release.yml`, environment `release`.
- [x] Workflow actions stay pinned to full commit SHAs (version comment beside
      each). Update them deliberately, never to a moving tag. (Done.)

## Before tagging (maintainer, local)

- [x] `bun run preflight:node` (Node >= 22.19) and `bun run probe:runtime`
      (Bun 1.4.3) pass. Local, macOS arm64: Node 24.15.0, probes 8/8.
- [x] Full suite run on a supported host (a green `linux-suite.yml` run on the
      tagged commit counts). Linux run: [run 39198490517](https://github.com/dungnt1312/dnt-harness/actions/runs/39198490517) (full suite green); local macOS (Node 24.15.0, `--maxWorkers=3`): 374 files, 5160 passed, 2 skipped. Any failure is either on the pinned
      baseline inventory (`plans/261017-runtime-provider-hardening/reports/phase-00-baseline.md`)
      or classified (isolated rerun: flake vs regression). Never "all green"
      by footnote.
- [x] `npm pack --dry-run`: no secrets, transcripts, `.env`, data dirs or
      `route-identity.secret` in the tarball. Audited on the release commit:
      1955 files (`bin`, `src`, `web-dist`, `skills`, `commands`, `README.md`,
      `package.json`), no `.env`, key material, token-shaped strings, data
      directories, tests, plans or transcripts; the only file names containing
      "secret" or "transcript" are source modules.

## Manual evidence (attach links/logs to the environment approval)

### Windows launcher / PM2 smoke (required, automated)

`.github/workflows/windows-smoke.yml` (windows-2025, Bun 1.4.3, pm2 7.0.4)
runs on every pull request, on `workflow_dispatch`, and as the `windows-smoke`
gate of `release.yml`. It packs the repo and checks:

- `npm pack`, `bun add -g <tarball>`; `dnt-harness --version` equals the
  `package.json` version.
- `dnt-harness start pm2 --name dnt-smoke`; pm2 reports the app online with
  an **absolute** `bun.exe` interpreter (`pm2 describe` is printed) and
  `/api/health` answers 200 (`scripts/pm2-smoke-windows.mjs`).
- From the checkout: `bun scripts/pty-smoke-windows.mjs --require` (I/O,
  resize, natural exit, kill with background-job cleanup, no console-host
  leak, 16 terminals).
- The globally installed bun-pty DLLs match the reviewed ones (bun-pty 0.5.1);
  any other or unreviewed DLL fails the job:
  `rust_pty.dll` SHA-256 `6F45D637E26365BD72A16964453047E2D563F2E3FD0D374A9182C0F38C6F5CFC`,
  `rust_pty_arm64.dll` SHA-256 `CA64B48DBC617DD5684D405DDE4A605470F05B952153C36EF08A2E39B1D15E76`.
  Any bun-pty version bump needs a new review and new hashes (in this file
  and in the workflow).
- Workbench terminals through the running server's HTTP API, for bash,
  PowerShell and cmd: input → output, resize, close (DELETE answers 200),
  natural `exit` with exactly one exit event.
- `pm2 restart dnt-smoke` and `pm2 stop dnt-smoke` each finish within 15 s
  while a cmd terminal runs a background job, and no shell process of the
  old server survives; the server is healthy again after the restart.
- Headless `dnt-harness chat --message "hello"` against a local fake
  OpenAI-compatible gateway (`scripts/e2e/fake-gateway.mjs`) through a
  temporary `--config`; no provider secret.

Green on `dev` (windows-2025, Windows Server 2025 10.0.26100): ConPTY smoke
14/14, PM2 smoke 27/27, both DLL hashes OK, headless chat OK, in
[run 39178325530](https://github.com/dungnt1312/dnt-harness/actions/runs/39178325530)
and [run 39178618295](https://github.com/dungnt1312/dnt-harness/actions/runs/39178618295).

- [x] `windows-smoke` green on the release pull request head ([run 39198490618](https://github.com/dungnt1312/dnt-harness/actions/runs/39198490618)).
- [ ] `windows-smoke` green on the release tag (link the run).

Still manual (not covered by the job):

- [ ] Workbench terminal in the browser UI (xterm rendering, keyboard input,
      the shell picker); the job drives the same server routes without a page.
- [ ] Windows on ARM64: the job runs on x64, so `rust_pty_arm64.dll` is
      hash-checked but never loaded.
- [ ] Headless chat against a real configured provider (optional; the fake
      gateway proves the CLI path, not a provider).

### Linux (required, automated)

- [x] `linux-probes` (probes 8/8, PTY probes) green on the release pull request
      head ([run 39198490537](https://github.com/dungnt1312/dnt-harness/actions/runs/39198490537)).
- [ ] `runtime-probes` gate green on the release tag (link the run). Linux
      terminal support is not claimed without this.

### macOS (claimed: zsh and Bash terminals)

macOS terminal support **is claimed** for this release. Evidence:

- [x] On real macOS with Bun 1.4.3, zsh and Bash: input/output, resize, close,
      idle reap, natural exit, and shutdown teardown of foreground/background
      jobs and a HUP-trapping job (`scripts/pty-probes.mjs`). Local: macOS 26
      (arm64), zsh 5.9 and bash 3.2.57, 11/11 probes each with
      `--require --shell zsh` and `--require --shell bash`. CI: the
      `macos-pty-probes` job (macos-15 arm64, macOS 15.7), 11/11 for both
      shells, green in [run 39177692003](https://github.com/dungnt1312/dnt-harness/actions/runs/39177692003).
- [x] README.md, docs/web.md and docs/guides.md say macOS is supported.
- [x] `macos-pty-probes` green on the release pull request head ([run 39198490537](https://github.com/dungnt1312/dnt-harness/actions/runs/39198490537)).
- [ ] `macos-pty-probes` green on the release tag (link the run). If it is not,
      drop the macOS claim from those docs before publishing.

### Optional live smokes (needed before the matching support claim)

- [ ] **User:** RH1-G OAuth refresh/revoke live smoke, steps below. The public
      HTTPS MCP part passed under Bun (`mcp.deepwiki.com`); refresh/revoke was
      not run because it would rotate or destroy live account tokens.
- [ ] PH4-G: `bun scripts/smoke-deepseek-reasoning.ts` with `DEEPSEEK_API_KEY`
      (prints counts/status only). Passed through a DeepSeek-compatible proxy
      (`deepseek-v4.1-flash-free`); native first-party DeepSeek thinking+tools
      is not claimed until it passes against the first-party endpoint.
- [ ] Prompt behavior: `PROMPT_EVAL_API_KEY=… PROMPT_EVAL_BASE_URL=… bun
      scripts/prompt-eval/run.ts deepseek-v4.1-flash-free` (the measured
      model; always name it, because the defaults are the first-party URL and
      `deepseek-v4-pro`), plus each other model the release recommends.
      Prints counts/status only; record the per-case lines.

### OAuth refresh/revoke smoke (user, disposable account)

Use a throwaway account on an OAuth MCP server (Notion, Linear, Atlassian or
Sentry in the catalog), never a real workspace: refresh rotates the stored
tokens and revoke destroys the grant. Run the release build under Bun 1.4.3
(`bun run web` from a checkout, or the installed `dnt-harness`) with a scratch
`--data-dir`.

1. Settings → MCP → **Browse catalog** → Install the OAuth entry (or add an HTTP
   server with `auth.type: managed_oauth`), enable it.
2. **Connect**; finish sign-in in the provider tab. Expected: the row shows
   connected and lists tools. Note the provider's lifetime for access tokens.
3. Call one tool from a chat (or the row's **Test**). Expected: success.
4. Refresh: keep the app running until the access token has expired (provider
   lifetime, commonly 1 h), then call a tool again. Expected: the call succeeds
   without a new browser sign-in and the row never shows **Needs sign-in**.
   Check the provider's "authorized apps" page shows one grant for this client.
5. Revoke: row menu → **Disconnect OAuth**. Expected: notice "<server> is
   disconnected." (a "provider did not confirm" notice means the provider
   refused revocation: record which provider). The row shows **Connect** again
   and tool calls fail with a sign-in-required result.
6. In the provider's authorized-apps page confirm the grant is gone. Confirm no
   plaintext token appears anywhere in the data dir (`grep -r` for the access
   token you saw in the provider UI, if it exposes one; tokens live encrypted
   under `oauth/`).
7. Record: date, provider, pass/fail per step, and the notice text from step 5
   (no tokens, no client secrets). Tick the RH1-G item above.

## Never

- Publish because the version was bumped. Approval follows runtime, security
  and migration review ([migration-runtime-hardening.md](migration-runtime-hardening.md)).
- Treat typecheck as a security gate.
