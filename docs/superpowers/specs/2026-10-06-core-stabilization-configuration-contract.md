# Core stabilization & configuration contract

Status: final design direction approved in chat; written specification awaiting review. Documentation only; no implementation authorization.
Date: 2026-10-06

## 1. Intent and approval boundary

The approved direction is to strengthen the core and standardize existing behavior before expanding product features. Advanced Settings is the first consumer of that foundation, not a separate configuration implementation inside the web host.

User constraints:
- Expose only existing configurable behavior; do not introduce subagent caps or new execution limits.
- Configuration is global, shared across workspaces, with a sectioned file that can hold more than limits later.
- Standardize incrementally; avoid building an speculative general-purpose extension framework.
- This deliverable is a design for review. No source changes, migrations, UI implementation, or implementation plan execution are authorized by it.

The final architectural direction was approved after an upstream comparison and self-review. This written specification captures that direction for a separate review before implementation planning. DeepSeek sources are pinned in section 11; local adaptations are deliberate and do not claim upstream parity.

## 2. Scope

### In scope

1. Reliable kernel startup, teardown, and dependency-driven restart contracts.
2. A harness-level global configuration service with immutable snapshots and explicit publication boundaries.
3. The existing `HarnessLimits` as the first vertical slice.
4. Migration of limits consumers from boot-captured values to operation-boundary snapshots, without changing enforcement semantics.
5. A small host-independent service API usable by web and headless compositions.
6. Later, Advanced Settings as a thin client of that API.

### Out of scope

- Module/code hot reload, import-cache invalidation, composition watchers, marketplace, SDK freeze, or plugin discovery.
- New subagent caps, nested delegation, new timers, or changing existing defaults as a side effect.
- Reloading session/agent/process services to change numeric configuration.
- Merging providers, credentials, MCP, mode, skill, session, and secret stores into the global file.
- A big-bang rewrite of `src/web/server.ts` or migration of every subsystem to the new service.
- Automatic filesystem watching in the first slice. An explicit reload operation can apply manual edits without introducing watcher races.

## 3. Evidence-based audit

Audit reflects working-tree source on this date. The repository contains substantial pre-existing changes; executors must re-read it before implementation. Line numbers are intentionally not treated as stable interfaces.

| Area | Current behavior and evidence | Gap / preservation requirement |
|---|---|---|
| Service store | `src/kernel/store.ts`: duplicate `set()` throws; delete/add broadcasts availability | Re-providing an existing service is not an update API. Keep duplicate-provider protection. |
| Effects | `src/kernel/fiber.ts`: reverse-order awaited disposers; sequential double disposal tested in `tests/kernel/effects.spec.ts` | Concurrent disposal returns early while unloading; throwing cleanup can prevent remaining cleanup. Define shared completion and error aggregation. |
| Startup | `src/kernel/registry.ts`: sync apply failure throws; async failure logs and removes entry; activation writes active unconditionally | Late startup must not revive an unloaded fiber; failed registrations must unwind and failures remain observable. |
| Dependency restart | Registry removes/disposes dependent then remounts; `tests/kernel/services.spec.ts` covers basic restart | Restart is fire-and-forget, and `Context.plugin()` documents lost parent linkage. Coordinate restart and preserve ownership. |
| Loader | `src/kernel/loader.ts`: one-time YAML parse/import/mount | No code/config reload manager. Do not treat lifecycle primitives as complete HMR. |
| Limits | `src/harness/limits.ts`: 17 fields, `resolveLimits()` merges defaults with permissive fallback | Mostly boot-captured. Existing validator is not a complete strict editor schema; it also does not freeze returned objects. |
| Agent request | `src/harness/agent/agent.ts`: LogicalRequest construction reads `this.limits()` multiple times; maxAttempts capped at 4 | Capture one revision for an entire logical request, including retries. Preserve attempt ceiling. |
| Web limits | `src/web/server.ts`: resolves options once; closures and HandlerDeps retain limits; Bash/attachments/approvals capture values at construction | Must migrate actual consumers, not merely replace a ctx entry. |
| Web defaults | `src/bins/web.ts`: sets automaticCompactionPressure to 0.85; library default is 0 | Preserve both profiles; file introduction must not silently disable web auto-compaction. |
| Headless | `src/bins/headless.ts`: provides DEFAULT_LIMITS and constructs capabilities separately | Shared contract does not imply enabling web-only behavior in headless. |
| Providers | Server serializes mutations, commits store before publishing registry changes | Reuse ordering principle; do not migrate provider storage in this slice. |
| MCP | Server has config mutation/generation, cancellation, reconnect and descriptor publication | Resource reconfigure is not a simple snapshot update. Preserve disabled/import and dispatch-authority rules. |
| Prompts/hooks | Prompts load during context assembly; hooks configuration is loaded at existing boundaries | Preserve existing behavior; investigate boundaries before any future migration. |
| Modes/model | Root/session snapshots and revisions; globals are not live authority over every session | Never replace session-owned controls with global live config. |
| Skills | Turn-local snapshots intentionally pin content/hash | No mid-turn instruction hot reload. |
| Process registry | `src/harness/processes/registry.ts` has its own limits shape | Not every limit belongs to HarnessLimits. Do not claim this slice covers all resource caps. |

