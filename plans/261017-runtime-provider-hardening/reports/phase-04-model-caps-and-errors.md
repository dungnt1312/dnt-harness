# Phase 04 — Shared model resolution, output caps, error classification

Status: implemented, **uncommitted**. Base: HEAD `7059b43` (baseline `337af2d` + Phase 0–3 commits).

## Files

| File | Change |
|---|---|
| `src/harness/llm/effective-model.ts` (new) | Pure resolver: selected pair, expressible thinking (strict for flags, lenient for stored prefs), context budget, `outputPolicy` {cap, source override/catalog/family/fallback, guessed}, wire compatibility, versioned route identity `{v:1, origin, path, model, protocol, profile, credential}`, `credentialGeneration` (domain-separated SHA-256/64-bit, `none` for keyless), `advertisedModelError`, `outputTokenCap`, `outputCeiling`, `applyThinking`. Compatibility detection moved here from `openai.ts` (re-exported). Only import besides catalog/budget is `node:crypto` (no fs/web). |
| `src/harness/llm/openai.ts` | Learned caps: route-keyed LRU (16/instance, memory only), guessed caps only, one corrective resend charged to `LogicalRequest` (`owner.consume()`; none if budget spent), limit parse bounded (known formats, safe int 1..256000, `< sent`, never vLLM window room); learned "no cap" forgotten on `missing_required_cap`. Exhausted ceiling → `context_exceeded` before network. `classifyRequestError` (bounded prefix): output_cap_rejected > missing_required_cap > shared-window/payload (status-gated) > quota/auth/rate/server/request. Deterministic classes never retried (502-wrapped cap rejection not transient). SSE gateway errors use the same classifier. `routeIdentity()` / `outputCapDiagnostics()` (secret-free). |
| `src/harness/llm/model-catalog.ts` | Exact output-limit table checked before family regex (`gpt-4o-2024-05-13`, `gpt-4-turbo*`, `gpt-4-0125/1106-preview` 4096, `gpt-4`/`-0613` 8192, `gpt-3.5-turbo*` 4096); `resolveOutputLimitSource`. |
| `src/harness/llm/types.ts` | `ProviderError.classification` (internal, not persisted); doc updates. |
| `src/harness/context/builder.ts` | Removed `Math.max(1, …)` floor on the ceiling; ceiling only bounds. |
| `src/bins/headless.ts` | Uses resolver for advertised-model validation, thinking, budget; same messages and ordering as 135ae5b (errors before data-home lock). |
| `src/web/server.ts` | `validateProviderModel` uses `advertisedModelError`; `modelBudgetOf` uses `effectiveBudget`. Precedence and orchestration unchanged. |
| `docs/prompt-contract.md`, `docs/harness.md` | Doc fix: prompt-contract said no cap is sent for unknown models; now describes the 32k fallback + bounded relearn, the ceiling semantics and cap-rejection behaviour. |
| Tests | `tests/harness/effective-model.spec.ts` (new), `tests/harness/provider-error-classification.spec.ts` (new), additions to `llm-openai.spec.ts`, `bins/headless.spec.ts`, `web/server-models.spec.ts`. |

## Acceptance coverage

- PH1-A: resolver unit + CLI (spawned Bun) + web: context 32768 → manifest, wire `max_tokens` 4096.
- PH1-B: same model id on two providers keeps separate overrides.
- PH1-C: unknown model / invalid / inexpressible thinking (strict vs preference); existing CLI tests confirm no session created before error.
- PH1-D: route identity versioned, secret-free (no query/userinfo/key), changes with endpoint/model/profile/credential; rotation test resets learned cap.
- PH2-A..D (amended: fallback kept, no unknown-omit): snapshot table, override/invalid override, learned only over guess, ceiling never invents, no floor, `0`/negative = exhausted, 256k global max, GPT-4 Turbo 4096.
- PH3-A: window 8192/input 8000/output 1024 through real adapter + agent loop → squeeze, completes, operator cap not relearned.
- PH3-B/C: pure cap rejection and cap+overflow → exactly one request, terminal, history kept, redacted actionable message.
- PH3-D: 28-row classifier table (HTTP, relay 502, SSE error, localized, malformed, empty, auth/quota/429/500).
- PH3-E: squeeze levels exhausted → explicit provider failure, no tool call.
- Extra: learned/omitted cap diagnostics, LRU eviction, unknown Claude alias + thinking (dropped with no cap; recomputed below learned cap), small ceiling, missing-cap gateway, attempt accounting with a guessed cap + squeeze (≤4 physical attempts).

