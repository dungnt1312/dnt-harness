# Phase 04 — Shared model resolution, caps, errors

## Context Links

- Spec §7 PH-1, §8 PH-2, §9 PH-3.
- Baseline commits: `135ae5b` CLI/web provider parity; `337af2d` rejected-32k relearning.
- Code: `src/bins/headless.ts`, `src/web/server.ts`, `src/web/provider-store.ts`, `src/harness/llm/{openai,model-catalog,types}.ts`, `src/harness/context/builder.ts`, `src/harness/storage/events-jsonl.ts`.

## Overview

- Priority: P2, release-blocking.
- Status: Implemented, committed `31239c3`. No pending gates. Migration note shipped in Phase 6 (`docs/migration-runtime-hardening.md`, `58153cc`).
- Share effective model facts across CLI/web, settle output-cap policy, and classify overflow precisely.

## Key Insights

- `135ae5b` already makes CLI use context override and validates advertised models. Preserve and characterize it.
- `337af2d` keeps 32k fallback, but relearns only a guessed cap after a rejection, resending once with parsed limit or no cap. It is in-memory per provider instance.
- `337af2d` conflicts with the spec's original unknown-omit and no-learning policy; user decision required.
- Unknown cap affects Claude-style thinking budget: `applyThinkingOverride` relies on max tokens.
- `output_limit` is local output-byte failure; do not reuse it for provider max-token rejection.

## Requirements

### Resolver

- Add pure resolver for selected pair, thinking, context budget, output policy, compatibility, route identity.
- Route identity has an explicit version and fields: normalized origin/path, wire model id, protocol/profile, provider credential generation. Excludes secrets, headers, timeouts and display names.
- Credential/account changes increment generation without storing raw key.
- Preserve current web precedence and `135ae5b` CLI behavior.

### Output-cap policy (validated)

<!-- Updated: Validation Session 1 - keep bounded relearning; supersedes spec unknown-omit default -->
- Keep `337af2d` 32k fallback for unknown models plus bounded guessed-cap relearning. This supersedes spec §8 unknown-omit default and spec §3 decision 6.
- Constraints:
  - Only guessed caps; never override operator/catalog caps.
  - At most one corrective resend per logical request attempt; it counts against request ownership/attempt accounting.
  - Learned values are memory-only, bounded per provider instance, reset when route/credential generation changes.
  - Parse limits only from known formats and accept only safe integers ≤256,000.
  - Never infer a model limit from shared-window room.
  - Expose learned/omitted cap in diagnostics without secrets.
- No `fallbackMaxOutputTokens` setting in this plan; existing operator `maxOutputTokens` remains the explicit override.

### Thinking coupling

- When relearn falls back to no cap, do not send Claude budget thinking.
- Cap rejection/relearn recalculates thinking budget below the final cap.

### Window ceiling

- Ceiling bounds an existing cap and never invents one.
- Remove floor that raises cap above available room.
- Non-positive room triggers bounded budget recovery/failure before network.

### Errors

- Classify shared-window overflow, provider output-cap rejection, payload too large, missing required cap, other deterministic request.
- Shared-window overflow remains recoverable when message mentions `max_tokens`.
- Pure output-cap rejection never squeezes or retries the same payload.

## Architecture

- Hosts load config; resolver produces normalized facts.
- Adapter consumes final policy and optional learned-cap state.
- Classifier lives at adapter boundary; public reasons change only with validator/consumer migration.

## Related Code Files

- Add: `src/harness/llm/effective-model.ts`.
- Modify: `src/bins/headless.ts`, `src/web/server.ts`, `src/web/provider-store.ts`.
- Modify: `src/harness/llm/{openai,model-catalog,types}.ts`, `src/harness/context/builder.ts`.
- Modify if needed: `src/harness/storage/events-jsonl.ts`.
- Tests: headless, server models, OpenAI adapter, catalog, subagent stability, context budget.

## Implementation Steps

1. Characterize `135ae5b` and `337af2d` behavior.
2. Tighten relearning: attempt accounting, bounds, route/credential reset, no-cap thinking behavior.
3. Extract resolver and route identity with credential generation.
4. Wire CLI and web without changing orchestration.
5. Fix ceiling semantics and thinking coupling.
6. Replace error classification with structured/bounded parsing.
7. Add tests for learned/omitted cap, unknown Claude alias with thinking, credential rotation, small ceiling, missing-cap gateway, shared-window recovery, pure cap rejection.
8. Update docs and migration notes.

## Todo List

- [x] Characterization tests (existing 135ae5b/337af2d specs kept green; one intended change: 1,024 floor test updated with plan reference).
- [x] Bounded relearning tightened.
- [x] Resolver/route identity.
- [x] CLI/web wiring.
- [x] Ceiling and thinking coupling.
- [x] Classifier.
- [x] PH1/PH2/PH3 tests.
- [x] Docs (fallback + bounded relearn described).
- [x] Typecheck, affected specs, full suite vs baseline (no Phase 4 regressions; 5 shutdown-cleanup failures pre-existing at HEAD, see report).
- [x] Review fixes H1, M1–M4, low (see report).
- [x] Short migration note in release notes (Phase 6, `docs/migration-runtime-hardening.md`).

Report: [reports/phase-04-model-caps-and-errors.md](./reports/phase-04-model-caps-and-errors.md)

## Success Criteria

- PH1-A through PH1-D, PH2-A through PH2-D, PH3-A through PH3-E pass after amendments.
- Credential/account change cannot reuse reasoning lineage.
- No unbounded resend, no persistent learned cap, no cap invented by ceiling.

## Risk Assessment

- Learning from errors is provider-text dependent: strict formats, bounds, one resend, tests.
- Fallback 32k can still be wrong: bounded one-shot correction and operator override.
- Route fingerprint changes lock sessions: versioned explicit fields and tests.

## Security Considerations

- No raw credentials in route identity or diagnostics.
- Hostile relay cannot set authoritative cap or cause repeated resends.

## Next Steps

- Unblocks Phase 5 after route identity is stable.
