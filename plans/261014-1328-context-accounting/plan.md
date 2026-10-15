# Context Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sửa F1–F5: context measurement đúng request, replay bền vững, estimate sau compact đúng builder, cache không cộng lặp và UI/window resolver nhất quán.

**Architecture:** Giữ manifest estimate bất biến và gắn provider usage vào terminal physical attempt facts bằng contextId. Một pure reducer dùng chung cho API và historical UI; một shared host preparation path dùng cùng builder cho dispatch và prospective compact preview. Full post-compact estimate được commit cùng compaction/end, không trừ delta từ hai baseline khác nhau.

**Tech Stack:** TypeScript, Node.js fs/crypto/AsyncIterable, React hiện có, Vitest/Playwright và pnpm; không dependency runtime mới.

**Spec:** `plans/261014-1328-context-accounting/spec.md` — user approved 2026-10-14 13:46 +07:00. Đọc cả spec và plan.

**Plan status:** Chờ user review và chọn cách thực thi. Source đã đối chiếu: `main`, HEAD `b8a32c1`. Không coi approval spec là approval plan.

## Global Constraints

- Giữ estimator `ceil(chars/4)`, ảnh `1_200` tokens; không thêm tokenizer/dependency.
- Giữ output reserve `4_096`, margin `1_024`, trim order, retention, retry budget, adapter output cap và auto-compact thresholds hiện có.
- Không bật `compactionEffectiveEnabled`/`compactionPrecomputeEnabled`, không deploy/restart hoặc gọi paid provider.
- Log append-only; new metadata optional; không rewrite/migrate logs cũ, không đoán reported usage từ sessionId/time.
- Provider input gồm cached share: không cộng cachedInputTokens vào input lần nữa.
- `budget.usedTokens` và breakdown luôn estimate; window provenance riêng; tổng breakdown bằng usedTokens.
- Context sau compact là estimate độc lập, không dùng `reportedBefore - rawHistorySaving`.
- Usage physical attempt chỉ tính một lần theo attemptId; root không cộng child/maintenance vào foreground cache cohort.
- GET manifest không chạy model/hooks/read source files hoặc ghi Read observations.
- Canonical checkpoint/grants/coverage vẫn do transaction và recovery hiện có thực thi; preview metadata không cấp quyền.
- Giữ thay đổi có sẵn trong `src/harness/plugins/manifest.ts`, `tests/harness/plugin-containment.spec.ts`. Không stage/commit chúng.
- Khi bắt đầu execution tạo isolated worktree theo `superpowers:using-git-worktrees`; mang spec/plan chưa tracked sang worktree bằng file tools. Không stash/reset user files, không tự commit/push. Commit snippets không là permission: chỉ commit khi user yêu cầu.
- Verification affected tests trước rồi `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`; báo mọi failure/flaky. Không sửa skill code.

## Review Focus

1. Iterator bị consumer return sau usage nhưng trước EOF: vẫn lưu measurement một lần, không release transport ownership giả. Task 1 test consumer return/uncertain/reconciled.
2. Report terminal đến muộn sau compact hoặc reassembly: chỉ enrich historical request và totals, không resurrect reported trên current preview. Task 2 test late report + different contextIds cùng step.
3. Request controls đổi sau assembly (slash-command model, vision adaptation): window/schema/image cost phải thuộc pair/content thực gửi, không estimate của pair trước. Task 3 test command override và native/non-native vision; không đổi hành vi model selection/vision.
4. Preview await bị mode/grant/window đổi hoặc Stop: không commit preview stale; safety fit failure không bị nuốt như telemetry failure. Task 5 deferred-preview revalidation test.
5. SSE replay/live + session switching: không mất measurement trong compacted event list, không hiện count của session khác, structural sharing vẫn giữ. Task 6 + Task 7 tests.

## File map

| Unit | Files | Trách nhiệm |
|---|---|---|
| Usage/lifecycle | `llm/types.ts`, `llm/request-lifecycle.ts` | Host contextId; final valid usage on terminal attempt |
| Numeric validation | new `src/harness/context/context-metrics.ts` | Browser-safe TokenUsage/context metadata validation; không services/Node runtime |
| Context state | new `src/harness/context/context-state.ts` | Generic structural types, replay/incremental reducer, display response |
| Model budget | `llm/model-catalog.ts`, `context/budget.ts`, `context/builder.ts` | Resolver provenance, estimate honesty, same budget everywhere |
| Host preparation | new `src/web/context-assembly.ts`, `src/web/server.ts` | Shared input preparation with injected existing loaders; contextId dispatch and preview |
| Preview builder | `context/builder.ts` | Internal prospective entry point reuses one implementation, no fake canonical events |
| Transaction | `context/compaction.ts`, `web/compaction-host.ts`, `server.ts` | Async pure measure + atomic contextAfter publication + final fit validation |
| Storage/events | `session/events.ts`, `storage/events-jsonl.ts` | Additive metadata, compatible strict optional vocabulary |
| Web consumers | `web/lib/{types,api,format,project,manifest-refresh}.ts`, `App.tsx`, ContextMeter/ContextPanel/MessageParts/StepInspector/trajectory | Shared measurement projection, union unavailable, explicit labels |

Paths without prefix in this map are under `src/harness/`. Preserve existing exported types through aliases/re-exports. Do not export host preview authority from `src/index.ts`.

## Tasks

### Task 1: Durable physical-attempt usage

**Files:** Modify `src/harness/llm/{types,request-lifecycle}.ts`, `src/harness/context/builder.ts`, `src/harness/storage/events-jsonl.ts`; create `src/harness/context/context-metrics.ts`; tests `tests/harness/{request-lifecycle,attempt-events}.spec.ts`.

