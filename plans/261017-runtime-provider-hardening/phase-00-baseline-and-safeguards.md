# Phase 00 — Baseline, runtimes, platform gates

## Context Links

- Spec: [`../261017-spec-runtime-provider-hardening.md`](../261017-spec-runtime-provider-hardening.md) §1, §11, §13.
- Baseline commits: `135ae5b` CLI/provider-store parity; `337af2d` output-cap relearning.
- Pending HC plan: `plans/261017-0018-harness-core-hardening/`.

## Overview

- Priority: P1.
- Status: Implemented, committed `2ff6eff`. Pending gate: first GitHub Linux CI run (branch not pushed). macOS: no evidence. Report: [reports/phase-00-baseline.md](./reports/phase-00-baseline.md).
- Establish a valid baseline under supported runtimes before functional changes.

## Key Insights

- Current `node` on PATH may be 18.20.3; Undici 7.29.1 requires newer Node and Vitest collection fails under Node 18.
- Default `bun run test` is Vitest and is not proof of Bun runtime behavior.
- No Docker CLI is available locally. WSL exists, but only Docker Desktop distros were found stopped; no usable Linux test distro is proven.
- Bare `undici` imports resolve to Bun's native shim under Bun 1.4.3; real package entry import blocks through dispatcher in a local probe.

## Requirements

- Re-confirm HEAD before work; abort if tracked source changes appear unexpectedly.
- Enforce Vitest Node `>=22.19.0` before baseline. Prefer pinned path/override; fail with an actionable message.
- Enforce Bun `1.4.3` for runtime probes and production-runtime tests.
- Create Bun executable resolver for spawned tests; no Windows shell-only shim.
- Provision GitHub Linux CI as the Linux gate environment: dedicated Bun runtime/DNS/PTY probe job, separate from the full suite with known host-environment failures. Record its baseline separately. <!-- Updated: Validation Session 1 - GitHub Linux CI selected -->
- macOS terminal support requires real zsh/Bash smoke evidence before release; no evidence means no macOS terminal support release. <!-- Updated: Validation Session 1 - macOS evidence required -->
- Record baselines by `{commit, OS, Node, Bun, Git, test command}`.

## Architecture

- `tests/helpers/runtime-executable.ts`: explicit runtime resolution for child process tests.
- `scripts/runtime-probes.mjs`: small probe runner using the exact Bun executable.
- Runtime preflight script or check used by test docs/CI.

## Related Code Files

- Add: `tests/helpers/runtime-executable.ts`, `scripts/runtime-probes.mjs`.
- Modify: tests that spawn Bun directly.
- Modify: `package.json` only for clearly named preflight/probe scripts.
- Modify later in Phase 6: CI/docs for permanent gates.

## Implementation Steps

1. Snapshot HEAD, untracked paths, runtime versions.
2. Add/run Node preflight; stop on unsupported Node.
3. Add Bun resolver and runtime probe entry.
4. Run focused suites, then full suite under supported Node.
5. Run Bun runtime probes on Windows.
6. Add GitHub Linux CI probe job, run its baseline and runtime probes.
7. Record macOS environment availability; no release support claim without evidence.

## Todo List

- [x] HEAD and untracked inventory recorded.
- [x] Node `>=22.19.0` preflight enforced.
- [x] Bun `1.4.3` resolver/probes added.
- [x] Windows pinned-runtime baseline recorded.
- [x] GitHub Linux CI probe job provisioned (`.github/workflows/runtime-probes.yml`).
- [ ] Linux CI baseline recorded — pending first push (user chose not to push).
- [x] macOS availability recorded (none available).

## Success Criteria

- No baseline failure caused by unsupported Node or missing Bun shim.
- Real runtime is printed by probes, not inferred.
- Linux environment can run Bun and real Bash before Phase 3 starts.
- Failure inventory separates pre-existing, platform-specific, unknown.

## Risk Assessment

- No Linux runtime available: blocks Phase 3 and release gate; do not substitute mocks.
- Platform failures hide regressions: compare test identity and error class across same commit/runtime.

## Security Considerations

- Do not store secrets, API keys, transcripts, or environment dumps in reports.

## Next Steps

- Unblocks Phases 1–6 according to plan dependencies.
