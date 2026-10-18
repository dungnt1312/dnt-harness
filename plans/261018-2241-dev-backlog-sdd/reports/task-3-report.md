# Task 3 report: Linux CI evidence via PR dev → main

Status: DONE (2026-10-18)

## PR
- https://github.com/dungnt1312/dnt-harness/pull/1 (dev → main, "Runtime hardening, merged feature branches and live smokes"). Open, mergeable (CLEAN), not merged, no auto-merge. `dev` was pushed fast-forward (7464e6e..126fa70); nothing was force-pushed and nothing was pushed to main.

## Runs (workflow `Runtime probes`, job `linux-probes`, ubuntu-latest, Bun 1.4.3, Node 22.20.0)
1. https://github.com/dungnt1312/dnt-harness/actions/runs/39144485540 at 126fa70: success (28s).
   - runtime-probes 8/8 (outbound-http 16/16, DNS localhost -> ::1, 127.0.0.1, bash 5.2.21)
   - pty-probes --require 9/9
2. https://github.com/dungnt1312/dnt-harness/actions/runs/39144703578 at 724b319: success. Same results, plus the new `npx vitest run tests/scripts/repo-freeze.spec.ts` step: 71/71 passed, 0 skipped. That includes the POSIX "handles Git-valid special characters" and "preserves executable bit and symlinks" tests.
3. https://github.com/dungnt1312/dnt-harness/actions/runs/39144804342 at 2a5ed7b (docs-only head): success.

Per-gate results:
- RH1-A: zero requests on rejection; bare `undici` fails closed with connections=0.
- RH1-B: system-resolver and injected [::1, 127.0.0.1] fallback reach the IPv4 fixture; public-to-loopback and mixed answers are blocked at connect.
- RH2-C: repo-freeze spec 71/71 on Linux. It also passed 71/71 locally on macOS (Node 24.15).
- RH3-A: remove stops shell, foreground and background jobs (3 members, 0 left, 54ms), with exactly one exit event. HUP-ignoring processes are KILLed at about 1s. An unrelated host-session process was never signalled.
- RH3-C: fds 9→9 over repeated create/close; UTF-8 split across reads decodes intact (0 replacement chars).
- RH3-E: natural exit, idle reap and disposeAll all pass (16 terminals, 48 members, 1056ms against a 4000ms budget).
- Bun's built-in PTY child does session-leader sweeping correctly on Linux, so there was no failure and no backend change.

## Failures / fixes
None. No product code changed.

## Changes
- 724b319 ci: run the POSIX repo-copy name tests in the Linux probe job. This adds one focused Vitest step to `.github/workflows/runtime-probes.yml`. Without it, CI never executed the RH2-C POSIX tests, because the workflow did not run Vitest.
- 2a5ed7b docs(release): record green Linux runtime, POSIX name and PTY probe results.
  - `plans/261017-runtime-provider-hardening/reports/phase-06-final-report.md`: legend gains Pass (Linux CI) with the run URL; rows RH1-A/B, RH2-C, RH3-A/C/E and QH-1 updated; Pending gates item 1 marked closed; the POSIX PTY residual risk marked resolved on Linux; Follow-ups item 1 marked done.

## Concerns
- The workflow change was not explicitly in the brief. It was needed to get Linux evidence for RH2-C. `release.yml` calls this workflow, so the release gate now also runs this spec (about 25s).
- The full Vitest suite is still not run on Linux, and the report's Follow-ups item 1 keeps it as the remaining item. Report lines 9, 12 and 89 (phase summary and regression verdict) still say Linux CI never ran or the baseline does not exist. They were left unchanged because they were outside the listed sections.
- Annotations: Node 20 actions are deprecated, and ubuntu-latest moves to Ubuntu 26 from 2026-10-19, so future runs may differ.
- QH-1 stays partial: a repo admin still has to configure the protected release environment and tag protection.

## Fix round 1 (2026-10-18)

Finding: the final report contradicted itself after the green run. Fixed in e283844, "docs(release): align the final report summary and verdict with the green Linux probe run", pushed fast-forward to origin/dev.

Edits to `plans/261017-runtime-provider-hardening/reports/phase-06-final-report.md`:
- Line 9 (phase 0): "Linux CI has never run" now says the Linux probe job was green on 2026-10-18 (run 39144804342), and that the full Vitest suite has not run on Linux or macOS.
- Line 12 (phase 3): the Linux process inspector is verified by the Linux PTY probes; the macOS inspector stays unverified.
- Line 89 (verdict): a Linux probe baseline now exists (8/8, 71/71, 9/9); a full Vitest suite baseline on Linux or macOS does not exist yet.
- Other stale statements from the scan:
  - All run links now point to the final run 39144804342 instead of 39144703578. Pending gates item 1 names both earlier green runs.
  - Pending gates item 1 and Follow-ups item 1 keep the full suite open on both Linux and macOS.
  - The residual risk "Real-cert TLS ... untested" contradicted the RH1-G row. It now says real-cert TLS is covered only by the single RH1-G public MCP smoke on macOS.
- Reviewed and left unchanged because they are still accurate: the plan-status header (gates still open), Pending gates 2-5, the macOS inspector risk, the "Bun probe 13/13" count for the Windows phase 1, and Follow-ups 2-6.
- CI on head e283844: https://github.com/dungnt1312/dnt-harness/actions/runs/39144987217 success.
