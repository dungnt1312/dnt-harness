# Task 4 report: MCP production completion (finish phase 06, continue phase 07)

Status: DONE_WITH_CONCERNS
Branch `dev`, e283844 → f05c610, pushed fast-forward to origin/dev (no force, PR not merged).

## Commits

| SHA | Subject |
|---|---|
| 84e0735 | test(mcp): prove hard resource limits are refused and record the PM2 restart drill |
| d4f100e | feat(mcp): report local fence and remote revocation when a secret or OAuth server is deleted |
| 1f891b9 | fix(mcp): record the carrying runtime's generation and say a fenced in-flight call may have run |
| b0999a5 | fix(mcp): a retired client's list-change refresh no longer calls back into the host |
| 2d1559b | test(mcp): two workspaces share one tool name with separate schemas and runtimes |
| 035f45f | test(mcp): failed, auth-required, audit-fault and stale MCP states read the same after a restart |
| f05c610 | docs(plans): record desired-state reconciliation evidence and phase progress |

## Phase 06 checkboxes

- Windows Job Object (line 83): **left open**. The criterion asks for passing Job Object escape/resource/kill-on-close tests, not a refusal, so "refused, not claimed" does not satisfy it. No helper is packaged and no Windows host was available. The refusal is now tested end to end: `tests/web/server-g5.spec.ts` "hard resource limits are refused, not claimed, on a host without a tested hard primitive; nothing starts". Enable and Test both fail, the row stays disabled, and no process starts (checked with INIT_FILE).
- Linux cgroup v2 (line 84): **left open**. Children are not placed in a cgroup, so there is no cgroup test to pass. The "unavailable hosts reject hard limits" half holds and is covered by the same test.
- PM2 single-fork shutdown/restart (line 87): **ticked**, with the drill evidence below.

### PM2 drill evidence (2026-10-18 23:31, macOS)

- Before the drill: `uptime` load was about 3.0 on 10 cores, `vm_stat` showed memory in normal use, and `pm2 list` showed 10 existing apps. None of them was touched, and all 10 were still online afterwards.
- The throwaway app was `dnt-drill-20261018233115`. It ran `src/bins/web.ts` under bun with its own scratch HOME and `--data-dir`, port 39182 and `--no-auth`. The script is at scratchpad `pm2-drill.sh`.
- pm2 reported `fork_mode`, 1 instance and `kill_timeout` 15000.
- I enabled a stdio fixture server. Child pid 36000 ran under host pid 35961.
- I started a second host on the same data home. It failed with `OwnershipError: data home already has a live owner (epoch 1)`.
- `pm2 restart` took about 1 s. Old host 35961 and child 36000 were both dead. The new host 36036 respawned one child (36068) under itself, and the row came back `ready`.
- `pm2 stop` took under 1 s. Afterwards there was no host, no child, no `mcp-owner.lock` and no leftover fixture process.
- I ran `pm2 delete`, removed the drill's pm2 log files and deleted the scratch dirs.
- Scope: the fixture spawns no grandchildren. On macOS, descendant cleanup stays best effort.
- Incident during the first attempt: setting `HOME` for the pm2 CLI made pm2 start a second God Daemon under the scratch HOME. It failed with a socket path EINVAL and had no apps. I started that daemon, so I stopped it: SIGTERM did nothing and SIGKILL removed it. For the real run I fixed the script to keep `PM2_HOME=~/.pm2`. The user's daemon (pid 1381) was never touched.

## Phase 07 checkboxes (lines 73-82): all ticked

| Line | Item | Proving test |
|---|---|---|
| 74 | Linearization point after acknowledgment | `tests/web/mcp-runtime-reconciliation.spec.ts` "a call in flight keeps its old generation and is reported as possibly run; the first dispatch after the acknowledgment uses the new runtime" |
| 75 | In-flight and remote-revocation limits reported | same test (in-flight note), plus the "MCP secret deletion" describe (secret `remoteRevocation`, OAuth server `revocation: {local, remote}`) |
| 76 | Every config field change reconciles to one generation | "command, env, limits, allowlist, transport, URL and auth changes each retire the old runtime and leave one current generation" (uses an inline HTTP MCP server for transport/URL/auth) |
| 77 | Secret deletion statuses with affected servers | "fences every server that reads the secret and reports the local fence and remote revocation separately", plus `tests/harness/mcp-secret-dependencies.spec.ts` |
| 78 | State survives restart | "failed, auth-required, audit-fault and stale states read the same after the host restarts" (two restarts) |
| 79 | Old callbacks cannot publish | `tests/harness/mcp-client-fixes.spec.ts` "a tools/list_changed refresh in flight when the generation is retired never calls back into the host", plus e2e "list-change refreshes of a fenced, disabled or deleted runtime never republish…" |
| 80 | One global name, two-workspace schema isolation | "one global tool name carries each workspace its own schema, runtime and lifecycle" |
| 82 | Existing contracts green | full suite (below) |