**Interfaces:** `ModelRequest.contextId?: string`; `ContextManifest.contextId?: string`; `AttemptFact.contextId?: string`, `usage?: TokenUsage`. `context-metrics.ts` exports `isValidTokenUsage(value: unknown): value is TokenUsage` and `isValidContextId(value: unknown): value is string`. ContextId is a host random UUID; allow `[A-Za-z0-9_-]{1,128}` for test/legacy IDs. TokenUsage keys restricted to inputTokens/cachedInputTokens/outputTokens, values safe nonnegative integers, cached≤input.

- [ ] Add RED to `request-lifecycle.spec.ts`, using existing completion/collect helpers:
```ts
const facts: AttemptFact[] = []
const owner = new LogicalRequest()
const usage = { inputTokens: 120_000, cachedInputTokens: 110_000, outputTokens: 2 }
try {
  await collect(runAttempt({ async *stream() {
    yield { type: 'usage', usage: { inputTokens: 100_000, cachedInputTokens: 50_000 } } as const
    yield { type: 'usage', usage } as const
    yield completion
  } }, { messages: [], contextId: 'ctx-1' }, {
    owner, admission: new AttemptAdmission(),
    attribution: { sessionId: 's', turnId: 't', stepId: 'step' },
    recordAttempt: async fact => { facts.push(fact) },
  }))
  expect(facts.find(f => f.state === 'end')).toMatchObject({ contextId: 'ctx-1', usage })
  expect(facts.find(f => f.state === 'start')?.usage).toBeUndefined()
} finally { owner.dispose() }
```
- [ ] Run `pnpm exec vitest run tests/harness/request-lifecycle.spec.ts tests/harness/attempt-events.spec.ts --maxWorkers=1 --no-file-parallelism`; record RED reason (new fields absent/rejected, not an unrelated timeout).
- [ ] Implement validator and hold `let usage: TokenUsage | undefined` in runAttempt. On usage event, accept last valid report; ignore malformed report without erasing previous. Add contextId and terminal usage in notify, and retained uncertain fact. Never include usage on start. Keep terminal persistence and physical ownership semantics unchanged.
```ts
if (event.type === 'usage' && isValidTokenUsage(event.usage)) usage = event.usage
// In terminal fact construction:
...(state !== 'start' && usage !== undefined ? { usage } : {})
```
- [ ] Expand JSONL attempt allowlist with contextId/usage; reject usage on start, bad IDs, extra keys, fractions, NaN/negative/cached>input. Test legacy field-free attempts still load and deriveMessages unchanged. Diagnostic for invalid live usage is static (`invalid provider token usage`) through optional safe observer, not raw payload; no error changes retry outcome.
- [ ] Add tests to existing lifecycle fixtures: provider yields usage then throws; last invalid report; iterator return immediately after usage; end then uncertain then reconciled all same attemptId/report; queued cancel without physical fact remains zero measurement. Use deferred iterator/settlement helpers already in file, not sleeps/stress.
- [ ] GREEN rerun command; `pnpm run typecheck`. Review that upstream stream events stay untouched and no per-usage fsync was added. If commit explicitly authorized: `fix(context): persist final usage on physical attempt facts`.

### Task 2: Browser-safe context reducer and event contracts

**Files:** Create `src/harness/context/context-state.ts`, `tests/harness/context-state.spec.ts`, `tests/fixtures/context-accounting.ts`; modify `src/harness/session/events.ts`, `src/harness/storage/events-jsonl.ts`, `tests/harness/attempt-events.spec.ts` and `tests/harness/storage.spec.ts`.

**Interfaces:** Use generic structural manifests, not runtime imports of builder/session. Define in context-state:
```ts
type ContextDisplayState =
  | { kind: 'request'; contextId?: string }
  | { kind: 'post-compaction'; compactionSeq: number; coversSeq: number }
  | { kind: 'unavailable'; reason: 'legacy-compaction'|'preview-failed' }
interface CacheTotals { cacheableInputTokens: number; cachedInputTokens: number }
interface UsageView extends CacheTotals { last?: TokenUsage }
interface ManifestShape {
  contextId?: string
  budget: { usedTokens: number; availableTokens: number; contextLimitTokens?: number; estimated: boolean }
  history: { setting: string }
}
type AvailableContext<M extends ManifestShape> = M & { display?: Exclude<ContextDisplayState, {kind:'unavailable'}>; usage?: UsageView }
interface UnavailableContext { display: Extract<ContextDisplayState, {kind:'unavailable'}>; usage: CacheTotals }
type ContextResponse<M extends ManifestShape> = AvailableContext<M> | UnavailableContext
interface ContextEvent<M extends ManifestShape> {
  readonly seq: number; readonly type: string; readonly turnId?: string
  readonly manifest?: M; readonly fact?: AttemptFact
  readonly coversSeq?: number; readonly summary?: string; readonly error?: string
  readonly contextAfter?: M; readonly contextEffect?: 'replaced'|'unchanged'
  readonly measurement?: CompactionMeasurement['measurement']
}
interface ContextReducer<M extends ManifestShape> {
  apply(events: readonly ContextEvent<M>[]): readonly string[] // IDs whose historical view changed
  current(): ContextResponse<M> | null
  request(contextId: string): AvailableContext<M> | undefined
}
createContextReducer<M extends ManifestShape>(sessionId?: string): ContextReducer<M>
deriveContextState<M extends ManifestShape>(events: readonly ContextEvent<M>[], sessionId: string): ContextResponse<M> | null
isAvailableContext<M extends ManifestShape>(view: ContextResponse<M>): view is AvailableContext<M>
```
Types remain readonly at public boundary; internal Maps may mutate. Cache output view references; ignored streaming chunk apply returns empty changed-ID list and current() reference unchanged. Legacy manifest use internal `legacy:<seq>` map key but never stamp fabricated contextId into source. createContextReducer accepts optional sessionId for existing web projector API: before first attributed matching fact, store manifests but no provider associations; pin sessionId on that fact and reject later foreign attribution. Server always supplies explicit session.id. Optional mode is only for a single-session event list, never cross-session aggregation.

