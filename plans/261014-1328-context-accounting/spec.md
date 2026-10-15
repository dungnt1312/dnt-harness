# Spec đề xuất: Context accounting nhất quán

- Trạng thái: **User đã duyệt spec ngày 2026-10-14 13:46 +07:00 (“Làm theo đề xuất”); chờ duyệt implementation plan và cách thực thi**.
- Ngày: 2026-10-14 (+07:00).
- Source khi soạn spec: HEAD `a41df5e`, branch `feat/workbench-three-tier`. Khi lập plan: `main`, HEAD `b8a32c1`.
- Bằng chứng: `plans/reports/debug-261014-1321-context-accounting.md` và probe cùng thư mục.
- Phạm vi: context accounting của web host, shared event/lifecycle contracts và các UI đọc chúng. Không cam kết headless compaction parity.

## 1. Mục tiêu và cách tiếp cận

User yêu cầu đề xuất spec xử lý luồng context không đồng nhất. Kết quả mong muốn: số hiển thị giải thích được, gắn đúng request/state, không nhảy về baseline cũ sau restart, không về 0 giả sau compact, và cache totals không cộng lặp.

Ba phương án:

| Phương án | Ưu điểm | Hạn chế |
|---|---|---|
| **A. Request-scoped measurement + replay từ log (đề xuất)** | Xử lý đủ lỗi, giữ số provider báo, audit được request nào | Thêm metadata additive vào manifest/attempt/compaction events; cần một reducer dùng chung |
| B. Chỉ vá công thức compact và cache totals | Ít thay đổi nhất | Không giải quyết restart và API khác StepInspector |
| C. Mọi UI chỉ dùng estimate | Dễ đồng nhất | Bỏ số thực đã có; vẫn không đúng tokenizer và khó phản ánh context thực |

Chọn A nhưng không xây framework telemetry mới: tận dụng `context/manifest`, `model/attempt`, `execution/uncertain|reconciled`, `compaction/end` và JSONL hiện có.

## 2. Phạm vi và non-goals

Bao gồm F1–F5 trong báo cáo: baseline sau compact, durable usage/state, UI parity theo request, cache totals, window override parity.

Không thay estimator chars/4 bằng tokenizer; không thêm dependency; không đổi trim order, retention, summary generator, policy/grants, retry budget, output-cap policy hay threshold auto-compact. Không bật effective/precompute, không restart/deploy, không gọi paid provider. Không sửa history cũ, không migration rewrite JSONL. Không refactor subsystem ngoài các integration bắt buộc.

## 3. Các khái niệm phải tách rõ

| Dữ liệu | Ý nghĩa | Độ chính xác |
|---|---|---|
| `budget.usedTokens` | Estimate toàn input sau trim của **một assembly** | Luôn estimated, kể cả operator window verified |
| `budget.preTrimTokens` | Estimate input trước microcompact/drop | Estimated; dùng pressure policy hiện có |
| `breakdown` | Phân bổ estimate cùng assembly | Tổng bằng usedTokens |
| `usage.inputTokens` | Provider count của đúng attempt gửi assembly đó | Reported; cached tokens đã nằm trong input, không cộng thêm |
| `contextLimitTokens` | Whole window của effective provider/model | Override hoặc catalog/family/fallback; provenance riêng |
| Post-compact preview | Estimate input nếu tiếp tục với checkpoint mới và chưa có input mới | Không phải request đã gửi; không có reported usage |
| Cache totals | Tổng usage của các foreground agent attempts có cache report trong session | Không gồm child session khác hoặc compaction maintenance |

Không gọi verified window là verified token estimate. `budget.estimated` của manifest mới luôn true; thêm `windowSource: 'override'|'catalog'|'family'|'fallback'` để giải thích window. Legacy reader vẫn chấp nhận field cũ.

## 4. Invariants bắt buộc

1. Một usage chỉ được ghép với đúng assembly identity và attempt identity; turnId hoặc sessionId một mình không đủ.
2. Final estimate = tổng breakdown. Không sửa mỗi messages row bằng delta từ baseline khác.
3. Reported count không thay budget.usedTokens/breakdown; nó là measurement riêng.
4. Context sau compact không dùng reported usage của request trước compact. Không có công thức `reportedBefore - rawHistorySaving`.
5. Replay committed log cho cùng state phải cho cùng số/basis/model/window/cache totals như runtime, không đọc lại filesystem để dựng số lịch sử.
6. Nhiều usage reports trong một physical stream: report hợp lệ cuối thắng; attempt chỉ contribute một lần.
7. Usage của attempt cũ được tính trong cache totals nhưng không thay current assembly mới hơn.
8. Child, tool-internal model call và summary maintenance không được thay foreground meter của root.
9. Canonical compaction commit là authority; preview không được hợp thức hóa checkpoint, thay coverage hay cấp quyền.
10. Số không biết phải là unavailable/absent, không thành 0. 0 chỉ hợp lệ nếu nội dung thực được đo là rỗng.

