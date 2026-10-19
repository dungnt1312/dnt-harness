# Changelog

## 0.3.0

Changes since 0.2.0. Release gates and manual steps: [docs/release-checklist.md](docs/release-checklist.md);
upgrade notes for the runtime changes: [docs/migration-runtime-hardening.md](docs/migration-runtime-hardening.md).

### Behavior changes

- **Hooks Settings keeps what it cannot run.** Saving hooks in Settings now
  preserves unknown events, non-command hook types and unknown fields instead of
  rejecting or dropping them. An invalid command hook blocks saving until it is fixed.
- **Speech-to-text:** `transcribe` answers `413` for a request body over the
  attachment limit.
- **macOS terminals are supported** (zsh and bash), on CI evidence (macos-15,
  arm64) and a local macOS run; the claim is re-checked on the release tag run.
  The login shell is tried first, and `LC_CTYPE=UTF-8` is set when the
  environment has no locale.
- **Bun is the runtime.** The toolchain, PM2 launcher and docs moved from
  pnpm/tsx to Bun 1.4.3 (`engines.bun >=1.4.3`); Vitest/Vite need Node >= 22.19.
  The Windows terminal backend is bun-pty 0.5.1 (was node-pty); the web terminal
  uses Bun's built-in PTY on POSIX. Windows is gated on x64; the ARM64 DLL is
  hash-checked but not loaded in CI, and the browser terminal UI is checked by hand.
- **DeepSeek defaults** to `deepseek-flash`, and retired models are no longer offered.

### Added

- Speech-to-text dictation over OpenAI-compatible transcription APIs.
- Provider-agnostic reasoning round-trip; DeepSeek reasoning is replayed across
  tool loops and never fabricated. This was proven through an OpenAI-compatible
  DeepSeek proxy; the first-party DeepSeek endpoint has not been live-smoked yet.
- Background child agents that outlive the turn and wake the root; resume and
  message children from a pinned spawn snapshot; undelivered background reports
  survive a restart.
- Versioned global limits (component-owned schema, authenticated edit and reload
  routes, Settings editor) applied at host operation boundaries.
- Headless `chat` selects provider, model and thinking level from flags and the
  provider store, with the same rules as the web host.
- `scripts/` tailscale reverse proxy for the loopback-only web host; e2e wire
  probes and the bench harness.

### Fixed and hardened

- Outbound MCP/media requests enforce the network policy at connect time through
  the real Undici under Bun.
- PTY teardown is awaitable and idempotent; shutdown stops accepting before
  dropping connections and bounds its wait; no OAuth token writes after shutdown begins.
- Benchmarks never mutate the source repository (independent HEAD-only copies).
- One effective-model resolver, bounded output-cap relearning (a rejected 32k
  guess is relearned, history is not squeezed) and precise overflow classification.
- PM2 runs Bun by absolute path so Windows can spawn it; no spawned console windows.
- MCP: the breaker window ends when recovery starts; call journals record the
  generation of the carrying client; deleting an MCP server reports local fence
  and remote revocation.
- Boot recovery no longer loads every session; session replay is cached.
- Faster startup: the web host now reaches listening in about half a second on a large history (about 19 s before) by indexing settled child agents and checking root-mode snapshots from session summaries. The first start after upgrading rebuilds session summaries once (about 10 s on a large history).
- Settings lists have valid ARIA structure; dictation settings lookup settles on failure.

### CI and release

- New gates: Windows launcher/PM2 smoke (`windows-smoke.yml`), Linux full suite
  (`linux-suite.yml`, on pull requests and pushes to `main`), and Linux plus macOS
  (zsh, bash) runtime/PTY probes (`runtime-probes.yml`).
- Tag-triggered publish needs every gate and approval of the protected `release`
  environment, and publishes a prebuilt tarball with npm trusted publishing
  (the trusted publisher setup and the first tag run are still to be confirmed).
  A pull request touching `release.yml` runs the gates and the pack job as a
  dry run without `publish`.
- Actions are pinned to full commit SHAs on `ubuntu-24.04`.
