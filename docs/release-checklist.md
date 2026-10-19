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
   - `linux-runtime-probes` (`runtime-probes.yml` via `workflow_call`): Bun
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

All gates are wired but **pending their first green CI run**; until a real
tag run passes, treat them as unproven.

### Linux full suite and promoted suites

`.github/workflows/linux-suite.yml` (ubuntu-24.04, Node 22.20, Bun 1.4.3) runs
the whole `bun run test` suite on every pull request and on `workflow_dispatch`.
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

## One-time repository setup (admin)

The workflow cannot enforce these itself. They must exist before anyone relies
on tag-triggered publish:

- [ ] Settings → Environments → `release`: required reviewers (≥ 1), "Prevent
      self-review" on, deployment restricted to `v*` tags.
- [ ] Settings → Rules → tag ruleset for `v*`: only maintainers may create,
      update or delete release tags (tag protection).
- [ ] npm trusted publisher configured for this repository, workflow
      `release.yml`, environment `release`.
- [ ] Workflow actions stay pinned to full commit SHAs (version comment beside
      each). Update them deliberately, never to a moving tag.

## Before tagging (maintainer, local)

- [ ] `bun run preflight:node` (Node >= 22.19) and `bun run probe:runtime`
      (Bun 1.4.3) pass.
- [ ] Full suite run on a supported host (a green `linux-suite.yml` run on the
      tagged commit counts). Any failure is either on the pinned
      baseline inventory (`plans/261017-runtime-provider-hardening/reports/phase-00-baseline.md`)
      or classified (isolated rerun: flake vs regression). Never "all green"
      by footnote.
- [ ] `npm pack --dry-run`: no secrets, transcripts, `.env`, data dirs or
      `route-identity.secret` in the tarball.

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

- [ ] `windows-smoke` green on the release tag (link the run).

Still manual (not covered by the job):

- [ ] Workbench terminal in the browser UI (xterm rendering, keyboard input,
      the shell picker); the job drives the same server routes without a page.
- [ ] Windows on ARM64: the job runs on x64, so `rust_pty_arm64.dll` is
      hash-checked but never loaded.
- [ ] Headless chat against a real configured provider (optional; the fake
      gateway proves the CLI path, not a provider).

### Linux (required, automated)

- [ ] `linux-runtime-probes` job green on the release tag (link the run).
      Linux terminal support is not claimed without this. (Pending its first
      green CI run.)

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
- [ ] `macos-pty-probes` green on the release tag (link the run). If it is not,
      drop the macOS claim from those docs before publishing.

### Optional live smokes (needed before the matching support claim)

- [ ] RH1-G: public HTTPS MCP server, OAuth refresh/revoke and media bytes
      under Bun.
- [ ] PH4-G: `bun scripts/smoke-deepseek-reasoning.ts` with `DEEPSEEK_API_KEY`
      (prints counts/status only). Native DeepSeek thinking+tools is not
      claimed until this passes.

## Never

- Publish because the version was bumped. Approval follows runtime, security
  and migration review ([migration-runtime-hardening.md](migration-runtime-hardening.md)).
- Treat typecheck as a security gate.
