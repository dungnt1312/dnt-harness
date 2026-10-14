# Effective-context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay raw-transcript fold mặc định bằng compact context hiệu lực, phục hồi continuation state có giới hạn và guarded precompute.

**Architecture:** Builder phát typed projection; host capture completed request thành durable snapshot. Một structured summary request tạo prepared result; adoption có reservation/validation riêng, ghi canonical checkpoint và giữ nguyên tail ngoài cutoff. Precompute reuse cùng generator/installer, không tạo framework retry hay store authority thứ hai.

**Tech Stack:** TypeScript, Node.js fs/crypto/AbortController, Vitest, React hiện có, pnpm; không dependency runtime mới.

**Spec:** `plans/261013-2237-effective-context-compaction/spec.md` — approved 2026-10-13 22:43 +07:00. Executors đọc cả spec và plan.

## Global Constraints

- Summary text có cap hiện tại 24k ký tự. Output token budget ban đầu đề xuất 8k, clamp theo model/output/window; hard character cap vẫn authoritative.
- Job deadline đề xuất 180s cho toàn summary operation, retry tối đa hai physical attempts mỗi logical request, nằm trong cùng deadline.
- Manual operation: reuse ready valid candidate trước; nếu candidate pending, wait tối đa 15s rồi hủy/quiesce job trước foreground generation.
- Config đề xuất `compactionPrecomputeEnabled` mặc định false trong rollout; `compactionPrecomputePressure` 0.65 trên usable request budget, không phải full model window.
- Gain ≥256 estimated tokens; post-restore context phải fit mà không drop tail ngoài cutoff.
- Không commit spec hoặc source trên branch đang có nhiều thay đổi không liên quan trừ khi user yêu cầu. Không native API adapter, không tự deploy/restart.
- Giữ log append-only, checkpoint v1 legacy và strict stop-completion; summary/restoration là lower-trust data, không tăng permissions.
- Không tự gọi paid providers; live benchmark cần approval riêng. Không sửa dữ liệu live dưới host storage.
- Scope web host; không tuyên bố headless compact parity. Core interfaces dùng được lại nhưng không tự thêm headless workflow.

## Review Focus

1. Snapshot mới cùng cutoff do thêm telemetry có thể khác reference nhưng không khác source: digest phải lấy content semantics, không mọi timestamp/attempt event. Test Tasks 1–2.
2. Provider EOF sau stop nhưng tail lỗi không được promote snapshot; completion flag ở `finally` không đủ. Test Task 3.
3. Rejected speculation đã sinh usage vẫn phải tính phí nhưng không được ghi vào context meter của foreground. Test Tasks 6/9.
4. Maintenance file restore không được làm Edit nghĩ agent đã Read; symlink/grant shrink lúc await không vượt policy. Test Task 7.
5. Seed/identity đổi sau validation nhưng trước append success: revalidate dưới reservation và committed barrier; no double checkpoint. Test Tasks 5/9.

## File map và dependency

Existing integration: `builder.ts`, `compaction.ts`, `events.ts`, `events-jsonl.ts`, `server.ts`, `llm/types.ts`, `llm/openai.ts`, `limits.ts`, web API/projector/stream/UI. Chỉ wiring trong server lớn; extract compact-specific orchestration sang module mới, không refactor các subsystem khác.

New focused units:
- `src/harness/context/compaction-projection.ts`: typed losses, source identities, eligibility.
- `src/harness/context/compaction-snapshot.ts`: portable snapshot schema/digest validation; không IO.
- `src/harness/storage/compaction-snapshot-store.ts`: atomic sidecar/reference validation/GC.
- `src/web/compaction-capture.ts`: exact request capture/promotion/reconstruction.
- `src/web/compaction-generator.ts`: summary collector/prompt/budget/deadline/usage.
- `src/web/compaction-host.ts`: manual/auto source selection/hooks/reservation/adoption.
- `src/web/compaction-restoration.ts`: bounded grant-safe continuation material.
- `src/web/compaction-precompute.ts`: candidate state/identity/cancellation; dùng existing provider lifecycle.
- `tests/fixtures/compaction/`: sanitized synthetic source và expected facts; không copy private live transcript.

