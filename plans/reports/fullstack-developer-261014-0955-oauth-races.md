# OAuth race fixes — 2026-10-14

Status: implemented; affected tests pass, repository-wide verification blocked by unrelated concurrent worktree changes.

## Changes

- `src/harness/mcp/oauth-store.ts`: durable server incarnation, per-server publication queue, combined encrypted grant file published by one rename (tokens + discovery record), legacy pre-incarnation fixture detection.
- `src/harness/mcp/oauth.ts`: transaction incarnation and completion expiry checks, post-exchange config validation and fenced atomic grant publication; revoke invalidates pending incarnations.
- `src/web/mcp-oauth-connect.ts`: bind transactions to managed OAuth config; fail closed on missing new-grant metadata while retaining pre-incarnation fixture tokens.
- `src/web/server.ts`: re-read shared file before edits; changed **only OAuth import/construction, MCP config mutation serialization for OAuth identity, and DELETE invalidation**. Parent's plugin sync and unrelated session-list changes were not touched. Config mutation invalidates identity under the publication lock. HTTP route shapes and request/response API were unchanged.
- `tests/harness/mcp-oauth.spec.ts`, `tests/web/mcp-oauth-races.spec.ts`: expiry after deposit, revoke before completion, config changes while exchange is blocked, delete/recreate same URL, config change/revert, interrupted publication.

## Verification

- RED confirmed expiry and revoke regressions (2 failed before implementation); config change/revert failed before its invalidation fix.
- GREEN: 62/62 tests across five affected OAuth/integration suites. `pnpm exec tsc --noEmit -p tsconfig.json` passes.
- `pnpm run typecheck` fails only in unrelated concurrent `web/hooks/useWorkbenchFiles.spec.ts` (`closeFileWithDraft` export missing and implicit-any callback). `pnpm test` had unrelated flaky `tests/web/server-g1.spec.ts` queued-steer case; isolated rerun passed. No source or tests outside the ownership list were edited.

## Compatibility / unresolved

- Existing pre-incarnation fixture grants without discovery metadata remain eligible only before an epoch file has been created and when token resource matches current URL. A no-record grant that previously worked outside that legacy condition must reconnect.
- Atomic file replacement is process-local serialized; externally editing `mcp.json` or running multiple hosts against one data directory is outside the managed config-mutation contract.