## Behavior changes and TDD evidence

1. **Secret references and delete responses.** New file `src/harness/mcp/secret-dependencies.ts` finds secret references in env, headers, static auth and a managed OAuth `clientSecret`, whether the reference is the whole value or embedded in a longer one. `DELETE /secrets/:n` now returns `{deleted, localFence:'fenced', affectedServers, remoteRevocation:'not_applicable'}`. Deleting a managed OAuth server now returns `revocation`.
   - RED: `reconnected` was `[]` for `Bearer ${TOK}`, because the old code only matched an exact `${TOK}` value. The delete response was also missing the new fields.
   - GREEN: both tests pass.
2. **In-flight calls cut by a fence.** The journal intent now records the generation of the runtime that carries the call, not the counter read at dispatch time. An `indeterminate` call whose runtime was fenced mid-flight now has a note saying it may already have run and was not undone or repeated.
   - RED: the note was absent from the transcript. The generation and indeterminate assertions already passed before the change.
   - GREEN: the test passes.
3. **Retired clients.** `McpServerClient.refreshToolsFromNotification` now does nothing once the client is retired, and skips `onReconnected` if the client was retired while a listing was out.
   - RED: the callback fired 3 times after `retire()` when it should have fired once.
   - GREEN: the test passes.
   - The e2e retired-runtime test passes with or without the server-side `mcpClients` guard. Removing that guard did not make it fail in 3 runs, so the guarantee is proved at the client layer, not by the e2e test.
4. **Characterization tests, no code change:** the hard-limit refusal, the config-field reconciliation, two-workspace isolation and restart survival.
5. **Test fixture options** added to `tests/fixtures/mcp-stdio-server.mjs`: `SIDE_EFFECT_PID`, `QUERY_PROP`, `LIST_FILE`, `LIST_DELAY_MS` and `LIST_CHANGED_EVERY_MS`. All are opt-in and existing behavior is unchanged.

## Verification

- `bun run typecheck`: clean.
- `bun run test -- --maxWorkers=3` on Node 24.15.0 (preflight OK): 371 files passed and 1 skipped; 5114 tests passed and 3 skipped; 175.7 s. No failures, so there were no load flakes to separate.
- Focused runs while iterating: server-g5, mcp-lifecycle-fixes, mcp-oauth-connect, mcp-desired-state, mcp-integration-review, mcp-production-stack, web settings components, mcp-client-fixes, mcp-transport-limits, g5-mcp and mcp-resilience. All green.

## Files changed

- `src/harness/mcp/secret-dependencies.ts` (new)
- `src/harness/mcp/client.ts`
- `src/web/server.ts`
- `web/lib/api.ts` (typed `SecretDeleted` and `McpServerDeleted` responses)
- `tests/web/mcp-runtime-reconciliation.spec.ts` (new, 7 tests)
- `tests/harness/mcp-secret-dependencies.spec.ts` (new)
- `tests/harness/mcp-client-fixes.spec.ts`
- `tests/web/server-g5.spec.ts`
- `tests/fixtures/mcp-stdio-server.mjs`
- `plans/260922-1139-mcp-production-completion/{plan.md, phase-06-…, phase-07-…}`

## Concerns

- Phase 07 implementation step 1, a dedicated `McpRuntimeSupervisor` module that owns lifecycle, was not done. Lifecycle, fencing and publication still live in `src/web/server.ts`. The criteria are met with the existing generation counters and the per-workspace mutation queue. The phase file and the plan table say "Criteria met; supervisor extraction open".
- After a restart, failed and auth-required rows are rebuilt by the reopen connect attempt from durable config, secrets and OAuth state. They are not read from a persisted status record. This is documented in the checkbox text.
- Phase 06 Windows Job Object and Linux cgroup v2 stay open. They need a real helper or cgroup integration and test hosts.
- The PM2 drill covered macOS only, and a direct child only (no grandchildren).