Dependencies: 1 → 2 → 3; 4 phụ thuộc 1/2; 5 phụ thuộc 2; 6 phụ thuộc 3/4/5; 7 phụ thuộc 1/5/6; 8 phụ thuộc 6/7; 9 phụ thuộc 6/7/8; 10 phụ thuộc tất cả. Không parallel edit `server.ts`/event union giữa workers. Mỗi task review và targeted checks trước khi task consumer bắt đầu. Phase deliverables lần lượt foreground portable, restoration/observability, precompute; tất cả đều thuộc approved scope.

## Task 1: Typed projection và source policy

**Files:** Create `src/harness/context/compaction-projection.ts`, `tests/harness/compaction-projection.spec.ts`; modify `src/harness/context/builder.ts`, `src/harness/session/events.ts`; extend `tests/harness/g3-microcompact.spec.ts`.

**Interfaces:** `AssembledContext` thêm `compactionProjection: CompactionProjection`. Không parse omissions strings. Export types/functions sau:

```ts
export type ProjectionLoss =
  | { kind: 'tool-result-cleared'; seq: number; callId: string; policyVersion: 1 }
  | { kind: 'uncovered-history-dropped'; fromSeq: number; throughSeq: number }
  | { kind: 'regenerable-section'; source: string; hash: string }
  | { kind: 'unknown'; reason: string }
export interface CompactionProjection {
  v: 1; policyVersion: 1; history: 'none' | 'recent' | 'compact'
  seed?: { coversSeq: number; hash: string }
  sources: readonly { messageIndex: number; seq: number; turnId: string }[]
  losses: readonly ProjectionLoss[]
}
export type Eligibility = { ok: true } | { ok: false; reason: string }
export function assessProjection(events: readonly SessionEvent[], cutoff: number,
  projection: CompactionProjection): Eligibility
```

- [ ] **RED:** add tests using existing completed-turn fixture construction and new typed projection. Pin uncovered turn refusal, unknown loss, seed omission, full seed+delta coverage, parallel call/result pairing. Include this assertion with fixture-generated `cutoff`/`projection`:
```ts
expect(assessProjection(events, cutoff, {
  ...projection,
  losses: [{ kind: 'uncovered-history-dropped', fromSeq: 1, throughSeq: cutoff }],
})).toEqual({ ok: false, reason: 'uncovered-history-dropped' })
```
- [ ] Run `pnpm exec vitest run tests/harness/compaction-projection.spec.ts tests/harness/g3-microcompact.spec.ts`; new tests must fail for missing typed output or wrong clear policy, not fixture errors.
- [ ] **GREEN:** attach sources while builder assembles messages; emit typed losses exactly at microclear/section-drop/turn-drop sites. Derive coverage from user/assistant/tool content events and completed turn boundaries; ignore telemetry identity churn. Protect unread batch, error output, question/approval/state/child deliverables. Remove default MCP clear eligibility unless policy explicitly asserts safe; keep unsafe output.
- [ ] Add seed hash and invalid-mode tests; metadata-only event append must leave semantic coverage digest inputs unchanged. Run targeted tests plus `tests/harness/g3-context.spec.ts`.
- [ ] Record diff/checks and review. Commit only on explicit user request, scoped to this task.

## Task 2: Snapshot schema, atomic store và event compatibility

**Files:** Create `src/harness/context/compaction-snapshot.ts`, `src/harness/storage/compaction-snapshot-store.ts`, `tests/harness/compaction-snapshot.spec.ts`; modify `src/harness/session/events.ts`, `src/harness/storage/events-jsonl.ts`, exhaustive switches found by typecheck, `tests/harness/storage.spec.ts`.

**Interfaces:** `EffectiveCompactionSnapshot` has `id:string` (host random UUID), `v:1`, `policyVersion:1`, `sessionId`, `cutoff`, `turnId`, `request` (ModelRequest allowlist only), `finalAnswer: ModelMessage`, `projection`, `sourceDigest`, `seedHash?`, `identity`, `inputEvidence?`. `identity` is `{provider, model, thinkingLevel?, modeHash, grantsHash, providerGeneration, policyVersion, prefixHash}`. Export `snapshotHash(snapshot): string`, `sourceDigest(events, cutoff): string`, `validateSnapshot(snapshot, events): Eligibility`. Snapshot IO accepts an explicit trusted per-session directory, never a user-supplied path.

