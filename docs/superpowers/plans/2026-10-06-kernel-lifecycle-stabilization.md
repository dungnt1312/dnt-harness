# Kernel Lifecycle Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make existing fiber startup, cleanup, dependency restart and shutdown safe under concurrent lifecycle transitions.

**Architecture:** Retain the existing event bus and service store. Give cleanup and lifecycle transitions shared completion promises; retain logical plugin entries across replacement fibers so parent ownership survives restarts. No module reload, generic rollback, or new plugin platform.

**Tech Stack:** TypeScript ESM, Node >=22.19.0, Vitest, existing kernel.

**Spec:** `docs/superpowers/specs/2026-10-06-core-stabilization-configuration-contract.md`, sections 3–4 and milestone 1.

## Global Constraints

- “Expose only existing configurable behavior; do not introduce subagent caps or new execution limits.”
- “Standardize incrementally; avoid building an speculative general-purpose extension framework.”
- “No change to the duplicate-provider rule, event dispatch semantics, or trust model is required.”
- No module/code hot reload, generic plugin-tree rollback, source-cache manipulation or HTTP diagnostics feature.
- Preserve `ctx.plugin()` returning the initially mounted Fiber and synchronous activation for synchronous plugins.
- Workspace is already dirty: do not discard/stage unrelated changes. Use isolated execution workspace at implementation time; commits must contain only each task's changes.

## Review Focus

1. Early effect disposer racing fiber teardown must run once and both callers await completion — Task 1.
2. A throwing disposer must not strand remaining cleanup or advertise successful replacement — Tasks 1/3.
3. Late async apply completion/rejection after unload must not revive or leak the instance — Task 2.
4. Parent unload during dependency restart must dispose the replacement or suppress its mount — Task 3.
5. Stop racing restart/service additions must drain owned transitions and prevent resurrection — Task 4.

## File Map

- `src/kernel/fiber.ts`: effect teardown records and shared disposal result.
- `src/kernel/registry.ts`: logical entries, startup settlement, restart coordination, diagnostics and shutdown fence.
- `src/kernel/context.ts`: parent ownership attachment and safe effect registration.
- `src/kernel/events.ts`, `src/kernel/index.ts`, `src/index.ts`: typed additive lifecycle surface/export.
- Existing `tests/kernel/effects.spec.ts`, `services.spec.ts`: backward compatibility; new `tests/kernel/lifecycle.spec.ts`: races and diagnostics.
- `docs/kernel.md`, `docs/architecture.md`: corrected lifecycle contract.

## Frozen Additive Interfaces

Defined by Task 2 unless noted:

```ts
interface PluginDiagnostic {
  readonly name: string
  readonly fiber: Fiber
  readonly parentUid: number | null
  readonly error?: unknown
}
// Returns copied records for logical entries, including failures; not mutable registry internals.
Kernel.inspect(): readonly PluginDiagnostic[]
// Drains transitions already running, including work they schedule, until quiescent.
// Does NOT wait forever for missing dependencies; does await currently running async apply.
Kernel.settle(): Promise<void>
// Synchronous throw compatibility is preserved; diagnostics retain async failures.
Events['kernel/plugin-failed'](failure: {
  readonly name: string; readonly fiber: Fiber
  readonly phase: 'startup' | 'teardown'; readonly error: unknown
}): void
```

Task 3 extends `Kernel.plugin(definition: ResolvedPlugin, owner?: Fiber): Fiber`; omitted owner uses root. Internal entry identity is stable; replacement Fiber uid changes. A parent-owned effect disposes the logical entry's current generation, not just the first returned Fiber. `Kernel.stop(): Promise<void>` remains awaitable and gains shared completion in Task 4.

Use controlled deferred promises created in tests (a local typed resolver helper), not sleeps/polling to drive races. No shared test helper module is required.

---

### Task 1: Once-only awaited effect and fiber teardown

**Files:** Modify `src/kernel/fiber.ts`; Test `tests/kernel/effects.spec.ts`.