## Results

- Typecheck (`bun run typecheck`, both tsconfigs): exit 0.
- Affected specs: llm-openai, effective-model, provider-error-classification, model-catalog, subagent-stability, llm-review-regressions → 188/188. headless, server-models, compaction-context-reliability, g3-compaction, server-compaction, compaction-generator, compaction-reliability, server-session-model, server-subagents, g4-subagent-contract → 250/250. `g3-context` 1 failure = baseline.
- Full suite (Windows, Node 22.20): 35 failed files / 317 passed / 1 skipped; 89 failed tests / 4713 passed; 5 unhandled errors. Baseline: 25 files / 66 tests / 4 errors.

### Non-baseline failures triage

| File | Isolated | With Phase 4 stashed | Verdict |
|---|---|---|---|
| processes/registry, scripts/repo-freeze (8), web/compaction-benchmark, mcp-lifecycle-fixes, server-compaction, server-project-git-v2 | pass | — | load flakes |
| web/server-g1 (1), server-g2 (2), server-g3 (3), sse-resume (1), processes/server-processes (2) | fail | **also fail** | Pre-existing at HEAD, not Phase 4: `AggregateError: shutdown cleanup failed` from `server.close()` → `runCleanup` (`src/web/server.ts` close path). These appeared after the baseline commit, most likely 7059b43 (PTY teardown) or 075c50c. Out of scope (`src/web/terminals.ts` must not be touched in this phase); flag to the Phase 3 owner. |

All remaining failing files are on the baseline list. No Phase 4 regression found.

## Deviations

- Plan output-cap decision kept (32k fallback + bounded relearn). No `fallbackMaxOutputTokens`. Spec §8 unknown-omit not implemented (superseded).
- No new public `ProviderErrorReason`: cap/missing-cap rejections keep `unknown` (terminal), payload-too-large keeps `context_exceeded`; the finer class is on `ProviderError.classification` (not persisted). Therefore `storage/events-jsonl.ts` and the web consumers are unchanged; `output_limit` is not reused.
- Credential generation is a hash of the key (stable across restarts), not a counter; providers are re-instantiated on store change (web `syncRegistrations`, CLI per run), which also drops learned caps.
- `provider-store.ts` not modified (not needed).
- A legacy learned value of `null` + explicit request still sends the request's bound (caller intent).

## Review fixes (code review 7.5/10, 2026-10-18)

Shutdown fix `bb358c2` in `src/web/server.ts` kept; Phase 4 hunks there remain uncommitted.

