# Runtime & provider hardening: final report

Date: 2026-10-18. Baseline `337af2d`. HEAD `593cfc4`. Plan status: **in-review**. Implementation is complete and committed, but release-blocking gates are still open. Do not tag or publish yet.

## Per-phase summary

| # | Phase | Summary |
|---|---|---|
| 0 | Baseline, runtimes | Node >=22.19 preflight, explicit Bun 1.4.3 resolver, `scripts/runtime-probes.mjs`, and a Linux CI probe job (`runtime-probes.yml`). Windows baseline recorded. Linux CI has never run. |
| 1 | Outbound transport | `outbound-http.ts` loads real Undici by resolved entry and fails closed without a real dispatcher. Connect-time DNS vetting is applied to MCP, OAuth and foreign media. Media redirects keep the same-origin exception only until the first foreign hop. Bun probe 13/13. |
| 2 | Bench repo safety | `compare-opencode-dnt` never resets or restores the source. Hardened read-only Git freeze. Per-contestant repos are rebuilt from HEAD/index/worktree layers (HEAD only, no history). Drift fails the run and keeps artifacts. |
| 3 | PTY lifecycle | State machine `running → closing → exited \| failedTeardown`. Teardown is idempotent and session-owned (HUP → KILL with identity checks). DELETE awaits the outcome. Shutdown is bounded at 13.5s, under PM2's 15s. Linux/macOS process inspectors are unverified on real OSes. |
| 4 | Model caps/errors | Shared `effective-model.ts` resolver with a versioned route identity (HMAC credential generation). 32k fallback plus bounded, memory-only relearn. The ceiling never invents a cap. Structured classifier: cap rejection is terminal, while shared-window overflow still squeezes. |
| 5 | Reasoning round-trip | Optional `reasoning {text, complete, source}` on assistant messages. Strict DeepSeek replay of same-route complete reasoning. The pre-network gate covers the active tool loop. Nothing is fabricated. Reasoning is redacted before persistence. Compaction dual-reads v1/v2. Stored reasoning is never sent to delegation, child reports or SSE. |
| 6 | Metrics, prompt, docs, release | Bench cache metrics are normalized per record, and missing usage stays unknown. The prompt drops the absolute bans. The release workflow `needs:` all gates, uses SHA-pinned actions, and builds the tarball without OIDC. Added migration notes and a release checklist. |
| — | Post-plan (user request) | Windows terminal backend changed from node-pty to bun-pty 0.5.1 (exact pin, prebuilt FFI, no install script). `scripts/pty-smoke-windows.mjs` added (14 checks). POSIX still uses Bun's built-in PTY. |

Every phase went through code review, and its findings were fixed before commit.

## Commits

| Commit | Description |
|---|---|
| `2ff6eff` | Phase 0: runtime preflight, Bun resolver, probes, Linux CI job |
| `075c50c` | Phase 1: outbound transport security |
| `2033415` | Phase 2: bench repository safety |
| `7059b43` | Phase 3: PTY teardown |
| `bb358c2` | Shutdown: stop accepting before dropping connections |
| `31239c3` | Phase 4: effective model, caps, classifier |
| `355056f` | Phase 5: reasoning round-trip |
| `529264a` | No OAuth token writes after shutdown begins |
| `16eb829` | Phase 6: bench metrics + prompt |
| `58153cc` | Phase 6: release gates + docs |
| `593cfc4` | Replace node-pty with bun-pty on Windows |

## Acceptance criteria

