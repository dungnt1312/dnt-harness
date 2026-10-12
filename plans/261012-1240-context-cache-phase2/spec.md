# Spec: Skill thành tool result và summarizer dùng lại prompt cache

Status: **Phần A implemented** (2026-10-12, cùng đợt 1 với spec `261012-1228`); **Phần B draft**, làm plan riêng sau khi đo lại `usage.jsonl`. Đã chốt: skill ở lại history các turn sau; body không bị `toolOutputLimit` cắt mà có trần riêng 200 000 ký tự, vượt thì từ chối nguyên khối.
Nguồn: `plans/reports/research-261012-1240-deepseek-harness-context-cache.md`.

## 1. Vấn đề

Sau khi bỏ giờ khỏi system prefix, còn hai nguồn làm mất prompt cache đáng kể:

1. **Skill load giữa turn.** Khi model gọi `Skill`, body được đưa vào khối `skill` đứng **trước history** (`src/harness/context/builder.ts`, thứ tự message `[5+]`). Request ngay sau đó phải đọc lại toàn bộ history. Khi turn kết thúc, `skillSnapshots` bị xoá (`src/web/server.ts:1189`), nên request đầu của turn sau lại đổi lần nữa. Trên log thật: 246 lần đổi, khoảng 30M token phải đọc lại. Request có skill mang trung bình khoảng 8 900 token skill.
2. **Summarizer không dùng được cache.** `createCompactionSummarizer` (`src/web/llm-summarizer.ts:76-133`) làm phẳng transcript thành text, chia chunk 200 000 ký tự rồi fold tuần tự. Toàn bộ input là token mới, và session dài cần nhiều lượt nối tiếp (lần đo trước: 313 giây).

DSH xử lý cả hai bằng cùng nguyên tắc: nội dung mới luôn đi sau prefix đã cache.

## 2. Phần A: Skill body thành tool result

### Thiết kế

- `Skill` load trả **chính instructions đã expand** làm tool result, như DSH (`skill/tool-skill`) và Claude Code. Dòng đầu ghi tên và hash: `skill 'x' loaded (hash …)`.
- Khối `skill` ở đầu request chỉ còn cho **definition skills của agent con**. Chúng được nạp một lần khi spawn và không đổi trong suốt lượt chạy của child, nên không làm vỡ cache.
- `skillSnapshots` chỉ còn giữ definition skills. Phần pin theo turn của skill do model load không cần nữa, vì tool result trong log vốn đã bất biến.
- `Skill` vẫn không bị microcompact (đã có trong danh sách loại trừ của `isCompactableTool`).
- Grant `allowed-tools` của command vẫn cài như hiện tại; chỉ vị trí của body thay đổi.

### Đánh đổi

- Skill **ở lại trong history các turn sau** thay vì bị xoá khi turn kết thúc. Tốn token hơn nhưng đã nằm trong prefix được cache. Claude Code và DSH đều làm vậy. Khi cần, budget trimming và compaction xử lý như mọi tool result khác.
- Skill body không còn là nguồn "droppable" riêng trong budget. Nó chỉ bị bỏ khi bỏ nguyên turn chứa nó.
- Manifest không còn liệt kê skill do model load ở `sources.skills`. Cần thêm cách hiển thị khác, ví dụ đọc từ `tool/call` của `Skill` trong turn.
- `toolOutputLimit` (60 000) giờ áp dụng cho skill body. Cần kiểm tra: skill lớn nhất trong catalog hiện tại phải nằm dưới giới hạn, hoặc Skill được miễn giới hạn này.

## 3. Phần B: Summarizer dùng lại prefix

### Thiết kế

- Đường mặc định: dựng lại request bằng **cùng `buildContext`** với input của request gần nhất, tính đến `lastEnd`, rồi append chỉ thị compaction làm user message cuối. Giữ nguyên system, tools và history để provider dùng lại cache; chỉ phần chỉ thị là token mới.
- Chỉ thị yêu cầu không gọi tool. Summarizer hiện đã từ chối output có tool call; trường hợp đó chuyển sang đường dự phòng.
- Nếu request + chỉ thị + output tối đa (24 000 ký tự, khoảng 6 000 token) **vượt budget**, hoặc provider báo vượt context, thì dùng **đường hiện tại** (transcript làm phẳng, chunk, fold). Không bỏ đường cũ.
- Checkpoint trước đó đã có trong khối `compacted-history` của request, nên fold incremental vẫn đúng. Prompt chỉ thị giữ cấu trúc 9 mục của `COMPACT_SUMMARY_PROMPT`.
- Không có model (extractive) thì giữ nguyên hành vi hiện tại.

### Điểm cần xác minh khi plan

- Assembly đang nằm trong middleware `agent/context` và phụ thuộc `agentScope`. Cần tách phần chuẩn bị input thành hàm dùng được ngoài turn, nhưng không được để usage/context middleware ghi nhận nhầm request compaction (bối cảnh của `agentScope.exit` ở `src/web/server.ts:1263`).
- Output reserve hiện là 4 096 token, thấp hơn mức output summary cho phép. Request compaction cần reserve riêng.
- Mức tiết kiệm phụ thuộc request compaction có chạy trong thời gian cache của provider sau turn cuối hay không. Auto compaction chạy ngay khi turn xong nên thuận lợi; manual compaction sau thời gian dài thì không.

## 4. Không thuộc phạm vi

- Memory và skill catalog đổi giữa session: khoảng 4,7M token trên 43 lần đổi, quá nhỏ so với độ phức tạp của cơ chế append thông báo.
- Microcompact: chưa kích hoạt lần nào trong 20 865 request.
- Tokenizer thật hoặc neo ước lượng vào usage của provider như `token-meter` của DSH. Hữu ích cho độ chính xác của meter nhưng không ảnh hưởng chi phí.

## 5. Kiểm thử

- Prompt contract: load skill giữa turn thì mọi message trước history của request tiếp theo giống hệt request trước từng byte; body xuất hiện ở đúng tool result.
- Child có definition skills vẫn nhận skill ở khối đầu như hiện tại.
- `allowed-tools` grant và rollback khi expand lỗi vẫn đúng.
- Summarizer: request compaction có prefix trùng request cuối; tool call hoặc vượt budget thì chuyển sang chunk path; incremental seed vẫn đúng.
- `tests/web/server-compaction.spec.ts` và `tests/web/llm-summarizer.spec.ts` pass; sau đó `pnpm test`, `pnpm run typecheck`, và `pnpm run build:web` nếu manifest UI đổi.

### Tiêu chí sau khi chạy thật

- Request ngay sau Skill load có cached token gần bằng input của request trước.
- Request compaction có tỷ lệ cached token cao và thời gian chạy giảm rõ so với hiện tại.

## 6. Câu hỏi cần anh chốt

1. Anh chấp nhận skill ở lại history các turn sau như Claude Code không, hay vẫn muốn skill chỉ có hiệu lực trong turn đã load?
2. Skill body có được miễn `toolOutputLimit` không?
3. Làm Phần A và B trong cùng một plan, hay tách riêng để A đi trước? A nhỏ và có số đo rõ; B động tới compaction và cần thiết kế kỹ hơn.