## 5. Identity và durable measurement

### 5.1 Assembly identity

Thêm optional `contextId` vào ContextManifest và host-only ModelRequest metadata. ID mới được cấp mỗi lần assembly, kể cả reassembly cùng step sau overflow/retry. Không dùng LogicalRequest.id làm assembly identity: owner hiện tại tồn tại qua nhiều reassembly.

`context/manifest` giữ turnId hiện có và manifest.contextId. Không cần thêm stepId vào AgentScope: core stream attribution đã có sessionId/turnId/stepId; việc ghép làm khi dispatch. Manifest cũ không có contextId vẫn đọc được.

contextId không serialized lên provider wire, không là prompt text, không ảnh hưởng prefix hash/cache hay snapshot sourceDigest. Compaction snapshot chỉ giữ các model-visible/control fields vốn có, không mang identity của request nguồn sang summary call.

### 5.2 Tận dụng attempt facts hiện có

Extend `AttemptFact` additive:

```ts
interface ContextAttemptMeasurement {
  readonly contextId?: string
  readonly usage?: TokenUsage
}
// AttemptFact carries these optional fields alongside existing attemptId,
// requestId, attribution, provider/model and lifecycle state.
```

`runAttempt` giữ usage hợp lệ cuối của stream, lấy contextId từ request, và đính vào terminal attempt fact (`end` hoặc `uncertain`; `reconciled` có thể lặp cùng fact nhưng không được tính lại). Đây là điểm có physical attemptId và attribution chính xác, không đoán từ ambient scope hay latest manifest map.

Agent `recordAttempt` hiện đã append và flush fact vào log. Giữ đường đó làm nguồn durable, không thêm fsync theo token hoặc theo từng usage chunk. Measurement phải được ghi trước khi chuyển sang step mới/step-abandoned/turn-end. Consumer hủy iterator hoặc error sau usage vẫn giữ last report trong terminal fact; stream không báo usage thì omit.

Usage validation: finite, nonnegative integer; cached ≤ input. Invalid report bị bỏ qua và có diagnostic không chứa raw provider data; không clamp âm/NaN thành 0. Report hợp lệ trước đó vẫn được giữ nếu report cuối malformed.

Physical terminal fact có report là bằng chứng provider count, kể cả attempt không tạo final answer. Không suy attempt thành công chỉ từ usage.

### 5.3 Cost log và cache totals

Web cost logger chỉ fold report cuối một lần/physical stream, như usage.jsonl hiện đang làm; không cộng session cache totals mỗi usage chunk nữa. Không tạo billing store thứ hai.

Context reducer tính cache totals từ terminal attempt facts có attribution thuộc đúng session và contextId ghép được với agent manifest. Dedupe bằng attemptId (end/uncertain/reconciled). Retry attempts khác ID được tính riêng; duplicate terminal fact không tính hai lần.

Bỏ qua compaction/tool-internal stream không có matching agent contextId. Root không cộng child usage. Settings Usage chỉ so sánh với meter khi đã lọc **cùng session và foreground attempt cohort**; tổng Usage có maintenance/children không buộc bằng meter.

## 6. Reducer dùng chung và API

Thêm một pure context-state reducer dùng được bởi server và frontend, không import Node-only modules, services hoặc filesystem. Nó nhận events, trả current state, measurement theo contextId và session cache totals. Server có incremental cache để không scan toàn log mỗi GET; replay và incremental phải tương đương. Reducer kết hợp request estimate với reported usage theo identity, không rewrite manifest nguồn.

Reducer transitions:

