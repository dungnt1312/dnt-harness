# Spec: Compaction phải giảm context, không được tăng

Status: **superseded** · 2026-10-12. Hướng đã chốt và đã triển khai: bỏ tail N turn thô, chỉ giữ user message nguyên văn (cùng câu trả lời cuối của turn covered mới nhất) trong trần `compactionRetainTokens` = 20k, theo mẫu Codex/ZCode. Xem `plans/reports/research-261012-1150-compaction-zcode-codex.md`. Phần preflight và postcheck bên dưới không triển khai vì kích thước sau compact đã bị chặn theo thiết kế.

## 1. Vấn đề

Manual compact báo `76.7k → 78.8k tokens through seq 893, 8 KB summarized, glm-5.3-flash, 313.7s`. Context tăng 2.1k token sau hơn 5 phút gọi model.

### Root cause (đã tái hiện)

Request sau compact = `summary + raw history từ window.startSeq`. `historyWindow()` (`src/harness/context/builder.ts:870-903`) giữ **N turn hoàn thành cuối cùng** trong vùng covered dưới dạng raw (`compactionTailTurns`, mặc định 4, `src/harness/limits.ts:74`). Tail tính theo **số turn, không có trần token**.

Probe với `estimateConversationTokens` trên session giả lập (summary 8000 chars ≈ 2084 token):

| Session | Trước | Sau (tail 4 turn) | Tiết kiệm |
|---|---|---|---|
| 3 turn, 552 seq | 56.6k | 58.7k | **−2.1k** |
| 5 turn, 620 seq | 63.1k | 52.5k | 10.5k (17%) |
| 6 turn dài, 744 seq | 93.7k | 64.5k | 29.1k (31%) |
| 20 turn ngắn, 680 seq | 64.6k | 15.0k | 49.5k (77%) |

Dòng đầu khớp đúng ảnh chụp: có ≤ 4 turn thì `starts[max(0, len-4)] = starts[0]`, toàn bộ history vẫn raw, và summary bị cộng thêm vào. Session agentic thường có ít turn nhưng mỗi turn chứa hàng trăm event tool, nên đây là trường hợp phổ biến chứ không phải biên.

### Các lỗi phụ

1. **Không có preflight lợi ích.** `compactSession` (`src/harness/context/compaction.ts:180`) gọi model trong khi chưa biết compact có giảm được gì không. Có thể biết trước mà không tốn gì: phần raw sẽ bị bỏ chính là history trước `startSeq` mới.
2. **Không có postcheck.** `measure` (`src/web/server.ts:1295-1325`) tính ra `saved < 0` nhưng vẫn commit checkpoint, ghi đè meter, và báo "Compacted". Comment ở `server.ts:1308` cho thấy đây là hành vi cố ý, nhưng kết quả là user bị lỗ.
3. **Auto-compaction cũng dính lỗi này.** Mỗi turn mới ở pressure cao có thể gọi lại model mà không giảm được gì. Hiện chỉ có `automaticBoundaries` chặn việc chạy lại trên cùng một seq.
4. **Số liệu chỉ có khi `history === 'compact'`.** Mode khác thì toast không có số, user không biết lời hay lỗ.

## 2. Mục tiêu / không thuộc phạm vi

Mục tiêu:
- Một lần compact thành công phải làm context giảm tối thiểu `minGain`.
- Trường hợp không lời phải bị từ chối **trước khi gọi model** và báo rõ lý do.
- Tail vẫn giữ ngữ cảnh gần nhất ở dạng raw nhưng bị chặn bởi trần token.

Không thuộc phạm vi: compact giữa một turn đang mở (đã có microcompact lo), đổi prompt summarizer, đổi cap 24k.

## 3. Thiết kế

### A. Tail có trần token (`builder.ts`)

- Thêm limit `compactionTailTokens` (mặc định đề xuất **16 000**, cho phép giá trị 0) bên cạnh `compactionTailTurns`.
- `historyWindow(compact)` đi lùi từ turn covered mới nhất. Mỗi turn được giữ nếu `count < tailTurns` **và** `tailCost + turnCost ≤ tailTokens`. Gặp turn đầu tiên vượt trần thì dừng. Tail luôn giữ nguyên cả turn, không cắt đôi cặp tool-call/result.
- Nếu ngay turn mới nhất đã vượt trần thì tail = 0 turn, summary phủ toàn bộ. Có một phương án thay thế ở câu hỏi Q2.
- Để tính `turnCost`, `historyWindow` cần chi phí message, nên phải truyền vào danh sách `DatedMessage` đã derive (có attachments) thay vì tự derive lại. Mọi caller phải dùng **cùng một hàm**: `buildContext`, `estimateConversationTokens`, preflight. Nhờ vậy ước lượng và request thật không bị lệch nhau.

