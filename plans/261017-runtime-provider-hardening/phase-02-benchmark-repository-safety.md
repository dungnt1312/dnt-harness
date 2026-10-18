# Phase 02 — Benchmark repository safety

## Context Links

- Spec §5 RH-2.
- Code: `scripts/e2e/compare-opencode-dnt.mjs`.

## Overview

- Priority: P1 for shared tooling.
- Status: Implemented, committed `2033415`. RH2 Windows subset passes. Pending gate: POSIX-only special-name RH2-C tests on Linux CI. Deviation: copies are HEAD-only (no history). No separate phase report; summary in [reports/phase-06-final-report.md](./reports/phase-06-final-report.md).
- Remove destructive source handling and create independent disposable repositories.

## Key Insights

- Current verifier unconditionally resets index and only backs up working-tree bytes.
- Independent copies prevent rig mutation and contestant contamination; they are not a malicious-agent sandbox.
- Windows path rules and CRLF/filemode conversion make checkout-byte copying unreliable.

## Requirements

- Remove reset/restore/delete against source.
- Refuse non-disposable `--repo` targets.
- Build each contestant repo from Git object data into a fresh Git directory.
- Reconstruct HEAD, index entries, and working-tree layer separately.
- Force `core.autocrlf=false` and stable comparison config in disposable repos.
- Refuse submodules, unmerged entries, unsupported symlinks, invalid Windows paths, sensitive tracked paths, and source drift during freeze.
- Do not copy ignored files.
- Run every source Git command with hardened config/env: no system/global config, no hooks, `core.fsmonitor=false`, no external diff, no textconv, no filters, no optional locks, no index refresh.
- Untracked files are not copied by default. Opt-in copying prints the list before agents start and applies sensitive-path policy to untracked as well as tracked files.
- Drift fails the run and preserves artifacts.

## Architecture

- Freeze source metadata through read-only Git inspection.
- Use `git ls-files -s`, `git cat-file`, and index/worktree manifests rather than checkout bytes.
- Create one fresh repo per contestant/run.

## Related Code Files

- Modify: `scripts/e2e/compare-opencode-dnt.mjs`.
- Add: script-focused tests/fixtures.

## Implementation Steps

1. Add regression fixture for staged-only content loss.
2. Remove destructive source verifier behavior.
3. Implement hardened source Git runner, freeze and refusal rules.
4. Rebuild independent repos from object store/index manifest.
5. Verify reconstructed layers before any agent run.
6. Add drift detection with artifacts.
7. Run Windows fixture set; run Linux-only special filename fixtures.

## Todo List

- [x] Staged-only regression test.
- [x] Source mutation removed.
- [x] Layered independent copy implemented.
- [x] Refusal cases implemented.
- [x] RH2 tests pass Windows subset.
- [ ] RH2 POSIX-only special-name tests (2) pass on Linux — pending Linux CI run.

## Success Criteria

- RH2-A through RH2-E pass.
- RH2-C special-name cases run on Linux; Windows-invalid paths are refused, not normalized.
- Raw source index and worktree remain unchanged across success, failure, timeout.
- Malicious source config/attributes (`fsmonitor`, diff/textconv/filter) do not execute.
- Untracked sensitive file is not copied unless explicitly opted in and allowed by policy.

## Risk Assessment

- Reconstruction mismatch: verify blob ids, modes, index entries, and worktree hashes before agent.
- Platform path differences: refuse unsupported names explicitly.

## Security Considerations

- Never print sensitive file contents.
- Sensitive tracked path policy is conservative and reports paths only.

## Next Steps

- Required before using comparison results as release evidence.
