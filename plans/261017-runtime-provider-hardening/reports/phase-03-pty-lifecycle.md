# Phase 03 — PTY lifecycle: implementation report

Date: 2026-10-17. Status: **implemented; Linux gate (RH3-A/C) written but NOT yet run** — no Linux env, user chose not to push. macOS: no evidence.

## Spike note (step 1 — done on Windows only, Linux pending)

Verified on Bun 1.4.3 (win32 build, runtime reflection; the repo has no `bun-types`/`@types/bun`, so the adapter keeps its own structural `BunPtyRuntime` type):

- `Bun.spawn(cmd, { terminal: { cols, rows, name, data(term, chunk) } })` returns a `Subprocess` with `pid`, `kill(signal?)`, `killed`, `signalCode`, `exitCode`, `exited`, `terminal`.
- `Bun.Terminal.prototype`: `write`, `resize`, `close`, `closed`, `setRawMode`, `ref`/`unref`, flag accessors. `close()` is idempotent (second call no-throw); `closed` flips to `true`.
- `proc.kill(sig)` after the child was reaped is a no-op (no throw). That is the "never signal after exit" guarantee for the direct child; the service also stops calling it once `onExit` fires.
- Old adapter called `proc.kill()` = Bun default SIGTERM, which an interactive bash ignores. It now sends SIGHUP.

**Still needs Linux verification** (`bun scripts/pty-probes.mjs --require`):
1. Bun's PTY child is a session leader (`setsid` + controlling tty): `/proc/<pid>/stat` session == pid. If it is not, `ownsSession` returns false and teardown falls back to shell-only HUP/KILL, which **fails RH3-A**. The probe reports this explicitly.
2. `terminal.close()` + SIGHUP to the shell → bash forwards HUP to its jobs; background job in its own process group stays in the session and is caught by the `/proc` sweep.
3. HUP-trapping shell + HUP-trapping job → KILL after ~1s escalation.
4. 16 terminals (4 HUP-trapping) under `disposeAll` within `TERMINAL_SHUTDOWN_BUDGET_MS` (4s).
5. FD count bounded across 30 create/close cycles; UTF-8 split decoding against a real PTY.
6. Go/no-go (step 2): **pending**. If probes 1–4 fail, stop and compare a `bun-pty` dependency (spec §6.2).

## What changed

| File | Change |
|---|---|
| `src/web/terminals.ts` | State machine `running → closing → exited \| failedTeardown`; one shared idempotent teardown (`closeLive`) for delete/reap/natural exit/disposeAll; close PTY → HUP → poll → KILL after `ESCALATE_MS` (1s) → `KILL_GRACE_MS` (1s POSIX, 2.5s Windows) → explicit `teardown-failed`; failedTeardown keeps record, blocks write/resize (`closing` error), retried by explicit kill, reaper and `disposeAll`; `kill()`/`disposeAll()` are now `Promise`; `disposeAll` concurrent under one budget, throws `TerminalTeardownError` with remaining PIDs/session ids; natural exit closes PTY, sweeps session, disposes `onData`/`onExit` disposables; exit event exactly once; subscriber exceptions isolated; `create` refused after dispose; Bun adapter: `pid`, `closeTerminal`, `signal`, disposable `onData`, kill=SIGHUP. Windows node-pty path unchanged (it has no `closeTerminal`/`signal`; `kill()` as before). |
| `src/web/pty-session.ts` (new) | `ProcessInspector`: Linux `/proc/<pid>/stat` (session field 6, starttime field 22, zombie filtered, comm-safe parsing, 20ms shared scan cache); macOS `ps -o pid=,stat=,tty=,lstart=` keyed on controlling tty, snapshot-only (no rescan after close, since a tty name can be reused). Identity re-check (start time, + session on Linux) before every signal; never signals pid ≤ 1, the host pid, or a group; session sweep only if the shell leads a session the host is not in. |
| `src/web/server.ts` | Terminal-only: DELETE awaits teardown → `200 {killed:true}` or `500 {killed:false,error}`; `closing` → 409; shutdown step awaits `terminals.disposeAll()`. |
| `src/bins/web.ts` | `SHUTDOWN_DEADLINE_MS = 13_500` timer around `server.close()` (PM2 `kill_timeout` 15s). Budget: terminals 4s + ~8 bounded steps × 1s + 1.5s slack. |
| `scripts/pty-probes.mjs` (new) | Real-process RH3-A/C probes under Bun (see above); SKIP off Linux, `--require` fails instead. Checks an unrelated `sleep` in the host session is never signalled. |
| `.github/workflows/runtime-probes.yml` | linux job: `bun scripts/pty-probes.mjs --require`. |
| `tests/web/terminals-lifecycle.spec.ts` (new) | RH3-B fake adapter + fake inspector (23 tests). |
| `tests/web/terminals-posix.spec.ts` (new) | `it.skipIf(!linux)` runs the probe script with real Bun. |
| `tests/web/terminals.spec.ts`, `tests/web/server-terminals.spec.ts` | Adjusted to async kill/dispose; new Bun adapter assertions; DELETE failure/retry test. |

## Tests

