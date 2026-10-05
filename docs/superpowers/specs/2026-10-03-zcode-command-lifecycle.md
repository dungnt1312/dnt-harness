# ZCode-style command lifecycle

## Decision and reference

Implement ZCode semantics, not the earlier proposal to remove all command limits or transfer child ownership to a parent. Reference checkout: zai-org/ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`.

Reference paths under `apps/zcode-cli/packages/`:
- `core/src/tool/bash-timeout-policy.ts`: default foreground wait 120000 ms; maximum 600000 ms.
- `core/src/tool/handlers/bash-background-policy.ts`: automatic backgrounding excludes empty commands, explicit background requests, and commands whose first whitespace-delimited token is exactly `sleep`.
- `adapters/src/exec/node-execution-adapter-lifecycle.ts:102-285`: single spawn; foreground deadline commits background ownership, removes parent abort listener, and returns handle, rather than killing/restarting the command.
- `core/src/tool/handlers/task-output.ts`: snapshot or bounded wait; watch deadline does not kill execution.
- `core/src/runtime/methods/subagent.ts:398-418`: normal child completion seals notifications without cancelling background commands; explicit cancellation cancels child background tasks.
- `core/src/runtime/helpers/runtime-tools.ts`: subagent background maximum defaults to 3600000 ms.

## Scope

Change agent Bash/process infrastructure in web and headless hosts. Preserve interactive PTY terminal behavior: ZCode integrated terminals and agent Bash are separate surfaces; do not introduce a Bash deadline into PTYs. Retain native tool names Bash, BashOutput, KillShell instead of adopting ZCode's names wholesale.

## Contracts

- Default Bash foreground wait: 120000 ms; maximum request wait: 600000 ms. Keep model argument `timeoutMs`; document eligible-command deadline as auto-background, not kill.
- Explicit `run_in_background: true` returns a session-owned process ID immediately and is not bound to the turn abort after admission.
- Eligible foreground commands run once. If the command finishes before the deadline, return bounded output and exit status. Otherwise transition the SAME execution to background and return `running`, process ID, and instructions to use BashOutput/KillShell.
- Match ZCode's `sleep` eligibility exception: ineligible foreground commands retain deadline termination. Compatibility calls without session/registry cannot return a managed handle and retain bounded foreground termination; explicitly document this exception.
- Foreground Stop kills its process tree. Once background transition is committed, root turn Stop does not implicitly kill background commands. Child cancellation explicitly kills all background commands owned by that child before cancellation is reported complete.
- Normal child completion does not kill or transfer ownership. No process completion may restart a completed child. Existing snapshot UI can inspect and stop a child's process through workspace/session-scoped routes.
- A child background process has a 3600000 ms maximum runtime measured from background commitment, including explicit background. Host configuration may override with a positive finite value. Root background processes do not inherit that child limit.
- BashOutput adds `block?: boolean` (default false) and `timeoutMs?: number` (default 30000, maximum 600000). A bounded wait returns current status/output, including `running`; deadline or caller abort ends the wait, not the background process. Preserve current full bounded snapshot output semantics; incremental cursors are out of scope.
- BashOutput/KillShell remain strictly owner-session scoped, and role/mode/spawn grants still narrow access. Give verifier both lifecycle tools because normal Bash can now auto-background.
- All managed process start/exit records, including children, go to the canonical owning session. Exactly one terminal process record; start precedes exit; child cancellation exit is flushed before the parent child-result becomes durable. Delayed bridge writes must not recreate deleted sessions or leak unhandled rejections.
- Keep output capture caps, process concurrency caps, process-tree stop, shutdown/delete cleanup, and restart-interrupted reporting. No process re-adoption or execution resumption on restart.

## Non-goals

No shell sandbox guarantees, ownership transfer, detached child agents, new terminal UI, PTY redesign, generic TaskOutput tool, output artifact storage redesign, or broad unrelated cleanup.