- [ ] Fixture file exports `manifest(id?: string): ContextManifest`, `row(seq, payload): SessionEvent`, `attempt(seq, contextId, attemptId, usage, state='end'): SessionEvent`. Manifest estimate=6_000, breakdown `{systemPrompt:1000, systemTools:2000,mcpTools:0,metaContext:0,skills:0,messages:3000}`, compact history, window=256_000; attempt attribution=session `s`, turn `t`, step `step`. Import only types and no runtime Node dependency.
- [ ] RED reducer examples:
```ts
const r = createContextReducer<ContextManifest>('s')
r.apply([row(1, { type:'context/manifest', turnId:'t', manifest:manifest('a') })])
r.apply([attempt(2,'a','physical-1',{inputTokens:120_000,cachedInputTokens:110_000})])
expect(r.current()?.usage).toMatchObject({last:{inputTokens:120_000},cacheableInputTokens:120_000,cachedInputTokens:110_000})
r.apply([row(3,{type:'context/manifest',turnId:'t',manifest:manifest('b')})])
r.apply([attempt(4,'a','physical-1',{inputTokens:120_000,cachedInputTokens:110_000},'reconciled')])
const current = r.current()
expect(current !== null && isAvailableContext(current) ? current.usage?.last : undefined).toBeUndefined()
expect(r.request('a')?.usage?.last?.inputTokens).toBe(120_000)
```
- [ ] RED post-compact + late report: append successful compact with summary/cutoff/contextAfter=manifest without ID, then terminal old usage. Expect current display=post-compaction, usage.last absent, historical reported preserved. Append failed compact: current reference unchanged. Append legacy successful compact without contextAfter: unavailable; latest recent-history/explicit unchanged: current preserved.
- [ ] Run `pnpm exec vitest run tests/harness/context-state.spec.ts --maxWorkers=1`; implement reducer: association by contextId + matching session/turn and admitted provider/model when present; dedupe contribution by attemptId; first valid terminal report is final, duplicate inconsistent report diagnostic/reject rather than double-count. Totals denominator only attempts with cachedInputTokens present. New manifest resets only last association, not totals. Never mutate original manifest.
- [ ] Add event fields exactly as spec: `contextEffect`, `contextAfter`, `measurement` on compaction/end; exported type `CompactionMeasurement` from session/events contains scalar compatibility plus full metadata. Optional fields absent keep legacy decode. Validate new fields only on new vocabulary; contextAfter must have finite/safe budgets, valid whole window, breakdown sum=usedTokens, no contextId/usage; no contextAfter on failed/unchanged ends. Validate only supplied optional contextId in legacy manifests, do not impose new required fields on old logs.
- [ ] Add tests missing/zero/uncached report, invalid association, child session and maintenance no-contextId ignored; same step two contexts; duplicate uncertain/reconciled; replay vs apply prefixes; irrelevant chunks retain references; forged malformed optional metadata schema failure while old logs pass. Model projection and sourceDigest invariant assertion compares events before/after metadata additions.
- [ ] GREEN `pnpm exec vitest run tests/harness/context-state.spec.ts tests/harness/attempt-events.spec.ts tests/harness/storage.spec.ts --maxWorkers=1 --no-file-parallelism`; review browser-safe imports and aliases. If authorized: `feat(context): derive request and compact state from durable events`.

### Task 3: One window resolver and shared host assembly preparation

**Files:** Modify `src/harness/llm/model-catalog.ts`, `src/harness/context/{budget,builder}.ts`, `src/harness/llm/adaptive-vision.ts` only if needed for existing pure adapter use, `src/web/server.ts`; create `src/web/context-assembly.ts`, `tests/web/context-assembly.spec.ts`; tests `tests/harness/g3-context.spec.ts`, `tests/web/{server-g3,server-session-model,server-adaptive-vision,server-native-vision}.spec.ts`.

**Interfaces:** `resolveContextWindow(modelId: string): {tokens:number;source:'catalog'|'family'|'fallback'}` in model-catalog; existing resolveContextLimit delegates and returns tokens. `resolveModelBudget({model?:string,contextTokens?:number}): ResolvedBudget` in budget, retains existing fallback/reserve/margin, adds windowSource. Builder re-exports this one ResolvedBudget, removing duplicate declaration. `ContextManifest.budget.windowSource?` optional, estimated=true regardless verified window.

