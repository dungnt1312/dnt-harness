# Web host server split — design

- Date: 2026-10-13
- Status: awaiting review
- Scope: `src/web/server.ts` (≈10,050 lines) → modular layout under `src/web/server/`
- Driver: maintainability; **behavior must stay 100% identical**

## Problem

`src/web/server.ts` is a single ≈10k-line file holding three distinct bodies of
work plus shared plumbing:

1. **Composition root** — `createWebServer()` (≈3,500 lines): kernel boot,
   workspace/mode/skill/memory services, MCP host wiring, provider registry,
   automations runtime, and the ≈100-field `deps` object.
2. **Router** — `handle()` + `handleApi()` (≈3,300 lines): one if-chain with
   31 commented route sections across every product domain.
3. **Domain helpers** (≈2,300 lines): git-panel actions, session operations,
   workspace helpers, provider helpers, shared HTTP/SSE/static helpers.

Everything already flows through one contract — the `HandlerDeps` interface —
and module-level helpers already take `(req, deps)` style parameters, so the
seams exist; the file is just too large to read, diff, or edit reliably.

## Goals

- Split `server.ts` into focused modules under `src/web/server/`, grouped by
  domain (user decision: **deep split, done in one pass**).
- **Zero behavior change.** No route match changes, no status-code changes, no
  logic edits, no timing changes, no config/defaults changes.
- Public API of `src/web/server.ts` unchanged: `createWebServer`, `WebServer`,
  `WebServerOptions`, `WebEnvelope`, `PublicProvider`, `TerminalEnvelope`,
  `TerminalSnapshot`, `extractModelIds` keep their exact names and import path.
- The 78 specs in `tests/web/` plus `tests/browser/control-plane-auth.e2e.ts`
  pass **unmodified** — they are the behavior-preservation oracle.

## Non-goals

- No router registry / pattern-matching redesign (rejected as Option B).
- No splitting of the `HandlerDeps` interface into per-domain sub-interfaces.
- No renaming of any symbol, route, event, or file format.
- No changes to `web/` (frontend) — it does not import from `server.ts`.
- No test additions for the split itself (existing suite is the oracle).

## Constraints & mechanical-extraction rules

These rules are what make "100% identical behavior" verifiable by review:

1. **Move-only edits.** A moved block's body stays byte-identical except:
   new import lines, and new parameters that bind the *same identifier names*
   the block already referenced as captured closure variables.
2. **Rename nothing** — no identifier, string literal, comment, or key changes
   inside moved code.
3. **Route dispatch order preserved verbatim.** `handleApi`'s if-chain order
   is behavior (prefix overlaps exist, e.g. `/api/automations/preview` before
   workspace-scoped automations; legacy unscoped routes after scoped ones).
   Each extracted route module exports a predicate handler
   `(req, res, pathname, query, deps, send, fail) => Promise<boolean>`
   returning `true` when it matched **and** responded, exactly mirroring its
   current `if` predicate and fallthrough. `handleApi` keeps the same chain,
   one call per current section, same order.
4. **Late binding stays late.** Where closures today read state through
   `depsRef.current` or similar thunks (e.g. `ChildExecutor` inbox drain), the
   extracted factory keeps the same thunk; no eager capture.
5. Closures extracted from `createWebServer` become factory functions
   (`createXHost(inputs) → { …closures, …state }`) whose parameter names equal
   the captured variable names (`kernel`, `workspaces`, `sessions`, …), so
   bodies stay untouched.
6. Module-scope mutable singletons that are route-domain state keep their
   semantics: `promptPrincipals` (askpass principals) moves with the git/auth
   code that owns it; nothing that is per-`createWebServer`-call becomes
   module-scope, and vice versa.

## Target layout

`server.ts` remains the public entry (re-exports public types), so
`src/index.ts`, `src/bins/web.ts`, and all tests keep importing unchanged.