Related architecture: `docs/architecture.md`, `docs/kernel.md`, and `docs/decisions/plugin-platform.md`. The proposed plugin platform explicitly excludes hot reload, while already identifying parent-preserving restart and observable startup failure as preconditions. This proposal overlaps those preconditions; it does not authorize the rest of that platform proposal.

## 4. Layer boundaries

### Kernel owns mechanics

The kernel knows fibers, effects, named services, dependencies, and lifecycle outcomes. It does not know timeouts, models, workspaces, settings files, or HTTP.

Kernel requirements:
- All callers disposing the same fiber await the same teardown completion; each effect executes once.
- Teardown attempts remaining cleanups after a cleanup error and reports accumulated failures. A failed teardown must not be advertised as a safe replacement.
- Startup completion is generation/state guarded. Unload during async startup cannot publish a late active instance.
- Startup failure initiates cleanup of acquired effects and remains observable with original error and cleanup outcome.
- Dependency restart preserves logical parent ownership across replacement fibers. Parent teardown disposes the replacement, including a restart that races parent shutdown.
- At most one restart transition per logical plugin instance is active. Multiple dependency removals coalesce; remount reevaluates all requirements.
- Kernel stop fences new mounts/restarts, awaits owned transitions, and does not allow late resurrection.
- Hosts can await startup/lifecycle completion without polling or relying on console output. Exact API additions belong in the implementation plan.

No change to the duplicate-provider rule, event dispatch semantics, or trust model is required.

### Harness owns configuration meaning

Configuration infrastructure is a stable coordinator for storage, conflict checking, resolution, immutable snapshot publication, and active revision. It delegates validation and defaults to component-owned definitions; it must not become a new monolithic owner of every business schema.

Each component owns its section's schema, defaults, units/descriptions, effective-source metadata, and application semantics. Settings projects that metadata into a form; it has no parallel business-settings store or independent validation/default rules. A fixed set of supported section definitions is sufficient initially; no dynamic plugin/schema registration framework is required.

For limits, expose one stable typed reader returning an immutable `{ revision, values }` snapshot. Capture the complete policy once per operation rather than maintaining 17 independent references. Publication changes the snapshot, not the reader/service identity. Never delete/re-add the service or restart agents, sessions, tools, or processes to update numeric values.

The kernel does not infer update policy from JSON diffs. Pure-data publication can be atomic; external-resource activation is subsystem-specific and is not a generic transactional rollback system.

### Hosts own composition and transport

Web/headless supply storage location and startup profile, mount the service, and adapt errors. HTTP handlers do not own validation/publication algorithms. Capability adapters receive operation-specific values rather than importing a global web singleton.

Only extract the orchestration needed for this slice; unrelated web-host code remains in place.

## 5. Global configuration model