```ts
export class CompactionSnapshotStore {
  constructor(sessionDir: (id: string) => string) {}
  put(snapshot: EffectiveCompactionSnapshot): Promise<{ id: string; hash: string }>
  load(id: string, ref: { id: string; hash: string },
    events: readonly SessionEvent[]): Promise<EffectiveCompactionSnapshot | undefined>
  prune(id: string, keepIds: ReadonlySet<string>): Promise<void>
  close(): Promise<void>
}
```

- [ ] **RED:** real-temp-directory tests for write/sync/rename/reference order, stale digest, unsupported version, broken seed, missing/corrupt sidecar, invalid path ID and crash/orphan states. Canonical key ordering yields same source digest; telemetry-only append does not change digest. Changing user text/effective args does.
- [ ] Run `pnpm exec vitest run tests/harness/compaction-snapshot.spec.ts tests/harness/storage.spec.ts`; missing store/schema fails.
- [ ] **GREEN:** allowlist snapshot fields, canonical SHA256 encoding with schema version, content-event source digest. Persist atomically with unique temp, fsync then rename; append `context/snapshot` reference only after `put` succeeds, acknowledge after session barrier. Event fields `{snapshotId, hash, cutoff, schema:1}`; projection ignores reference event. On load require committed reference and eligible completed cutoff, then validate payload against log/seed.
- [ ] Implement ownership-aware prune latest eligible + pinned candidate only after barrier; close drains writes. Test failed sidecar IO keeps original history and legacy event decoding intact; no secrets/assemblySignal/handles serialized. Propagate event-union exhaustiveness without weakening assertions.
- [ ] Run targeted storage/session suites and typecheck; review before task 3.

## Task 3: Capture exact completed prefix và recover reconstructed source

**Files:** Create `src/web/compaction-capture.ts`, `tests/web/compaction-capture.spec.ts`; modify `src/web/server.ts` request middleware/stream tap/turn-settled, `tests/web/server-compaction.spec.ts`.

**Interfaces:** `captureRequest(request: ModelRequest, projection: CompactionProjection): PendingCapture`; `promoteCapture(session: Session, pending: PendingCapture, finalAnswer: ModelMessage, store: CompactionSnapshotStore): Promise<EffectiveCompactionSnapshot | undefined>`; `reconstructSnapshot(session: Session, request: ModelRequest, projection: CompactionProjection, identity: EffectiveCompactionSnapshot['identity']): EffectiveCompactionSnapshot | undefined`. `PendingCapture` stores immutable allowlisted request + projection and strict completion evidence; source identity promotion uses completed durable turn, not model EOF alone.

- [ ] **RED:** scripted stream with valid stop then tail rejection, duplicate completion, aborted stream, abandoned step, internal tool-model call, open turn and uncertain execution must not promote. Exact prefix preserves every system/tool schema/message order and thinking; no reference before turn durability.
```ts
expect(snapshot.request.messages).toEqual(completedRequest.messages)
expect(snapshot.finalAnswer).toEqual({ role: 'assistant', content: finalText })
expect(snapshot.projection.losses.some(l => l.kind === 'tool-result-cleared')).toBe(true)
```
- [ ] Run `pnpm exec vitest run tests/web/compaction-capture.spec.ts tests/web/server-compaction.spec.ts` and confirm new failures.
- [ ] **GREEN:** capture at the actual root dispatch tap only once per armed agent step; retain successfully drained/validated completion, discard on tail error even in `finally`. Promote latest completed request after durable turn/end. Use typed eligibility rather than `omissions.length===0`; keep public completed-request consumers compatible until replaced.
- [ ] Recover from durable sidecar on reload. For absent/corrupt sidecar reuse ordinary context builder with committed source/sections under current policy, classify reconstructed, and refuse uncovered dropped turns. No maintenance read changes agent Read observation state. Test restart exact vs reconstructed and mismatched provider/mode.
- [ ] Run affected server/context tests; review shared interfaces and request capture ordering.

## Task 4: Structured generator và bounded provider policy

