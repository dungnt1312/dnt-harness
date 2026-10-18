# Task 1 report: merge unmerged feature branches into dev

Status: DONE_WITH_CONCERNS

Start: `dev` at 7464e6e (clean). End: `dev` at 4225f6a. Nothing was pushed, and no branch or worktree was deleted.

## Commits created on dev (first-parent)

| SHA | Subject |
|---|---|
| 84cead7 | Merge branch 'fix/ctx-meter-a11y' into dev |
| 405c91e | Merge branch 'feat/session-load-perf' into dev |
| 32e8bb2 | Merge branch 'feat/speech-to-text' into dev |
| 2a0e4fe | Merge branch 'feat/subagent-resume-background' into dev |
| 39ef3b4 | fix(web): keep child resume records in the delegation stream view |
| eeaa7c0 | Merge branch 'feat/app-config-slice' into dev |
| 4225f6a | fix(web): settle the dictation settings lookup even when it throws |

On `feat/app-config-slice` (worktree `.worktrees/core-config`): b2e7118 `docs(config): mark plan steps done and count all 18 limit fields`.

Every commit message ends with the `Co-Authored-By` trailer. Each of the five branches now shows `git rev-list --count dev..<branch>` = 0.

## Per branch

### fix/ctx-meter-a11y (1 commit): merged, no conflicts
This is a finished change and includes tests. It adds an aria label for the context meter while loading or failed, shows the live manifest with a `display: request`, and makes wording and BashOutput description fixes.

### feat/session-load-perf (1 commit): merged, conflicts resolved
Dev had already shipped its own version of most of this branch in 0f2873d ("cache recent conversations and resume their stream by cursor"). That version covers the cached conversations, the cursor resume, the `reviving` EventSource and the identity-based derivation gates.
- **Kept dev's version:** `web/hooks/useSessionStream.ts` (cache and cursor), `web/lib/api.ts` (`reviving` source, `(envelope, cursor)` callback), `web/lib/session-derived.ts` and its spec, `web/components/chat/Transcript.tsx`, and `web/lib/types.ts`. The branch's `Envelope.cursor` field was not taken.
- **Dropped as superseded:** the branch's `web/lib/session-stream-cache.ts` and its spec.
- **Re-applied the branch's unique intent, the delegation-only stream view:**
  - The server applies `?view=delegations` (`src/web/replay-view.ts`) to the replay, the live frames and the held compaction frames when they are released. A new `streamSessionFrame` helper does this inside dev's compaction hold logic.
  - On the client, `subscribeEventsIn(..., cursor, { delegationsOnly })` builds the query, `useSessionStream(ws, id, delegationsOnly)` includes the flag in its cache scope, and `App.tsx` opts the subagents root stream in.
- **Tests:** the branch's two batch tests were adapted to dev's cursor argument. I added a URL assertion in `web/lib/api-stream.spec.ts`. The branch's server test and its docs/profiling script were kept.

