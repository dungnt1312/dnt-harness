# Phase 06 — Metrics, prompt, docs, release gates

## Context Links

- Spec §11 QH-1/QH-2 and §13.
- Code: `scripts/bench/*`, `src/harness/context/builder.ts`, `package.json`, `.github/workflows/release.yml`, docs.

## Overview

- Priority: P2, release-blocking for runtime gates.
- Status: Implemented, committed `16eb829` (metrics + prompt) and `58153cc` (release gates/docs). Pending gates: protected `release` environment + tag protection (repo admin), first green Linux CI run. Behavioral prompt eval (spec §11.3) implemented 2026-10-19 via `scripts/prompt-eval/`. nonexistent-feature passes 5/5 live after a scorer false-positive fix (run 5 failures classified as false positives, run 6 passed). Scope: one model via the `ocproxy-2` proxy, one sample for each of the other cases, and the scorer was adjusted after observing live answers. Report: [reports/phase-06-final-report.md](./reports/phase-06-final-report.md).
- Finish measurement, prompt calibration, documentation, and enforceable release gates.

## Key Insights

- Cache aggregation currently falls back between arrays, so `cachedInputTokens` is ignored.
- Current prompt can discourage evidence-based refinement.
- Release workflow publishes on tag after typecheck only, with a job holding OIDC publish permission.
- Linux CI must run dedicated probes because broad suite already has host-environment failures.

## Requirements

- Normalize cache metrics per record before aggregation; preserve missing as unknown.
- Label token semantics correctly.
- Tighten read-task verifier.
- Soften prompt: avoid unchanged repetition; allow evidence-based refinement and reverification.
- Pin Bun 1.4.3 and Node `>=22.19.0` for Vitest/Vite.
- Release workflow enforces gates through `needs:`: typecheck, affected deterministic suites, GitHub Linux Bun outbound/DNS and PTY probes, Windows launcher/PM2 smoke where supported by CI or a signed manual evidence step, and macOS terminal evidence for any macOS support claim. <!-- Updated: Validation Session 1 - Linux CI + macOS evidence -->
- Use protected `release` environment with required reviewers before publish.
- Pin GitHub Actions to commit SHA in OIDC publish workflow.
- Tag protection or equivalent repository rule is required before relying on tag-triggered publish.

## Architecture

- Bench records normalize once; aggregation consumes normalized fields only.
- Gate jobs are separate; publish job `needs:` all required gates and runs in a protected release environment.
- Platform evidence is attached to the release review, not inferred from typecheck.

## Related Code Files

- Modify: `scripts/bench/run-bench.mjs`, `harness-agent.mts`, `opencode-run.mjs`.
- Modify: `src/harness/context/builder.ts`, prompt tests.
- Modify: `package.json`, `.github/workflows/release.yml`.
- Modify: `README.md`, `CLAUDE.md`, `docs/guides.md`, `docs/prompt-contract.md`, `docs/web.md`.

## Implementation Steps

1. Fix and test benchmark normalization/verifiers.
2. Calibrate prompt with small behavioral fixtures.
3. Pin runtime versions and preflight docs.
4. Split CI gate jobs and make publish depend on them.
5. Add protected release environment and pinned actions.
6. Run final verification against Phase 0 baselines.
7. Write implementation report with residual risks.

## Todo List

- [x] Metrics fixed (`scripts/bench/metrics.mjs`, `tests/scripts/bench-metrics.spec.ts`).
- [x] Prompt softened (string-level tests in `base-prompt-guidance.spec.ts`).
- [x] Behavioral prompt eval (recall with tool count): `scripts/prompt-eval/`, `tests/scripts/prompt-eval-score.spec.ts`. Run 3 passed 3/3 under the rule narrowed after run 1. Run 4 (hardened scorer) failed nonexistent-feature; run 5 (5 samples, answers captured) showed 5/5 scorer false positives; run 6 under the fixed scorer passed 5/5. One model via the `ocproxy-2` proxy (2026-10-19).
- [x] Runtime pins/docs (Bun 1.4.3, Node >=22.19; README/guides/web/migration/release-checklist).
- [x] Release jobs: publish `needs:` all gates, SHA-pinned actions, tarball built without OIDC token.
- [ ] Protected `release` environment + tag protection — must be configured by repo admin.
- [x] Final verification/report (Windows; Linux CI pending).

## Success Criteria

- Cache fixture aggregates correctly; missing usage remains unknown.
- Prompt fixtures preserve recall and stop on true absence.
- Publish cannot run when a required gate fails or before reviewer approval.
- Full suite has no new failures versus pinned baselines.
- Platform support claims match evidence.

## Risk Assessment

- CI platform failures pre-exist: use separate deterministic gate suites and baseline inventory.
- Manual gates can be bypassed: require protected environment approval with evidence links.

## Security Considerations

- No secrets/transcripts in artifacts.
- OIDC workflow uses pinned actions and protected environment.

## Next Steps

- Await explicit release/tag approval.