**Files:** Create `src/web/compaction-generator.ts`, `tests/web/compaction-generator.spec.ts`; modify `src/web/llm-summarizer.ts`, `src/harness/llm/types.ts`, `src/harness/llm/openai.ts`, other adapters exposing output limits, `src/harness/limits.ts`; tests `tests/web/llm-summarizer.spec.ts`, `tests/harness/llm-openai.spec.ts`.

**Interfaces:** add optional `ModelRequest.maxOutputTokens?: number` consumed as clamp with provider configured/model cap, absent preserves ordinary behavior. `generateCompaction(snapshot, stream: StreamFn, options: {signal:AbortSignal; deadlineAt:number; maxOutputTokens:number; recordUsage:(usage:TokenUsage)=>void}): Promise<PreparedSummary>`; `PreparedSummary` fields `{snapshotId, cutoff, summary, sourceDigest, identity, seedHash?, generationMs, path:'exact'|'reconstructed', usage?:TokenUsage}`. Snapshot is immutable; generation never dispatches tools.

- [ ] **RED:** prefix equality except appended summary instruction/output limit; stop requirement, tool progress rejection, length rejection, empty summary, giant delta cap, oversize one re-ask, second overflow refusal. Test shared 180s deadline covers both requests/queue/backoff; contextExceeded never resends same input.
```ts
expect(sent.messages.slice(0, -1)).toEqual([
  ...snapshot.request.messages, snapshot.finalAnswer,
])
expect(sent.tools).toEqual(snapshot.request.tools)
expect(sent.thinkingLevel).toBe(snapshot.request.thinkingLevel)
expect(sent.maxOutputTokens).toBe(8000)
```
- [ ] Run generator/adapters tests RED.
- [ ] **GREEN:** concise handoff prompt per spec, 24k character collector using existing `validateCompletion`. Limit physical attempts to two per LogicalRequest and shared operation deadline; preserve transport-settlement fencing and parent cancellation. Buffer attempts for retries but expose progress separately; usage recorded for completed/failed reported attempts including later rejected results. Re-ask at most once; no raw chunk fallback.
- [ ] Implement token fit: same-snapshot usage baseline includes schema/system; reserve final assistant output, appended instruction and 8k output; 20% margin for unmeasured increments. Without usage estimate whole request conservatively. Unknown window/no-model safe extractive refusal paths tested. Adapter caps never override lower operator cap.
- [ ] Run generator, completion, lifecycle and adapter suites; ordinary request wire unchanged when maxOutputTokens absent. Review.

## Task 5: Prepared checkpoint adoption và canonical recovery

**Files:** Modify `src/harness/context/compaction.ts`, `src/harness/session/events.ts`, `tests/harness/compaction-reliability.spec.ts`, `tests/harness/compaction-context-reliability.spec.ts`; add `tests/harness/compaction-adoption.spec.ts`.

**Interfaces:** keep legacy `compactSession` for explicit raw recovery; add `adoptPreparedCompaction(session, checkpoints, prepared:PreparedSummary, options:{trigger:'manual'|'automatic'; signal:AbortSignal; validate:()=>Promise<void>; restoration:readonly ModelMessage[]; measure:()=>{tokensBefore:number;tokensAfter:number}}):Promise<CompactionCheckpoint>`. Store sidecar-independent adoption proof on start/end: version, transaction ID, source cutoff/digest, seed identity, captured boundary + adoption-start bound. Legacy event fields remain optional; legacy recovery retains old rules.

- [ ] **RED:** candidate cutoff A followed by closed turn B recovers checkpoint A and keeps B verbatim. Open B refuses. Turn/start inserted after adoption/start invalidates. Forged proof/mismatched transaction/start owner/digest/seed rejects. Same cutoff no-op calls no model and appends no lifecycle.
```ts
expect(recoverCanonicalCheckpoint(session.committedEvents)?.coversSeq).toBe(cutoffA)
expect(deriveMessages(session.committedEvents).some(m => m.content === 'tail B')).toBe(true)
```
- [ ] Run `pnpm exec vitest run tests/harness/compaction-adoption.spec.ts tests/harness/compaction-reliability.spec.ts` RED.
- [ ] **GREEN:** independently revalidate proof and boundary under existing session compaction exclusion, validate summary/measure before append. Commit durable end first, cache second. Permit completed turns between cutoff and transaction start only for proven new-version transaction; forbid model execution during adoption, not during speculation. Restoration record and success authority must be paired by transaction ID, never visible on failed/dangling start.
- [ ] Fault tests before success/after append/before durability/after durability/cache failure; cancellation after successful durable commit cannot undo it. Reject seed mutation before commit via final validation. Run legacy g3 and reliability suites unchanged except assertions that explicitly change approved semantics.
- [ ] Review transaction/version migration; no rewriting old log.