| Event | Current state | Historical state |
|---|---|---|
| context/manifest mới | Assembly mới, estimate; bỏ association reported cũ | Lưu assembly theo contextId |
| Terminal attempt fact có usage | Reported chỉ khi current kind=request và matching contextId; không thay post-compaction/unavailable | Attach đúng contextId, không attach theo vị trí gần nhất |
| Successful compaction/end có contextAfter | Post-compact estimate | Request lịch sử giữ measurement cũ |
| Successful compaction/end áp dụng cho compact-history nhưng thiếu contextAfter | Unavailable, không quay về request trước compact | Giữ historical requests |
| Failed/noop compaction | Không đổi current state | Không quảng bá preview |
| Measurement đến muộn cho context cũ | Không thay current state | Cập nhật đúng request cũ; cache totals một lần |

Extend response hiện tại `/manifest` bằng display-state union, không đổi URL:

```ts
type ContextDisplayState =
  | { kind: 'request'; contextId?: string }
  | { kind: 'post-compaction'; compactionSeq: number; coversSeq: number }
  | { kind: 'unavailable'; reason: 'legacy-compaction' | 'preview-failed' }
```

Với request/post-compaction khả dụng, response 200 giữ shape manifest hiện tại, bổ sung `display`; request state ghép usage.last chỉ khi matching identity. Với unavailable, response 200 là `{ display: { kind: 'unavailable', reason }, usage: { cacheableInputTokens, cachedInputTokens } }`, không có budget/breakdown/usage.last. Đây là **một mở rộng union của API**, không phải bảo đảm mọi response còn nguyên required manifest fields: `fetchManifest` và tất cả consumers phải cập nhật đồng bộ trong cùng release. Request/preview có manifest vẫn backward-compatible về fields. Trước request đầu giữ 204 hiện có.

Legacy: manifest không có contextId hiển thị estimate theo seq; không suy usage từ record Usage chỉ có sessionId/time. Legacy compaction có scalar tokensAfter nhưng thiếu full estimate không dựng breakdown giả hoặc trộn manifest cũ. UI báo chưa có estimate khả dụng cho state này đến request tiếp theo.

## 7. Context sau compact: tính lại, không trừ delta

### 7.1 Shared assembly preparation

Tách phần chuẩn bị BuildContextInput hiện trong server thành collaborator hẹp dùng chung cho dispatch và compact preview. Không tạo builder thứ hai. Input bao gồm effective controls, mode/revision, exposed schemas, prompt overrides, grant guidance, workspace instructions, catalog/memory snapshot, role/skills, attachment content và environment.

Preview sau compact:

- Dùng `buildContext` và cùng final-text/schema/history cost rules.
- Dùng history khi transaction đã đóng, **không thêm user message giả**; final answer được giữ theo retention hiện tại; preserve uncovered tail.
- Squeeze reset về 0 cho preview một future request mới; current request window không bị thay bằng squeeze window.
- Đọc sources theo policy của request sau checkpoint mới, gồm refresh catalog/memory ở prefix mới. Chuẩn bị snapshot riêng và chỉ promote sau commit; preview lỗi không poison snapshot runtime.
- Attachments được load theo assembly policy, kể cả retained covered messages và uncovered tail, không chỉ delta dùng cho summarizer.
- Restoration đo từ **wrapped model-visible body**, không cộng raw restored.tokens lần nữa; thay restoration cũ theo checkpoint mới.

Builder cần internal prospective-compaction input để preview checkpoint/restoration **chưa canonical committed**. Nó chỉ được host transaction cung cấp sau boundary/summary/seed validation. Không giả mạo committed-log attestation, không append success event tạm để lừa canonical recovery. Dispatch production vẫn chỉ chấp nhận checkpoint recover từ committed log. Shared history/message projection phải dùng cùng logic cho cả hai đường.

### 7.2 Atomic publication

Extend successful `compaction/end` optional field:

```ts
readonly contextEffect?: 'replaced' | 'unchanged'
readonly contextAfter?: ContextManifest // estimate only, no contextId/report
readonly measurement?: {
  readonly before?: { tokens: number; basis: 'reported'|'estimated'; contextId?: string }
  readonly after?: { tokens: number; basis: 'estimated' }
  readonly unavailableReason?: 'preview-failed'
}
```

Measurement callback trở thành async, **pure đối với visible meter**; nhận prospective checkpoint và full restoration input, không chỉ restoredTokens scalar. Nó trả full estimate trước success append. Sau awaits phải revalidate model/mode/grants/source snapshot và no-open-turn để không commit estimate đã stale. Giữ exclusion/reservation đến durability barrier.

