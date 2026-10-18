# Phase 00 — Baseline report

## Environment (Windows)

| Key | Value |
|---|---|
| Commit | `337af2d` (`main`), no tracked modifications before work |
| OS | win32 x64 |
| Node (Vitest) | 22.20.0 — `C:\laragon\bin\nodejs\node-v22.20.0-win-x64` (PATH default 18.20.3 is rejected by preflight) |
| Bun | 1.4.3 — `...\node-v22.20.0-win-x64\node_modules\bun\bin\bun.exe` |
| Git | 2.37.3.windows.1 |
| Command | `node node_modules/vitest/vitest.mjs run` with Node 22.20 first on PATH |

## Untracked inventory (preserved)

`node_modules.old-pnpm/`, `plans/261016-*.md`, `plans/261017-0018-harness-core-hardening/`, `plans/261017-opencode-vs-dnt*`, `plans/261017-runtime-provider-hardening/`, `plans/261017-spec-runtime-provider-hardening.md`, `plans/ab-prompt-*.md`, `plans/bench-*.md`, `scripts/tailscale-proxy.mjs`.

## Runtime probes (Windows, `bun scripts/runtime-probes.mjs`)

- PASS runtime is Bun 1.4.3
- PASS resolved Undici entry (`node_modules/undici/index.js`) honors the custom dispatcher
- INFO bare `undici` import **bypasses** the dispatcher (Bun native shim), which confirms red-team finding #1
- Bun intercepts `require.resolve('undici')` too, so Phase 1 has to resolve through `undici/package.json` → `main`
- PASS DNS lookup

## Full suite baseline (Windows, Node 22.20)

Files: 25 failed / 322 passed (347). Tests: 66 failed / 4492 passed / 46 skipped. 4 unhandled errors. Duration ~187s.

Failing files (count = failing tests):

| File | n | Class |
|---|---:|---|
| tests/web/project-git-{conflicts,ops,hunks,path,sync}.spec.ts, server-project-git-actions | 24 | platform (Windows git / PATH resolution, `spawn git ENOENT` in PATH-isolation tests) |
| tests/harness/file-memory.spec.ts | 11 | unknown |
| tests/web/project-files-{save,write}.spec.ts | 8 | platform (likely symlink/permissions) |
| tests/capabilities/apply-patch.spec.ts | 3 | unknown |
| tests/harness/mcp-resilience.spec.ts | 3 | platform (`process.kill(-pid)` ESRCH on Windows) |
| tests/web/server-skill-sources.spec.ts | 3 | unknown |
| tests/capabilities/bash.spec.ts, harness/claude-md, processes/review-regressions | 2 each | platform (shell) / unknown |
| tests/capabilities/fs-search.spec.ts | 1 | platform (symlink EPERM without Developer Mode) |
| g3-context, g4-subagent-contract, g5-prompt-contract, skill-layers, background-tools, command-lifecycle, compaction-restoration, notify-channels, push | 1 each | unknown |

Comparison rule: a test failing after a phase that is not on this list, or that fails here with a different error class, blocks that phase.

Raw log: kept outside the repo (`%TEMP%\opencode\rh-baseline.txt`). It is not committed because it could contain environment details.

## Linux gate

`.github/workflows/runtime-probes.yml` runs on push/PR/dispatch and is `workflow_call`-able. It pins Bun 1.4.3 and Node 22.20.0 and runs the preflight plus probes, including real bash. **Pending first run:** this needs a push to GitHub. Phase 3 is blocked until it passes.

## macOS

No macOS machine or runner evidence is available. The release must not claim macOS terminal support until real zsh/Bash smoke evidence exists.