```
src/web/
  server.ts                      ≈1,200–1,500 lines: createWebServer() as pure
                                 composition — service construction, factory
                                 calls, deps assembly, listen + teardown
  server/
    types.ts                     public types: WebEnvelope, WebServerOptions,
                                 WebServer, PublicProvider, TerminalEnvelope,
                                 TerminalSnapshot (server.ts re-exports)
    handler-deps.ts              HandlerDeps, SessionEntry, PendingApproval,
                                 PendingQuestion, WorkspaceControls,
                                 ModelPairName + constants they own
    envelope.ts                  questionEnvelope, approvalEnvelope,
                                 effectivePolicy, toolRequiresInteraction,
                                 sendModeError, publicProvider,
                                 MODEL_PAIR_NAMES/ROUTES
    http/
      entry.ts                   handle() (host gate → auth gate → /api →
                                 static) — the request entrypoint
      guards.ts                  crossSiteWrite, requestHostname,
                                 browserPrincipal, promptPrincipals
      body-io.ts                 readJson, readBytes, MAX_BODY_BYTES,
                                 CONTENT_TYPES, isRecord
      sse.ts                     writeFrame, compactReplayEvents, streamEvents,
                                 streamTerminals, terminalDimension,
                                 resolveTerminalCwd
      static-assets.ts           serveStatic, serveProjectMedia,
                                 serveStoredVideo, brandShell, brandManifest,
                                 manifestWithHost, installLabel,
                                 IMMUTABLE_ASSET_PATH
    auth.ts                      handleAuth, handleOAuthDeposit
    routes/
      index.ts                   handleApi(): the if-chain, one call per
                                 section in current dispatch order; send/fail
                                 constructors stay here
      01 workspaces.ts           §workspaces
      02 sessions.ts             §workspace-scoped sessions (largest: create/
                                 SSE events/inputs/steer), §legacy unscoped
                                 session routes
      03 processes.ts            §background processes of one session
      04 delegation.ts           §G4 agent definitions + delegation
      05 mcp.ts                  §G5 MCP/hook management (+ McpRevisionConflict)
      06 legacy-grants.ts        §legacy folder grant, §legacy meta/model/thinking
      07 models.ts               §global provider/model defaults, §per-session
                                 model control, §global subagent model aliases,
                                 §provider registry, /api/usage,
                                 putModel/putThinking/putModelDefaults
      08 automations.ts          §automations → handleAutomations (moves ~verbatim)
      09 push.ts                 handlePush (moves verbatim)
      10 channels.ts             handleChannels (moves verbatim)
      11 modes.ts                §G3 live mode control, §mode authoring,
                                 §root-owned live mode, §workspace-scoped
                                 controls
      12 skills.ts               §G3 skills (+ skillLayers,
                                 skillLayersForQuery, workspaceSaveWarnings)
      13 plugins.ts              §Claude Code plugins + §plugins/marketplaces
      14 memory.ts               §G3 memory
      15 context.ts              §context manifest inspector + compaction
                                 (compactionRequestOf, compactionAnswerFor)
      16 projects.ts             §projects, §sidebar project order
      17 attachments.ts          §composer attachments, §generated videos
                                 (serveStoredVideo caller), parseAttachments
      18 terminals.ts            §interactive terminals
      19 git.ts                  §Git panel actions + askpass (gitFlag,
                                 gitText, parseGitOperation,
                                 handleProjectGitAction, GIT_OPERATIONS,
                                 GIT_QUERIES)
      20 project-files.ts        §project browsing/explorer writes,
                                 §filesystem browser (folder picker),
                                 handleProjectFileWrite
      21 system-prompts.ts       §system prompt overrides
      22 guard.ts                §dangerous command guard
    session-ops.ts               createRootSession, submitMessage,
                                 acceptMessage, amendQueuedInput, steerSession,
                                 dispatchInbox, queueHookRewake, patchSession,
                                 renameSession, findSession, listSessions,
                                 forgetSessionState, roleIdentityOf,
                                 boundProject, reconcileInterruptedProcesses,
                                 recordUsage, requireWorkspace,
                                 implicitWorkspace, defaultWorkspaceId,
                                 workspaceMeta
    providers.ts                 provider helpers: createProvider,
                                 patchProvider, sanitizeModelSettings,
                                 authHeaders, fetchEndpointModels,
                                 pingCompletions, extractModelIds,
                                 parseModelAliasInput, modelAliasRow
    host/
      mcp-host.ts                MCP wiring block (mcpStore…connectWorkspaceMcp:
                                 ensureMcpServer, reconcileMcpTools,
                                 cancelMcpConnection, journalFor,
                                 fenceWorkspace, serializeMcpMutation,
                                 writeDesiredState, updateMcpConfig/Secrets,
                                 fileDigest, observeConfig, acknowledgeDrift,
                                 resolveMcpAuth, testMcpServer,
                               connectWorkspaceMcp + mcp* state maps)
      provider-registry.ts       provider registry block: list/aliases/defaults
                                 state, instantiate, injectionNames,
                                 usableIds, repairGlobalDefaults,
                                 syncRegistrations, mutateProviderStore,
                                 pairOf/setModelPair model pairs
      compaction-runtime.ts      compactions map, runCompaction,
                                 cancelCompaction, runPreCompactHooks,
                                 manifestTurns, automaticBoundaries
      automations-runtime.ts     AutomationStore/PushService/NotifyChannels
                                 construction, scheduler, runAutomation,
                                 settleStaleRuns, notifyRun, onWaiting,
                                 pinRole, runStillLive, runUrl
      session-authority.ts       hostAuthority, exposureDenial,
                                 scopeWarningOf, currentOutsideRequirement,
                                 executionAuthority wiring, approvalReceipts
      agent-context.ts           environmentBlockFor, readWorkspaceInstructions,
                                 cachedGitBranch, scopedSession, modelCatalog
      grants-wiring.ts           protected roots + session grants: 
                                 refreshSkillProtectedRoots,
                                 addSkillProtectedRoots, sessionGrants,
                                 effectiveGrants, intersectGrants, scopeGrants,
                                 mutateSessionGrants, grantQueues,
                                 staticProtectedRoots
      claude-hooks-wiring.ts     PreToolUse/PostToolUse hooks block:
                                 hookToolContext, hookAskCalls, hookAskKey,
                                 writesHookConfig, stopTurnForHook,
                                 stopHookContinuations, hookHost,
                                 backgroundHooks, runInlineShell wiring
      mode-resolution.ts         modeOf, turnTerminal, rootModeOf,
                                 adoptMode, stampRootMode, executingMode,
                                 childRootSession, controlsFor,
                                 seedWorkspaceControls, resolveEffectiveModel,
                                 summarizerModelOf, childModelFor
    shared.ts                    anything cross-domain after the move (expect
                                 this to stay small or empty; delete if empty)
```

