# ZCode đếm context như thế nào, và dnt-harness khác ở đâu

Ngày 2026-10-15. Nguồn ZCode: clone `/tmp/zcode-research` (commit `aac4755`, 2026-10-10). Dữ liệu dnt-harness: log phiên `session-mv963felwbc8zp` trên server đang chạy.

## Triệu chứng

Meter nhảy giữa ~360K (est) và ~645K (reported). Log cho thấy mọi request trong phiên có tỉ lệ provider/ước tính ổn định 1.78–1.79:

| contextId | Ước tính (chars/4) | Provider báo |
|---|---|---|
| aa73329e | 357 821 | 639 382 |
| 2b374124 | 360 878 | 642 883 |
| 7e664ea5 | 363 303 | 646 603 |

Nguyên nhân trực tiếp: meter hiện ước tính khi request mới chưa có usage, rồi chuyển sang số provider khi có. Nguyên nhân gốc: **dnt-harness lấy ước tính chars/4 làm số chính cho budget, trim và auto-compact**, mà ước tính này thấp gần một nửa so với thực tế ở phiên tiếng Việt và code.

## ZCode làm thế nào

### 1. Số chính là provider usage, ước tính chỉ để bù phần mới

`runtime/methods/compact.ts:316` `buildProviderUsageTokenOverride`:

- Tìm assistant message gần nhất đã commit có usage (`turn-model-step-usage.ts:54` `findLatestCommittedAssistantUsage`).
- Baseline = `inputTokens + outputTokens` của request đó (`agent/message-history-usage.ts:24`). Input của provider đã gồm cache read/write, nên không cộng thêm.
- Chỉ **ước tính phần message mới thêm sau baseline** (`estimateMessageTokens(messages.slice(messageIndex + 1))`).
- `tokenCount = providerBase + incremental`.
- Không có usage (phiên mới, sau compact) thì mới rơi về ước tính toàn bộ.

Con số này dùng cho:
- Auto-compact: `compact/policy.ts:103` `tokenCount = tokenOverride?.tokenCount ?? estimatedTokenCount`, kèm `tokenSource: "provider_usage" | "estimate"`.
- Reactive compact và các chỗ gọi `estimateCurrentModelInputTokens` (`compact.ts:345`).

Vì phần ước tính chỉ là phần nhỏ mới thêm vào, sai số chars/N chỉ ảnh hưởng vài nghìn token, không phải hàng trăm nghìn.

### 2. Meter chỉ hiện số provider, không lùi về ước tính

`contracts/events/event-reducer.ts:223`: khi có usage, `contextUsed = getModelUsageContextTokens(usage)`. Nếu event không có usage thì **giữ nguyên giá trị cũ**, không thay bằng ước tính. Sau compact, dùng `truePostCompactTokenCount ?? postCompactTokenCount` (`event-reducer-helpers.ts:93`). TUI cũng chỉ cập nhật khi `inputTokens > 0` (`tui/src/app-events.ts:312`).

Kết quả: số trên meter chỉ đi lên theo request thật, hoặc xuống sau compact; không nhảy qua lại.

### 3. Ước tính của ZCode chặt hơn

- `ESTIMATED_TOKEN_CHAR_DIVISOR = 3` (`packages/shared/src/usage-stats.ts:9`), không phải 4.
- Chữ Hán đếm gấp đôi (`context/utils.ts:12`).
- Đếm cả input của tool call, không chỉ content (`compact/manual.ts:102`).

Breakdown theo nguồn (system prompt, tools, messages...) vẫn là ước tính và được ghi rõ `tokenMethod: "estimated"`, `confidence: "low"` (`context-usage.ts:235`). Breakdown là để giải thích, không phải số chính.

## dnt-harness đang làm gì

- `budget.ts` `estimateTokens = ceil(chars / 4)`, áp cho mọi chỗ.
- `buildContext` so ước tính này với `availableTokens` để microcompact, trim và báo lỗi budget.
- Áp lực auto-compact = `preTrimTokens / availableTokens`, cũng là ước tính.
- Usage của provider chỉ được dùng để hiển thị.

Hệ quả ở phiên này: meter ước tính báo 34%, thực tế ~62%. Auto-compact ở 85% ước tính tương đương ~150% thực tế, tức là provider sẽ từ chối trước khi compact chạy. Lúc đó chỉ còn đường squeeze.

## Đề xuất fix gốc (theo ZCode)

1. **Context dùng cho mọi quyết định = provider base + ước tính phần mới.**
   Lấy usage terminal gần nhất của session (đã có trong `model/attempt` cùng `contextId` từ Task 1). Phần mới = các message có seq sau request đó. Dùng con số này cho áp lực auto-compact, kiểm tra fit và quyết định trim/microcompact trong builder. Không có usage hợp lệ (phiên mới, ngay sau compact, provider không báo usage) thì dùng ước tính như hiện nay.
2. **Meter hiển thị cùng con số đó**, nhãn "reported + estimated delta" hoặc "estimated" tuỳ nguồn. Không bao giờ quay về ước tính toàn phần khi đã có usage, nên hết nhảy.
3. **Siết ước tính cho phần còn lại:** dùng hệ số 3 ký tự/token thay vì 4 và đếm cả input tool call (dnt-harness đã đếm). Có thể thêm hệ số cho ký tự ngoài ASCII (tiếng Việt có dấu, CJK).
4. **Sau compact:** ước tính toàn phần là đúng (không còn baseline hợp lệ), giống `postCompactTokenCount` của ZCode.

Những gì cần thay đổi trong spec đã duyệt:
- `plans/261014-1328-context-accounting/spec.md` §3/§4 ghi "Reported count không thay budget.usedTokens/breakdown" và "giữ estimator chars/4". Fix gốc trái với hai điều này, cần anh duyệt đổi spec.
- Breakdown vẫn là ước tính và vẫn cộng bằng tổng ước tính, nhưng không còn là số chính.

## Rủi ro

- Đổi estimator sang chars/3 làm mọi phiên trim/compact sớm hơn khoảng 33% khi chưa có usage.
- Baseline phải gắn đúng request: nếu request trước bị trim khác (squeeze, microcompact) thì phần delta không còn khớp. ZCode xử lý bằng cách lấy usage theo assistant message đã commit trong cùng lịch sử đang gửi; dnt-harness có thể dùng `contextId` cộng `includedSeqRange` của manifest.
- Provider không báo usage hoặc báo sai (gateway) thì quay về ước tính.

## Câu hỏi còn mở

- Anh duyệt đổi spec để usage provider thành số chính cho quyết định budget/compact không?
- Đổi hệ số chars/4 sang chars/3 ngay, hay chỉ dùng provider baseline trước?