### feat/speech-to-text (1 commit): merged, conflicts resolved
The branch's single commit also carried two unrelated changes that dev already ships in its own form: a mobile SSE reconnect (`resilientSource`, 3 s hide) and an MCP warm-up when a workspace opens. I kept dev's `reviving` source (30 s) and dev's warm-up, and dropped the branch's versions.
- **Taken:** provider `kinds` and `servesKind`/`parseKinds` (combined with dev's `compatibility` and `rawCompatibility` in `parseProviderEntries`), the transcription proxy, the speech-to-text pair route, the Voice settings panel, and composer dictation. The STT client calls were added to dev's `api.ts`.

### feat/subagent-resume-background (6 commits): merged, conflicts resolved
- **`definition-service.ts`:** enforces both dev's `effort` and the branch's `background`, and removes both from the unsupported keys.
- **`executor.ts`, boot recovery:** keeps dev's streamed per-parent `readCanonicalEvents` grouping. It re-applies the branch's owed-background-report restoration and judges each child by its current run (`currentRun` slice) instead of the removed `latestChildResult`.
- **`server.ts` `queueHostInput`:** keeps dev's post-barrier re-read of pending inputs. That re-read already carries `origin: 'child'`, so the branch's extra `enqueueAccepted` is not needed.
- **Integration fix (39ef3b4):** the delegation-only view now also carries `agent/child-resume`. The subagent rows, the Workbench count and the projector read it, and without the fix a resumed child would stay shown as finished.

### feat/app-config-slice (20 commits + 1 doc commit, 302 behind): merged, heavy conflicts
- **Doc edits in the worktree:** these were finished corrections (40 plan checkboxes ticked, and the limit count changed from 17 to 18 to match the branch's own `LIMIT_FIELDS` test). I committed them on the branch before merging, as b2e7118.
- **Semantic integration.** Dev's `HarnessLimits` had changed under the branch:
  - `compactionTailTurns` became `compactionRetainTokens`.
  - New fields: `readOnlyToolConcurrency`, the compaction deadline, output, candidate-wait and precompute-pressure fields, and two boolean rollout switches.
  - Dev's web bin passed `WEB_BIN_LIMITS` as explicit `limits`, which under the branch's model would lock those fields.

  How I resolved it:
  - **Validation:** a single `isValidLimit(key, value)` now covers every key. It accepts booleans for the switches, a fraction in (0, 1] for `compactionPrecomputePressure`, and dev's integer and zero-capable sets, which now include `approvalExpiryMs` (0 = wait forever).
  - **What the file can edit:** `LimitKey` is the 23 numeric keys only, and `LIMIT_FIELDS` gained metadata for the new fields, including a new `tokens` unit. The rollout switches are host options only: the file refuses them, and the service layers carry them from the host and explicit options.
  - **Web host profile:** `WEB_LIMIT_DEFAULTS` holds dev's web-bin profile (pressure 0.85, `compactionEffectiveEnabled: true`, `approvalExpiryMs: 0`). The bin passes it as `limitDefaults`, so nothing is locked. `web-limits.ts` re-exports it as `WEB_BIN_LIMITS`.
  - **Approval expiry:** a live `expiryMsOf() === 0` waits forever like the static 0. A new test covers it.
  - **`server.ts`:** dev's structure plus the branch's `BootScope` failed-boot cleanup, which now also disposes `providerRegistrations`. Every `limits.*` / `deps.limits.*` consumer that dev added now reads the live snapshot at its own boundary. The compaction host and precompute get a getter-backed `compactionLimits`. The assembly captures `assemblyLimits` once.
  - **`agent.ts`:** the read-only concurrency now comes from `readLimits(ctx)`.
  - **`headless.ts`:** rebuilt from dev's version (provider store, flags, guard) plus the branch's app-config boot before the lock, live limits for Bash and approvals, the guarded startup scope, and `AggregateError` reporting.
  - **`bash.ts`:** dev's longer description plus the branch's live schema and per-execution budget.
  - **Settings UI:** dev's sections, sub-tabs and `UnsavedChangesContext`, plus an Advanced tab under Global with its own guard. Leave titles name the one draft at stake (provider, advanced) or fall back to "Discard unsaved changes?". External section requests go through the guard.
  - **Docs:** `docs/harness.md` and `docs/web.md` now describe 23 editable limits, the host-only switches, the web profile and the capture table for the new fields.
- **Test updates for dev's model:**
  - `limits-config`, `app-config-service` (new switch-layering test), the runtime spec (dev's checkpoint path `compaction/`, retained tokens), and the advanced panel and Settings specs (new labels and counts).
  - The approval spec now uses `expiresAt?: number`.
  - The headless app-config test now passes `--config`; see the concerns.

### Integration fix after all merges (4225f6a)
`useDictation` called `getSpeechToTextSettings()` synchronously inside a Promise executor. A mocked api that threw there, in `product-ui.spec`, produced an unhandled rejection that failed the full run. The lookup now starts inside a `.then`, so any failure settles to "mic hidden".

## Verification (on final dev, 4225f6a)
- `bun run typecheck`: pass. Running it first needed `bun install --frozen-lockfile`, because `bun-pty@0.5.1` from the lockfile was missing locally.
- `bun run test -- --maxWorkers=3`: pass, exit 0. 369 files passed and 1 was skipped; 5103 tests passed and 3 were skipped. No flakes were seen in the final run. The earlier run's only failure was the dictation unhandled rejection, fixed above.
- `bun run build:web`: pass. The only output was the existing chunk-size warning.
- Node 24.15.0 is first on PATH, and `preflight:node` reports OK.

## Concerns
1. **The branch's headless test may have sent a real request to your configured provider.** Before the fix, the new app-config test in `tests/bins/headless.spec.ts` ran the CLI without `--config`, so on dev it read the real `~/.dnt-harness/providers.json`. One run exited 0 without reaching the fake server, which means a "hello" message was probably sent once to whatever provider/model is your default there, using your key. The test now passes `--config <tmp>`.
2. **stt-only provider can become the chat default.** `repairDefaults` / `preferredDefaults` in `provider-store.ts` do not filter by `servesKind('chat')`, so an stt-only provider could become the global chat default. This gap was already on the branch and was not changed here.
3. **Image/video tools keep the startup attachment cap.** The image and video generation tools capture `maxAttachmentBytes` when they register, so an edited value applies to uploads but not to those tools. This is documented in `docs/harness.md`.
4. **Rollout switches not editable.** The rollout switches (`compactionEffectiveEnabled`, `compactionPrecomputeEnabled`) cannot be edited in Advanced settings. That was a deliberate choice, because they are boot-shaped host options.
5. **Playwright e2e not run.** `tests/browser/chat-workflows.e2e.ts` (Playwright) asserts the branch's leave-dialog titles. It is not part of `bun run test` and was not run.
6. **Two existing worktrees are behind dev.** `.worktrees/session-load-baseline` (detached) and the other feature worktrees were left untouched. Nothing was deleted.

## Files changed (beyond the branch content)
Resolution and integration edits:
- `src/web/server.ts`, `src/web/replay-view.ts`
- `src/harness/limits.ts`, `src/harness/limits-config.ts`
- `src/harness/config/service.ts`, `src/harness/config/types.ts`
- `src/harness/approval/policy.ts`, `src/harness/agent/agent.ts`, `src/harness/agents/executor.ts`, `src/harness/agents/definition-service.ts`
- `src/capabilities/shell/bash.ts`
- `src/bins/headless.ts`, `src/bins/web.ts`, `src/bins/web-limits.ts`
- `src/web/provider-store.ts`
- `web/lib/api.ts`, `web/hooks/useSessionStream.ts`
- `web/components/settings/SettingsModal.tsx`, `web/components/settings/AdvancedPanel.tsx`
- `web/components/composer/useDictation.ts`
- `docs/harness.md`, `docs/web.md`

Test edits:
- `tests/harness/limits-config.spec.ts`, `tests/harness/app-config-service.spec.ts`, `tests/harness/g1-approval.spec.ts`
- `tests/web/server-app-config-runtime.spec.ts`, `tests/web/replay-view.spec.ts`
- `tests/bins/headless.spec.ts`
- `web/components/settings/advanced-panel.spec.tsx`, `web/components/settings/settings-panels.spec.tsx`, `web/components/ui/ui.spec.tsx`
- `web/hooks/useSessionStream.batch.spec.tsx`, `web/lib/api-stream.spec.ts`

## Fix round 1

### 1. Removed the AI attribution trailer (history rewrite, trees unchanged)
- Checked first: the parent of b2e7118 was 46358aa (the original branch tip). Both worktrees were clean, apart from the untracked `plans/` directory, which belongs to the user.
- One rewrite covered both branches:
  `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --msg-filter "sed '/^Co-Authored-By: Claude/d'" -- 7464e6e..dev 46358aa..feat/app-config-slice`
- The output reported "Ref 'refs/heads/dev' was rewritten" and "Ref 'refs/heads/feat/app-config-slice' was rewritten". The original feature-branch commits kept their SHAs, because their messages did not change.
- Checks after the rewrite:
  - `git diff 4225f6a dev` printed 0 lines, and so did `git diff b2e7118 feat/app-config-slice`. The trees are identical.
  - `git log --format=%B 7464e6e..dev 46358aa..feat/app-config-slice | grep -ci claude` returned 0.
  - `git rev-list --count dev..<branch>` is 0 for all five branches.
  - The app-config merge 641c0d6 now has parents 78f83fb and e6f1418, and e6f1418 is the rewritten `feat/app-config-slice` tip.
- I deleted `refs/original/refs/heads/{dev,feat/app-config-slice}` with `git update-ref -d`. No `refs/original` remains.
- `.worktrees/core-config` now has e6f1418 checked out, and `git status` is clean. Its index and working tree already match, because the tree did not change.
- Old-to-new SHA mapping:

  | Old | New | Commit |
  |---|---|---|
  | 84cead7 | 37fcfe0 | Merge fix/ctx-meter-a11y |
  | 405c91e | dc8d349 | Merge feat/session-load-perf |
  | 32e8bb2 | 54ae25d | Merge feat/speech-to-text |
  | 2a0e4fe | b69c443 | Merge feat/subagent-resume-background |
  | 39ef3b4 | 78f83fb | fix(web) delegation view |
  | b2e7118 | e6f1418 | docs(config), on feat/app-config-slice |
  | eeaa7c0 | 641c0d6 | Merge feat/app-config-slice |
  | 4225f6a | d8567bc | fix(web) dictation |

### 2. Made the session-load spec hermetic
- `tests/web/session-load-performance.spec.ts` now starts the server with `configFile` pointing into a fresh `mkdtemp` directory, which it removes in `finally`.
- Ran `bunx vitest run tests/web/session-load-performance.spec.ts`: 1 test passed. `tsc -p tsconfig.json` also passed.
- Committed as 1cc381c `test(web): keep the session load spec off the real provider store`, with no trailer.

Nothing was pushed.