**Interfaces:** Consumes existing `Effect`, `Fiber.effect()`, `Fiber.dispose()`; produces the same signatures with shared completion. Successful disposal ends `disposed`; failed disposal ends `failed` and rejects `AggregateError`. Subsequent callers observe the same outcome. `getEffects()` is empty after all cleanup attempts.

- [x] **Step 1: Add failing tests with these assertions**

```ts
// concurrent_dispose_waits_for_same_cleanup
const done = deferred<void>()
let calls = 0
const fiber = new Fiber('test')
fiber.effect(() => async () => { calls++; await done.promise })
const a = fiber.dispose(); const b = fiber.dispose()
let bFinished = false; void b.then(() => { bFinished = true })
await Promise.resolve()
expect(bFinished).toBe(false)
done.resolve(); await Promise.all([a, b])
expect(calls).toBe(1); expect(fiber.state).toBe('disposed')
```

Also add `early_disposer_racing_unload_is_once_and_awaited` (call returned disposer, then dispose; hold cleanup open; both remain pending; count=1), `cleanup_errors_do_not_skip_remaining_effects` (order `third,second,first`; second throws; rejects AggregateError; state failed), and `iterable_cleanup_attempts_every_disposer` (throwing middle iterable cleanup still executes oldest). Catch rejecting promises immediately in tests to avoid artificial unhandled rejections.

- [x] **Step 2: Run red**

Run `npm test -- tests/kernel/effects.spec.ts`; expect new concurrency/error assertions FAIL while prior cases still run.

- [x] **Step 3: Implement shared teardown records in `Fiber`**

Represent each effect as a once-only teardown with a cached promise; track running early disposals so whole-fiber teardown awaits them. Both normal and iterable cleanup continue after errors. Cache fiber teardown completion; reject aggregate after cleanup, never label it successful. Keep reverse order for not-yet-started effects and reject new effects once unloading/failed/disposed.

- [x] **Step 4: Run green**

Run `npm test -- tests/kernel/effects.spec.ts`; expect PASS including existing effect shape and sequential double-dispose cases.

- [x] **Step 5: Commit task-only changes**

`git add src/kernel/fiber.ts tests/kernel/effects.spec.ts && git commit -m "fix(kernel): await once-only teardown and aggregate cleanup failures"`

### Task 2: Observable startup settlement and late-completion fencing

**Files:** Modify `src/kernel/registry.ts`, `context.ts`, `events.ts`, `src/kernel/index.ts`, `src/index.ts`; Create `tests/kernel/lifecycle.spec.ts`; Test `tests/kernel/services.spec.ts`.

**Interfaces:** Produces `PluginDiagnostic`, `Kernel.inspect()`, `Kernel.settle()` and typed `kernel/plugin-failed` above. Failure event listener exceptions are contained at the producer; unchanged general emit remains fail-fast. A failed entry remains inspectable after cleanup, until kernel stop.

- [x] **Step 1: Add failing cases and exact outcomes**

`async_apply_failure_unwinds_effects`: apply registers service/listener then rejects Error('startup'); settle; service absent, listener no longer invoked, diagnostic error is original error, fiber disposed after successful startup cleanup, exactly one startup failure event.

`sync_apply_failure_is_thrown_and_inspectable`: existing caller receives Error('startup'); await settle; acquired effects cleaned, failed diagnostic retained. `unload_during_loading_never_reactivates`: hold apply; dispose fiber; resolve apply; settle; state disposed, no new active diagnostic. `rejection_after_unload_is_observable_without_unhandled_rejection`: reject held apply after disposal; settle; no resurrection, original error observable. `provide_after_unload_does_not_leak_service`: call captured ctx.provide after disposal; throws, service absent. `failure_observer_throw_does_not_mask_original_failure`: failure listener throws; original diagnostic remains.

- [x] **Step 2: Run red**

`npm test -- tests/kernel/lifecycle.spec.ts tests/kernel/services.spec.ts`; expect missing APIs/new assertions FAIL.

- [x] **Step 3: Implement startup tracking and safe publication**

