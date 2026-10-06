# Global Configuration & Advanced Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose existing limits through component-owned configuration, global sparse persistence and operation-safe hot application, with Advanced Settings as its thin client.

**Architecture:** Limits owns validation/defaults/form metadata. A host-independent coordinator serializes durable edits and reloads and publishes immutable snapshots through a stable reader. Web/headless capture policies at existing operation boundaries; Settings sends only changed-field edits. No service replacement or file watcher.

**Tech Stack:** TypeScript ESM, Node >=22.19.0, Vitest, React/Radix, existing atomic storage and REST/CSRF seams; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-06-core-stabilization-configuration-contract.md`.

## Global Constraints

- “Expose only existing configurable behavior; do not introduce subagent caps or new execution limits.”
- “Configuration is global, shared across workspaces, with a sectioned file that can hold more than limits later.”
- Global `<dataHome>/app-config.json`; provider `configFile` retains its meaning.
- API edits and explicit reload use one pipeline; watcher is deferred.
- Preserve defaults, legacy helper behavior, supported value domain, existing retry clamps, session authority and turn-pinned instruction semantics.
- No generic rollback, plugin-loader/schema registration platform, resource reconfigure migration or broad server rewrite.
- Keep static legacy `ctx.get('limits')` shape; introduce a distinct reader. No new third-party dependency.
- Execute after kernel plan operationally, but depend only on public context/service seams. Never stage unrelated working-tree changes.

## Review Focus

1. Sparse edits/reset must not pin unrelated defaults or alter locked fields — Tasks 1–3/7.
2. Manual invalid/new-version files and I/O errors must preserve active values and remain diagnosable — Tasks 2–3/6.
3. Save versus reload races and notification failures must not create stale/mixed publication — Task 3.
4. Operation A started before update and operation B after update must retain their own policies, including caches — Tasks 4–5.
5. UI close/tab switch/conflict/late responses must not lose an unsaved draft unexpectedly — Task 7.

## File Map

- `src/harness/limits.ts`: existing value shape/helper plus shared field predicate.
- New `src/harness/limits-config.ts`: limits-owned strict parsing, defaults metadata and editor definitions.
- New `src/harness/config/types.ts`, `store.ts`, `service.ts`: document/wire-independent contracts, atomic durable store, serialized coordinator.
- New `src/harness/config/limits-reader.ts`: snapshot seam and legacy fallback.
- `src/harness/agent/agent.ts`, `tools/service.ts`, `tools/types.ts`, `approval/policy.ts`: boundary capture and trusted execution metadata.
- `src/capabilities/shell/bash.ts`, `src/harness/attachments/store.ts`: compatible per-operation seams and cache correctness.
- `src/web/server.ts`, both bins, `src/index.ts`: host composition and existing consumer migration.
- New `src/web/app-config-api.ts`: focused route adaptation; global auth stays in server.
- `web/lib/api.ts`, new `web/components/settings/AdvancedPanel.tsx`, `SettingsModal.tsx`: transport and UI.
- New focused tests identified by each task; existing tests retained as regression coverage.

## Frozen Interfaces

Task 1 owns these exports; use the same names downstream:

```ts
// limits-config.ts
export type LimitKey = keyof HarnessLimits
export interface LimitField {
  readonly key: LimitKey; readonly label: string; readonly hint: string
  readonly group: 'requests' | 'tools' | 'context' | 'admission'
  readonly unit: 'ms' | 'bytes' | 'chars' | 'count' | 'ratio'
  readonly integer: boolean; readonly minimum: number; readonly exclusiveMinimum: boolean; readonly maximum: number
  readonly applies: 'next-operation'
}
export const LIMIT_FIELDS: readonly LimitField[]
export const WEB_LIMIT_DEFAULTS: Readonly<Partial<HarnessLimits>> // pressure 0.85 only
export function parseLimitOverrides(input: unknown): Partial<HarnessLimits>
// limits.ts: shared accepted-value predicate; resolveLimits keeps old fallback
export function isValidLimit(key: keyof HarnessLimits, value: unknown): value is number
```

Tasks 2–3 own infrastructure:

```ts
// types.ts
export interface AppConfigDocument { readonly v: 1; readonly limits?: Partial<HarnessLimits> }
export type LimitEdit = { readonly op: 'set'; readonly key: LimitKey; readonly value: number }
  | { readonly op: 'unset'; readonly key: LimitKey }
