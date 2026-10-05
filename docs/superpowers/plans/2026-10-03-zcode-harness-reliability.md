# ZCode-informed Harness Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved end-to-end reliability supplement without replacing the existing harness architecture.

**Architecture:** Keep Agent, ToolsService, provider adapters and JSONL authoritative sessions. Add provider-neutral completion/failure/request facts, mandatory execution settlement gates and consistent context projections. Host adapters supply resource/admission controls; observers never own correctness.

**Tech Stack:** TypeScript, Node >=22.19.0, Vitest, existing kernel and file-first storage.

**Spec:** `docs/superpowers/specs/2026-10-03-zcode-harness-reliability.md` (approved by user; read alongside each task).

## Global Constraints

- Preserve all existing dirty working-tree changes; do not reset, clean, stage broadly, commit or restart the live server.
- Preserve the existing kernel, Agent, ToolsService, LlmService, child executor and file-first sessions.
- No side-effect rollback/replay, automatic crash resumption, automatic regeneration after visible partial output, or silent provider fallback.
- Ordinary busy input queues for another turn; never inject it into the active turn.
- Keep command-lifecycle defaults (120 s foreground / 600 s maximum wait / 1 h child background) unchanged.
- Coordinate final identity/authority with `docs/superpowers/plans/2026-10-03-permission-hardening.md`; do not implement unrelated permission-policy changes.
- All defaults in spec §9 are binding for this implementation. Legacy logs remain readable; missing historical facts remain unknown.
- Run tasks sequentially. Use TDD and review each incremental diff against a saved pre-task snapshot. No commits until explicitly requested.

## Review Focus

- Legacy providers/fixtures omit finish metadata: explicit compatibility capability, never success inferred from content.
- Abort-ignoring transport: responsive cancellation with retained ownership, no overlapping retry or fake permit release.
- Child result handoff fails after lookup: persistent staged/delivered identity prevents silent consumption or child rerun.
- Legacy checkpoint lacks summary/provenance: fall back to intact history, never manufacture missing facts.
- Async authority/durability gaps: Stop prevents a not-yet-started body and prepared capability executes at most once.

## File responsibilities and interfaces

Retain existing public modules. New focused modules proposed below may be renamed only with a ledger ruling; update all consumers and exports together.
- `llm/completion.ts`: normalized finish validation, independent from tools/session writes.
- `llm/request-lifecycle.ts`: aggregate attempts, cancellation/time/admission, structured status; not an adapter-specific parser.
- `agent` lifecycle: mandatory pre-terminal cleanup versus contained post-terminal observers.
- `session/events.ts`: canonical effective-call projection and new backward-readable event facts.
- `context/compaction.ts`: canonical summary authority and derived cache eligibility.

---

### Task 1: Explicit completion and bounded wire parsing

**Files:** Modify `src/harness/llm/{types,openai,mock,deepseek}.ts` (locate actual adapter files), `src/harness/agent/agent.ts`, `src/index.ts`; create `src/harness/llm/completion.ts`; tests `tests/harness/{llm-openai,agent-loop,g1-lifecycle,subagent-stability}.spec.ts` and new `tests/harness/stream-completion.spec.ts`.

**Interfaces:** Produce `ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'unknown'`, terminal `StreamEvent` completion facts and `ProviderError` structured reason/phase fields. Keep existing error flags as compatibility accessors. Provider compatibility is explicit, not inferred from answer content. Agent executes calls only after successful validated completion and settled transport.

- [ ] Write failing table tests A01–A05/A10–A11: text/valid-call EOF has no tool execution; successful finish+DONE succeeds once; length/filter/unknown/conflicting finish reject; partial arguments never execute; valid finish/EOF accepted only by configured compatibility; interleaved arguments assemble; conflicting IDs/names/indices and oversized frames/calls fail; bounded error reader cancels at 16 KiB and display 4,000 chars; malformed SSE tail fails.
- [ ] Run `npx vitest run tests/harness/stream-completion.spec.ts tests/harness/llm-openai.spec.ts` and confirm new assertions fail for the intended mechanisms.
- [ ] Implement normalized completion and batch validation; bounded SSE parser/argument/output/error reads using spec §9 caps. Add reader cleanup and completion boundary per §5.1. Do not repair JSON. Update built-in providers, explicit legacy compatibility and repository mock fixtures atomically; do not soften production policy to satisfy old fixtures.
- [ ] Update Agent to require completion, preserve partial UI chunks as failed/non-model content, reject truncated calls and treat only nonempty deltas as commitment. Preserve durable intent before side effect.
- [ ] Run targeted tests and `npm run typecheck`; report commands/results, fixtures changed and compatibility tradeoffs. Do not commit.