contextAfter nằm cùng canonical success event để không có crash gap giữa checkpoint success và context update. Chỉ sau end durable mới update current cache. Failed/cancelled transaction trước commit không đổi meter; late Stop sau commit tuân theo irreversible commit rule hiện có.

Giữ scalar tokensBefore/tokensAfter để tương thích, nhưng đi kèm basis. tokensAfter = contextAfter.budget.usedTokens; nếu preview unavailable thì omit, không fallback phép trừ. Không trình bày hai scalar khác basis thành phần trăm tiết kiệm chính xác. Compaction không được bắt buộc giảm số reportedBefore → estimatedAfter vì hai phép đo khác tokenizer/basis.

Preview failure không tự làm mất successful legacy checkpoint: ghi unavailable state và diagnostic. Với effective adoption, **fit/coverage validation vốn là safety check** phải độc lập fail closed trước commit; không nuốt no-fit vào telemetry failure. New success event ghi `contextEffect: 'replaced'` khi history compact đọc checkpoint, `'unchanged'` khi mode không đọc checkpoint; unchanged giữ meter và không publish contextAfter. Legacy end thiếu contextEffect dùng history.setting của latest manifest để xác định checkpoint có tác động; không đọc mode mới từ disk để suy lại lịch sử.

## 8. Resolver window thống nhất

Một pure resolver nhận effective provider/model và provider settings snapshot, trả ResolvedBudget và windowSource. Dùng cho request builder, CompactionHost, assertFitsWindow/precompute và candidate fit assessment.

Ưu tiên giữ nguyên: valid contextTokens override → exact catalog → known family → fallback. Provider/model không hợp lệ giữ behavior fail-closed hiện có. Giữ outputReserve=4.096 và margin=1.024 trong phạm vi này; compaction summary vẫn có outputTokens riêng và adapter clamp hiện tại.

Candidate fit không được chỉ so conversation estimate với whole window. Phải xét fixed sources + summary + retention + uncovered tail + restoration, dùng cùng preview inputs. Với effective adoption không được drop uncovered tail/required restoration chỉ để đạt fit; giữ invariant existing spec. Window override thay trong lúc candidate pending phải được revalidate khi adoption, không chỉ lúc generation.

## 9. Chính sách pressure và UX

Không thay auto pressure contract:

```text
ringRatio = (matching reported input OR current estimate) / wholeWindow
policyPressure = preTrimEstimate / usableInputBudget
```

UI hiện rõ:

- Request state: `Last request`, model/window của request đó, badge `reported` hoặc `estimated`.
- Post-compact state: `After compaction · estimated`; không nhận reported badge của request cũ.
- Breakdown: `Estimated source tokens`; hiển thị cả tổng estimate khi khác reported total, không scale row để giả số thực.
- Cache: `Session average cache hit rate`; không phải phần context được giảm bởi cache.
- Nếu policy bật, expose policyPressure/threshold trong chi tiết với nhãn riêng; không vẽ ring theo pressure.
- Đổi model/mode chưa có request mới: tiếp tục label last request và controls/model của measurement, không ghép numerator cũ với window model mới.
- Chuyển session: state cũ không được hiện như của session mới; loading rõ và guard theo workspace/session identity. Giữ request cancellation/ref checks hiện có.

Composer và ContextPanel đọc current reducer state. Chat marker và StepInspector đọc historical request state từ **cùng reducer**. Khi chọn cùng request, raw count/basis/window phải giống nhau; sau compact current meter khác historical inspector là hợp lệ và phải có nhãn.

Refresh key bổ sung terminal measurement attempt facts; partial stream chunks không trigger manifest HTTP refetch. Reducer update phải giữ structural sharing; không làm mọi message rerender mỗi chunk.

## 10. Compatibility, privacy và vận hành

- Metadata additive; old logs không bị rewrite, new readers chấp nhận old records. Kiểm thử old-reader fallback nơi có supported contract, không cam kết old binary hiểu UX mới.
- JSONL validation cho contextId/usage/contextAfter phải reject malformed authority/metrics đúng corruption policy; valid legacy records vẫn load.
- SSE numeric metadata được phép; không đưa raw prompt, attachment bytes, file body, auth hoặc provider headers vào các field mới. Existing body routes/redaction giữ nguyên.
- Model history projection bỏ qua telemetry mới. Snapshot digest không được đổi chỉ vì context metadata.
- GET manifest không gọi model, chạy hooks, ghi Read observations hay read source files để dựng lại lịch sử.
- Không thêm DB, không migration data, không tự bật flags hoặc live restart. Triển khai rollout-off vẫn phải sửa legacy compact measurement.