- **H1** `openai.ts`: every limit pattern anchored to `max_tokens`/`max_completion_tokens` in the same clause (`[^.;,]{0,40}?`); the generic `Expected a value <= N` form now requires the `'max_(completion_)tokens': integer above maximum value` prefix. `OUTPUT_CAP_REJECTED` / `OUTPUT_CAP_INDEPENDENT` no longer span `;`/`,`. Lower bound: a parsed limit < 256 is treated as unreadable (resend with no cap; nothing tiny learned). Tests: `max_tokens is too large: 32000; temperature must be at most 2` → no cap (never 2); `top_p … Expected a value <= 1` → undefined; neighbour-only text is not a cap rejection; 255/256/16 bounds.
- **M2**: the parsed limit (or "no cap") is stored for the route before the resend is reserved, so it is learned even with no attempt left. A rejected *guess* surfaces as `fallback output-cap guess (N) rejected for 'm'; the corrected cap applies to the next request (or set maxOutputTokens)`; "lower maxOutputTokens" is reserved for operator/catalog caps. Test asserts the message and that the next request uses 4096.
- **M1**: new `StreamOptions.correctiveAttempt` supplied by `runAttempt`: it closes the rejected attempt (`end`, reason `unknown`, settled, uncommitted), consumes an owner attempt and opens a new fact (fresh `attemptId`, next `attempt`) under the same ticket/timers. Without it (direct owner use) the adapter still `consume()`s. Test: log reads `[1 start] [1 end unknown] [2 start] [2 end]`, one `requestId`, distinct `attemptId`s; the test fails when the hook is disabled.
- **M3**: credential generation is `k2:` + HMAC-SHA256 (domain-separated) truncated to 64 bits. New `src/harness/llm/credential-secret.ts` (host-side) loads/creates `route-identity.secret` (32 random bytes hex, `wx`, mode 0600, dir 0700; best effort on Windows) next to `providers.json`; CLI and web inject the hasher (`OpenAiCompletionsOptions.credentialHasher`, `DeepSeekProvider` optional 3rd arg). Unusable dir → in-memory random secret (`persistent: false`): identities are then process-local, so lineage is not reused across restarts (never wrongly reused). `effective-model.ts` stays fs-free; with no injected hasher it uses a process-local secret. Tests: secret dependence, not plain SHA-256, file created once/reused, 0600 on POSIX, fallback.
- **M4**: pinned: independent output maximum + window arithmetic (either order) → `output_cap_rejected`, terminal, no squeeze; window arithmetic alone stays `context_exceeded`.
- **Low**: `outputCapDiagnostics` uses `LearnedCaps.peek` (no LRU touch); test proves reads don't keep an entry alive.

Verification: `bun run typecheck` exit 0; Phase 4 affected specs 17 files / 483 tests pass; attempt/lifecycle consumers (agent-loop, agent-tools, attempt-events, child-progress, context-calibration, request-lifecycle, web/server, …) 10 files / 315 tests pass. Full suite not re-run for this round.

## Release notes (for Phase 6)

- Unknown models still get a 32 000-token output cap; if the endpoint rejects it, the harness corrects it once per route (in memory) or sends no cap. Set `maxOutputTokens` per model to override.
- `gpt-4` / `gpt-4-0613` now send their catalog cap **8192**, and `gpt-3.5-turbo*`, `gpt-4-turbo*`, `gpt-4-0125/1106-preview` and `gpt-4o-2024-05-13` send **4096**, instead of the 32 000 guess.
- The output ceiling no longer raises a cap to 1 024; a request with no window room left is refused before sending (and squeezed).
- A new per-install file `route-identity.secret` appears next to `providers.json` (keys route fingerprints; contains no credential; safe to delete — identities then change once).

## Risks / follow-ups

- Learning remains provider-text dependent; mitigated by bounded formats, `< sent`, ≤256000, one resend per stream call, LRU.
- Corrective resend now consumes a logical-request attempt: a guessed-cap request has one fewer squeeze/retry available (intended by plan).
- Builder `maxOutputTokens` may now be ≤0; any third-party consumer that assumed ≥1 sees the raw room (in-repo consumers: only CLI/web `outputCeilingTokens`).
- Compaction/web paths that set `outputCeilingTokens` from a very full window now fail fast as `context_exceeded` instead of sending a 1-token cap; covered by existing squeeze recovery, but watch compaction summarizer (it does not squeeze; it falls back to extractive on `contextExceeded`).
- Route identity is not yet persisted/consumed for reasoning lineage — Phase 5 must use `routeIdentity()`/`routeKey()`.
- Re-run PH4 attempt-boundary tests after any rebase onto the HC plan.
