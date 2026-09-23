---
phase: 10
title: "Conformance and Full-Stack Verification"
status: blocked
priority: P1
effort: "6-10 days plus quantified soak"
dependencies: [2, 3, 4, 5, 6, 7, 8, 9]
---

# Phase 10: Conformance and Full-Stack Verification

Blocked in this workspace: Windows and Linux CI jobs, a quantified soak, and retained release artifacts need runners and a named approver that are not available here. Hermetic vitest coverage stays in phases 2-9.

## Overview

Prove the complete tested profile with pinned fixtures, a separate real-stack Playwright suite, Windows/Linux platform jobs, quantified failure/performance thresholds, migration/rollback-floor cases, and immutable CI evidence. No P1 skip is accepted without narrowing the release claim.

## Requirements

- Pinned fixture provenance/version/checksum/license and no mutable network dependency at test runtime.
- Separate fast fixture-backed browser suite and real browser→web host→MCP suite.
- Protected test pairing bootstrap via stdin/file/IPC only; absent in production and traces/logs.
- Explicit Windows and Linux runners; POSIX is not inferred from Git Bash on Windows.
- Quantified soak workload/environment/thresholds.
- Compatibility gates for modes, subagents, terminal, old config, auth migration, ownership, journal operations, migration/rollback, and PM2.
- CI artifacts are immutable/redacted with retention/access/approver policy.

## Architecture

Create `playwright.full-stack.config.ts` and a host launcher using temporary data/provider config, random loopback port, actual stdio/HTTP/OAuth fixtures, and protected one-time bootstrap. Keep current `test:browser` mocked/fast; add `test:browser:mcp`.

CI jobs: Windows and Linux clean install, typecheck, unit/integration, conformance, process gates, web build, fixture browser, real-stack browser, migration/rollback, and soak. New dependencies receive license/SBOM/vulnerability/reproducibility review.

## Related Code Files

- Create: `tests/fixtures/upstream-mcp/README.md`
- Create: `tests/fixtures/upstream-mcp/manifest.json`
- Create: `scripts/fetch-mcp-fixtures.mjs`
- Create: `playwright.full-stack.config.ts`
- Create: `scripts/start-mcp-e2e-host.mjs`
- Create: `tests/browser/mcp-full-stack.e2e.ts`
- Create: `tests/browser/mcp-oauth.e2e.ts`
- Create: `tests/harness/mcp-conformance.spec.ts`
- Create: `tests/harness/mcp-failure-injection.spec.ts`
- Create/modify: `.github/workflows/mcp-cross-platform.yml` or name equivalent mandatory runner config
- Modify: `package.json`/lockfiles
- Modify: existing G5/web/auth/process tests

## Implementation Steps

1. Pin representative stdio and Streamable HTTP/OAuth fixture versions with source, checksum, license, protocol, deviations, and reviewed update procedure.
2. Add clean-install gate: lockfile integrity, no undeclared runtime network, license/SBOM/vulnerability checks for parser/OAuth/native containment dependencies.
3. Build protocol/adversarial corpus: malformed versions/capabilities/envelopes, CRLF, repeated cursor, compressed/oversized data, redirect/SSRF, metadata injection, notification storm, lost/late response, stalled cleanup, dead child, revoked credentials.
4. Build real host launcher with isolated data + provider config, random port, protected bootstrap through stdin/temp/IPC, actual fixtures, and bounded cleanup. Assert bootstrap absent from production, args, logs, trace/video/HAR/screenshots.
5. Browser happy path: pair, save disabled stdio, activation preview, activate, inspect tools, send/approve/call, reload, restart, persist; repeat for HTTP/OAuth profile.
6. Browser failure paths: bad command durable failed, stale 409, secret delete fence, lost response indeterminate/no replay, audit fault block/repair, auth logout/SSE close, OAuth revoke/re-authorize, containment unavailable.
7. Compatibility fixtures: policy-overlay/modes-only; root/child indeterminate repeat/fresh approval; terminal auth/non-interference; same public tool across two workspaces; per-session model unchanged.
8. Ownership/deployment: concurrent host startup, holder SIGKILL/takeover, split-brain rejection, PM2 fork/single instance, shutdown messages, restart during each dispatch/migration/refresh state.
9. Journal/operations: ENOSPC, ACL change, lock, torn tail, corrupt middle, backup/restore, key rotation, quota/compaction, token-store corruption, config drift, alert/runbook recovery.
10. Migration: v1/v2/omitted-enabled/external-token/corrupt secrets/partial transaction fixtures; interrupt every durable step; unsafe downgrade refuses start.
11. Platform gates: Windows Job Object/ACL; Linux cgroup/process; unsupported-host best-effort claim. No mock substitutes.
12. Define soak profile before run: runner class, duration, server/tool counts, payload/result sizes, call/churn/refresh/config rates. Set pass thresholds for connect/call/status latency, journal fsync/recovery, memory growth slope/ceiling, event-loop lag, handles/FDs, pending requests, process count, auth refresh, and shutdown.
13. Build the known-safe compatibility/rollback artifact at the declared schema floor; pin version/checksum, archive it, install it against migrated test data, prove unsafe older binaries refuse start, and retain it with the release artifacts.
14. Emit JUnit/log/screenshots/process/migration transcripts/fixture verification as redacted immutable CI artifacts with retention/access owner and release approver. Plan-tree reports are not the release evidence.

## Success Criteria

- [ ] Fixture manifest/checksum/license and update process are committed.
- [ ] Real stdio and HTTP/OAuth browser flows pass without API interception.
- [ ] One client dispatch/no replay and indeterminate crash windows pass.
- [ ] Production profile cannot use test bootstrap and artifacts contain no credential.
- [ ] Windows and Linux mandatory gates pass their claimed containment/auth/migration behavior.
- [ ] Ownership, journal ENOSPC/corruption, token corruption, config drift, backup/restore, PM2 restart, and unsafe downgrade gates pass.
- [ ] The pinned/checksummed safe compatibility artifact installs and passes rollback/fail-forward tests against migrated data.
- [ ] Modes/subagent/terminal/workspace/model compatibility fixtures pass.
- [ ] Quantified soak passes all predeclared thresholds; no qualitative “looks stable” gate remains.
- [ ] `npm run typecheck`, full tests, web build, fixture browser, and `test:browser:mcp` pass.
- [ ] Immutable release artifacts have redaction, retention, access owner, and named approver.
- [ ] Zero unexplained P1 skips remain; otherwise release claim is narrowed or blocked.

## Risk Assessment

Mandatory Windows/Linux infrastructure may not exist today; create it or block/narrow the corresponding claim. A local cooperative fixture does not prove universal provider compatibility, so evidence remains tied to the published matrix.