`context-assembly.ts` defines `PrefixSnapshot {key:string;skillCatalog?: BuildContextInput['skillCatalog'];memory?: readonly MemorySnippet[]}`, `PreparedAssembly {input:BuildContextInput;controls: {provider?:string;model?:string;thinkingLevel?:string;nativeVision:boolean};prefix?:PrefixSnapshot;revision:string;validate():Promise<void>;commitPrefix():void}` and `prepareContextAssembly(options: AssemblyOptions,deps:ContextAssemblyDeps):Promise<PreparedAssembly>`. AssemblyOptions = `{scope:AgentScope;events:readonly SessionEvent[];signal:AbortSignal;purpose:'dispatch'|'preview';squeeze?:number;checkpoint?:{summary:string;coversSeq:number}}`. ContextAssemblyDeps supplies six loaders: `resolve(scope):Promise<{input:Omit<BuildContextInput,'events'|'activeSkills'|'skillCatalog'|'pinnedMemory'|'attachments'>;controls:PreparedAssembly['controls'];revision:string}>`, `catalog(scope):Promise<BuildContextInput['skillCatalog']>`, `memory(scope):Promise<readonly MemorySnippet[]>`, `skills(scope):Promise<readonly ActiveSkill[]>`, `attachments(scope,events):Promise<AttachmentLookup|undefined>`, `prefix(scope):{current?:PrefixSnapshot;install(snapshot:PrefixSnapshot):void}`, plus `validate(scope,revision):Promise<void>`. Move assembly coordination into this module; injected loaders stay service closures in server and must preserve all existing source gates. No trivial wrapper that merely relocates callback name while leaving duplicated pipelines. Module has no HandlerDeps/server import cycle. Preview prefix key uses prospective cutoff, dispatch key canonical cutoff.

- [ ] RED resolver tests: operator override 32_768/512_000, invalid NaN/0/-1 ignored, namespaced known-family and unknown fallback. Extend builder test `buildContext(base({budget:{...DEFAULT_BUDGET,verified:true}})).manifest.budget.estimated === true`.
- [ ] Run `pnpm exec vitest run tests/harness/g3-context.spec.ts tests/web/context-assembly.spec.ts --maxWorkers=1 --no-file-parallelism`; add resolver and provenance preserving exact old limit values.
- [ ] Move existing preparation coordination (current server lines 3466–3668) into prepareContextAssembly and its injected loaders. Keep exposed schema ceiling/MCP degradation, disabled loader skips, memory guidance, attachments and role/skill policy. Preview uses provisional prefix object; dispatch uses installed prefix. `commitPrefix()` only invoked after successful compact durable publication. `revision` hashes controls/mode/settings/grants/instruction/source identity using existing hashes, never raw token/auth. `validate()` rereads revision-bearing sources and refuses change rather than publishing stale preview.
- [ ] Pin controls once before assembly, including existing slash-command model resolution now in agent/request. Keep agent/request as idempotent stamp of same resolved controls; no late pair change under same contextId. Preserve model selection fallback. Add internal `BuildContextInput.nativeVision?:boolean` (absent preserves old callers); when false adapt dated history messages via `textOnlyVisionFallback` before suffix-cost measurement while preserving seq mapping, and native filter DescribeImage schemas before assembly via `withoutDescribeImage`. Apply same in buildContextPreview. Reuse pure existing adapter functions, not a custom transformation; no changed model-visible vision behavior. This makes manifest/body/capture describe same message/tool bytes actually sent. Test metadata never serializes on wire.
- [ ] Stamp fresh randomUUID contextId into manifest + replacement request only in dispatch; persist context/manifest after full resolved assembly. Preview does not create manifest event or contextId. Capture remains dispatch-scoped; allowlist excludes contextId in snapshotRequestOf/compactionRequestOf. Tests two reassemblies same step produce different IDs, command-model window=override, native adapter tool absent from manifest tools, nonnative image estimate based on fallback text not discarded pixels.
- [ ] GREEN resolver/preparation plus `pnpm exec vitest run tests/web/server-g3.spec.ts tests/web/server-session-model.spec.ts tests/web/server-adaptive-vision.spec.ts tests/web/server-native-vision.spec.ts tests/harness/g5-prompt-contract.spec.ts tests/web/compaction-wiring.spec.ts --maxWorkers=1 --no-file-parallelism`. Explain any prompt-contract expectation adjustment only for already-existing vision/model behavior being measured at correct point; do not weaken trust/ordering tests. If authorized: `refactor(context): share resolved assembly inputs and model budget`.

### Task 4: Prospective compaction preview bằng cùng builder

**Files:** Modify `src/harness/context/builder.ts`, `src/harness/context/compaction.ts` types only, `src/web/context-assembly.ts`; create `tests/harness/context-preview.spec.ts`; extend `tests/harness/{compaction-restoration-context,g3-microcompact,g3-context}.spec.ts`.

**Interfaces:** Keep public `buildContext(input)` canonical-only. Extract its body to private `assembleContext(input, prospective?: PreviewCompaction)` and add internal module export (not src/index.ts):
```ts
interface PreviewCompaction {
  checkpoint: { summary: string; coversSeq: number }
  restoration?: Restored
  protectUncoveredHistory?: boolean
}
buildContextPreview(input: BuildContextInput, preview: PreviewCompaction): AssembledContext
```
Preview validates mode history=compact, summary 1..24_000 chars, cutoff is completed boundary, no open turn; no `verifiedAgainst:'committed-log'` spoof. Shared compaction wrapper/history retention/projection and restoration rendering are called from both paths. When protectUncoveredHistory=true, uncovered turn dropping or unknown loss refuses with named `compaction-preview-no-fit`; required restoration is fixed/non-droppable. Optional existing permitted losses remain typed. This is private host entry point, not a tool/API.

