# Spec: Cache-aware compaction và cache telemetry chính xác

Status: **Phần A implemented** (2026-10-12); **Phần B approved in chat, written design pending final review** (2026-10-13).
Nguồn: `plans/reports/research-261012-1240-deepseek-harness-context-cache.md` và số liệu `GET /api/usage` ngày 2026-10-13.

## 1. Mục tiêu

Tiếp tục tối ưu sau đợt giữ prompt prefix ổn định:

1. Compaction ưu tiên tái sử dụng nguyên prefix của model request vừa hoàn tất, thay vì luôn gửi transcript phẳng như input mới.
2. Usage log phân biệt rõ provider báo cache hit bằng `0` với provider không gửi cache telemetry.
3. Giữ nguyên đường compaction hiện tại làm fallback an toàn; không thay đổi tính đúng đắn của checkpoint, retry, cancellation hoặc incremental fold.

Không tối ưu lại turn thông thường: số liệu ngày 2026-10-13 đã đạt khoảng 94–98% theo các model chính, và request được kiểm tra gần nhất đạt 99,13%.

## 2. Phần A đã hoàn tất: Skill body nằm trong tool result

- `Skill` trả instructions đã expand trong tool result, kèm name và hash.
- Skill do model load nằm sau prefix và ở lại history; definition skills của agent vẫn được pin trước history.
- Skill result có trần riêng 200.000 ký tự và không bị microcompact.

Phần này giữ nguyên, không thuộc thay đổi mới.

## 3. Phần B1: Cache-aware compaction

### 3.1. Nguồn prefix chính xác

Manifest và `context/body` không đủ để dựng lại chính xác `ModelRequest`: manifest chỉ có hash/count và không giữ tool schemas hay toàn bộ ordered messages. Vì vậy host giữ một snapshot in-memory của **request cuối đã thực sự gửi provider** cho mỗi session.

Snapshot được lấy tại `llm/stream`, nơi request đã đi qua `agent/context` và `agent/request`, gồm:

- ordered `messages`;
- ordered `tools` nếu có;
- `model` và `providerName`;
- các execution options ảnh hưởng wire shape cần giữ để prefix giống từng byte.

Snapshot chỉ được đánh dấu reusable khi stream kết thúc hợp lệ và thuộc turn đã hoàn tất. Request lỗi, bị abandon, còn đang chạy hoặc thuộc child khác không được dùng làm compaction prefix. Snapshot là cache trong RAM, bị xoá khi session bị xoá hoặc host restart; không persist vì provider cache sau restart cũng không đáng tin và persist toàn request sẽ nhân đôi dữ liệu nhạy cảm trong log.

### 3.2. Request compaction ưu tiên

Khi compact một completed root turn và có snapshot phù hợp với effective `(provider, model)` hiện tại:

1. Clone nguyên messages và tools của snapshot.
2. Append final assistant answer của turn vừa hoàn tất nếu answer đó chưa nằm trong request snapshot.
3. Append một user message chứa `COMPACT_SUMMARY_PROMPT`, yêu cầu tóm tắt toàn bộ conversation prefix theo 9 heading hiện có, không gọi tool và output tối đa 24.000 ký tự.
4. Gửi trực tiếp qua `kernel.ctx.llm.stream` ngoài `agentScope`, như compaction hiện tại, để không chạy lại context middleware hoặc ghi nhầm manifest/session usage.

Toàn bộ request cũ đứng trước nội dung mới, nên provider có thể reuse prefix đã cache. Tool schemas vẫn được giữ để wire prefix giống request trước; nếu model gọi tool thì output bị từ chối và chuyển fallback, không thực thi tool.

Với checkpoint incremental đã có, request snapshot đã chứa wrapped `compacted-history` của checkpoint trước. Instruction yêu cầu tạo summary hoàn chỉnh cho boundary mới; không chèn seed lần hai.

### 3.3. Điều kiện dùng và fallback

Dùng cache-aware path chỉ khi tất cả điều kiện đúng:

- Có request snapshot đã hoàn tất cho đúng root session.
- Snapshot thuộc completed boundary mới nhất được compact.
- Provider và model vẫn trùng effective pair hiện tại.
- Request cộng assistant answer, instruction và output reserve riêng cho summary nằm trong context budget.
- Không có thay đổi authority làm request snapshot không còn hợp lệ cho việc gửi lại.

Fallback về `createCompactionSummarizer` hiện tại khi:

- thiếu snapshot, host vừa restart hoặc manual compaction diễn ra mà không còn prefix hợp lệ;
- request dự kiến vượt context hoặc provider trả `contextExceeded`;
- completion có tool call, finish reason khác `stop`, output rỗng hoặc vượt 24.000 ký tự.

Lỗi transport tạm thời vẫn retry cùng cache-aware request theo `LogicalRequest`. Sau khi hết retry, compaction thất bại như hiện tại; không âm thầm chuyển sang fallback và phát sinh một logical request khác, trừ các trường hợp fallback xác định ở trên.

### 3.4. Tính đúng đắn giữ nguyên

