# Release checklist

A tag push (`v*`) starts `.github/workflows/release.yml`. The publish job runs
only when all of these hold:

1. **Automated gates pass** (`needs:`):
   - `typecheck-build`: `bun run typecheck`, `bun run build:web`, tag equals
     the `package.json` version.
   - `deterministic-suites`: a stable Vitest subset under Node 22.20
     (outbound-http, mcp-outbound-policy, repo-freeze, terminals-lifecycle,
     effective-model, provider-error-classification, reasoning-round-trip,
     llm-openai, bench-metrics, base-prompt-guidance).
   - `linux-runtime-probes` (`runtime-probes.yml` via `workflow_call`): Bun
     1.4.3 runtime/Undici/DNS probes and `bun scripts/pty-probes.mjs --require`
     (real bash PTY teardown).
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

### Suites left out of the deterministic gate

These affected suites are **not** in `deterministic-suites` because they are
not yet proven stable on GitHub's Linux runners (PTY/host processes, timing,
native media tooling, loopback OAuth fixtures). Run them locally before tagging:

- `tests/web/terminals-posix.spec.ts`, `tests/web/terminals.spec.ts`,
  `tests/web/server-terminals.spec.ts`
- `tests/web/server-models.spec.ts`
- `tests/bins/headless.spec.ts`
- `tests/harness/image-tools.spec.ts`, `tests/harness/image-tools-mode-exposure.spec.ts`,
  `tests/harness/video-tools.spec.ts`
- `tests/harness/mcp-oauth*.spec.ts`, `tests/web/mcp-oauth*.spec.ts`
  (and the new `tests/web/mcp-shutdown-oauth.spec.ts`)
- `tests/harness/mcp-client-fixes.spec.ts`

- [ ] To do: after the first real release run, run these on the Linux runner
      (e.g. a `workflow_dispatch` job) and add each one that passes reliably
      to the `deterministic-suites` list in `release.yml`.

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
- [ ] Full suite run on a supported host. Any failure is either on the pinned
      baseline inventory (`plans/261017-runtime-provider-hardening/reports/phase-00-baseline.md`)
      or classified (isolated rerun: flake vs regression). Never "all green"
      by footnote.
- [ ] `npm pack --dry-run`: no secrets, transcripts, `.env`, data dirs or
      `route-identity.secret` in the tarball.

## Manual evidence (attach links/logs to the environment approval)

### Windows launcher / PM2 smoke (required)

Run on Windows with Bun 1.4.3 using an **absolute** Bun path for PM2:

- [ ] `bun add -g <packed tarball>`; `dnt-harness --version` prints the new
      version.
- [ ] `dnt-harness start pm2 --name dnt-smoke`. Then `pm2 describe dnt-smoke`
      shows interpreter `bun` (absolute path) and `/api/health` answers 200.
- [ ] Workbench terminal (node-pty/ConPTY): open bash/PowerShell/cmd,
      input → output, resize, close (DELETE answers 200), natural `exit`.
- [ ] `pm2 restart dnt-smoke` and `pm2 stop dnt-smoke` complete within PM2's
      `kill_timeout` (15 s), with no leftover shell processes.
- [ ] `dnt-harness chat --message "hello"` (headless) works against a
      configured provider.

### Linux (required, automated)

- [ ] `linux-runtime-probes` job green on the release tag (link the run).
      Linux terminal support is not claimed without this. (Pending its first
      green CI run.)

### macOS (only if the release claims macOS terminal support)

macOS terminal support is **currently not claimed**. To claim it:

- [ ] On real macOS with Bun 1.4.3, zsh and Bash: input/output, resize, close,
      idle reap, natural exit, and shutdown teardown of foreground/background
      jobs and a HUP-trapping job (same scenarios as `scripts/pty-probes.mjs`).
- [ ] Then update README.md, docs/web.md and docs/guides.md to say macOS is
      supported.

Without this evidence, the release scope is **Windows + Linux**, and the docs
must say macOS is unverified.

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