- [ ] Use deterministic fixture rows in context-preview.spec.ts: two closed turns, first assistant 1_100_000 chars, second small; cutoff latest closed turn, summary `SUMMARY`, budget DEFAULT_BUDGET. RED:
```ts
const input = { events: closedEvents, mode: compactMode, modeRevision:1,
  model:'scripted', providerName:'scripted', schemas:[], activeSkills:[],
  pinnedMemory:[], budget:DEFAULT_BUDGET, compactionRetainTokens:20_000 }
const before = buildContext(input)
const after = buildContextPreview(input,{checkpoint:{summary:'SUMMARY',coversSeq:cutoff}})
expect(before.manifest.budget.preTrimTokens).toBeGreaterThan(before.manifest.budget.availableTokens)
expect(after.manifest.budget.usedTokens).toBeGreaterThan(0)
expect(Object.values(after.manifest.breakdown).reduce((a,b)=>a+b,0)).toBe(after.manifest.budget.usedTokens)
expect(after.manifest.contextId).toBeUndefined()
expect(closedEvents.some(e=>e.type==='compaction/end')).toBe(false)
```
Define compactMode using BUNDLED_MODES.find(id===DEFAULT_MODE_ID) and assert history compact; reuse eventsOf pattern. Don't hardcode estimate for environment/source text.
- [ ] Run `pnpm exec vitest run tests/harness/context-preview.spec.ts --maxWorkers=1`; implement private shared path and explicit prospective restoration override. Canonical dispatch still rejects invalid checkpoint even if called after a preview. Preview mutation never alters passed events/source inputs or appends synthetic canonical success.
- [ ] Verify preview/canonical parity: after real compactSession/adoptPreparedCompaction success with same summary/restoration, call ordinary buildContext using recovered checkpoint and frozen identical inputs; compare messages/tools/budget/breakdown/history/source hashes (ignore only seq telemetry range differences). Do not compare preview with a follow-up that added a new user message.
- [ ] Add source coverage cases with tests: old microcompacted Read outputs, image/text attachments retained+tail, previous restoration replaced by new restoration body, small conversation summary growth, cutoff older than latest closed turn. Assert wrapper cost counted once and all uncovered tail messages preserved. protectUncoveredHistory with too-small override must refuse, not pass by dropping tail. Boundaries/open turn/invalid summary fail without changing canonical recovery.
```ts
expect(after.messages.filter(m=>String(m.content).includes('RESTORED_NEW'))).toHaveLength(1)
expect(after.messages.some(m=>String(m.content).includes('RESTORED_OLD'))).toBe(false)
expect(after.manifest.budget.usedTokens).toBe(canonical.manifest.budget.usedTokens)
expect(()=>buildContextPreview(tinyBudgetInput,{...preview,protectUncoveredHistory:true})).toThrow('compaction-preview-no-fit')
```
- [ ] GREEN run context-preview, compaction-restoration-context, g3-microcompact, g3-context and g5-prompt-contract sequentially; typecheck. If authorized: `fix(context): rebuild compact estimates with canonical assembly rules`.

### Task 5: Atomic post-compact state và full-window admission

**Files:** Modify `src/harness/context/compaction.ts`, `src/web/{compaction-host,server,context-assembly}.ts`; tests `tests/harness/{g3-compaction,compaction-adoption,compaction-reliability}.spec.ts`, `tests/web/{server-compaction,server-compaction-effective,server-compaction-precompute,compaction-host}.spec.ts`.

**Interfaces:** Task 2 `CompactionMeasurement`:
```ts
interface CompactionMeasurement {
  contextEffect?: 'replaced'|'unchanged'
  contextAfter?: ContextManifest
  measurement?: {
    before?: {tokens:number;basis:'reported'|'estimated';contextId?:string}
    after?: {tokens:number;basis:'estimated'}
    unavailableReason?: 'preview-failed'
  }
  tokensBefore?: number
  tokensAfter?: number
}
type CompactMeasure = (next:{summary:string;coversSeq:number}, standing:{summary:string;coversSeq:number}|undefined,
  restored:Restored|undefined) => Promise<CompactionMeasurement|undefined> | CompactionMeasurement | undefined
```
Both CompactionOptions.measure and AdoptionOptions.measure use this signature; accept synchronous callback for existing embedders. Add optional CompactionOptions.validate `():Promise<void>` for final host validation after preview. HostDeps.measure follows exact alias; HostDeps.restore unchanged. Move full safety fit into AdoptionOptions.validate after async measure; host may cache prepared preview/inputs until final synchronous revision check. Legacy telemetry failure gives replaced/unavailable; effective safety failure rejects before success append. No measure callback updates lastManifests/sessionUsage/current cache.