Keep direct caller sync apply synchronous and throwing, but schedule/track failure cleanup. Contain starts triggered by dependency wake so a consumer exception never propagates through another provider's publication. Track async startup promises with rejection handlers immediately. Activation checks generation and state before publication; failures retain original error, cleanup errors accompany it via AggregateError without hiding original cause. Implement `settle()` by draining tracked transition sets until no tasks remain; pending plugins are not tasks. `inspect()` returns copies. Guard `Context.provide()` before store mutation and undo publication if effect registration fails; never leak service when fiber cannot own it.

- [x] **Step 4: Verify**

`npm test -- tests/kernel/lifecycle.spec.ts tests/kernel/services.spec.ts tests/kernel/events.spec.ts`; expect PASS, duplicate provider still throws.

- [x] **Step 5: Commit**

Stage only listed task changes; `git commit -m "fix(kernel): expose lifecycle completion and fence late startup"`.

### Task 3: Parent-preserving coordinated dependency restart

**Files:** Modify `src/kernel/registry.ts`, `context.ts`; Test `tests/kernel/lifecycle.spec.ts`, `services.spec.ts`.

**Interfaces:** Consumes Task 1 cleanup and Task 2 settlement/diagnostics; produces `Kernel.plugin(definition, owner?: Fiber)` and logical-entry ownership described above. Failed teardown refuses remount; records teardown failure.

- [x] **Step 1: Add failing tests**

`restarted_child_stays_parent_owned`: mount parent→consumer requiring service; remove/return provider; settle; replacement uid differs, parentUid matches original parent, runs=2; dispose parent then settle; replacement cleaned and no owned active/pending child remains.

`two_dependency_removals_coalesce`: consumer injects ['a','b']; hold cleanup, remove both, return both, release cleanup, settle; initial cleanup count=1, total apply count=2. `parent_dispose_during_restart_prevents_remount`: same barrier; dispose parent during child cleanup; release; settle; total applies stays 1. `failed_cleanup_blocks_replacement`: cleanup throws; return dependency; settle; no second apply, teardown failure diagnostic present. `disposed_pending_child_never_wakes`: dispose pending child then provide dependency; settle; apply count=0.

- [x] **Step 2: Run red**

`npm test -- tests/kernel/lifecycle.spec.ts tests/kernel/services.spec.ts`; new ownership/coalescing cases FAIL.

- [x] **Step 3: Implement logical entry ownership**

Store parent, current generation, closed flag and one transition promise in logical entry. Register ownership once with parent and keep restart attached to that entry; do not attach replacement root-owned. Coalesce restart requests; after cleanup reevaluate dependencies and owner liveness. Do not mutate disposed initial Fiber into replacement. Explicit disposal through any generation handle closes logical-entry admission, including the first handle after restart; kernel-initiated generation cleanup uses a distinct internal path that does not close the entry. Retire disposed pending entries from activation candidates.

- [x] **Step 4: Verify**

`npm test -- tests/kernel`; expect all PASS and no orphan effect/service after parent teardown.

- [x] **Step 5: Commit**

`git add src/kernel/registry.ts src/kernel/context.ts tests/kernel/lifecycle.spec.ts tests/kernel/services.spec.ts && git commit -m "fix(kernel): preserve ownership across dependency restarts"`

### Task 4: Shutdown fencing and whole-kernel acceptance

**Files:** Modify `src/kernel/registry.ts`; Test `tests/kernel/lifecycle.spec.ts`; Document `docs/kernel.md`, `docs/architecture.md` only affected lifecycle paragraphs.

**Interfaces:** `Kernel.stop(): Promise<void>` caches completion; fences mounts/restarts synchronously; attempts every cleanup and reports aggregate errors. `settle()` is a drain API, not an activation-success guarantee: callers inspect failed/pending entries.

- [x] **Step 1: Add failing tests**

