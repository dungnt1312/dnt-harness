# Code review — core agent loop / session / LLM request lifecycle (2026-10-15)

Scope: `src/harness/agent/*.ts`, `src/harness/session/*.ts`, `src/harness/llm/*.ts`,
`src/harness/limits.ts`, plus the web-host call sites the findings below reach, and the relevant
`tests/harness/**` suites.

Every finding is **verified by reading code**; none is test-confirmed — the reviewer had no Bash and
no Write tool, so no suite was run.

## Severity counts: critical 0 · high 1 · medium 2 · low 3

| # | Severity | Location | Defect |
|---|---|---|---|
| F1 | high | `src/harness/session/session.ts:267-280` (fork), used by `src/harness/session/service.ts:346-361` | `Session.fork` copies events into `log` but never seeds `committedLog`, although `SessionsService.fork` has already made that exact log durable via `store.replace` (`service.ts:350`) |
| F2 | medium | `src/harness/agent/agent.ts:369-373`, `:399-404`, `:503-531` | Claimed inbox items are restored only on the **stop** path; any other early failure in `turn()` loses the claim without settling it |
| F3 | medium | `src/web/server.ts:9523`, `:9549`, `:9557` (with `amendQueuedInput` at `:9610-9628`) | A concurrent DELETE/PATCH during the `session.durable()` await is overwritten by the stale `stillPending` snapshot |
| F4 | low | `src/harness/llm/service.ts:35-39`, `:49-51` | `configureAdmission` ignores `uncertain` when refusing to replace a live admission |
| F5 | low | `src/harness/agent/agent.ts:456-461` vs `:503-526`, append at `:915` | `step/end` is written only on the success path; every other failure leaves a dangling `step/start` |
| F6 | low | `src/harness/session/session.ts:271` | `Session.fork` copies the parent's `durableListener` into the child |
| F7 | low (possibly by design) | `src/harness/agent/agent.ts:406-430` | On a `reject`/`empty` pre-step, injected items (no `inputId`) are discarded, asymmetric with the stop path at `:399-404` |

## Findings

### F1 (high) — a forked session reports an empty committed log

`Session.fork` copies events into `child.log` but never sets `child.committedLog`, while
`SessionsService.fork` has already persisted that same log with `store.replace(child.id, child.events)`
(`service.ts:350`). `committedEvents` / `committedSeq` therefore report an **empty** log for a forked
session until its first `durable()` barrier.

Re-verified independently by the parent session: `committedLog` starts as `[]`
(`session.ts:72`), is only assigned in `adoptHistory` (`:255`) and in the barrier at `:179`, and
`fork()` (`:267-280`) touches only `child.log`. `service.ts:350` does make the copy durable. So the
inconsistency is real.

*Consequences.* Fork a session whose log contains a successful `compaction/end`:

(a) `findHeldCompaction` (`src/web/server.ts:10677`) sees `compaction/end` with `seq >
committedSeq(0)`, so the events SSE holds the snapshot at `held.seq - 1` and queues everything behind
it — the client sees a truncated transcript until some later append passes a barrier.

(b) `assembleRequest` reads `checkpoints.latest(id, session.committedEvents)` (`server.ts:3734`) → `[]`
→ the fork's first requests ignore the copied checkpoint and resend the pre-compaction transcript
(window pressure).

*Fix.* After the copy loop, `child.committedLog = [...child.log]` (same as `adoptHistory`, `:255`) —
truthful because `store.replace` already committed those bytes. Not covered by any test.

### F2 (medium) — a claimed batch can be lost on the non-stop failure path

Claimed inbox items are restored only on the stop path (`stopRequested()` → `inbox.unshift(...claimed)`,
`:399-404`). Any other failure in `turn()` before `step()` writes `input/settled` — a throwing
`agent/pre-step` waterfall listener, a `session.append` failure — runs the catch at `:503`, which
writes `turn/error` + `turn/end: failed` but neither restores the claim nor calls
`settleClaimedInputs`.

*Trigger.* A pre-step listener that throws (instead of returning `{kind:'reject'}`) with
`agent.send()` input: the text is lost with no log record at all. With durably accepted input the
`input/queued` record survives, so the web host self-heals on the next `submitMessage` (`adoptPending`,
`server.ts:9557`) — headless/direct callers have no such path.