- [ ] RED server-compaction regression uses existing real HTTP fixture with scripted provider cumulative reports. Copy diagnosed oversized-history scenario, not entire probe file; wait for durable log boundary/idle using existing until helper. Assert compact response/end has nonzero tokensAfter, full contextAfter, estimated basis, sum invariant; restart same isolated home must return exact post-compact state before any new message.
```ts
expect(end.tokensAfter).toBeGreaterThan(0)
expect(end.tokensAfter).toBe(end.contextAfter.budget.usedTokens)
expect(end.measurement.after.basis).toBe('estimated')
expect(end.measurement.before.basis).toBe('reported')
expect(Object.values(end.contextAfter.breakdown).reduce((a:number,b)=>a+Number(b),0)).toBe(end.tokensAfter)
```
- [ ] Run RED `pnpm exec vitest run tests/web/server-compaction.spec.ts -t 'context accounting' --maxWorkers=1`. Existing production function's 0 clamp/delta must fail new assertion.
- [ ] Replace measureCheckpoint with async shared preparation + buildContextPreview and typed metadata. Historical before count comes from Task 2 reducer, no guessed usage. Preview context effect unchanged for noncompact history; replacement unavailable on loader failure, never 0 fallback. Attach contextAfter on same success event; publish provisional prefix and visible caches only after session.durable succeeds. Update manual route response to include measurement/contextEffect without exposing raw content.
- [ ] Update compactSession/adoptPreparedCompaction order:
```text
reserve → start append/barrier → summarize/restore → preview await
→ final validate/source/seed/boundary/revision check → abort check
→ success append WITH contextAfter → durable → derived prefix/cache promotion
```
Telemetry exceptions become replaced/unavailable only where safe. Keep current irreversible commit and sidecar best-effort semantics. With effective adoption require successful full preview+fit; override/no-fit throws validation error and failed end, not swallowed by measure catch. Failed end must never contain contextAfter.
- [ ] All contextWindowTokens callbacks use Task 3 resolver. Modify `src/web/compaction-precompute.ts` and `tests/web/compaction-precompute.spec.ts`: `PrecomputeDeps.assess(sessionId,prepared,signal):Promise<'no-gain'|'no-fit'|undefined>`, `start(snapshot,parent):Promise<boolean>`, `takeReady(sessionId,signal):Promise<PreparedSummary|undefined>`. Update every caller/assertion to await; startCandidate catches its promise without blocking next chat. Preserve per-session job identity across await, recheck abort/staleness/jobs.get(sessionId)===capturedJob before delete/reuse/start, and prevent two concurrent starts claiming a slot. waitPending awaits takeReady. Assessment uses full shared inputs/restoration and current override; final transaction validation is authoritative. Test deferred assess concurrent start, cancellation/delete during await, tail refill, override changed and no-gain. Minimum-gain remains 256 estimated tokens on the same eligible-conversation basis, not reported-vs-estimated; full fit additionally required. If sources/restore cannot be safely prepared, refuse candidate/adoption, not permissive fallback.
- [ ] Add deferred-preview race in compaction-adoption/host tests:
```ts
let release!:()=>void, entered!:()=>void
const gate = new Promise<void>(resolve=>{release=resolve})
const measureEntered = new Promise<void>(resolve=>{entered=resolve})
let valid = true
const running = adoptPreparedCompaction(session, checkpoints, prepared(session), options({
  measure: async()=>{entered();await gate;return {contextEffect:'replaced' as const,contextAfter:manifest()}},
  validate: async()=>{if(!valid)throw new Error('context revision changed')},
}))
await measureEntered
valid = false; release()
await expect(running).rejects.toThrow('context revision changed')
expect(endEvents(session).some(e=>!e.error)).toBe(false)
```
Repeat deterministic branches for Stop and durable failure using existing injected SessionStore fixture; old visible meter unchanged. Late Stop after canonical success still commits estimate. No-op/failed compact no state mutation. Context-only preview failure in legacy returns successful checkpoint+unavailable metadata. Tests mode recent unchanged, attachments from covered range, source prefix refresh after compact, live grants shrinking, window override changed during generation; SSE contains metadata only, restoration body remains redacted.
- [ ] GREEN affected command above plus all compaction-adoption/host/precompute/effective suites, sequential. Keep rollout flags defaults and summary request prefix equality tests. If authorized: `fix(context): commit full post-compaction estimates atomically`.

### Task 6: Manifest API replay và historical projector parity

**Files:** Modify `src/web/server.ts`, `web/lib/{types,api,project,manifest-refresh}.ts`, `web/components/workbench/trajectory.ts`; tests `tests/web/{server-usage,server-g3,sse-resume}.spec.ts`, `web/lib/{api-stream,project-sharing,manifest-refresh}.spec.ts`, `web/components/workbench/trajectory.spec.ts`; create `tests/web/server-context-accounting.spec.ts`.

**Interfaces:** Keep ContextManifestView shape for available historical assembly, adding optional contextId/windowSource/display/usage. Define `ContextView = ContextResponse<ContextManifestView>` imported type from shared reducer; `fetchManifest(...):Promise<ContextView|null>`. SseEvent gets optional contextAfter/contextEffect/measurement. `ContextReducer` from Task 2 accepts structural SseEvent/SessionEvent. For projector without supplied sessionId, derive trusted session identity from first matching attributed terminal fact **within that session event list**, then pin it; don't merge foreign attribution. Server passes explicit session.id.

