# Final-review fix wave — report

Branch `fix/context-accounting` (worktree `.worktrees/context-accounting`), commit `fe9b987` on top of `f542ed6`.

## Changes
- `src/web/server.ts`
  - #1 `previewCompaction` scope now spreads `...roleIdentityOf(entry.session)`, matching `reconstructFromLog` and the real agent.
  - #4a `contextRevision`: `systemPrompts.load` / `readWorkspaceInstructions` no longer `.catch` to `undefined`/`''`; a read error throws, so `measureCheckpoint` fails as a measurement failure (legacy: `preview-failed`; effective: `compaction fit not verified`). Unchanged hash when reads succeed.
  - #4b workspace instructions are read/hashed only when `mode.definition.sources.workspaceInstructions` is on (mirrors the builder).
  - #3 removed: `resolveContextLimit` import; `recordUsage` (no callers); `sessionUsage` map, its stale-`last` reset in the builder, `HandlerDeps.sessionUsage` field + deps wiring, the two `forgetSessionState` deletes, `SessionUsage` interface (nothing wrote to it, no test read it); `_standing`/`_loaded` params of `measureCheckpoint` and call-site args (host `measure` callback keeps its 3-arg signature, ignoring `_standing`).
- `tests/web/server-automations.spec.ts` — role root (automation `agent: 'explorer'`, `full-access`) compacts; asserts `compaction/end.contextAfter.sources.child.definition === 'explorer'` and toolNames = Glob/Grep/Read.
- `tests/web/server-compaction-effective.spec.ts` — (a) effective+legacy: system-prompt override set, `SystemPromptsStore.load` rejects once → not `context revision changed` (effective 409 `compaction fit not verified`; legacy 200 `preview-failed`). (b) effective+legacy: custom mode `workspaceInstructions: false`, CLAUDE.md edited during deferred preview → 200, no error.
- `docs/web.md` — line ~29 paragraph now describes post-compaction / unavailable `/manifest` views; route table row documents `/manifest` union (request / post-compaction / unavailable / 204) and `/compact` fields (`tokensBefore`, `tokensAfter`, `measurement`, `path`: exact|reconstructed|recovery|legacy) and 409 causes.
- `docs/capabilities.md` ~407 — DescribeImage fallback text only names the tool when the request carries it.

## RED evidence (before the server.ts fix)
- #1: `expected undefined to be 'explorer'` (contextAfter had no role).
- #4a: both variants `expected 'context revision changed' not to match /context revision changed/` (needs an override present; without one the swallowed read hashes the same as "no override").
- #4b: both variants `expected 409 to be 200`.

## Verification
- Targeted (7 listed specs + server-automations, `--maxWorkers=1 --no-file-parallelism`): 8 files, 169 tests passed.
- `pnpm run typecheck`: pass.
- `pnpm test`: 343 files / 4414 passed, 2 skipped; only the 3 known CSS.escape unhandled errors (git-panel-split ×2, git-panel-entries ×1).
  - First full run had 3 failures: my new automations assertion (409 — compacted before the run went idle; fixed by waiting for `idle`), `server-g5` MCP isolation and `project-git-ops` Pull (10s timeout) — the latter two passed 3/3 in isolation and in the second full run (load flakes, untouched code).

## Unresolved
- None blocking. `progress.md` under plans/ left uncommitted as instructed.