The 2026-10-03 spec §7 explicitly requires "restore unadmitted input oldest first and clear claims" on
a pre-step exception. *Fix.* On the non-stop failure path, unshift the still-unsettled claimed items
back (or settle them as `rejected`).

### F3 (medium) — a withdrawn/edited queued input can be resurrected

`submitMessage` snapshots `stillPending` (`:9523`), appends `input/queued` (`:9549`), then **awaits**
`session.durable()`, and only afterwards calls `agent.adoptPending(stillPending)` (`:9557`). A
concurrent DELETE/PATCH of an input in that snapshot succeeds in the meantime (the item is not in the
inbox yet, so `withdrawQueued`/`reviseQueued` return `true` and append `input/settled withdrawn` /
`input/revised`), and the stale snapshot then re-adds the input to the inbox.

*Trigger.* Slow disk/fsync: `DELETE …/inputs/:id` (or an edit) while a POST is parked on
`session.durable()`. The withdrawn input is logged as a `user/message` with its pre-withdrawal text and
settled `admitted` — the deletion is silently ignored. Same for an edit (stale content wins).

*Fix.* Re-read `sessions.pendingInputs(entry.session)` after the barrier and adopt that (the pending
cache makes it cheap), or skip inputs the log already settled. Needs a test.

### F4 (low) — admission replacement ignores uncertain attempts

`configureAdmission` refuses to replace a live admission only when `active > 0` (`:35-39`); it ignores
`uncertain`. `sessionUncertain` scans only the currently **registered** admissions (`:49-51`).
Replacing the admission of a provider with an unresolved attempt (`uncertain.size > 0`) drops the
session-ownership fence entirely: a new turn is admitted on a session whose previous transport may
still be live, and the retained ticket later decrements an orphaned admission's counter. Only
reachable through the public API (no host caller today). *Fix.* Also refuse while `uncertain.size > 0`,
or carry uncertain facts across the swap.

### F5 (low) — dangling `step/start` on every non-stop step failure

`step/end` is written only on the success path (`:456-461`); `closeOpenStep` is called only in the
`StopRequested` branch. Every other failure — silent/empty provider response, `length` budget
exhaustion at `:472-474`, protocol errors — leaves a dangling `step/start`.

*Trigger.* Any provider failure inside `step()`: the log reads `… step/start, turn/error, turn/end`
with no `step/end`. `recover()` (`session/service.ts:453`) never closes steps, and
`web/lib/manifest-refresh.ts` uses `step/end`/`step/abandoned` as its refresh triggers. *Fix.* Call
`closeOpenStep(turnId)` in the failure path (or in `closeOpenTurn`). Existing failure tests assert only
`turn/error` + `turn/end`, so this is uncovered.

### F6 (low) — fork copies the parent's durable listener

`Session.fork` copies the parent's `durableListener` into the child (`:271`). A child built by
`Session.fork` directly (not via `SessionsService.fork`, which immediately overwrites it at
`service.ts:355`) would schedule the **parent's** summary projection on its own barriers. Latent API
hazard only; the service path is safe.

### F7 (low, possibly by design) — injected context is dropped on a rejected pre-step

On a `reject`/`empty` pre-step, injected items (`inject()`, no `inputId`) are discarded rather than
returned to the inbox — asymmetric with the stop path at `:399-404`. *Trigger.* SessionStart-hook
context is injected, then the UserPromptSubmit hook blocks the prompt: the queued hook context is lost
and the next admitted turn no longer carries it. Flagged as an asymmetry only; not provable as
unintended.

## Domains read and considered clean (with what was checked)

- **Uncertainty accounting / ticket lifetime** (`llm/request-lifecycle.ts`, `llm/service.ts`): every
  path either releases the ticket or parks it in `admission.uncertain` with exactly one `reconcile`
  (`:272-298`); a poisoned `notify('uncertain')` cannot strand the ticket; late settlement reconciles
  after the driver exits. Covered by `tests/harness/request-lifecycle.spec.ts` and
  `llm-review-regressions.spec.ts`.