## Task 6: Portable foreground host, config và explicit slow recovery

**Files:** Create `src/web/compaction-host.ts`, `tests/web/compaction-host.spec.ts`; modify `server.ts` runCompaction/deps/routes/stop/delete/close, `limits.ts`, `tests/web/server-compaction.spec.ts`, `web/lib/api.ts`.

**Interfaces:** `CompactionHost` dependency-injected capture/store/generator/adopter/entry reservation, exposes `compact(sessionId, {trigger, strategy:'effective'|'recovery', signal?}):Promise<CompactResult>`, `cancelExplicit(sessionId):void`, `close():Promise<void>`. `CompactResult` preserves existing success fields with optional `path`/timings. Limits add `compactionEffectiveEnabled` versioned rollout default false until final gate, `compactionPrecomputeEnabled:false`, pressure 0.65, deadline 180000, output 8000, candidateWait 15000; validate ranges/zero-capable semantics explicitly.

- [ ] **RED:** exact and reconstructed one-call success; dropped uncovered turn returns typed `recovery-required` with estimated raw calls and no lifecycle/model request; auto never runs recovery; concurrent compact conflicts; inbox queues and drains once after failure/stop.
- [ ] Run host/server tests RED. Replace fixture prompt substring classifier with exported summary instruction marker so tests distinguish new prompt without tying to headings.
- [ ] **GREEN:** effective source selection, PreCompact once before foreground generation, operation reservation through commit, no-op before generation, no-model extractive preflight. Versioned effective config off retains old behavior for rollback; enabled does not auto-fallback on provider failure. Recovery request requires `{strategy:'recovery', confirmation:{cutoff,sourceDigest,estimatedCalls}}` matching current preflight; stale confirmation returns conflict. Empty POST remains supported.
- [ ] Use existing grants/auth/route scopes; never expose raw sidecar. Update all stop/deletion/closing paths to cancel/drain operation and remove reservations. Record speculative/maintenance usage without contaminating foreground meter. Test effective identity changes and actual next-request checkpoint consumption.
- [ ] Review; phase foreground deliverable can run with precompute still off.

## Task 7: Durable bounded restoration và true context fit

**Files:** Create `src/web/compaction-restoration.ts`, `tests/web/compaction-restoration.spec.ts`; modify builder/event schema/server wiring; regression `tests/harness/g3-context.spec.ts`, `tests/capabilities/fs-tools.spec.ts`, `tests/capabilities/fs-conflicts.spec.ts`.

**Interfaces:** `buildRestoration(input:{session:Session;cutoff:number;grants:readonly GrantedRoot[];signal:AbortSignal;registryState:readonly ModelMessage[]}):Promise<{messages:readonly ModelMessage[];tokens:number;losses:readonly ProjectionLoss[]}>`. Host inputs accepted plan/skills from actual durable sources; optional absent state is omitted honestly. Builder consumes committed `compaction/restoration` event paired with canonical adoption transaction and exposes provenance sections. Required state must not be silently shortened.

- [ ] **RED:** max 5 files/5k each/20k file total, skills 5k each/25k total, aggregate 25k, priority constraints → plan/runtime → skills → files. Larger files become references; current denied/symlink/missing/changed files never return unauthorized stale content. Restoration cannot authorize later Edit without agent Read.
```ts
expect(restoration.tokens).toBeLessThanOrEqual(25_000)
expect(restoration.messages.some(m => String(m.content).includes('Referenced file'))).toBe(true)
```
- [ ] Run restoration tests RED; use real temporary grant directories and fs policy, not permission bypass mocks.
- [ ] **GREEN:** host-safe reads with grants recheck after awaits; do not use fs tool observation registry. Preserve source stamps and register durable lower-trust context messages only on successful adoption. Keep accepted plan pointer when content unavailable; active agents/processes/questions derive state without execution. Missing state does not invent a plan.
- [ ] Preview exact next context (checkpoint + bounded retained user/final answer + all tail + restoration); no budget trimming of tail allowed for adoption fit/gain. Required context overflow refuses before transaction; optional file/skill restoration can fall back to pointers within declared caps. Update manifest estimate, not fake actual provider usage.
- [ ] Review storage growth and authority separation; rerun retention, grants and fs freshness tests.