`stop_racing_restart_never_remounts`: hold restart teardown; call stop; supply service; release; await stop; no apply after stop. `concurrent_stop_waits_for_same_teardown`: both stops held until cleanup barrier, cleanup once. `mount_after_stop_is_rejected`: ctx.plugin and direct Kernel.plugin throw. `stop_attempts_all_cleanup_after_failure`: bad plugin disposer throws, good disposer and root effect still run; stop rejects AggregateError, next stop reports same failure. `loading_plugin_cannot_publish_after_stop`: late apply completion never active; late ctx.provide throws and leaves store empty.

- [x] **Step 2: Run red**

`npm test -- tests/kernel/lifecycle.spec.ts`; new shutdown cases FAIL.

- [x] **Step 3: Implement and document**

Close admission before detaching service observer. Dispose current generations/root while tracking cleanup outcomes; drain owned transitions without waiting for unavailable dependencies. Async apply completion cannot restore ownership; do not add a new arbitrary deadline or force-kill user code. Document await semantics, failure diagnostics and impossibility of cancelling arbitrary JavaScript work automatically.

- [x] **Step 4: Acceptance verification**

Run `npm test -- tests/kernel`, `npm run typecheck`, `npm test`. Expected all exit 0. If pre-existing failures appear, record exact failing case and establish baseline; do not claim pass or fix unrelated files silently.

- [x] **Step 5: Commit**

Stage task-only files; `git commit -m "fix(kernel): fence shutdown and drain owned lifecycle transitions"`.

## Opus review corrections — binding refinements

These refinements resolve the reviewed ambiguities in Tasks 1–4; implementations and tests must follow them.

- K1: Startup failure is a diagnostic on the logical entry, separate from teardown failure. Record the original startup error, close entry admission, and drive cleanup through unloading to disposed on success or failed on cleanup error. Do not skip cleanup merely because startup failed. Task 2's startup-failure assertion is diagnostic.error=original error and fiber.state=disposed after successful cleanup, not fiber.state=failed. Failed/retired entries are excluded from dependency wake/restart candidates. Stop does not replay an already-cleaned startup error; only unresolved teardown failure rejects stop. Add `cleaned_startup_failure_does_not_reject_stop` and `failed_entry_does_not_restart_on_dependency_removal`.
- K2: Before any side effect, Context.on/once/provide/plugin/effect verifies that its owner accepts effects. If ownership registration fails after a side effect, undo the listener/service/child immediately and track async cleanup. Add late on/once/plugin cases after unload, asserting no listener, service, child or effect remains. Guarding provide alone is insufficient.
- K3: Direct Kernel.plugin/ctx.plugin calls preserve synchronous apply exceptions. Starts caused by service additions/flushPending contain synchronous consumer failures as diagnostics and failure events, never throwing through another owner's provide. Add `pending_consumer_failure_does_not_fail_publisher`: publisher remains active, its service has cleanup ownership, consumer cleaned diagnostic is retained, removing publisher removes service.
- K4: Disposing ANY generation's returned Fiber handle closes its logical entry, including the initially returned handle after restart. Kernel-internal generation cleanup is a separate internal path and does not close the logical entry. Do not recursively delegate the internal cleanup through public dispose. Add `dispose_initial_handle_after_restart_closes_entry`: remove provider, allow replacement to pend, dispose initial handle, return provider; no further apply and replacement cleaned. Direct unowned Fiber instances keep Task 1 behavior.
- Async apply is not cancellable arbitrary JavaScript. Settle/stop may await held startup work; existing host boundedCleanup can time out and intentionally retain data-home ownership when quiescence cannot be proven. Document that limitation, do not invent a deadline or force release. Test late completion with controlled barriers, and test shutdown reports actual cleanup failures distinctly from already-cleaned startup failures.

## Handoff

Execute this plan before the configuration plan operationally; configuration snapshots do not require a general reload framework. The configuration plan consumes no private kernel transition machinery. User selected SDD with GLM Flash after Opus review. Before implementation create or verify an isolated workspace with user consent, retaining the current dirty working-tree baseline. Each implementer and task reviewer uses the explicit Flash model; never silently escalate outside the selected model without permission.