- **Retry bounds**: `LogicalRequest` attempts ≤ 4 (`:98`), `canRetry` requires `transportSettled &&
  !committed && !aborted` (`:110-112`); squeeze ≤ `MAX_SQUEEZE_LEVEL`; backoff capped at 30 s,
  abortable, listeners removed in `finally`, no permit held while sleeping (`:114-123`). No unbounded
  loop in `step()`'s `for(;;)` — squeeze, discard budget and attempt budget are all bounded.
- **Read-only tool concurrency** (`agent.ts:842-980`): `next++` is synchronous so lanes cannot
  double-index; results are appended in call order; a failing call cannot cancel siblings; a stop
  answers every declared call.
- **Durability/ordering** (`session/session.ts`): monotonic `seq`, the commit prefix is never retracted
  on out-of-order barriers (`:179`), poison is sticky, observer failures are isolated via
  `ctx.parallel`, `relaxedStreamingAppends` is restricted to `assistant/chunk`.
- **Recovery** (`session/service.ts:453-557`): interrupted turns, synthesized results for
  call-without-result and declared-without-call, approvals invalidated, everything durable before the
  session is cached; idempotent (6 crash shapes covered by `session-review-recovery.spec.ts`).
- **Wire parsing** (`llm/completion.ts`): byte-bounded error reads, SSE frame limit, incomplete
  terminal tail rejected, reader lock released on every exit; `openai.ts` never lets the `finally`
  throw mask a primary error.
- **`limits.ts`**: `resolveLimits` domain checks (integers, `> 0` except zero-capable keys,
  `MAX_TIMER_MS` cap) are consistent with the documented operation-boundary contract.
- **Pure projections**: `deriveTitle`, `userActivityOf`, `parentOf`, `lastRecorded`,
  `textOnlyVisionFallback`, `withoutDescribeImage`, and `applyThinkingOverride`'s per-family tables.

## Memory-recorded issues re-confirmed (by reading)

- **Mid-stream retry via `step/abandoned`** — correct and bounded: `agent.ts:789-798` discards once
  per step (`discardBudget`), applies to tool-result steps too (no `contents` guard), appends
  `step/abandoned` + a fresh `stepId` + `step/start` + backoff, and the transcript cannot grow (tests
  `agent-loop.spec.ts:409-524`).
- **Length-truncation recovery** — confirmed: `validateCompletion(…, {allowLength:true})`
  (`agent.ts:718`), `calls = []` on `length` (`:724-725`), `TRUNCATION_NOTICE` with `origin:'context'`
  (`:476`), no empty `assistant/message` (`:825`), turn fails on the 3rd cutoff (`:472-474`,
  `MAX_TRUNCATION_RECOVERIES = 2`); `tests/harness/length-recovery.spec.ts` matches. Doc note only: the
  sentence "After `MAX_TRUNCATION_RECOVERIES` (2) cutoffs in one turn the turn fails"
  (`docs/harness.md:947`) reads as one fewer recovery than the code and test actually allow.
- **Prompt-cache prefix stability (loop side)** — the request is re-derived from the log inside the
  attempt loop (`agent.ts:663`), so a retry/abandon/squeeze reuses the same assembly inputs and the
  prefix cannot shift because of retry mechanics. Host-side prefix caching was out of scope here (see
  the sibling context/compaction report).
- **Stop/steer/queue semantics** — re-confirmed against `agent.ts:238-262`, `:294-331`, `:399-404` and
  `agent-loop.spec.ts:589-774`; the only hole found is F3, which is host-side, not in the driver state
  machine.

## Not checked (out of scope)

`src/harness/context/*` (compaction transaction, builder budget, adoption proof), `src/web/*` beyond
the routes touched above, `src/harness/agents/executor.ts`, `src/harness/tools/*`.

## Unresolved questions

1. Is `Session.fork` intentionally leaving `committedLog` empty, or is `SessionsService.fork`'s
   `store.replace` meant to be paired with an `adoptHistory`-style commit? (Decides F1's fix shape.)
2. Should a rejected/empty pre-step drop queued `inject()` context (F7), or keep it for the next
   admitted turn like the stop path does?
3. Is `configureAdmission` meant to be reachable while a previous attempt is unresolved (F4), or should
   it be fenced entirely?

**Risk:** F1's SSE-truncation symptom and F3's resurrection race are reasoned from code only; both need
a test before being treated as settled. F2 and F5 are log-shape / claim-state inconsistencies rather
than data loss on the web host.