File location: `<dataHome>/app-config.json`, global to one data home, not per workspace and not shared automatically by separate data homes. This avoids implying workspace scope and avoids conflating app configuration with the existing provider store. `WebServerOptions.configFile` remains provider-only; a distinct `appConfigFile` option may override the app file location for embedding/tests. Do not rename or repurpose the existing option.

Memory-only hosts use an isolated configuration store alongside their existing temporary resource home, never the user's default app file. Persistent hosts use their existing data-home ownership boundary; explicit reload and mutation are serialized in the coordinator.

Illustrative durable shape:

```json
{
  "v": 1,
  "limits": {
    "toolTimeoutMs": 300000
  }
}
```

Requirements:
- File stores explicit overrides, not a copied set of every default.
- Secrets do not belong here.
- Missing override means inherit the host profile/default; clearing a field removes its override.
- Version and section validation is strict. Unknown versions/fields are reported rather than silently discarded or overwritten.
- Future sections require an explicit reviewed schema and application policy, not arbitrary unvalidated JSON.
- Section mutation preserves unrelated supported sections. A limits editor must not replace the entire document.
- Writes are atomic and serialized; compare-and-swap uses the canonical document hash.
- Stable service identity; snapshot objects cannot be mutated by consumers.

### Defaults and override precedence

Recommended precedence, highest first:

1. Explicit embedding/test `options.limits` overrides, if supplied.
2. Durable global file overrides.
3. Host profile defaults (web retains compaction pressure 0.85).
4. Library DEFAULT_LIMITS (compaction pressure 0).

Separate host defaults from explicit option overrides so file settings can override the normal web defaults. Preserve existing programmatic invalid-option fallback behavior: only valid explicitly supplied fields enter the highest-priority layer and lock those fields. Do not resolve an entire partial options object to full defaults before layering, which would accidentally shadow all file values.

A locked field is visible with its effective source. API set/reset operations targeting that field are refused before persistence with a field-specific locked-override error; unrelated fields remain editable. Reload may read a valid file value under a lock but reports it as shadowed. The UI disables locked edits rather than reporting a save that cannot affect runtime.

No unconditional first-boot seed is needed. Missing file preserves existing behavior; user saves create sparse overrides. Reset removes the durable override and inherits current host/library defaults, rather than persisting a copy of those defaults.

### State and API semantics

Distinguish:
- **Durable hash:** conflict token for the complete persisted document; changes with canonical content.
- **Active revision:** process-local monotonic revision of effective published configuration; not reused as a durable hash across restart.
- **Effective snapshot:** resolved values and their source, captured at an operation boundary.

Conceptual service operations (names/signatures to freeze in a later plan):
- Read current effective immutable snapshot and active revision.
- Read durable overrides/default sources/hash for an editor.
- Apply explicit set/unset edits to supported fields with expected durable hash, preserving unedited overrides and other sections. Do not rebuild a document from effective or incomplete UI values.
- Explicitly reload/validate the file and publish a new snapshot.

API mutation and reload use the same component validation, resolution, and publication path. Mutation additionally persists; reload never rewrites the operator's file. Both are serialized so an older asynchronous reload cannot overwrite a newer publication. Future file watching is an owned adapter calling reload, not a second update algorithm.

The API descriptor exposes durable overrides/hash, active values/revision, inherited defaults, per-field source/lock/application metadata, and any last reload error. A valid manual edit not yet reloaded is distinguishable from active state; an invalid document remains diagnosable without mutating active values. A GET must not silently activate file edits.

Atomic replacement and in-process compare-and-swap do not lock arbitrary external editors. Read canonical file state at mutation time and reject observed stale changes, but do not claim cross-process transactional exclusion. Read failures other than a missing file are surfaced, not treated as empty defaults.

For the limits slice there is no async resource reconfiguration: prepare/validate the candidate before writing, atomically persist, then publish by a synchronous non-throwing snapshot swap. Failed persistence leaves active state unchanged. Notification failures must not undo a committed publication or make clients believe a successful mutation failed.

No-op effective updates do not need a new active revision, even if removing a redundant override changes the durable hash. Reloading unchanged content is a no-op.

### Invalid files and failures