## Task 8: Candidate manager và background generation ownership

**Files:** Create `src/web/compaction-precompute.ts`, `tests/web/compaction-precompute.spec.ts`; modify `src/harness/llm/request-lifecycle.ts` only to expose optional lower-priority admission (ordinary default unchanged), relevant admission tests, host wiring.

**Interfaces:** `CompactionPrecompute` holds one job per session, `start(snapshot, signal):boolean`, `takeReady(sessionId):PreparedSummary|undefined`, `waitPending(sessionId, waitMs, signal):Promise<PreparedSummary|undefined>`, `invalidate(sessionId, reason):Promise<void>`, `close():Promise<void>`. Manager uses generator and immutable snapshot ID; no checkpoint write/hooks. Candidate owns pinned snapshot ref until settled. Failure key snapshot+identity prevents retry tight loops.

- [ ] **RED:** fake-clock job pending → ready; normal source append doesn't discard; seed/model/mode/grants/provider generation change does. Deadline, queued foreground priority, shared candidate cancellation, two starts return false, discarded reported usage persists.
```ts
expect(manager.start(snapshot, signal)).toBe(true)
expect(manager.start(snapshot, signal)).toBe(false)
expect(checkpoints.latest).not.toHaveBeenCalled()
```
- [ ] Run manager/admission tests RED.
- [ ] **GREEN:** deadline starts before queue, low-priority admission never claims more than existing provider capacity. Shared LogicalRequest machinery handles transport and backoff; don't wrap unmanaged second stream. Ready candidate metadata includes complete identity/source/seed; pending job is not session `busy`/turn open.
- [ ] Shutdown/delete cancel and await transport settlement; uncertainty is surfaced and blocks successor instead of pretending abort settled. Candidate generation fault never appends canonical lifecycle. Keep only latest eligible+pinned snapshot; release pin after settled discard/commit.
- [ ] Review with generation/usage/admission suites.

## Task 9: Precompute trigger, guarded adoption, hook and tail races

**Files:** Modify `compaction-host.ts`, `compaction-precompute.ts`, `server.ts` turn-settled/inbox/model/grants/config listeners; add `tests/web/server-compaction-precompute.spec.ts`.

**Interfaces:** host `maybePrecompute(entry):Promise<void>` starts after durable completed turn when effective enabled + precompute enabled + eligible source + pressure≥0.65 + headroom. `compact` first validates ready candidate; pending waits 15s, then aborts/quiesces before foreground generation. Candidate adoption consumes Task 5 proof and Task 7 preview.

- [ ] **RED:** deferred scripted provider lets foreground turn B complete while summary A generates; compact adopts A, B survives, no tool duplication. Input delivered during adoption stays FIFO. PreCompact block leaves history; new custom instructions cause regeneration under reservation and run hook once. Same seed races allow only one commit.
- [ ] Run integration test RED; enforce deterministic barriers (`deferred`/condition probes), not sleeps.
- [ ] **GREEN:** separate background job map from existing maintenance reservation. At safe boundary acquire reservation, await durability, validate candidate source+seed+identities before hooks and again before end. Keep checkpoint cutoff A; update canonical identity after commit/invalidate other candidate. Auto failures dedup snapshot identity and don't stall newly queued foreground input.
- [ ] Test tail-refill no-fit/gain<256 discard before lifecycle; manual pending timeout+uncertain transport launches no overlapping request. Model/grant/provider config change after hook/restore await refuses. Completed restored candidate restart comes from eligible snapshot regeneration, not treating unpersisted candidate as ready.
- [ ] Review end-to-end crash/restart behavior; precompute remains off by default.

## Task 10: API/UI progress, metrics, docs và verification