### B. Preflight lợi ích (`compaction.ts`, trước `compaction/start`)

- Thêm hàm thuần `compactionGain(events, { seed, coversSeq, tailTurns, tailTokens, attachments })`, trả về `{ droppedTokens, keptTailTokens, seedTokens }`. `droppedTokens` là chi phí raw history nằm trong window hiện tại (theo seed) nhưng sẽ rơi khỏi window mới.
- Thêm option `CompactionOptions.minGainTokens`. Nếu `droppedTokens − seedTokens < minGainTokens + SUMMARY_ALLOWANCE` thì throw `nothing to compact: only N tokens of history are eligible (tail keeps M)` **trước khi** append bất kỳ lifecycle event nào. Cách này giống pattern `extractiveCap` hiện có. Không gọi model, không ghi event failed.
- `SUMMARY_ALLOWANCE` lấy theo ước lượng thận trọng: kích thước summary của seed nếu có, nếu không thì 2 000 token. Không lấy cap 6k vì sẽ chặn oan.
- Mặc định đề xuất `minGainTokens` = **4 000**.

### C. Postcheck sau khi có summary

- Sau khi summarizer trả kết quả, tính `saved = was − now` bằng `estimateConversationTokens` trong core. Phép tính này không phụ thuộc mode, khác với `measure`.
- Nếu `saved < minGainTokens` thì append `compaction/end` với `error: "compaction would not reduce context (saved N tokens)"`, không lưu checkpoint, không động vào meter.
- `measure` giữ vai trò hiển thị (`tokensBefore` lấy từ provider), nhưng quyết định commit chuyển sang `saved` ở core.

### D. Auto-trigger (`server.ts:1339-1358`)

- Preflight từ chối thì không có event, chỉ `console.debug`. `automaticBoundaries` vẫn được set, nên turn kế tiếp sẽ preflight lại. Preflight là phép tính thuần, chi phí không đáng kể.

### E. API / UI

- Route `POST …/compact` trả 409 kèm message preflight. Toast hiện nguyên lý do, ví dụ: "Nothing to compact: 3.1k tokens eligible; recent 4 turns are kept raw."
- Chip `Compaction failed` trong `MessageParts.tsx` hiện lý do lấy từ `error`. Code hiện tại đã render error sẵn, chỉ cần kiểm tra lại.
- Thêm `tokensBefore/After` cho mọi mode: ngoài mode `compact` thì chỉ báo `saved` ước lượng. Nếu thấy không cần thì bỏ mục này (xem Q4).

## 4. Tests

- `tests/harness/compaction-context-reliability.spec.ts`:
  - Tail dừng ở trần token.
  - Turn mới nhất quá lớn thì tail = 0.
  - `buildContext` và `estimateConversationTokens` cho cùng `startSeq`.
- `tests/harness/compaction-reliability.spec.ts`:
  - Preflight từ chối session 3 turn dài: summarizer không được gọi, không có `compaction/start`.
  - Seed + delta nhỏ thì bị từ chối.
  - Postcheck `saved < minGain` thì ghi failed end và không có checkpoint.
- `tests/web/server-compaction.spec.ts`:
  - 409 kèm message.
  - Test hiện có (`tokensAfter ≥ 0`) phải thêm assert `tokensAfter < tokensBefore`.
- Regression: session đầy đủ 20 turn vẫn compact được, giảm ≥ 70%.
- Chạy `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`.

## 5. Rủi ro

- Tail ngắn hơn thì model mất chi tiết raw của turn gần nhất. Chất lượng câu trả lời ngay sau compact phụ thuộc vào summary nhiều hơn. Giảm rủi ro bằng cách dùng trần 16k, vẫn đủ cho 1–2 turn thường.
- Thay đổi `historyWindow` ảnh hưởng mọi request dùng mode `compact`, không chỉ lúc compact. Bắt buộc có test đối chiếu window giữa builder và estimator.
- Checkpoint cũ không cần migrate: tail được tính lại ở mỗi request.

## 6. Câu hỏi mở

- Q1. Có đồng ý mặc định `compactionTailTokens = 16 000` và `minGainTokens = 4 000` không? Hay nên tính theo % context window (ví dụ tail ≤ 15% window)?
- Q2. Khi turn mới nhất đã vượt trần tail: chọn tail = 0 (đề xuất, đơn giản) hay giữ raw một phần cuối của turn (tool results cuối, câu trả lời cuối)? Cách thứ hai giữ ngữ cảnh tốt hơn nhưng phải cắt trong turn và đảm bảo không tách đôi cặp call/result.
- Q3. Postcheck không đạt thì ghi `compaction/end` failed (đề xuất, có dấu vết) hay im lặng bỏ qua?
- Q4. Có cần hiện số before/after cho mode không phải `compact` không, hay bỏ mục E3?