Recommended behavior:
- Missing file: use defaults/profile without warning.
- Invalid API update: reject visibly; do not write or publish.
- Invalid explicit reload: keep last-known-good active snapshot; report the file error. Do not silently reset runtime to defaults.
- Invalid file at boot: refuse boot with actionable diagnostics rather than silently weakening configured controls.
- Stale hash: conflict; require reload before retry.
- I/O failure: retain active state and expose the failure.
- Save refuses to overwrite a corrupt/unsupported file without explicit operator recovery; do not erase unknown future config.

Strict file/API validation reports malformed fields rather than silently falling back; it accepts the existing supported value domain and does not introduce incidental range/integer changes. `resolveLimits()` retains its exported programmatic fallback behavior. Both validation paths share field rules owned by limits so accepted values cannot drift. Invalid programmatic overrides fall through to lower layers; invalid durable configuration refuses publication.

## 6. Operation-boundary contract for all 17 limits

Capture once at the stated boundary. Never re-time an existing operation or combine two revisions within its policy. Permission narrowing remains governed by existing live authority gates, not by a numeric-config snapshot.

| Fields | Capture boundary | Existing work |
|---|---|---|
| streamFirstEventMs, streamIdleMs, logicalRequestMs, stepRetries, stepRetryBaseMs | Start of logical model request, including maintenance requests | All retries keep the same policy; preserve current maxAttempts <= 4. |
| toolTimeoutMs, bashMaxWaitMs | Start of Bash execution, before deriving its foreground wait | Running command and explicit tool argument precedence remain unchanged. |
| subagentBackgroundBashMaxMs | Start of child Bash execution, retained if it becomes background | Do not retroactively kill background processes when config decreases. |
| delegationJoinMs | Start of each root join of outstanding children | An active join retains its deadline; config updates do not cancel children. |
| approvalExpiryMs | Creation of approval request | Pending approval retains its existing expiresAt; timeout never implicitly approves. |
| toolOutputLimit | Start of tool execution | The eventual result uses that operation's captured cap. |
| maxPendingInputs | Serialized input enqueue admission | Existing accepted inputs are not dropped; preserve dedup/queue durability ordering. |
| automaticCompactionPressure | Settled-boundary decision to schedule compaction | Existing compaction is not cancelled by threshold changes. |
| compactionTailTurns | Start of a context assembly or compaction assembly | Each assembly retains one captured policy; checkpoints remain immutable. |
| maxAttachmentBytes | Start of upload admission, shared by body read and store validation | In-flight upload uses one cap; stored blobs are not deleted. |
| maxAttachmentsPerMessage | Message admission validation | Previously accepted messages are not revalidated. |
| attachmentTextLimit | Start of attachment projection for a context/maintenance request | Do not let cache return text truncated under a different cap; cache strategy must be verified. |

Special review cases:
- Model-visible Bash argument schemas/descriptions must agree with host clamps after an update; do not leave a boot-time advertised max next to a new runtime max.
- A decreasing queue bound below current occupancy rejects only new admissions, not accepted queue entries.
- Increasing text limits must not reuse a cached truncated representation that hides previously omitted text.
- Count/duration validation must preserve existing supported behavior. Existing helper allows zero only for pressure/tail and does not require integer values for every field; stricter rules are a separately reviewed semantic change, not an incidental cleanup.
- This work must not accidentally imply configurable max subagents. Spawn counters are currently uncapped.

## 7. Standardizing other subsystems without migrating them now

The common vocabulary is:
- **Next operation:** new operations take a new snapshot.
- **Explicit reconfigure:** reconnect/rebuild an owned resource with subsystem-specific failure behavior.
- **Restart required:** boot/composition fields that cannot safely change live.

Existing storage scope and authority boundaries remain intact. MCP keeps its generation fencing and no-replay dispatch guarantees; provider mutation retains disk-before-publication ordering; modes/model remain session-owned; skills remain turn-pinned. Future adapters may reuse conflict/publication patterns, but not a generic rollback mechanism that assumes all external operations are reversible.