**Files:** Modify `src/web/usage-log.ts`, `events.ts`, `server.ts`, `web/lib/api.ts`, `web/lib/types.ts`, `web/lib/project.ts`, `web/components/chat/MessageParts.tsx`, explicit compact handler in `web/App.tsx`; add `tests/web/compaction-observability.spec.ts`, extend existing project/stream specs; create `tests/web/compaction-benchmark.spec.ts`, `tests/fixtures/compaction/continuation-cases.json`; update `docs/harness.md` compact section and `docs/README.md` map.

**Interfaces:** operation events `compaction/job` carry IDs/stage/path/counts/timings/typed reason, never raw source. Foreground progress preparing/generating/applying projects independently of canonical start/end. Idle speculation is diagnostic-only and does not set Working. API typed `recovery-required` includes source confirmation; UI explicit confirmation describes estimated calls; cancellation never auto-confirms recovery.

- [ ] **RED:** SSE ready/discarded speculation not shown as user turn/Working; manual summary progress elapsed and adoption lifecycle render correctly. Failed attempt reported usage counted once, unknown usage omitted not zero, foreground context meter unchanged by speculation.
```ts
expect(projectedItems.some(item => item.kind === 'user')).toBe(false)
expect(recordedUsage.filter(record => record.kind === 'compaction')
  .reduce((total, record) => total + record.output, 0)).toBe(reportedDiscardedOutput)
```
- [ ] Run existing `web/lib/project-compaction.spec.ts`, `web/hooks/useSessionStream.compaction.spec.ts`, new observability tests RED. Derive fixture view through existing projector APIs, don't invent production return fields to satisfy tests.
- [ ] **GREEN:** map job metrics generation/blocking/adoption/queue/firstProgress/retries/re-ask/tokens/source losses; physical timing from attempt facts, never inference from usage gaps. Extend UsageKind/accounting without counting retry observations twice. UI only confirms exact recovery source fingerprint; existing success API shape remains compatible.
- [ ] Build sanitized fixtures with Vietnamese constraints, forbidden paths, pending work, failed test, ruled-out approach, verified completion and media references. Deterministic scripted latency test compares ≥7 baseline raw calls vs one normal call, no cumulative chunk outputs; quality fixture asserts expected facts/cutoff in requests and checkpoint. It cannot prove real LLM fidelity.
- [ ] Document cold/warm/restart benchmark procedure, separate target ≥70% median generation reduction and ready-candidate blocking p95≤5s excluding hooks/storage. Live runs only on approved spend/provider, same settings and fixed inputs; record candidate waste/cost/quality, no claim without evidence. Without approval label live gate pending, not passing.
- [ ] Run targeted suites → `pnpm test` → `pnpm run typecheck` → `pnpm run build:web`. Record pre-existing failures using non-destructive baseline evidence. Independent whole-change review of source coverage/durability/concurrency/grants/wire/UX, resolve verified findings and rerun tests. Do not enable precompute/live rollout automatically.
- [ ] Correct stale docs about tail N turns, start event before generation, raw fold default and output budgeting. Produce final verification report under `plans/reports/`; no commit/deploy/restart without request.

## Spec coverage matrix

| Spec sections | Tasks |
|---|---|
| 1–4 effective source/intent/safety | 1, 3, 4, 6 |
| 5 durable snapshot/restart | 2, 3, 8, 9 |
| 6 request/budget/output/completion | 4 |
| 7 fallback/legacy/extractive/recovery confirmation | 6, 10 |
| 8 speculation/config/priority/deadline | 4, 8, 9 |
| 9 adoption/hooks/canonical lifecycle/tail/stop | 5, 6, 9 |
| 10 restoration/freshness/current grants | 7 |
| 11 metrics/usage/UI | 6, 8, 10 |
| 12 correctness/fault/performance gates | all; final gate 10 |
| 13 rollout/rollback/delivery | 2, 5, 6, 9, 10 |

## Execution gate

Plan authored after spec approval; implementation remains unapproved until user reviews plan and chooses execution method. Recommend subagent-driven task-by-task with sequential ownership of shared files because a source-coverage or checkpoint-adoption bug can silently lose continuation state. Use isolated worktree at execution time; current `feat/subagent-mcp-inherit` contains unrelated dirty work. No staging or resetting that work.