- `compactSession` vẫn là nơi xác định completed boundary, append `compaction/start`, validate summary, append durable `compaction/end` và lưu checkpoint.
- Cancellation, PreCompact hooks, idempotent no-op, canonical recovery và boundary-change checks giữ nguyên.
- Usage của compaction vẫn được ghi riêng với `kind: 'compaction'`.
- Extractive fallback khi không có model giữ nguyên.

## 4. Phần B2: Cache telemetry chính xác

### 4.1. Vấn đề

`TokenUsage.cachedInputTokens` là optional. Hiện hai call site ghi:

```ts
cached: usage.cachedInputTokens ?? 0
```

Do đó persisted usage không phân biệt:

- provider có telemetry và báo cache hit bằng 0;
- provider không gửi cache field.

Context meter nội bộ đã phân biệt đúng bằng `cachedInputTokens !== undefined`; durable usage/API phải dùng cùng semantics.

### 4.2. Record và backward compatibility

Giữ `UsageRecord.v = 1` và thêm field bắt buộc cho record mới:

```ts
cacheReported: boolean
```

`cached` vẫn là number để giữ tương thích đọc và tổng token cũ.

Khi parse log cũ không có `cacheReported`:

- `cached > 0` được xem là `cacheReported: true`, vì giá trị dương chứng minh provider đã báo cache;
- `cached === 0` được xem là unknown/unreported, vì không thể phân biệt zero hit với thiếu telemetry.

Không rewrite `usage.jsonl` cũ.

### 4.3. Daily aggregation và API

Mỗi `UsageDayRow` giữ các field hiện tại và thêm:

```ts
cacheableInput: number
cacheReportedRequests: number
unreportedRequests: number
```

Aggregation:

- `input`: toàn bộ prompt input như hiện tại;
- `cached`: chỉ tổng cached token đã được provider báo;
- `cacheableInput`: input của request có `cacheReported: true`;
- cache hit chuẩn: `cached / cacheableInput`;
- request không telemetry không bị tính thành 0%.

Các client cũ vẫn đọc được `input`, `cached`, `output`, `requests`. Web types và test fixtures được cập nhật; Usage UI hiện tại không bắt buộc thêm card mới trong scope này.

## 5. Thay đổi dự kiến

- `src/web/usage-log.ts`: record schema, parser tương thích log cũ, daily buckets/API fields.
- `src/web/server.ts`: ghi `cacheReported`, giữ/retire last completed request snapshot, chọn cache-aware/fallback compaction.
- `src/web/llm-summarizer.ts`: tách validator/chunk fallback để cache-aware path dùng chung completion contract mà không nhân đôi logic.
- `web/lib/types.ts`: thêm daily telemetry fields.
- `tests/web/server-usage.spec.ts`: persisted telemetry, restart và legacy parsing.
- `tests/web/llm-summarizer.spec.ts`, `tests/web/server-compaction.spec.ts`: prefix reuse, assistant answer, tool-call/context-overflow fallback, restart/no-snapshot fallback, usage accounting.
- `docs/harness.md`: mô tả cache-aware compaction và fallback.

## 6. Kiểm thử và acceptance

### Automated

1. Record mới có `cacheReported: true` kể cả khi cached bằng 0.
2. Record mới không có provider cache field ghi `cacheReported: false`.
3. Log cũ cached dương được tính vào `cacheableInput`; legacy zero không bị tính thành zero-hit chắc chắn.
4. Cache-aware compaction giữ toàn bộ previous request làm byte-identical prefix và chỉ append assistant answer + instruction.
5. Compaction không thực thi tool; tool-call output chuyển sang chunk fallback.
6. `contextExceeded` chuyển sang chunk fallback; transport retry không tạo checkpoint kép.
7. Sau restart hoặc thiếu snapshot, đường chunk hiện tại vẫn hoạt động.
8. Incremental checkpoint, cancellation, durable lifecycle và no-op tests vẫn pass.
9. Chạy affected tests, sau đó `pnpm test` và `pnpm run typecheck`; `pnpm run build:web` chỉ khi web implementation ngoài type contract thay đổi.

### Runtime

Sau ít nhất một ngày chạy thật, báo cáo riêng:

- normal turn cache hit;
- child cache hit;
- compaction cache hit;
- unreported request count;
- cache hit chỉ trên `cacheableInput`.

Kỳ vọng: turn thường giữ mức hiện tại; cache-aware compaction có cached prefix gần request cuối và thời gian compaction giảm rõ rệt so với chunk-only path.

## 7. Ngoài phạm vi

- Giảm số MCP tool schemas hoặc đổi tool discovery architecture.
- Snapshot `CLAUDE.md`/workspace instructions.
- Persist full request snapshot qua restart.
- Thay provider cache policy hoặc thêm provider-specific `cache_control`.
- Thay đổi compaction trigger pressure.

## 8. Quyết định đã chốt

- Giữ chunk summarizer làm fallback, không thay thế hoàn toàn.
- Không tính request thiếu cache telemetry như 0% hit.
- Không rewrite historical usage log.
- Không mở rộng scope sang MCP schema reduction hay Usage UI redesign.