### Task 2: Aggregate request lifecycle, classification and admission

**Files:** Create `src/harness/llm/request-lifecycle.ts`; modify `llm/{types,openai,service}.ts`, `agent/agent.ts`, `limits.ts`, `session/events.ts`, `src/index.ts`; host configuration/status seams in `src/bins/{web,headless}.ts`, `src/web/server.ts` and related UI event readers as required. Tests new `tests/harness/request-lifecycle.spec.ts` plus llm/subagent suites.

**Interfaces:** Consume Task 1 completion/error facts. Produce host-injected attempt admission `{ acquire(signal): Promise<{ release(): void }> }`, an aggregate logical-request owner (4 physical attempts/30 min), structured per-attempt IDs/status, and bounded uncertainty registry. One retry coordinator for built-in agent requests; standalone adapter policy explicit. Export types and preserve provider-neutral injection.

- [ ] Write failing tests A06–A12/A27: reset/read/gateway classification, permanent TLS/auth/quota/bad URL no retry, clean incomplete pre-commit EOF retry, committed text no retry, Stop wins races; squeeze and adapter retries share four physical attempts; cap=1 across roots/children/summarizer; backoff releases; queued Stop no fetch; observer throw no leaks; no-progress/idle/total expiry; abort-ignoring transport retains ownership across session reload.
- [ ] Run `npx vitest run tests/harness/request-lifecycle.spec.ts` and confirm RED.
- [ ] Implement spec §5.3–5.5/§9/§10: 600 s first-progress, 300 s idle, 30 min logical deadline, base 1 s/cap 30 s jitter, aggregate 4 attempts, provider cap 4; safe cause taxonomy and attempt facts. Timers/permits/listeners settle once. No retry until previous transport ownership resolved; unresolved cleanup retained in registry and canonical uncertainty facts where writable.
- [ ] Wire web/headless and summarizer to shared admission; distinguish status from durable facts and redact diagnostics with sentinel fixtures. Update closed unions/legacy readers and exports.
- [ ] Run targeted tests and `npm run typecheck`; record evidence and no-remote-termination guarantee. Do not commit.

### Task 3: Mandatory terminal barrier and execution budgets

**Files:** Modify `agent/{agent,types,service}.ts`, `agents/executor.ts`, `limits.ts`, `src/web/{server,agent-delegation}.ts`, session lifecycle events/UI status as required; tests `agent-loop`, `g1-lifecycle`, `g4-subagent-contract`, `subagent-stability`, web Stop/subagent suites; new `tests/harness/terminal-barrier.spec.ts`.

**Interfaces:** Consume uncertainty/request owner. Add mandatory `agent/turn-finalizing` gate carrying turnId, terminal reason, signal/cleanup deadline; keep `agent/turn-settled` observational. Executor closes admission and drains descendants before terminal persistence. Agent has bounded root/child step/time budgets and no idle/success flip while local ownership unresolved.

- [ ] Write failing A15–A19/A26–A27 tests: root provider/internal/storage failure while children run; poisoned storage still cleans; spawn races closing; paused cleanup blocks steer successor; later Stop/closure leaves queue; HTTP 202 means requested; legacy/workspace routes same contract; endless tool loop/child deadline; background ownership exceptions unchanged.
- [ ] Run `npx vitest run tests/harness/terminal-barrier.spec.ts tests/harness/subagent-stability.spec.ts` and confirm RED.
- [ ] Implement one mandatory finalization path on every outcome including cancellation/pre-step reject/failure; 10 s cleanup grace becomes uncertain retention, never fake stopped. Poisoned persistence remains truthful. Reconcile old cancellation routes and steer so successor waits for verified old ownership.
- [ ] Implement root 256 steps/4 h, child 128 steps/1 h; definitions/spawn may narrow only. Model retries consume request budget but not fresh turn allowance. Budget expiry drains ownership without advancing queued input. Preserve committed-root-background/normal-child-background semantics.
- [ ] Run harness/web lifecycle suites and typechecks; report test results and any parked edge case. Do not commit.

### Task 4: Single-start tools, input and child-report ownership

**Files:** Modify `tools/{service,types}.ts`, `agent/agent.ts`, `agents/executor.ts`, `session/{events,service}.ts`, web child handoff/final gate and `src/index.ts`; tests `tool-final-gate`, `tools`, `agent-loop`, `subagent-stability`, `g4-subagent-contract`; new `tests/harness/execution-ownership.spec.ts`.