- Typecheck (`tsc -p tsconfig.json` and `tsconfig.web.json`): pass.
- `tests/web/terminals.spec.ts`, `terminals-lifecycle.spec.ts`, `server-terminals.spec.ts`: **55/55 pass**; `terminals-posix.spec.ts`: 1 skipped (win32).
- RH3-B covered: natural exit (PTY closed, no signal after exit, listeners disposed, data-before-exit), double kill (same promise, one HUP, one event), kill racing exit both ways, close/HUP errors, no unhandled rejections, escalation order `close,hup,SIGKILL`, failedTeardown (record kept, input 409/`closing`, explicit retry), reaper retry, idle reap, disposeAll retry + PID report, 16 concurrent within budget (~60ms vs ≥640ms sequential), budget cap without hang, 50 create/close cycles with no timer growth, session sweep of background jobs, KILL for HUP-trapping member, no signal to other session / reused PID (Linux and snapshot modes), no sweep when shell does not lead a session, `/proc/stat` + `ps` parsing.
- Windows node-pty smoke (real ConPTY via Bun 1.4.3, through `createTerminalService`), 4 runs: bash/powershell/cmd input→output, resize, kill (~51ms each), natural `exit`, disposeAll of 2 (~1.5s); 16 terminals killed 500ms after spawn: disposeAll ok in 2.5s. Observed: a ConPTY shell killed while still starting reports exit only after 1–2.5s (hence the Windows `KILL_GRACE_MS`). One `teardown-failed` seen once, under load right after the 16-terminal stress run; that is the explicit failure path working (record kept, retry possible), and it did not recur in 4 later runs.
- Full suite not re-run (baseline has 25 known failing files); only affected specs run.

## Documented limitations

- **External SIGKILL / host crash during teardown can leave shell processes and jobs running.** No orphan-reaping state is persisted (by design for this plan). Release claims cover graceful delete, idle reap, natural exit and shutdown only.
- Intentionally detached daemons (`setsid`, `nohup … & disown` into a new session) leave the PTY session and are not cleaned up (spec §6.1).
- **macOS: no evidence.** The `ps`/tty inspector is implemented but unverified (field names, whether `tty` survives PTY close, Bun PTY session leadership). No macOS terminal support claim until zsh/bash smoke passes (RH3-D).
- **Linux: no evidence yet.** CI step wired but not run. Do not claim POSIX terminal support before `pty-probes` passes on the linux job.
- PIDs appear only in server-side shutdown error / logs (`TerminalTeardownError`), never in HTTP responses.

## Deviations

- Kept a structural `BunPtyRuntime` type instead of `bun-types` (not installed; tsconfig `types: ["node"]`).
- `TERMINAL_SHUTDOWN_BUDGET_MS` is 4s (not 3s) because of the measured Windows ConPTY startup-exit delay.
- macOS membership is by controlling tty (`ps tty`) + pre-close snapshot, not `ps sess` (`sess` meaning varies by platform; unverified).
- Client (`web/lib/api.ts` `killTerminal`) unchanged: a non-2xx already surfaces as an error in `TerminalPanel`.

## Review fixes (round 2)

- **H1 session reuse**: `sessionView` in `terminals.ts`. (a) Anchor: if a process with the shell's PID is present with a different start time, the session was reused, so it is treated as empty and the sweep stops for good. (b) Known members (pid+start) are seeded from the shell and the pre-close snapshot. If the shell is already gone, only members whose start ≥ the shell's start are seeded. A newcomer is admitted only if its ppid chain (inside the session) reaches a known member. ppid is parsed from `/proc/<pid>/stat` field 4 and from macOS `ps ppid`. Tests: leader PID reused with a new start, and an orphan newcomer with a foreign parent vs a child of a known member.
- **H2 shutdown budget** (`server.ts close()`): terminal teardown starts first and runs concurrently. On failure it does `console.error` right away and rethrows; the chain awaits it after `processes.disposeAll`. Every step is now bounded: operator channel 0.5s, MCP connects 0.5s, `agentDrivers.stopAll({timeoutMs:1000})` (+1s fence), hooks/compactions/candidates 1s each, `processes.disposeAll` 1.5s, checkpoints 1s, process events 1s, usage‖automations 1s, HTTP close‖MCP disconnect 1s, kernel.stop 1s. Chain worst case is 12.5s, plus 1s slack for owner-lock/sync steps, = 13.5s `SHUTDOWN_DEADLINE_MS`. Terminals (≤4s) overlap the chain. Trade-off: agent stop timeout went from 10s to 1s, so an agent mid-tool at shutdown now hits the persistence fence sooner (existing safe path: ownership retained, error reported).
- **Medium**: `create()` re-checks `disposed` after spawn. If disposed, it tears the new PTY down, disposes listeners and throws `unavailable` without registering. SIGCONT goes after HUP to the shell (via backend) and to snapshot members. `TerminalInfo.state?` is optional, filled by `get`/`list`/`create`/`created` event; the client is unchanged.
- **Low**: a shell exiting before identity capture is documented in `runTeardown` (no anchored sweep, only backend close/HUP/KILL). A natural exit while `failedTeardown` retries immediately.
- Tests: terminal specs 61 pass / 1 skipped (posix, win32); `server.spec.ts` 29/29; `shutdown-safety.spec.ts` 6/6; tsc both configs pass.

## Unresolved

1. Run `bun scripts/pty-probes.mjs --require` on Linux (CI or VM) → go/no-go for the built-in PTY.
2. macOS evidence (RH3-D), or an explicit decision to release Windows/Linux only.
