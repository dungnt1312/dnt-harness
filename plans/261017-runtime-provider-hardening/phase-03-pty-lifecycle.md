# Phase 03 — PTY lifecycle

## Context Links

- Spec §6 RH-3.
- Code: `src/web/terminals.ts`, `src/web/server.ts`, `src/bins/web.ts`, `ecosystem.config.cjs`.

## Overview

- Priority: P1 for POSIX terminal support.
- Status: Implemented, committed `7059b43` (+ `bb358c2` shutdown fix; Windows backend replaced by bun-pty 0.5.1 in `593cfc4`). Pending gates: Linux actual-process RH3-A/C (CI not run), macOS evidence (none; no macOS support claim).
- Ensure terminal delete, reap, natural exit, and shutdown have explicit physical teardown outcomes.

## Key Insights

- Built-in Bun adapter only calls `proc.kill()` and lacks a typed close/signal contract.
- Service removes records before teardown is proven.
- `bins/web.ts` waits for `server.close()` without a deadline; PM2 kill timeout is 15s.
- Interactive Bash job control places jobs in separate process groups.

## Requirements

- Time-box Linux spike before implementation.
- Track `running → closing → exited | failedTeardown`.
- `failedTeardown`: keep record, block input, allow explicit retry, retry on dispose/reap, and report remaining PIDs/session ids during shutdown.
- Close PTY and request process termination with verified API.
- Own process cleanup by PTY session id, not arbitrary process group. Linux uses `/proc`; macOS uses verified `ps` fields. Re-check start identity before escalation to avoid PID reuse.
- Run teardowns concurrently under one total deadline below PM2 timeout after other cleanup reservations.
- Make delete route await physical outcome and return explicit failure.
- No persistent orphan-reaping state in this plan. Document that external SIGKILL/host crash during teardown can leave processes; release claims cover graceful delete/reap/shutdown only. <!-- Updated: Validation Session 1 - document crash/SIGKILL limitation -->

## Architecture

- Terminal service owns state machine and shared teardown promise.
- Adapter owns PTY close/signals.
- Server cleanup awaits `disposeAll` under explicit budget.

## Related Code Files

- Modify: `src/web/terminals.ts`, `src/web/server.ts`, `src/bins/web.ts`.
- Modify/Add: `tests/web/terminals.spec.ts`, Linux runtime probes.

## Implementation Steps

1. Linux spike: built-in Bun close, HUP, process-session membership, foreground/background jobs, HUP trap.
2. Go/no-go: built-in backend vs dependency decision.
3. Implement state machine and failed-teardown retry semantics.
4. Implement session-member teardown with identity checks.
5. Await delete and dispose; add total shutdown budget.
6. Add fake-adapter race tests.
7. Add Linux actual-process tests with 16 terminals and slow cleanup steps.
8. Run Windows node-pty smoke; record macOS evidence or support scope.

## Todo List

- [ ] Linux spike and go/no-go. (Bun API spike done on Windows; Linux probe written, NOT run — no Linux env/no push. See reports/phase-03-pty-lifecycle.md)
- [x] State machine and retry semantics.
- [x] Session-member teardown. (Linux /proc + macOS ps implemented; both unverified on real OS)
- [x] Shutdown budget. (terminals 4s concurrent; bins/web.ts deadline 13.5s < PM2 15s)
- [ ] Actual-process tests. (scripts/pty-probes.mjs + tests/web/terminals-posix.spec.ts + CI step written; pending Linux run)
- [ ] Platform smoke evidence. (Windows: bun-pty `scripts/pty-smoke-windows.mjs` 14/14, repeated — node-pty removed in `593cfc4`; Linux pending; macOS none)

## Success Criteria

- RH3-A through RH3-E pass.
- Delete after failed teardown can retry.
- Sixteen terminals teardown concurrently within budget.
- No unrelated process signaled.

## Risk Assessment

- Session enumeration differs by OS: verify per platform; refuse unsupported platform release claim.
- PID reuse: identity check before every signal.
- External SIGKILL/crash: documented limitation, excluded from release claim.

## Security Considerations

- Never signal processes outside the owned PTY session.
- Diagnostics exposing PIDs are protected/admin only.

## Next Steps

- Release blocker for POSIX terminal support.