**Interfaces:** Consume finalization gate and canonical event identity. Prepared execute is single-consumption immutable capability; finalized implementation/intent agree. Report ledger keyed parent turn/child result has staged/delivered states; mark delivered with successful durable assistant outcome. Input pre-step ownership survives exception without auto-rerun.

- [ ] Write failing A13–A14/A18/A20–A21 tests: Stop during prepare/flush/final lookup, execute twice concurrently, final rewrite implementation consistency, revision changes after awaited gate; pre-step throw returns pending IDs/order/attachments; report lookup then provider/storage fail remains staged not delivered; explicit later execution consumes prior evidence without child rerun.
- [ ] Run `npx vitest run tests/harness/execution-ownership.spec.ts tests/harness/tool-final-gate.spec.ts` and confirm RED.
- [ ] Implement immutable finalized capability with synchronous abort/revision consumption immediately before body. Rebind rewritten implementation or reject unsupported rewrite; no new approval subsystem. Integrate current permission plan receipt seam and fail closed if not yet supplied; record exact scope decisions in ledger.
- [ ] Restore unadmitted inputs after exception; only durable admitted/rejected/empty settlement consumes them. Persist report staging/delivery references; do not release owed report state with turn budgets; update lookup and UI projections/exports.
- [ ] Run targeted harness/web suites and typechecks. Do not commit.

### Task 5: Canonical context projection and durable bounded compaction

**Files:** Modify `session/events.ts`, `context/{builder,compaction,budget}.ts`, `src/web/llm-summarizer.ts`, web/headless compaction hooks, event/projection/UI readers; tests `g3-compaction`, `g3-microcompact`, new `tests/harness/compaction-reliability.spec.ts` and recovery fixtures.

**Interfaces:** Consume canonical effective-call projection and shared request admission. Summarizer accepts signal/deadline/input/output caps. Successful canonical compaction fact authorizes cache, not vice versa; compatibility decoder validates old facts without invented provenance.

- [ ] Write failing A21–A25 tests: rewritten tool projections consistent; failed partial chunks UI-only after reload; hanging/endless summarizer aborted; disclosed bounded input; cache write/sync/rename/crash before and after canonical end; invalid future/active ranges; missing legacy summary/provenance falls back to full canonical history; concurrent compaction/admission and dangling start recovery.
- [ ] Run `npx vitest run tests/harness/compaction-reliability.spec.ts tests/harness/g3-compaction.spec.ts` and confirm RED.
- [ ] Reuse effective-call projection in builder/summary; preserve pair integrity and current task. Keep completed-boundary summaries, no reactive mid-turn rewrite. Label chars/4 usage estimated independently of known model window.
- [ ] Implement bounded cancellable summarizer (120 s/64 KiB output), shared admission and disclosed input policy; canonical successful end before cache eligibility, atomic derived cache and validation/rebuild; versioned legacy fallback, idempotent interrupted compaction reconciliation. Serialize admission eligibility; Stop/delete cannot resurrect sessions.
- [ ] Run context/storage/recovery suites and typechecks; include real temporary filesystem fault tests. Do not commit.

### Task 6: End-to-end fault matrix and product contract integration

**Files:** Modify `docs/{harness,capabilities,web}.md`, targeted tests across `tests/harness`/`tests/web`, status UI/API adapters as required; no unrelated styling changes.

**Interfaces:** Consume all prior contracts. Complete A01–A27 traceability in a validation report, expose waiting/retrying/cancelling/uncertain/truncated truthfully and read historical event fixtures.

- [ ] Add missing cross-boundary regression tests and mapping for every A01–A27; tests assert actual no-side-effect/order/ownership facts, not model claims. Run targeted tests first to demonstrate RED for remaining integration defects.
- [ ] Implement minimal integration fixes/document defaults, explicit compatibility profiles, requested-vs-verified Stop, unknown crash outcomes and no replay guarantees. Update public tool/provider docs without changing command-lifecycle ownership.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build:web`; run relevant supported-shell/process-tree and temporary-filesystem tests. Separate pre-existing baseline failures from introduced failures using saved snapshots; do not claim passing on partial output.
- [ ] Obtain task review then independent whole-change review against original baseline; one grouped fix wave and scoped re-review. Record rulings and residuals, do not hide blockers or merge/push/commit automatically.