Saved-versus-active metadata for future resource sections must reflect actual activation failure. Do not promise all sections of a global file activate atomically unless such a transaction is implemented and tested.

## 8. Incremental delivery and gates

These are design milestones, not a step-by-step implementation plan. Kernel and configuration should receive separate bounded plans after this design is reviewed.

### Milestone 1 — Kernel lifecycle stabilization

Files: `src/kernel/fiber.ts`, `registry.ts`, `context.ts`, relevant kernel tests and kernel docs. Reuse existing event bus; exact diagnostics API is planned here, not an HTTP plugin diagnostics feature.

Gate: deterministic tests for concurrent disposal, throwing cleanup, startup failure cleanup, unload during loading, multiple dependency loss, parent teardown during restart, and stop during restart. No late active fiber, orphan replacement, duplicate effect, or swallowed lifecycle completion.

### Milestone 2 — Global config service and existing-limit slice

Focused infrastructure under `src/harness/config/`: document types, durable store, coordinator and snapshot reader. Limits-owned schema/defaults/field metadata stay with the limits component; do not hardcode each future business schema in the coordinator. Existing `limits.ts` remains the enforcement value shape and compatibility helper. Exact module names are frozen in the implementation plan. No new schema-library dependency is required by this design; justify one only if existing validation cannot meet the contract.

Do not silently replace the existing `ctx.get('limits')` value shape with a reader object. Introduce a distinct typed reader seam and preserve/document the legacy static compatibility surface until an explicit migration decision. New operation-time consumers must use the reader; tests must prove updates reach them rather than merely inspecting the old service value.

Migrate only required seams in agent, tools, Bash, approvals, attachments, web/headless compositions, and public exports. Keep direct-use capability APIs compatible where practical by retaining existing static options as fallbacks.

Gate: defaults/profile precedence, strict mutation validation, CAS, atomic failure behavior, immutable snapshots, no-op updates, valid/invalid explicit reload, and two-workspace global consistency. Integration tests hold operation A open, publish revision B, then prove A keeps old policy and operation B uses new policy. Do not test only file persistence.

### Milestone 3 — Advanced Settings consumer

Global tab, authenticated API with normal CSRF protections, source/effective values, save conflict feedback, reset-to-inherited defaults, explicit reload, and visible application semantics. Use centralized API client and existing settings primitives. Render the simple limits form from component-owned metadata; no independent UI schema/defaults, parallel settings store, reload algorithm, or generic recursive form engine.

The form sends only changed field set/unset operations, never all displayed effective values. Show locked fields and why they are locked. Show saved-versus-active divergence after manual edits and preserve unsaved drafts during failures/conflicts. Request retries beyond the current effective ceiling must be explained rather than promising more attempts.

Gate: navigation/responsiveness, loading/error/retry, invalid input, locked embedding overrides, dirty-state handling on close/tab change, stale conflict, and a saved change reflected by a subsequent real operation without restarting services.

### Milestone 4 — Follow-up standardization assessment

Inventory remaining ad-hoc config orchestration and select one subsystem at a time. No commitment to migrate providers/MCP/hooks until evidence shows reuse improves ownership or correctness. General plugin HMR remains a separate design.

## 9. Verification strategy for later execution

Relevant existing tests: `tests/kernel/effects.spec.ts`, `services.spec.ts`, `loader.spec.ts`; `tests/harness/request-lifecycle.spec.ts`, approval/process/attachment/tool suites; `tests/web/server-compaction.spec.ts`, `server-g1.spec.ts`, `child-process-lifecycle.spec.ts`, provider/MCP suites; headless tests and browser settings workflows.

Required regression principles:
- Existing injected limits continue to work in tests/embedders.
- Web profile compaction 0.85 and library/headless defaults remain deliberate and testable.
- No session data migration, dropped pending input, widened permission, restarted command, or replayed MCP call.
- Run kernel-focused tests per lifecycle task and consumer-focused tests per config task, then full typechecks/build/test suite using current package scripts.
- Use controlled promises/barriers for races rather than timing sleeps as the main proof.

No implementation tests were run for this documentation deliverable, and audit risks are not claims of newly reproduced test failures.