## 11. Acceptance và regression matrix

| Ca | Kết quả bắt buộc |
|---|---|
| Untrimmed request, provider có/không usage | reported khi có matching report; estimate khi không; breakdown sum=usedTokens |
| Verified operator window, chưa có usage | badge estimated; windowSource override |
| Two cumulative reports một stream | chỉ report cuối cho cache/cost contribution; 110k/120k=91,67%, không 160k/220k |
| Retry/reassembly cùng step | contextId mới; measurement cũ không thay context mới; attempts tính riêng |
| Abandoned step và late usage | attach đúng historical assembly; không overwrite latest |
| Failed/uncertain stream có usage | report giữ với outcome, terminal fact dedup; không giả success |
| Child/internal/summary calls | không thay root context; maintenance không tính root cache cohort |
| API vs chat marker vs StepInspector | cùng contextId cho cùng count/basis/window sau reload |
| Host restart sau request reported | numeric/basis/cache totals giống trước restart |
| Trimmed history lớn rồi compact | estimate mới bằng full builder projection; không 0 giả; rows sum đúng |
| Microcompact trước compact | không trừ saving của tool outputs vốn đã cleared |
| Compaction restoration thay bản cũ | wrapped cost được tính đúng một lần |
| Covered attachments + later tail | cùng loading/projection với next request; không mất cost ảnh/text |
| Candidate cutoff cũ + later turns | tail được tính và giữ; no-fit refuse theo override + full fixed cost |
| Crash trước/ở/sau success barrier | only canonical durable success cập nhật state; không về stale pre-compact manifest |
| Compact failed/noop/late Stop | no premature meter mutation; commit rule giữ nguyên |
| Legacy log thiếu usage/contextAfter | estimate lịch sử hoặc unavailable sau compact; không fabricate reported |
| Model/window override đổi | same resolver cho assembly/generation/adoption; không stale numerator/new denominator |
| Small conversation summary lớn hơn history | cho phép estimate tăng, không báo negative saving giả |
| Session switching và SSE reconnect | không lộ meter session khác, replay/incremental equivalent |
| Prompt contract | metadata không lên wire/history; message text/order/grants unchanged |

Với equality preview và request kế tiếp: so bằng **cùng inputs** trước khi thêm message mới và khi sources không đổi. Không buộc bằng reported tokenizer count, không buộc bằng một request đã thêm user message/time mới.

Verification khi triển khai: regression RED trước từng fix; affected tests trước, sau đó `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`. Browser smoke kiểm tra các surface, session switch, compact và reconnect bằng isolated scripted provider. Failure/flaky phải báo riêng, không đổi assertion để làm xanh. Live paid benchmark không là điều kiện cho accounting correctness và không được chạy tự động.

## 12. Bề mặt dự kiến và thứ tự triển khai

Các integration chính: `src/harness/context/{builder,budget,compaction}.ts`, `src/harness/llm/{types,request-lifecycle}.ts`, `src/harness/session/events.ts`, `src/harness/storage/events-jsonl.ts`, `src/web/{server,compaction-host,compaction-generator}.ts`, web types/format/project/trajectory/manifest-refresh/ContextMeter/ContextPanel/StepInspector/compaction UI.

Extract chỉ hai trách nhiệm rõ nếu cần: pure context-state reducer và shared host assembly preparation/budget resolver. Không tăng server.ts bằng một pipeline copy-paste, không chia file chỉ để chia.

Thứ tự đề xuất, không phải implementation plan: identity + terminal usage → replay/reducer + cache → shared assembly/resolver + atomic post-compact preview → UI parity/labels → regression và quality gates.

## 13. Các quyết định xin duyệt

1. Dùng phương án A, tận dụng attempt facts thay vì thêm usage event/ledger mới.
2. Sau compact hiển thị **estimate dựng lại độc lập**, không cố duy trì continuity bằng reportedBefore trừ estimated saving. Số có thể nhảy từ reported sang estimated nhưng có nhãn rõ.
3. Giữ auto-compact pressure khác ring; chỉ giải thích trên UI, không thay policy.
4. Legacy state không đủ metadata: unavailable thay vì đoán hoặc quay về số pre-compact.

Sau khi user duyệt spec mới lập implementation plan. Chưa sửa source, chưa commit, chưa chọn cách thực thi.
