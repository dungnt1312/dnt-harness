---
phase: 6
title: "Process Ownership and Resource Policy"
status: in-progress
priority: P1
effort: "6-10 days"
dependencies: [3, 5]
---

# Phase 6: Process Ownership and Resource Policy

## Overview

Make stdio activation explicit, remove ambient credential inheritance, own executable identity and shutdown, and publish only platform guarantees that are backed by real containment primitives. Integrate PM2 shutdown/single-instance behavior before runtime reconciliation relies on process ownership.

## Requirements

- New/v2 servers are disabled until explicit activation.
- Stdio environment is minimal plus explicitly configured values/pass-through names.
- Activation previews and spawns a canonical executable path; shell mode is excluded from the production milestone.
- Windows hard containment uses a reviewed Job Object mechanism assigned without an escape window.
- Linux hard tree resource enforcement uses cgroup v2 only when required delegation exists; otherwise limits are rejected or labeled best-effort.
- macOS receives bounded best-effort cleanup only until a tested hard primitive exists.
- PM2 runs one fork instance and provides a shutdown deadline greater than MCP cleanup.
- Master-key ACL/mode verification is identity-based and fail-closed.

## Architecture

`OwnedProcessController` reports capability level:

```ts
type Containment = "hard" | "best_effort" | "unavailable";
```

Separate guarantees:

- graceful stop cleanup;
- watchdog response;
- host crash behavior;
- startup orphan reclamation.

Do not describe app-level process controls as a sandbox. A stdio server still runs with the user’s filesystem/network privileges.

## Related Code Files

- Modify: `src/harness/mcp/client.ts`
- Modify: `src/harness/mcp/config.ts`
- Create: `src/harness/mcp/process-controller.ts`
- Create: `src/harness/mcp/process-controller-windows.ts`
- Create: `src/harness/mcp/process-controller-linux.ts`
- Create: optional reviewed native/helper source and packaging files
- Modify: `src/bins/web.ts`
- Modify: `ecosystem.config.cjs`
- Modify: `src/web/server.ts`
- Modify: `src/index.ts`
- Modify: `package.json`/lockfiles/build packaging
- Create: `tests/fixtures/mcp-process-tree-server.mjs`
- Create: `tests/harness/mcp-process-windows.spec.ts`
- Create: `tests/harness/mcp-process-linux.spec.ts`
- Create: `tests/bins/web-shutdown.spec.ts`
- Modify: docs

## Implementation Steps

1. Remove implicit activation and edit-form enabled semantics; save/import writes disabled desired config and activation is a separate authenticated operation.
2. Resolve command to canonical executable path before confirmation; display path and file identity/hash where practical; revalidate before spawn and abort if replaced. Spawn without shell.
3. Build minimal platform environment and explicit `passEnv`. Strip provider/cloud/registry/proxy tokens and `NODE_OPTIONS` by default.
4. Select and review concrete Windows Job Object implementation, including build/distribution/architecture/signing/provenance and fail behavior. Assign child before it can create uncontained descendants.
5. Implement Linux cgroup v2 containment where supported; detect delegation. Hard CPU/memory settings fail closed when unavailable rather than silently degrading.
6. Implement best-effort cleanup for unsupported platforms with qualified status/diagnostics; do not claim hard tree limits.
7. Define CPU semantics, sample cadence, consecutive breach count, allowed overshoot, non-overlap, sampling-failure behavior, TERM/grace/KILL equivalents, and exactly-one watchdog action.
8. Handle rapid child creation, detach/daemon attempts, PID churn, host crash, and startup orphan reclamation according to platform guarantee.
9. Use one idempotent host shutdown for SIGINT, SIGTERM, and PM2 Windows message path. Configure `instances: 1`, `exec_mode: fork`, `kill_timeout`, and reject cluster/shared-data mode.
10. Align ownership lock/fencing with process startup and replacement; new host does not start runtimes until prior owner is fenced.
11. Harden secret master key: POSIX owner/mode; Windows SID allowlist, owner, inheritance, unexpected ACE rejection; fail closed on unverifiable protection.
12. Add tests for environment isolation, canonical executable change, activation separation, Job/cgroup capability, burst versus sustained breach, unavailable sampling, child/grandchild/detach behavior, stale watchdog, PM2 shutdown/restart, and ACL localization/extra principal.

## Success Criteria

- [x] Saving/importing cannot start a process; activation is explicit and authenticated.
- [x] Fixture cannot read unrelated ambient secrets. A live stdio child lists its own environment (`env` fixture tool): it sees its explicit `env` and platform basics, never a variable set only in the host (`tests/harness/g5-mcp.spec.ts`).
- [x] Spawn uses the confirmed canonical executable and refuses identity change. Enable now pins `executable: { path, sha256 }` of the canonical file; every spawn re-resolves and refuses a different path or bytes (`executable_changed`) until enabled again. Saves cannot forge or move the pin; reconnect never re-authorizes (`tests/web/server-g5.spec.ts`). Before this the hash was computed and never compared. Residual: a swap in the instant between the final hash and `spawn` is not closed (no exec-by-handle in Node).
- [ ] Windows hard-containment claims pass Job Object escape/resource/kill-on-close tests. No Job Object helper is packaged, so hard containment is refused instead of claimed.
- [ ] Linux hard-limit claims pass cgroup v2 tests; unavailable hosts reject hard limits. Hard limits are refused. A cgroup v2 test is not claimed.
- [x] Unsupported platforms are labeled best-effort and do not overclaim daemonized-descendant/resource guarantees.
- [x] Watchdog semantics are quantified and produce no false kill on short bursts and one action on sustained breach. CPU breach = 3 consecutive 1 s samples over the limit; a 1.2 s burst survives, sustained load gets exactly one kill (`watchdogKills`). Sampling is now asynchronous: on Windows it used `spawnSync('powershell')` every second, blocking the host's event loop per watched server.
- [ ] PM2 single-fork shutdown/restart leaves no contained descendants and prevents overlapping owners. Overlapping owners are refused by the data-home lock. A PM2 restart drill is not in this suite. A drill against a throwaway pm2 app was attempted on 2026-09-24 and abandoned: the shared host was at ~95% CPU / ~90% RAM, so its timing would prove nothing and it risked the other apps. Run it on a quiet host.
- [x] Master-key verification rejects unexpected principals/permissions. Windows: SID allowlist — inheritance removed and every Allow ACE is the current user's SID (read via `Get-Acl`, cached by ctime); POSIX: no group/other bits and owned by this uid. The previous English-name denylist let `LOCAL SERVICE` (and any localized group) through; the test grants it by SID and is refused, then restored.
- [x] Documentation repeatedly states app-level isolation, not sandboxing.

## Risk Assessment

Native containment helpers materially affect schedule and supply chain. If reviewed Job Object or Linux cgroup integration cannot be delivered, narrow the supported hard-enforcement matrix rather than shipping `taskkill`/enumeration under a hard-containment claim.