## 10. Final decisions and review gate

The approved in-chat direction is captured as these design decisions:
1. Global `<dataHome>/app-config.json`; provider `configFile` retains its meaning.
2. Component-owned schema/defaults/metadata; configuration infrastructure coordinates, Settings projects.
3. One stable limits reader with complete immutable operation snapshots; no remount for numeric changes.
4. API edits and explicit reload use one pipeline; watcher is deferred.
5. Host defaults sit below file overrides. Valid explicit embedding overrides sit above them and refuse targeted form edits.
6. Invalid boot file refuses startup; invalid runtime reload retains last-known-good.
7. Preserve defaults, legacy helper behavior, supported value domain, existing retry clamps, session authority and turn-pinned instruction semantics.
8. Kernel lifecycle stabilization, configuration/limits slice, then Advanced Settings. Kernel work is independently testable; hot config is not an architectural dependency on full plugin reload support.
9. No general plugin-tree transaction/rollback, module HMR, speculative schema platform, or broad host rewrite.

Written-spec approval permits implementation planning, not implementation execution. Separate plans should cover kernel stabilization and the configuration vertical slice; execution requires review of those plans and selection of an execution method.

## 11. DeepSeek reference and deliberate adaptations

Source repository: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), pinned revision `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. These are inspected documentation/source references, not a claim that the upstream test suite was run locally.

| Reference | Evidence | Adopt / adapt |
|---|---|---|
| [Profile-owned live configuration](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/notes/implemented/architecture/2026-09-19-profile-owned-live-configuration.md) (implemented) | Separate settings registrations duplicated schema/defaults/persistence; forms now edit owning profile config | Adopt one owner and one update path. Adapt persistence to a global sectioned JSON file, not profiles/Includes. |
| [Volatile references](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/notes/implemented/architecture/2026-09-18-volatile-config-references.md) (implemented) | Stable references hold immutable values; consumers capture per operation; validation precedes commit | Adopt semantics with a complete limits snapshot, not 17 references or a new volatile schema framework. |
| [Loader Entry.update](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/vendor/loader/src/config/entry.ts) | Volatile-only update validates and commits references; notification is not asynchronous activation completion | Adopt pure-data commit ordering and notification containment; do not implement a loader diff engine. |
| [SettingsForms](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/settings/settings/src/index.ts) | Schema-derived forms, revision conflicts and targeted path edits | Adopt metadata projection and changed-field edits. No generic form engine or secret migration is needed. |
| [Nontransactional Loader](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/notes/implemented/simplification/2026-09-09-nontransactional-loader.md) (implemented) | Generic candidate-generation rollback was reverted; app consumers own activation audit | Avoid general rollback. Pure-data snapshot updates remain atomic; resource reconfigure stays subsystem-specific. |
| [watchConfig](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/hmr/src/watch-config.ts) | Exact-path watching, stabilization, serialized refresh and disposal drainage | Future watcher must be an owned reload adapter. Defer it until explicit reload is proven. |
| [Config-only HMR proposal](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/notes/proposed/simplification/2026-09-19-config-only-hmr.md) (proposed, not implemented) | Proposes reducing module-HMR maintenance; source HMR still exists at inspected revision | Motivation to defer code HMR, not evidence upstream removed it. |

Upstream profile editing can pin complete entry configs because Include replaces a config block. Our field-level sparse overrides deliberately avoid that behavior: editing one limit must not freeze all inherited defaults. Do not import composition isolation, JS config expressions, automatic module replacement, or an SDK surface as incidental parts of this design.

## 12. Self-review record

Checked scope, ownership, compatibility, operation boundaries and update failure behavior against the final direction and local code. Corrected an omission in the earlier draft by adding the `delegationJoinMs` boundary, bringing the table to all 17 current fields. Distinguished provider file naming, host defaults from explicit locks, strict editing from legacy fallback, and durable hash from active revision. Added serialization of reload versus save, saved/active visibility, no external-editor exclusion claim, and upstream implemented/proposed distinctions.

No product implementation or implementation-test success is claimed by this documentation change.
