---
phase: 11
title: "Rollout, Documentation, and Signoff"
status: blocked
priority: P1
effort: "3-5 days plus canary window"
dependencies: [10]
---

# Phase 11: Rollout, Documentation, and Signoff

Blocked in this workspace: the 24-hour canary, the live PM2 drill, and a named human signature cannot be completed or invented from the repository.

## Overview

Execute the already-tested migration kernel against real data through a bounded canary, enforce the safe rollback floor, update current authority docs and G5 supersession map, verify live PM2 behavior, and sign off only against retained CI/canary evidence.

## Requirements

- No schema/migration algorithm is invented here; Phase 3 implementation and Phase 10 interruption tests are prerequisites.
- Default canary is one explicitly selected non-critical workspace for 24 hours and at least 100 safe fixture/approved read-only calls; zero auth bypass, replay, stale-generation dispatch, audit fault, config loss, or contained-process leak is allowed, and Phase 10 latency/resource thresholds must remain green. The `MCP_RELEASE_APPROVER` identity must be explicitly recorded in the retained Phase 10 release manifest before rollout; absence blocks rollout.
- No shadow execution of real MCP tools.
- Rollback stays at or above the minimum safety kernel; unsafe older binary refuses migrated data.
- Backups/journals/revocation tombstones remain protected and retained per policy.
- Documentation qualifies protocol/provider/platform/threat support and optional exclusions.

## Architecture

Rollout:

```text
preflight ownership/disk/ACL -> protected backup + dry-run
-> migrate quarantined/disabled -> start authenticated host
-> canary workspaces -> verify evidence/thresholds
-> expand -> production smoke -> approver signoff
```

Rollback means deploy a known-safe compatibility build or disable new features while preserving config v2 reader, ownership lock, no-replay coordinator, execution journal, tombstones, and downgrade marker. Rollback below that floor is technically refused.

## Related Code Files

- Modify: `src/bins/migrate-mcp.ts`
- Modify: `src/bins/web.ts`
- Modify: `ecosystem.config.cjs`
- Modify: current docs: `docs/capabilities.md`, `docs/harness.md`, `docs/web.md`, `docs/guides.md`, `README.md` if applicable
- Add dated supersession note/table to completed G5 plan without altering historical checkboxes
- Add release notes/changelog location used by repository
- Use CI artifacts from Phase 10; do not create mutable plan reports as authority

## Implementation Steps

1. Apply the default canary contract: one explicitly selected non-critical workspace, 24 hours, at least 100 safe fixture/approved read-only calls, Phase 10 performance thresholds, zero auth bypass/replay/stale-generation dispatch/audit fault/config loss/contained-process leak, and a 30-second new-dispatch fence objective. Require the explicitly recorded `MCP_RELEASE_APPROVER` from the retained Phase 10 release manifest; do not infer authority from Git author configuration.
2. Preflight exact dnt-harness PM2 process, one-owner topology, disk space, ACLs, backup path, config/provider data locations, safe binary/schema floor, and current build/source mtime.
3. Run protected dry-run and review every workspace/server action. Confirm no process/network/OAuth/token/runtime mutation occurred.
4. Create/verify unique protected backup and migration journal, then migrate ambiguous entries disabled/quarantined and legacy OAuth as external token.
5. Start new host, pair/authenticate, reconcile selected canary workspaces, and verify journal/status/process ownership/auth/OAuth/no-replay/secret fence/restart/shutdown.
6. Compare canary evidence to predeclared Phase 10 baselines; expand only if all thresholds pass for the defined duration.
7. Drill rollback/fail-forward using the exact pinned/checksummed safe compatibility artifact produced and retained by Phase 10. Verify unsafe binary refuses start, journals/tombstones persist, no unresolved invocation replays, and new dispatch/process/session ownership fences within 30 seconds.
8. Audit real user `providers.json`, MCP config, and key files before/after hermetic smoke to prove no temp-run pollution.
9. Update current docs with exact protocol version, transports, OAuth profile, local auth/deployment, activation/no-sandbox warning, containment matrix, state meanings, recovery/runbooks, migration/backup/rollback, metrics, and optional exclusions.
10. Add G5 supersession table: retry/no replay, audit evidence, environment inheritance, process containment, OAuth meaning, fixtures, metrics/dashboard, local auth, and config schema marked retained/strengthened/deprecated/deferred.
11. Run production smoke: exact current process/port/build, auth and SSE, one safe stdio call, one safe HTTP/OAuth call, indeterminate fixture in isolated environment, restart recovery, secret fence, and clean shutdown.
12. Sign off against immutable CI/canary artifacts, open known issues, and qualified release claim. No plan document substitutes for evidence.

## Success Criteria

- [ ] Default canary contract (one non-critical workspace, 24 hours, 100 safe calls, zero safety violations, Phase 10 thresholds, 30-second fence objective) is met and repository/deployment owner approval is recorded.
- [ ] Dry-run is mutation-free except protected requested output.
- [ ] Backup/migration completes under one owner and passes checksum/ACL/key compatibility checks.
- [ ] Ambiguous legacy servers remain disabled; external tokens are not misrepresented as managed OAuth.
- [ ] Canary meets all thresholds for full duration with no stale credential, orphan contained process, unauthenticated access, config loss, replay, or journal fault.
- [ ] The exact Phase 10 safe compatibility artifact passes rollback/fail-forward drill and unsafe old binary refuses migrated data.
- [ ] Hermetic smoke leaves real user config untouched.
- [ ] Current docs and G5 supersession map accurately qualify support and limitations.
- [ ] Live PM2 smoke verifies exact current code/build, port, auth, both transports, restart, fence, and shutdown.
- [ ] Named approver signs retained artifacts; zero unexplained P1 skips remain.

## Risk Assessment

Production rollback cannot mean reinstalling the current unsafe client. If the safe compatibility build is unavailable or downgrade marker is not enforced, rollout is blocked. Backups contain sensitive encrypted material and key dependencies; retention, access, and deletion follow the protected data policy, not ad hoc plan artifacts.