export interface LimitsSnapshot { readonly revision: number; readonly values: Readonly<HarnessLimits> }
export interface LimitsReader { read(): LimitsSnapshot }
export type LimitSource = 'library' | 'host' | 'file' | 'explicit'
export interface AppConfigView {
  readonly document: AppConfigDocument | null; readonly hash: string | null
  readonly active: LimitsSnapshot; readonly inherited: Readonly<HarnessLimits>
  readonly fields: readonly (LimitField & { readonly source: LimitSource; readonly locked: boolean; readonly fileValue?: number; readonly shadowed: boolean })[]
  readonly outOfSync: boolean; readonly error?: string
}
// store.ts
export type ConfigRead = { readonly kind: 'missing'; readonly document: AppConfigDocument; readonly hash: string }
  | { readonly kind: 'valid'; readonly document: AppConfigDocument; readonly hash: string }
  | { readonly kind: 'invalid'; readonly error: string }
export class AppConfigStore {
  constructor(file: string, io?: { read?: (file:string)=>Promise<string>; write?: (file:string,content:string)=>Promise<void> })
  read(): Promise<ConfigRead>
  save(document: AppConfigDocument, expectedHash: string): Promise<{ document: AppConfigDocument; hash: string }>
}
// service.ts; host-independent, mounted once using ctx.provide, not HTTP-owned
export class AppConfigService implements LimitsReader {
  constructor(store: AppConfigStore, options?: {
    readonly hostDefaults?: Partial<HarnessLimits>; readonly explicit?: Partial<HarnessLimits>
    readonly onPublished?: (snapshot: LimitsSnapshot) => void
    readonly onNotificationError?: (error: unknown) => void
  })
  boot(): Promise<void>
  read(): LimitsSnapshot
  describe(): Promise<AppConfigView> // disk observation, never activation
  edit(edits: readonly LimitEdit[], expectedHash: string): Promise<AppConfigView>
  reload(): Promise<AppConfigView>
}
// limits-reader.ts
export function readLimits(ctx: Context): LimitsSnapshot
// Reads ctx.get('limits-reader'); fallback resolves legacy ctx.get('limits') with revision 0.
```

Errors use `AppConfigError extends Error` in types.ts, code `'invalid' | 'conflict' | 'locked' | 'io'`, optional `key: LimitKey`. API maps invalid=400, conflict/locked=409, io=500. No new credentials or public paths.

Snapshot revision starts at 0 after boot; effective value changes increment it, including successful reload. Disk-only/source-only changes do not increment effective revision. Descriptor metadata/hash still refresh. Snapshots and documents are detached/frozen; service identity is stable.

---

### Task 1: Limits-owned schema and metadata without changing legacy validation

**Files:** Modify `src/harness/limits.ts`; Create `src/harness/limits-config.ts`; Create `tests/harness/limits-config.spec.ts`; export new public types from `src/index.ts`.

**Interfaces:** Produces `isValidLimit`, `LimitKey`, `LimitField`, `LIMIT_FIELDS`, `WEB_LIMIT_DEFAULTS`, `parseLimitOverrides` above. Component rules mirror existing resolveLimits exactly: MAX_TIMER_MS for maximum; integer enforcement only on the existing six keys (streamFirstEventMs, streamIdleMs, logicalRequestMs, stepRetries, stepRetryBaseMs, compactionTailTurns); zero allowed only tail/pressure. Legacy fractions in other keys remain accepted. No new field.

- [ ] **Step 1: Write failing tests**

```ts
expect(LIMIT_FIELDS.map(f => f.key).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort())
expect(LIMIT_FIELDS).toHaveLength(17)
expect(parseLimitOverrides({ automaticCompactionPressure: 0, compactionTailTurns: 0 })).toEqual({ automaticCompactionPressure: 0, compactionTailTurns: 0 })
expect(() => parseLimitOverrides({ stepRetries: 0 })).toThrow()
expect(() => parseLimitOverrides({ streamIdleMs: 1.5 })).toThrow()
expect(parseLimitOverrides({ toolTimeoutMs: 1.5 })).toEqual({ toolTimeoutMs: 1.5 })
expect(() => parseLimitOverrides({ maxSubagents: 4 })).toThrow()
expect(WEB_LIMIT_DEFAULTS).toEqual({ automaticCompactionPressure: 0.85 })
```

Add a table for every key and values undefined/null/NaN/Infinity/-1/0/0.5/MAX_TIMER_MS/MAX_TIMER_MS+1: strict parser acceptance must equal `isValidLimit`; rejected programmatic values retain DEFAULT_LIMITS. Metadata hints pin stepRetries as extra attempts capped at 3 by current consumer; max attempts remains 4. Unit/hint for attachmentTextLimit says bytes currently sliced, preserving implementation rather than incorrectly claiming characters.

- [ ] **Step 2: Run red:** `npm test -- tests/harness/limits-config.spec.ts`; expect missing exports FAIL.
- [ ] **Step 3: Implement shared predicate and limits definition.** Move current acceptance test into `isValidLimit`; resolveLimits calls it. Strict parser accepts only plain object, known keys and valid numeric values; returns detached sparse overrides. Metadata stays component-owned, all units remain native (no UI conversion drift). Set minimum=0 for every field, exclusiveMinimum=false only for pressure/tail and true otherwise; maximum=MAX_TIMER_MS. This represents existing accepted fractions without falsely imposing minimum=1.
- [ ] **Step 4: Run green:** `npm test -- tests/harness/limits-config.spec.ts tests/harness/request-lifecycle.spec.ts tests/harness/processes/shutdown-safety.spec.ts`; expect PASS.
- [ ] **Step 5: Commit:** task-only files, `feat(config): define component-owned limits schema and metadata`.

### Task 2: Versioned atomic app-config storage

**Files:** Create `src/harness/config/types.ts`, `store.ts`, `tests/harness/app-config-store.spec.ts`.

**Interfaces:** Produces AppConfigDocument, ConfigRead, LimitEdit, AppConfigError and AppConfigStore above. Use existing `replaceFileAtomic` from `src/harness/storage/events-jsonl.ts`. Missing document canonicalizes to `{v:1}`; stable hash is SHA256 of canonical JSON with keys sorted, independent of whitespace/order. Unknown top-level keys/version reject; supported sections are explicitly validated, initially limits only.

- [ ] **Step 1: Write failing tests**

`missing_is_empty_v1`: read missing → kind missing, document {v:1}, no file created. `sparse_save_roundtrips`: save {v:1,limits:{toolTimeoutMs:300000}} → exact sparse document after restart. `canonical_hash_ignores_whitespace_and_key_order`: rewrite equivalent JSON with different ordering → same hash. `stale_save_conflicts`: save with old hash after file edit → code conflict, file untouched. `invalid_and_future_versions_are_not_overwritten`: broken JSON/v2/unknown section/unknown limits key → read invalid; save rejects. `read_permission_error_is_io_not_missing`: injected/controlled read error surfaces io. `failed_atomic_write_preserves_existing_bytes`: writer rejects Error('disk full'); saved file bytes unchanged. `queued_saves_recheck_hash`: two concurrent edits with same expected hash → one success, one conflict.

- [ ] **Step 2: Run red:** `npm test -- tests/harness/app-config-store.spec.ts`; missing module FAIL.
- [ ] **Step 3: Implement store.** Read unknown JSON and validate entire document before hashing. Serialize save with per-store promise tail; re-read canonical state inside lock, compare expected hash, then atomic write. Treat ENOENT only as missing. Do not silently repair corrupt file or overwrite unsupported fields. Do not claim exclusion against arbitrary external editors.
- [ ] **Step 4: Run green:** same command; expect PASS, no user-home I/O in tests.
- [ ] **Step 5: Commit:** new task files, `feat(config): persist versioned global overrides atomically`.

### Task 3: Stable coordinator, field edits and explicit reload

**Files:** Create `src/harness/config/service.ts`, `limits-reader.ts`, `tests/harness/app-config-service.spec.ts`; extend `types.ts`; export public service/types from `src/index.ts`.

**Interfaces:** Produces AppConfigService, LimitsReader/Snapshot/View and readLimits. Register through host-owned `ctx.provide('app-config', service)` and `ctx.provide('limits-reader', service)`. No dynamic section-registration system; limits definition is composed explicitly. Legacy limits service remains static startup-compatible.

- [ ] **Step 1: Write failing tests**

```ts
// with file idle=123, host pressure=.85, explicit output=77:
expect(service.read().values).toMatchObject({ streamIdleMs: 123, automaticCompactionPressure: .85, toolOutputLimit: 77 })
expect(service.read().revision).toBe(0)
// invalid explicit streamIdleMs=0 must NOT lock or shadow file idle=123
```

Add `snapshot_is_detached_frozen_and_stable_until_update`; `set_only_persists_changed_field`; `unset_inherits_without_pinning_other_defaults`; `locked_set_and_unset_refuse_before_write`; `whole_batch_is_rejected_if_one_edit_invalid`; `noop_and_source_only_edit_do_not_increment_revision`; `write_failure_preserves_active_identity`; `notification_throw_does_not_reject_committed_edit`; `manual_edit_describe_does_not_activate`; `reload_error_preserves_last_good`; `boot_invalid_refuses`; `missing_reload_removes_file_overrides`; `slow_reload_then_edit_is_serialized` using a read barrier; `unknown_future_file_stays_diagnosable_and_edit_refuses`. Assert active snapshot stays unchanged on errors, document/hash null with error for invalid observations, valid descriptor supplies outOfSync and current disk hash.

- [ ] **Step 2: Run red:** `npm test -- tests/harness/app-config-service.spec.ts`; missing APIs FAIL.
- [ ] **Step 3: Implement coordinator.** Normalize valid sparse explicit overrides without filling other keys; compose library→host→file→explicit. Serialize boot/edit/reload. Edits validate runtime shape and known keys, apply set/unset to canonical disk document, refuse locks, resolve candidate before save, publish only after write. Describe observes disk separately and reports drift without changing snapshot. A save based on observed canonical file activates that complete valid candidate, including manual valid edits; descriptor must make this clear. Notify contained after commit. readLimits uses reader first and legacy fallback when no reader mounted.
- [ ] **Step 4: Run green:** `npm test -- tests/harness/app-config-store.spec.ts tests/harness/app-config-service.spec.ts tests/harness/limits-config.spec.ts`; expect PASS.
- [ ] **Step 5: Commit:** task-only files, `feat(config): publish immutable operation snapshots through one update path`.

### Task 4: Live operation policies in agent, tools, Bash and approvals

**Files:** Modify `src/harness/agent/agent.ts`, `tools/service.ts`, `tools/types.ts`, `approval/policy.ts`, `src/capabilities/shell/bash.ts`; Create `tests/harness/limits-operation-boundaries.spec.ts`; extend `tests/capabilities/bash.spec.ts`, `tests/harness/g1-approval.spec.ts`.

**Interfaces:** ToolExecution gains optional `limitsSnapshot?: LimitsSnapshot` (trusted, detached/frozen); existing outputLimit/child background fields remain for compatibility. BashToolOptions gains optional `limits?: LimitsReader`; its execute prefers exec.limitsSnapshot, then options reader, then existing static options. ApprovalOptions gains `expiryMsOf?: () => number`; capture once when an approval is created, fallback static expiryMs. No model arguments can stamp snapshot/revision.

- [ ] **Step 1: Write failing tests**

`logical_request_retries_keep_one_snapshot`: start request A with retries/delays captured, publish B during transient failure wait; A attempts follow original policy (max 4), next request B uses new policy. `tool_output_limit_captures_at_body_start`: prepare A under cap20, update to40 while approval held, start A and update to60 while body held; A retains40, next execution B uses60. `child_background_budget_is_pinned`: child Bash exec stamped old max retains it on background commitment after update. `bash_schema_and_execution_read_current_limits`: schema description changes from default 120000/max600000 to default100/max200; execute captures same current clamp at start; explicit argument >max clamps; static callers unchanged. `approval_expiry_applies_only_to_new_questions`: fake timers + approval creation barrier; A expires at old deadline, B at new; neither approves automatically.

- [ ] **Step 2: Run red:** `npm test -- tests/harness/limits-operation-boundaries.spec.ts tests/capabilities/bash.spec.ts tests/harness/g1-approval.spec.ts`; new assertions FAIL.
- [ ] **Step 3: Implement boundary capture.** Agent captures readLimits once immediately before constructing LogicalRequest. Tools captures once in executionAtRun at body dispatch after approval/final authority gates; preparation does not pin a runtime limits snapshot. Preserve the run-time snapshot through output/post-execute processing; never recapture during the running body. Output truncation consumes captured outputLimit. Bash dynamic `schema()` reuses existing ToolDefinition seam and computes current description; execute takes one local policy before awaits. Retain detection/cwd/process registry/explicit argument precedence and static parameters fallback. Approval captures expiryMsOf only at creation, separate from tool preparation snapshot as spec requires.
- [ ] **Step 4: Run green:** focused command plus `npm test -- tests/harness/tool-final-gate.spec.ts tests/harness/tools.spec.ts tests/harness/processes`; expect PASS and live permission rechecks unaffected.
- [ ] **Step 5: Commit:** task-only files, `feat(config): capture execution policies without restarting services`.

### Task 5: Host composition, admissions, compaction and attachment cache

**Files:** Modify `src/web/server.ts`, `src/bins/web.ts`, `headless.ts`, `src/harness/attachments/store.ts`, `src/index.ts`; Create `tests/web/server-app-config-runtime.spec.ts`; extend `tests/harness/attachments.spec.ts`, `tests/bins/headless.spec.ts`.

**Interfaces:** WebServerOptions adds `appConfigFile?: string`, `limitDefaults?: Partial<HarnessLimits>`; configFile untouched. WebServer gains readonly `appConfig: AppConfigService`. Attachments `put(workspaceId,input,limits?: AttachmentLimits): Promise<AttachmentRef>` accepts already-captured cap, falls back constructor static cap. Headless mounts same reader/service, but does not add web-only automation. Existing limits option remains highest valid override; web bin moves .85 to limitDefaults.

- [ ] **Step 1: Write failing tests**

`two_workspaces_share_one_active_config`: service update changes subsequent operations in both roots, retains agents/tools/session service identities. `profiles_and_embedding_precedence`: missing file → library pressure 0, web-bin defaults .85; file pressure .7 overrides host .85; explicit .9 locks .9; invalid explicit falls through. `provider_configFile_is_not_app_file`: explicit provider path remains unchanged; app file separate. `invalid_boot_releases_partially_acquired_host_resources`: boot rejects invalid file and another server can use data home afterward.

`upload_started_before_update_uses_one_cap`: hold body read; lower cap mid-upload; read and store accept under captured old cap; new upload rejected. `attachment_cache_reprojects_at_changed_text_limit`: text 'abcdefgh', load limit3→'abc', then limit8→'abcdefgh', then limit2→'ab'; truncation flags correct. `lower_queue_bound_does_not_drop_accepted_inputs`: old accepted entries retained; new admission rejected when occupancy >= new cap, dedup retry still returns original receipt. `message_count_limit_changes_next_admission`: new count applies without revalidating previous messages. `join_deadline_is_pinned`: change during active join, old deadline retained, next join captures new. `compaction_and_context_capture_current_policy`: threshold update affects next settled decision, tail/text update affects next assembly, ongoing compaction not cancelled. `headless_loads_same_file_contract`: valid overrides used; malformed boot refuses without leaking lock.

- [ ] **Step 2: Run red:** `npm test -- tests/web/server-app-config-runtime.spec.ts tests/harness/attachments.spec.ts tests/bins/headless.spec.ts`; new cases FAIL.
- [ ] **Step 3: Implement host integration.** Use the explicit startup/failure-cleanup sequence in C2 below (the current host has no general boot-failure cleanup flow); boot config before constructing consuming resources and web lock acquisition, then publish startup legacy limits value and stable reader once. Migrate every existing limits consumer: root and maintenance LogicalRequest, join, pressure check, context/tail, text projection, upload body/store, message count and enqueue cap. Capture upload before reading body; capture count at message validation and queue limit at actual serialized admission, preserving queue/dedup order. Attachment cache key includes normalized mediaType and textLimit for text (images omit textLimit); existing byte-budget accounting remains bounded. No operation mutates prior snapshots. Replace HandlerDeps numeric limits reads with reader/service, not a mutable global singleton.
- [ ] **Step 4: Verify green:** focused command plus `npm test -- tests/web/server-compaction.spec.ts tests/web/server-g1.spec.ts tests/web/child-process-lifecycle.spec.ts`; expect PASS. Audit `HarnessLimits` references to verify no migrated runtime path remains permanently boot-captured.
- [ ] **Step 5: Commit:** task-only files, `feat(config): apply global limits at host operation boundaries`.

### Task 6: Authenticated global configuration API

**Files:** Create `src/web/app-config-api.ts`, `tests/web/server-app-config.spec.ts`; Modify `src/web/server.ts`, `src/harness/mcp/route-inventory.ts`; extend `tests/web/control-plane-auth.spec.ts`.

**Interfaces:** Export `handleAppConfigApi(req: IncomingMessage, pathname: string, service: AppConfigService, send: (status:number,body:unknown)=>void): Promise<boolean>`; return false for nonmatching paths. Routes: GET `/api/app-config`; PATCH `/api/app-config` body `{ expectedHash: string, edits: LimitEdit[] }`; POST `/api/app-config/reload` with empty JSON object. Return AppConfigView. Other methods matching these routes →405. Reject malformed/unknown request keys. Service errors map as defined; auth/CSRF stays before dispatch.

- [ ] **Step 1: Write failing tests**

GET returns fields, hash, active revision and native defaults; PATCH set timeout300000 saves only that override; restart retains value; reset removes override. Stale hash→409; locked field→409 with key; invalid key/value/schema→400; invalid reload→400 with service still last-good; disk read/write error→500. GET invalid disk still returns active descriptor with document/hash null and error; PATCH refuses until file repaired. Reload valid manual edit increments revision, repeated reload no-op. Unpaired access→401 when auth enabled; missing/wrong CSRF refuses mutations; scoped credential cannot bypass route policy. Unknown route returns false; GET reload/DELETE config→405.

- [ ] **Step 2: Run red:** `npm test -- tests/web/server-app-config.spec.ts tests/web/control-plane-auth.spec.ts`; new routes absent FAIL.
- [ ] **Step 3: Implement thin adapter and inventory.** Call existing readJson with bounded body inside API adapter; validate shape then invoke service. No store/schema/publication logic in route. Register inventory entries for GET/PATCH and POST reload with normal authenticated cookie+csrf mutation policy. Preserve existing auth defaults; do not add public path exceptions.
- [ ] **Step 4: Run green:** same command; expect PASS and existing control plane tests unchanged.
- [ ] **Step 5: Commit:** task-only files, `feat(web): expose authenticated global configuration edits and reload`.

### Task 7: Advanced tab, changed-field editing and guarded navigation

**Files:** Create `web/components/settings/AdvancedPanel.tsx`, `advanced-panel.spec.tsx`; Modify `web/lib/api.ts`, `SettingsModal.tsx`; extend `settings-panels.spec.tsx`, `tests/browser/chat-workflows.e2e.ts`, browser fixture route responses.

**Interfaces:** api.ts adds `getAppConfig(): Promise<AppConfigView>`, `patchAppConfig(edits: readonly LimitEdit[], expectedHash: string): Promise<AppConfigView>`, `reloadAppConfig(): Promise<AppConfigView>` using apiFetch/json. Type-only imports from config types/limits metadata have no Node runtime dependency. AdvancedPanel props: `{ onGuardChanged(guard: { readonly dirty:boolean; readonly busy:boolean; readonly discard:()=>void }): void }`. Global tab id `'advanced'`, label `'Advanced'`, icon `'sliders'`; no workspace required, badge All workspaces. Parent clears guard when panel unmounts.

- [ ] **Step 1: Write failing mounted tests**

Mock API descriptor with 17 fields. Render all metadata groups; locked field disabled with source reason. Change only toolTimeoutMs to300000 → PATCH exactly one set, not 17 fields; Reset field sends unset, not default numeric value. Invalid numeric draft blocks save using descriptor minimum/maximum/integer and shows error; server validation remains authoritative. Save error/conflict preserves draft; GET Refresh/rebase obtains current hash/baseline without clearing set/unset edits or activating file changes. Same-field remote changes require explicit confirmation before retry. POST Apply file changes is distinct and confirmed if dirty; no automatic overwrite retry. No-op draft disables Save. Failed initial load displays error + Retry, not infinite Loading. Unmount before late GET/PATCH resolves → no stale state/guard update. Manual file drift displays saved/active difference and Reload action; invalid disk displays error, no guessed hash. Provider and Advanced dirty guards are independent.

Mounted SettingsModal tests: close button/Escape/backdrop/mobile selector/desktop tab/external initialTab navigation all guard dirty Advanced draft; Cancel retains text, Discard performs pending navigation; busy saves block leaving. Existing provider discard behavior unchanged. Browser labels add Advanced and fixture `/api/app-config` GET descriptor so tablet/mobile navigation is reachable.

- [ ] **Step 2: Run red:** `npm test -- web/components/settings/advanced-panel.spec.tsx web/components/settings/settings-panels.spec.tsx`; new panel/tab FAIL.
- [ ] **Step 3: Implement panel and navigation contract.** Use settings-kit/Field/TextInput; metadata-only native numeric fields grouped requests/tools/context/admission. Track edits independently of effective baseline, including explicit unset intent. Scoped async state protects late feedback. Clear draft only on successful save or confirmed discard/reload. Extend existing leave guard to union provider draft and active Advanced guard; generalize confirmation copy, call correct discard function, and route external tab changes through leave (avoid direct setTab bypass). Do not add generic form engine or migrate other panels.
- [ ] **Step 4: Verify:** `npm test -- web/components/settings tests/web/no-direct-fetch.spec.ts`, `npm run typecheck`, `npm run build:web`, `npm run test:browser -- tests/browser/chat-workflows.e2e.ts`; expect exit0 and keyboard/mobile reachability.
- [ ] **Step 5: Commit:** task-only files, `feat(settings): edit global limits through component metadata`.

### Task 8: Whole-slice regression and operator documentation

**Files:** Update affected sections of `docs/harness.md`, `docs/web.md`, `docs/architecture.md`, `README.md`; Test focused suites above and full suite.

**Interfaces:** No new production interface. Document data-home scope, precedence/locks, native units, explicit reload, invalid-boot recovery, last-known-good runtime behavior and static legacy reader compatibility.

- [ ] **Step 1: Add final integration regression** in `tests/web/server-app-config-runtime.spec.ts`: server runs operation A, PATCH creates revision B, subsequent operation B observes new limit, A completes old policy; agent/tools/session/process identity unchanged; two workspaces receive same active snapshot. Assert no new max-subagent field and provider file bytes untouched.
- [ ] **Step 2: Run the final regression:** `npm test -- tests/web/server-app-config-runtime.spec.ts`; expect PASS. In the assertions, hold A across publication and assert old/new policy outcomes separately, not just a revision number. If a newly discovered gap fails, retain the failing test and fix only its owning boundary before continuing; no artificial production fault injection is required.
- [ ] **Step 3: Write docs** with exact file/options/API routes/error and effect timing above. Explain malformed file repair/rename then restart without overwriting unknown config; no file watcher or code HMR. Reset inherits current defaults; auto-compaction .85 is web host default, not library-wide change.
- [ ] **Step 4: Final verification:** `npm run typecheck`, `npm test`, `npm run build:web`, `npm run test:browser -- tests/browser/chat-workflows.e2e.ts`. Expect all exit0. Record baseline failures if unrelated; do not claim suite passes while blocked. Check diff for unrelated provider/MCP/permission/default changes.
- [ ] **Step 5: Commit:** task-only docs/test, `docs(config): document live global configuration and verify runtime boundaries`.

## Self-review Coverage Map

- Spec kernel milestone → separate kernel plan; no private kernel API dependence here.
- All 17 fields → Task1 schema, Task4 request/tool/approval/Bash, Task5 join/context/compaction/attachment/admission.
- Defaults/locks/static compatibility → Tasks1/3/5/7.
- Atomic file/conflict/invalid/reload drift/concurrency → Tasks2/3/6.
- Thin auth API and metadata UI/navigation/accessibility → Tasks6/7.
- No watchers/HMR/resource-store migration/new business limits → Global Constraints and Task8 diff review.

## Opus review corrections — binding refinements

- C1: The spec execution-start boundary wins. Replace Task 4's prepare-time capture and test: prepare under output cap20, update to40 while approval waits, begin body execution A under40, update to60 while body held; A retains40 and next execution B uses60. Capture readLimits once in executionAtRun immediately before tool dispatch, after authority/approval waits. Stamp runExec snapshot, outputLimit and child background maximum from that policy. Post-execute/result truncation uses that same runExec; before-dispatch denials may use their original preparation envelope but must not govern later execution. Preserve live permission gates. Bash reads the trusted runExec policy, never the pre-approval snapshot.
- C2: Define host startup order explicitly. For web, allocate/resolve resourceHome, create store at appConfigFile ?? join(resourceHome,'app-config.json'), and boot config before constructing limit-consuming resources and before DataHomeLock.acquire. Enclose initialization in a resource-owned failure cleanup scope that stops the partial kernel and removes only its newly allocated temp home. Track acquired lock/resource disposers for failures after acquisition; release lock only after canonical writers safely settle. Existing listen-only cleanup is not a general boot cleanup. Headless currently acquires lock early: wrap all initialization after acquisition in its cleanup/finally scope, not just the interactive loop. Invalid-config failure must release the lock when no canonical writer started. Add tests for both hosts. Headless explicitly passes expiryMsOf to attachApproval and live limits reader to Bash, including maxWaitMs; do not enable web-only compaction automation.
- C3: Conflict recovery is GET refresh/rebase, retaining pending field set/unset edits and replacing descriptor/hash only. Do not clear draft or call POST reload just to retry 409. If the same field changed remotely, show its new baseline and require explicit user confirmation before resubmission; never auto-retry. Label POST reload separately as Apply file changes and confirm its activation if dirty. An explicit discard/reset is distinct from conflict refresh.
- Add AppConfigStore read injection: constructor(file: string, io?: { read?: (file:string)=>Promise<string>; write?: (file:string,content:string)=>Promise<void> }). Update existing constructor-write references to this options object. Add WebServerOptions.appConfigIo with that same optional test-seam shape so API I/O failures can be exercised deterministically; no chmod/root assumptions.
- AppConfigView field metadata adds optional fileValue:number and shadowed:boolean for a valid durable override hidden by explicit lock. The durable document continues to represent file overrides; active/source/lock metadata represents runtime. Test shadowed values explicitly.
- Inject readJson into handleAppConfigApi as its final argument `(req:IncomingMessage)=>Promise<Record<string,unknown>>`; use the existing bounded server helper via injection, not a private module import or duplicate parser.
- Reset disabled when the canonical file has no field override or field is locked. Update browser test title/counts as well as labels/fixture. Dirty guard must be updated synchronously with editing or via layout timing; test edit then Escape before passive effects to avoid lost drafts.

## Handoff

User selected SDD with GLM Flash after Opus review. Execute tasks in interface order with task-scoped review and persistent ledger. Verify isolation and preserve the dirty baseline before implementation. No production edits while worktree consent remains unresolved; do not silently escalate outside the selected model.