Line counts are estimates from the current file; the mapping is anchored by
**symbol names**, never line numbers — parallel work is shifting line numbers
daily. If a symbol is missing from this table at implementation time, its
destination is decided by the section comment it sits under; genuinely shared
symbols go to `shared.ts`.

## Execution preconditions (hard)

- User says "code" (other agents are running in parallel today).
- `src/web/server.ts` is **clean in git** at refactor start: any in-flight
  work (e.g. the current MCP production-stack changes) is committed first.
- No other agent edits `src/web/server.ts` while the split is in flight.
  Branch: `refactor/web-server-split` off a fresh `main`.

## Verification protocol

Per move group, and at the end:

1. `pnpm run typecheck`
2. `pnpm test` (full suite; `tests/web/**` is the behavior oracle —
   **no test file may be edited** in this refactor)
3. `git diff --stat` per move-group commit: it must only delete from
   `server.ts` the lines that now live in the new file(s) and add those same
   lines under `src/web/server/` (spot-check 2–3 moved blocks read identical)
4. Final: `git diff main --stat` shows only `src/web/server.ts` shrinking,
   new files under `src/web/server/`, and the docs; nothing else

`pnpm run build:web` is not needed (frontend untouched) unless `web/`
imports change, which the design forbids.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Parallel agents edit `server.ts` mid-refactor | Hard preconditions above; single implementer; short-lived branch |
| Closure extraction changes capture timing | Rule 4/5: same names, thunks stay thunks |
| Route order drift | Rule 3: numbered route files mirror dispatch order; `handleApi` keeps one call per section in order |
| Module-scope state accidentally shared across server instances | Rule 6: per-call state lives in factories; module scope only for true singletons (`promptPrincipals`) |
| Merge conflict with `main` at the end | Rebase frequently while other agents land work; the branch only moves code |

## Follow-ups (explicitly out of scope)

- Sub-interfacing `HandlerDeps` per domain.
- Router registry (Option B) if the if-chain ever hurts again.
- Deleting legacy unscoped routes (now isolated in `routes/06 legacy-grants.ts`
  and part of `02 sessions.ts`).

## Open questions

None — commit granularity inside the branch (one commit per move group vs.
one squashed move) is left to the implementation plan; default: one commit
per move group so review can diff group by group.