- [ ] RED live/restart cache test: one physical stream reports 100k/50k then 120k/110k. After durable completion, API usage totals=120k/110k and reported=120k; Settings single record=120k/110k. Close only isolated server, reopen same home, assert same current view/count/basis/totals. Read durable context/manifest+model/attempt from log, projectItems/projectTrajectory and assert historical manifest usage.last=120k.
- [ ] Run `pnpm exec vitest run tests/web/server-context-accounting.spec.ts web/lib/project-sharing.spec.ts web/components/workbench/trajectory.spec.ts --maxWorkers=1 --no-file-parallelism`; record meaningful RED.
- [ ] Replace API composition from lastManifests+sessionUsage by per-session reducer cache. For GET, apply only suffix up to committedSeq; cache tracks last applied seq, reset if event prefix replaced/session instance changed. Preserve existing assembly/start fast display: estimate may use latest live manifest but never publish appended-not-durable compact success as canonical. At committed terminal/compact event, replay suffix catches up. Session delete removes reducer cache for root+children. Keep lastManifests only for existing fresh auto pressure/capture; no fabricated compact delta mutation.
- [ ] Remove recordUsage(sessionUsage) on each stream chunk and sessionUsage map contract. Cost logger validates last report then writes once in finally; session foreground cache comes solely from reducer. Same last-valid-report policy as lifecycle. No extra read of production usage.jsonl to guess old request associations.
- [ ] createProjector owns incremental reducer and contextId→marker index. On measurement changed-ID list, update only existing marker showing that exact assembly using touch(); marker folded to later assembly in same turn never goes backwards. projectTrajectory derives request views from shared reducer and enriches trace manifests by ID, including completed earlier trace if late event arrived. No per-chunk recreation of all marker objects. Compaction metadata updates only current view; historical traces keep their own reported data.
- [ ] manifestRefreshKey checks terminal fact with valid usage/contextId on model/attempt/end or execution uncertainty/reconcile; not start/no-usage attempts or assistant/chunk. Tests partial chunks key unchanged. Existing step/turn/compaction triggers stay for backward compatibility.
```ts
expect(manifestRefreshKey([manifestEvent, terminalWithUsage],0)).toBe(`${terminalWithUsage.seq}:0`)
expect(manifestRefreshKey([manifestEvent, attemptStart, assistantChunk],0)).toBe(`${manifestEvent.seq}:0`)
const before = projector.apply(assemblyEvents)
const after = projector.apply([terminalWithUsage])
expect(after[userIndex]).toBe(before[userIndex])
expect(after[contextIndex]).not.toBe(before[contextIndex])
```
- [ ] Close observed SSE durability gap: current session/event broadcasts append before barrier. Modify `src/harness/session/session.ts` to emit additive `'session/durable'(session,lastSeq)` after committedLog update, isolated observer failures like session/event and without replacing existing service durableListener. In server live SSE, when successful compaction/end is uncommitted, queue it AND later events until committedSeq covers it; drain in seq order on session/durable, unsubscribe on close. Normal chunks before this rare gate still stream immediately. compactReplayEvents truncates fresh/resume capture at the first uncommitted successful compaction/end; snapshot/resume cursor MUST name last included seq, not raw latest, so reconnect cannot skip held event. Capture gate transitions without a subscribe/replay race using same synchronous append cursor setup. Do not await durable from append listener or add a barrier per token. Add `tests/harness/storage.spec.ts` and `tests/web/sse-resume.spec.ts` with deferred store.flush: compact success append invisible until release; rejected flush never publishes it; other streaming chunks stay live. API also uses committed success only. This gate prevents frontend reducer from showing uncommitted post-compact state.
- [ ] Test replay profile vs live SSE preserves optional metrics, no raw prompt bodies; encoded API union unavailable vs pre-request204; old log manifest no usage estimate and legacy compact unavailable; same contextId conflicting provider/model not associated; root vs child separation; same owner.id multiple assembly IDs; poisoned durability won't publish successful compact current state.
- [ ] GREEN API/projector/trajectory/SSE suites; typecheck may need Task 7 union consumer changes, which must land in same release (do not ship mixed API/client). If authorized after Task 7 compatibility: `fix(context): replay measurements consistently across API and history`.

### Task 7: Honest UI states, docs và final verification

**Files:** Modify `web/App.tsx`, `web/lib/{format,types,api}.ts`, `web/components/{composer/ContextMeter,layout/ContextPanel,chat/MessageParts,workbench/StepInspector}.tsx`; create `web/lib/context-view.ts` only if needed for shared guards/labels rather than repeated conditional logic. Tests `web/components/composer/context-meter.spec.tsx`, `web/components/chat/context-marker.spec.tsx`, `web/components/workbench/step-inspector.spec.tsx`, `web/lib/product-ui.spec.tsx`; add `web/lib/context-view.spec.ts`; update `docs/{prompt-contract,harness}.md`; test browser via existing `playwright.config.ts` fixture approach.

**Interfaces:** `contextFill` accepts only available manifest; unavailable guarded by isAvailableContext before call. `compactionTokenChange` reads measurement basis; old scalar-only event is legacy estimate, not falsely reported. Current UI props take ContextView|null and optional loading state; historical marker/inspector remain available request manifests. Do not spread response unavailable into ContextManifestView via casts.