Legend: **Pass (Windows/Node)** = Vitest on Windows, Node 22.20. **Pass (Bun probe)** = real Bun 1.4.3 probe on Windows. **Pass (Linux CI)** = `runtime-probes` job on GitHub `ubuntu-latest`, Bun 1.4.3, Node 22.20.0, 2026-10-18, run [39144703578](https://github.com/dungnt1312/dnt-harness/actions/runs/39144703578) (PR #1). **Pending (Linux CI)** / **Pending (live smoke)** = gate not run. **Not met** = not implemented.

| ID | Status | Note |
|---|---|---|
| RH1-A | Pass (Windows/Node) + Pass (Bun probe) + Pass (Linux CI) | Zero requests reach the destination when the dispatcher rejects. Linux: outbound-http probe 16/16, including bare `undici` failing closed with zero connections. |
| RH1-B | Pass (Windows/Node) + Pass (Bun probe) + Pass (Linux CI) | Fixture covers IPv4/IPv6/mapped/NAT64, mixed answers and re-resolve. Linux: `localhost` resolves to `::1, 127.0.0.1`; system-resolver and injected `[::1, 127.0.0.1]` fallback reach the IPv4 fixture; public-to-loopback and mixed answers are blocked at connect with zero requests. |
| RH1-C | Pass (Windows/Node) + Pass (Bun probe) | Literal blocked before network; loopback profile works. |
| RH1-D | Pass (Windows/Node) + Pass (Bun probe) | Private redirect refused; credentials stripped on foreign hops. |
| RH1-E | Pass (Windows/Node) + Pass (Bun probe) | Abort before headers, during body/SSE, and on timeout. |
| RH1-F | Pass (Windows/Node) | Scoped resolver/connector fixtures. Wiring test forbids raw `fetchImpl` / bare `undici`. |
| RH1-G | Partial pass (2026-10-18, macOS, Bun 1.4.3) | Public HTTPS MCP passed: `McpServerClient` over the default outbound transport (custom Undici connect, real TLS certificate) connected to the unauthenticated DeepWiki Streamable HTTP endpoint, listed 3 tools and called the read-only `read_wiki_structure` (no error). Not run: OAuth refresh/revoke (the only configured OAuth servers are real user accounts; refresh/revoke would mutate live tokens) and media tools. |
| RH2-A | Pass (Windows/Node) | Source HEAD/index/diffs/untracked unchanged. |
| RH2-B | Pass (Windows/Node) | `HEAD=A, index=B, worktree=C` preserved on exit/error/timeout. |
| RH2-C | Pass (Windows/Node) + Pass (Linux CI) | Rename/delete/add/space pass. Windows-invalid names are refused. Linux: `tests/scripts/repo-freeze.spec.ts` 71/71 with no skips, including the POSIX special-character and executable-bit/symlink tests (also 71/71 on macOS locally, Node 24.15). |
| RH2-D | Pass (Windows/Node) | Drift gives nonzero exit and keeps artifacts. |
| RH2-E | Pass (Windows/Node) | No destructive restore in any mode. |
| RH3-A | Pass (Linux CI) | Bun's built-in PTY: remove stops shell, foreground and background jobs (3 members, 0 left, 54ms) with exactly one exit event; HUP-ignoring shell and job are KILLed at the escalation deadline (~1s); an unrelated process in the host session was never signalled. |
| RH3-B | Pass (Windows/Node) | Fake adapter: 61 terminal tests pass. |
| RH3-C | Pass (Linux CI) | Repeated create/close is bounded (fds 9→9, no surviving processes or records); UTF-8 split across PTY reads decodes intact (4001 groups, 0 replacement chars). |
| RH3-D | Windows: Pass (bun-pty smoke 14/14, repeated). macOS: Not met (no evidence) | No macOS terminal support claim. The spec named node-pty; bun-pty smoke replaces it. |
| RH3-E | Pass (Linux CI) | Real bash 5.2.21 under Bun's PTY: natural exit sweeps background jobs with one exit event; idle reap stops shell and jobs; disposeAll stops 16 terminals (48 members) in 1056ms against a 4000ms budget. 9/9 PTY probes. |
| PH1-A | Pass (Windows/Node) | CLI (spawned Bun) and web manifest both 32768; wire cap 4096. |
| PH1-B | Pass (Windows/Node) | |
| PH1-C | Pass (Windows/Node) | No session is created before a CLI selection error. |
| PH1-D | Pass (Windows/Node) | Versioned, secret-free route identity. Rotation resets lineage. |
| PH2-A | Pass (Windows/Node) | |
| PH2-B | Pass (Windows/Node), amended | Spec deviation: 32k fallback + bounded relearn instead of unknown-omit. |
| PH2-C | Pass (Windows/Node) | GPT-4 Turbo sends 4096. |
| PH2-D | Pass (Windows/Node) | Floor removed; ceiling ≤0 counts as exhausted. |
| PH3-A..E | Pass (Windows/Node) | 28-row classifier table. Squeeze path is exercised through the real adapter and agent loop. |
| PH4-A..F | Pass (Windows/Node) | Fake strict DeepSeek gateway: real HTTP/SSE plus a real CLI process. |
| PH4-G | Pass (2026-10-18, Bun 1.4.3) | `scripts/smoke-deepseek-reasoning.ts` against the `ocproxy-2` OpenAI-compatible proxy, model `deepseek-v4.1-flash-free`, thinking `high`: turn 1 completed (3 assistant messages, 1 with complete reasoning, 2 tool results); turn 2 on the same session completed (5 assistants, 2 with reasoning, 3 tool results). Proves reasoning replay through that proxy; not the first-party DeepSeek endpoint or `deepseek-v4-pro`. |
| QH-1 | Partial: Linux CI Pass; admin config pending | Runtime pins and gated release workflow are done. Linux `runtime-probes` is green ([run](https://github.com/dungnt1312/dnt-harness/actions/runs/39144703578), 2026-10-18). Protected release env and tag protection are outstanding. |
| QH-2 | Partial: metrics/docs Pass; prompt eval Not met | §11.3 behavioral recall/tool-count eval was not done. Prompt checks are string-level only. |

## Final verification (Windows)

- `typecheck` OK. `build:web` OK.
- `bun scripts/runtime-probes.mjs`: 7/7.
- `bun scripts/pty-smoke-windows.mjs`: 14/14 (repeated).
- Full Vitest suite, `--maxWorkers=3` (with default workers this machine hits a V8 "Zone" OOM):

| | Failed files | Failed tests |
|---|---:|---:|
| Baseline `337af2d` | 25 | 66 |
| HEAD `593cfc4` | 28 | 70 |

Triage of the 5 files that fail at HEAD but are not on the baseline list:
- `server-g1`, `repo-freeze`, `server-model-alias`: pass when run alone. Load flakes.
- `registry.spec` "ring cap", `server-compaction` "cancels a hanging PreCompact hook" / "automatic pressure trigger" (ENOENT on checkpoint tmp): these also fail intermittently at baseline `337af2d`. They are pre-existing, and the first baseline run under-reported them. Running server-compaction + registry together gives 41/41 at both baseline and HEAD, in repeated runs.

Verdict: no regression attributable to this plan was found. The Linux suite/probe baseline does not exist yet.

## Pending gates (release-blocking)

1. ~~GitHub Linux CI never ran.~~ Closed 2026-10-18: `runtime-probes` on PR #1 passed ([run 39144703578](https://github.com/dungnt1312/dnt-harness/actions/runs/39144703578); first run 39144485540 also green before the RH2-C step was added). Runtime probes 8/8 (outbound-http 16/16), repo-freeze spec 71/71, PTY probes 9/9. RH1-B Linux DNS, RH2-C POSIX names and RH3-A/C/E pass; Bun's built-in PTY is go for Linux. The full Vitest suite is still not run on Linux.
2. macOS: no evidence. macOS terminal support must not be claimed.
3. RH1-G: public HTTPS MCP passed under Bun; OAuth refresh/revoke and media remain unrun.
4. PH4-G: passed via the `ocproxy-2` proxy with `deepseek-v4.1-flash-free`. A run against the first-party DeepSeek endpoint is still unrecorded; claim native thinking+tools support only as proven through that proxy.
5. A repo admin must configure the protected `release` environment (required reviewers) and tag protection.

Not met (scope gap, not a gate run): spec §11.3 behavioral prompt eval.

## Spec deviations

- Output cap: 32k fallback + bounded relearn (supersedes unknown-omit, spec §3 decision 6 / §8).
- RH-1: real Undici is loaded by resolved package entry; bare `undici` is forbidden.
- Phase 5: default DeepSeek replay window is the whole conversation (per official docs). The strict gate covers only the active tool loop.
- Phase 2: disposable copies are HEAD-only (no history).
- Phase 6: prompt eval is string-level only (§11.3 unmet).
- Windows terminal backend is bun-pty 0.5.1, not node-pty (post-plan, user request).

## Residual risks

- **POSIX PTY:** resolved on Linux (2026-10-18): the session sweep stops shell, foreground and background jobs under Bun's built-in PTY. Still unverified on macOS.
- **macOS inspector:** `ps`/tty fields are unverified.
- **Crash/SIGKILL:** external SIGKILL or a host crash during teardown can leave orphaned shells/jobs. Documented limitation; no orphan reaping.
- **Shutdown trade-off:** agent stop timeout dropped from 10s to 1s inside the 13.5s budget. An agent in the middle of a tool call hits the persistence fence sooner.
- **Cap relearn:** relies on provider error text (bounded formats, one resend, ≤256000). A corrective resend consumes one logical-request attempt.
- **Compaction summarizer:** may now fail fast as `context_exceeded` on very full windows, then fall back to extractive.
- **Reasoning, live endpoint:** if the endpoint enforces older turns more strictly than the gate, legacy tool sessions get the actionable 400 hint. Redaction masks token shapes only. A process without the persisted hasher does not replay across restarts.
- **Real-cert TLS** through the custom Undici connect is untested.
- **bun-pty native DLLs:** reviewed hashes are recorded in the release checklist. Re-review on any version bump.
- **Rebase:** re-run the PH4 attempt-boundary tests after any rebase onto the HC plan (`plans/261017-0018-harness-core-hardening/`).
- **Test suite on this machine:** needs `--maxWorkers=3`, and load flakes make full-suite comparisons noisy.

## Incident: node_modules wiped during worktree cleanup

- **What happened:** while removing temp worktrees, `cmd /c rmdir` resolved to an npm package named `cmd` instead of `cmd.exe`, so the node_modules junction inside the worktree was not removed. `git worktree remove --force` then followed the junction and deleted the contents of the main repo's `node_modules`.
- **Recovery:** `node_modules` was restored with `bun install --frozen-lockfile`. Final verification above ran after the restore.
- **Loss:** the untracked `node_modules.old-pnpm/` directory (listed in the Phase 0 inventory) is also gone. When it disappeared could not be determined, and it was not recoverable. No tracked files were affected.
- **Lesson:** remove junctions explicitly with the absolute `%SystemRoot%\System32\cmd.exe` (or `[System.IO.Directory]::Delete` on the link) and verify they are gone before `git worktree remove --force`.

## Follow-ups

1. Done 2026-10-18: Linux CI ran on PR #1 ([run](https://github.com/dungnt1312/dnt-harness/actions/runs/39144703578)); RH3-A/C/E, RH1-B DNS and RH2-C POSIX pass, and Bun's built-in POSIX PTY is go on Linux. Remaining: a Linux baseline of the full Vitest suite.
2. macOS zsh/Bash terminal evidence, or an explicit Windows/Linux-only release scope in the support docs.
3. Remaining live smokes: RH1-G OAuth refresh/revoke and media under Bun (needs a disposable account), and PH4-G against the first-party DeepSeek endpoint with `DEEPSEEK_API_KEY`.
4. Repo admin: configure the protected `release` environment and tag protection.
5. Implement the behavioral prompt eval (recall / tool-count fixtures, spec §11.3).
6. Leftover `bash.exe` PID 39640 (~2GB, a `/proc` kill loop from a 10/17 test run) was left alone. Kill it if the user agrees.

## Unresolved questions

- Release scope if macOS evidence cannot be obtained: Windows/Linux only?
- Should the behavioral prompt eval block this release, or move to the next one?