- [ ] RED UI tests: verified override no usage → estimated, reported total + estimate total both visible, breakdown rows unchanged; post-compaction estimate distinct label; unavailable displays explanatory text and no `0 / window`; historical reported trace remains reported after current compact. Use existing jsdom mount/Menu open helpers, act and automatic JSX runtime.
```tsx
await openMeter({ ...MANIFEST, display:{kind:'post-compaction',compactionSeq:40,coversSeq:30} })
expect(host.textContent).toContain('After compaction')
expect(host.textContent).toContain('estimated')
await openMeter({display:{kind:'unavailable',reason:'legacy-compaction'},usage:{cacheableInputTokens:0,cachedInputTokens:0}})
expect(host.textContent).toContain('Context estimate unavailable')
expect(host.textContent).not.toContain('0 /')
```
- [ ] Run `pnpm exec vitest run web/components/composer/context-meter.spec.tsx web/components/chat/context-marker.spec.tsx web/components/workbench/step-inspector.spec.tsx web/lib/context-view.spec.ts web/lib/product-ui.spec.tsx --maxWorkers=1 --no-file-parallelism` for RED/GREEN. Implement shared labels: Last request; After compaction · estimated; Estimated source tokens; Session average cache hit rate. Model/window shown from measurement manifest, not current controls picker. Add optional API `policy:{automaticCompactionPressure:number}` only when configured >0, outside durable manifest so it is explicitly current policy metadata. Extend ContextResponse client views with optional policy; pressure=(manifest.budget.preTrimTokens??usedTokens)/availableTokens for available state, never recompute from picker. Ring visual ratio may clamp but numeric count remains actual if exceeds window.
- [ ] App stores manifest with owning `{workspaceId,sessionId}` and loading state. On session change synchronously render loading rather than previous ownership's value; keep cancellation/currentRef/workspaceRef guards and 150ms refresh debounce. Test stale fetch resolves after switch with deferred promises; selected new session sees neither old count nor zero. API failure→unavailable/error label; brand-new204→no recorded request, not error.
- [ ] Compaction UI/toast labels each before/after basis; no claimed exact percent savings when reportedBefore/estimatedAfter. Request with more summary/restore may increase estimate. Show typed unavailable reason without raw error/provider secrets.
- [ ] Update docs normative accounting: identity/terminal usage, cached input inclusion, raw-policy vs ring distinction, final estimate/provider report, post-compact preview/legacy unavailable, GET no assembly, request-vs-current labels. Existing `docs/harness.md` measurement prose claiming reported-minus-saving must be replaced, not left contradictory. Link shared reducer tests in prompt-contract.
- [ ] GREEN all changed UI/projector/API/compaction tests. Run `pnpm test`, `pnpm run typecheck`, `pnpm run build:web` and capture exit statuses. No paid-provider probes. Existing audit probe assertions assert **old bugs**, so never use its old exit0 as a fix gate: replace its evidence with formal regression tests; keep report artifact marked historical or update probe assertions explicitly to fixed contract.
- [ ] Create `tests/browser/context-accounting.e2e.ts`, using workbench-nav helpers but real isolated server: beforeAll mkdtemp and `createWebServer({home,configFile:path.join(home,'p.json'),staticDir:path.resolve('web-dist'),providers:[scripted]})`, navigate `server.url`, afterAll close+rm. No fake EventSource, API interception or Vite proxy; same-origin built assets and real SSE. Assert request estimate→reported, matching StepInspector, compact→estimated, page reload/reconnect and session switching. Run after build: `pnpm exec playwright test tests/browser/context-accounting.e2e.ts --workers=1`. Existing global Vite fixture may start unused; don't alter global config. No live product restart, no paid provider; screenshots only on failure. If browser setup unavailable, report blocker rather than claiming smoke passed.
- [ ] Final fresh review against spec and diff; verify no user-owned files changed and no flags/defaults/dependencies altered. Report exact affected/full test results and any baseline flaky failures without hiding them. If authorized: `fix(web): label request and compact context measurements honestly` then reviewed integration commit; otherwise leave scoped changes uncommitted.



## Spec coverage and release gates

| Spec section | Tasks | Gate |
|---|---|---|
| §1–4 mục tiêu/metrics/invariants | 1,2,3,4 | numeric validity, estimate sum, typed basis |
| §5 identity/durable usage/cache | 1,2,3,6 | last-valid report, per-attempt dedup, retry IDs, restart parity |
| §6 reducer/API/legacy | 2,6,7 | current vs historical, union unavailable, no fabricated usage |
| §7 preview/publication | 4,5,6 | same builder inputs, atomic end, storage/SSE crash barrier |
| §8 resolver/full fit | 3,5 | overrides for generation/adoption; fixed+tail+restore fit |
| §9 pressure/UI | 6,7 | separate pressure; request labels; model/session switching |
| §10 compatibility/privacy | 1,2,4,6 | old logs, strict optional fields, no wire/digest/history metadata |
| §11 acceptance matrix | 1–7 | unit + real HTTP/disk + focused browser smoke |

Execution order is 1 → 2 → 3 → 4 → 5 → 6 → 7. Tasks share event/assembly contracts and `server.ts`; do not run independent workers editing these files simultaneously. Task 6 API union and Task 7 consumer changes cannot be released independently. Each task has its own RED/GREEN evidence; final branch review must inspect all seven together.

Mandatory final commands:
```bash
pnpm test
pnpm run typecheck
pnpm run build:web
pnpm exec playwright test tests/browser/context-accounting.e2e.ts --workers=1
```
Report passed/failed scope precisely. Baseline flaky failures require a scoped reproduction or clean-base comparison, not an assertion downgrade. No full-suite success claim if exit nonzero; no live spending/restart to satisfy browser gate.

## Plan self-review

- All five audit findings have an owning task: F1=4/5; F2=1/2/5/6; F3=2/6/7; F4=1/2/6; F5=3/5.
- Extra attention from current source: command-model/vision transformation must not make manifest describe different content than dispatch; this is measurement alignment, not a new vision feature.
- Strict JSONL attempt allowlist must expand with metrics before producing them; optional legacy records remain supported.
- Consumer return/late reconciliation and asynchronous candidate assessment have deterministic ownership/race tests, not stress loops.
- SSE success visibility must follow durability, because the existing session/event is append visibility only.
- The old diagnostic probe intentionally proves old bugs; formal new regression tests replace it as the fix verification source.
- New files have bounded responsibilities; no generic telemetry ledger, duplicate builder, paid benchmark, flags/default changes or unrelated workbench/plugin edits.

## Execution handoff

Recommended: **Native** execution in this session using executing-plans, because the seven tasks depend tightly on the same contracts and preparation path. Keep sequential TDD and a fresh whole-branch review at the end. Subagent-driven execution is valid if user wants task-by-task independent review; it costs more context and still must serialize shared-file changes.

Before any Agent call, load pinning-subagent-models and ask the user for the model group if none has been chosen. No delegate has been spawned for planning. User must review this plan and choose Native or Subagent-driven before implementation starts. No source edits, commits, push or restart have been authorized by this plan artifact.

