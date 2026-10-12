# Spec: Giữ prompt prefix ổn định để không mất cache mỗi phút

Status: **implemented** · 2026-10-12 (đợt 1, cùng Phần A của spec `261012-1240-context-cache-phase2`). Đã chốt: phương án `[sent …]`, chỉ gắn cho tin nhắn user gõ (không có `origin`).

## 1. Kết luận review lần hai

Lần review đầu em liệt kê năm điểm. Sau khi đo, chỉ một điểm có tác động thật, và tác động đó lớn:

| Điểm | Đo được | Quyết định |
|---|---|---|
| Timestamp theo phút trong system message | Mất **83% phần input không được cache** | **Sửa, phạm vi của spec này** |
| Project history hai lần mỗi step | `buildContext` 9,1 ms, `deriveMessages` 3,5 ms ở log 50 800 event | Không làm; quá nhỏ so với thời gian gọi model |
| Loader `CLAUDE.md` và skill catalog | 0,26 ms và 0,43 ms mỗi request | Không làm |
| Load attachment của toàn log | Chỉ tốn khi tổng blob vượt cache 64 MiB; chưa gặp trong dữ liệu thật | Không làm lúc này |
| Compaction không kiểm tra net gain | Đã chặn bởi trần 20k; spec `261012-1144` đã chuyển sang superseded | Không làm lại |

Số liệu benchmark lấy từ log tổng hợp chạy trên máy này bằng `tsx`. Số liệu cache lấy từ `~/.dnt-harness/data/usage.jsonl`.

## 2. Vấn đề

`environmentBlockFor()` (`src/web/server.ts:2862`) render `Today: 2026-10-12 Monday · 12:28 +07:00` từ `new Date()` ở **mỗi request**. Khối này nằm trong message `[0]`, đứng trước workspace instructions, skill catalog, memory và toàn bộ history. Khi phút thay đổi, prefix thay đổi ngay từ message đầu tiên, nên provider không dùng lại được gì.

`docs/prompt-contract.md:58` viết rằng độ phân giải theo phút giữ cho prefix ổn định. Điều này chỉ đúng với các step trong cùng một phút. Một turn dùng tool thường kéo dài nhiều phút.

### Bằng chứng

Em ghép từng cặp request liên tiếp của cùng session và model, cách nhau dưới 30 giây, rồi so phần đã có trong request trước với phần được cache ở request sau:

| Provider | Cùng phút: prefix bị mất | Khác phút: prefix bị mất |
|---|---|---|
| cliproxy | 3,4% (2 558 cặp) | **96,2%** (508 cặp) |
| zlite | 2,2% (160 cặp) | **92,1%** (30 cặp) |
| zpro | 1,1% (79 cặp) | **94,4%** (16 cặp) |

Trên toàn bộ log (4 046 request, 623M input token), 208M token không được cache. Trong đó khoảng **172M token (83%) bị mất đúng tại ranh giới phút**. Nếu sửa, tỷ lệ input không được cache dự kiến giảm từ khoảng 33% xuống còn dưới 10%. Đây là ước lượng từ log, chưa phải số đo sau khi sửa.

Cache hit trung bình theo model hiện chỉ 61–73%. Các provider đều dùng OpenAI-compatible chat completions (`src/harness/llm/openai.ts`) với cache theo prefix tự động, nên sửa phía harness là đủ, không cần thêm `cache_control`.

## 3. Mục tiêu và phạm vi

Mục tiêu:
- Message `[0]` và mọi message đứng trước history phải giống nhau từng byte giữa các request trong cùng ngày, khi không có thay đổi thật về mode, tool, skill hay memory.
- Model vẫn biết ngày hiện tại và vẫn trả lời đúng câu hỏi "bây giờ là mấy giờ".
- Thông tin thời gian vẫn là dữ liệu trusted do host tạo, không lấy từ nội dung session.

Không thuộc phạm vi: tối ưu CPU của builder, cache loader, chọn attachment theo window, thay đổi compaction, thêm `cache_control` riêng cho từng provider.

## 4. Thiết kế đề xuất

### A. System prefix chỉ chứa ngày

`renderEnvironmentContext` thêm option độ phân giải, mặc định cho request là `day`:

```text
<environment_context>
Today: 2026-10-12 Monday (timezone +07:00)
Platform: darwin arm64 · Node v24.15.0
Workspace: /Users/dungnt/workspace/dnt-harness (git branch: main)
</environment_context>
```

Prefix chỉ thay đổi khi sang ngày mới, đổi timezone hoặc lần đầu đọc được git branch. Vị trí của khối giữ nguyên, nên prompt contract không đổi thứ tự.

### B. Giờ hiện tại đi theo message của user

Mỗi `user/message` mà user gõ (`origin === undefined`) được project với một dòng thời gian lấy từ `event.timestamp`:

```text
[sent 2026-10-12 12:28 +07:00]
Review 1 lần nữa r đề xuất spec cho a
```

Lý do chọn cách này:
- `event.timestamp` là dữ liệu bất biến trong log, nên message cũ render giống hệt nhau ở mọi request và không làm vỡ cache.
- Phần mới của mỗi turn vốn đã nằm ở cuối request, nên dòng thời gian không làm mất thêm cache.
- Model biết thời điểm user hỏi. Trong một turn dài nhiều phút, giờ đó có thể cũ vài phút; với yêu cầu của harness này, mức chính xác đó là chấp nhận được.

Dòng thời gian do host thêm khi projection. Nó không được ghi vào log, không hiển thị trong UI transcript, không tính là nội dung user gõ trong compaction và retained messages. Message có `origin` (`continuation`, `context`, `command`, `hook`) không được gắn dòng này.

Thực hiện trong `projectMessages()` (`src/harness/session/events.ts`) để mọi đường dẫn dùng chung một projection, gồm `buildContext`, `estimateConversationTokens` và `deriveMessages`. `projectForSummary` không gắn dòng này, để summarizer không bị nhiễu.

Base prompt (`DEFAULT_BASE_SYSTEM`) cần thêm một câu ngắn: ngày nằm trong `<environment_context>`, còn giờ user gửi nằm ở dòng `[sent …]` của message.

### C. Headless dùng cùng quy tắc

`src/bins/headless.ts:238` cũng render environment theo phút. Đổi sang cùng option `day` để hai host hành xử giống nhau.

### D. Cập nhật contract và tài liệu

- `docs/prompt-contract.md`: sửa mục `<environment_context>` (ngày thay vì phút) và nêu rõ rằng mọi khối trước history phải ổn định theo byte trong ngày.
- `docs/harness.md`: thêm một câu về dòng `[sent …]` trong phần context assembly.

## 5. Kiểm thử

- `tests/harness/g5-prompt-contract.spec.ts`: dựng context hai lần với hai thời điểm khác phút trong cùng ngày, khẳng định mọi message trước history giống nhau từng byte. Cập nhật regex của dòng `Today:`.
- Test projection: user message gõ tay có dòng `[sent …]` lấy từ `event.timestamp`, render lại cho kết quả giống hệt; message có `origin` và `projectForSummary` không có dòng này.
- Test compaction/retention: retained user message vẫn được chọn đúng, budget tính cả dòng thời gian.
- Kiểm tra UI không hiển thị dòng `[sent …]` (projection chỉ dùng cho model).
- Chạy test bị ảnh hưởng, sau đó `pnpm test` và `pnpm run typecheck`. Chỉ chạy `pnpm run build:web` nếu có đổi phần web.

### Tiêu chí chấp nhận sau khi chạy thật

Dùng lại script phân tích `usage.jsonl` trên dữ liệu sau khi deploy ít nhất một ngày:
- Phần prefix bị mất ở các cặp khác phút dưới 10%, ngang mức cùng phút.
- Tỷ lệ input không được cache tổng thể giảm rõ so với mức 33% hiện tại.

## 6. Rủi ro

- **Model mất độ chính xác theo phút của giờ hiện tại** trong các turn dài. Cách giảm rủi ro: base prompt nói rõ giờ là thời điểm user gửi; model vẫn có thể gọi `date` khi cần chính xác.
- **Đổi projection làm thay đổi token count của mọi request**: mỗi user message thêm khoảng 10 token. Không đáng kể, nhưng test có số token cố định cần cập nhật.
- **Lần deploy đầu tiên làm vỡ cache của mọi session đang chạy** vì system text và history projection đều thay đổi. Chỉ xảy ra một lần.
- Các yếu tố khác vẫn làm vỡ cache nhưng hiếm: load skill giữa turn, sửa `MEMORY.md` hoặc `CLAUDE.md`, đổi mode/tool, microcompact. Spec này không xử lý các trường hợp đó.

## 7. Câu hỏi cần anh chốt

1. Anh đồng ý đưa giờ vào message của user qua dòng `[sent …]` không? Phương án khác là chỉ giữ ngày và bỏ hẳn giờ; cách này đơn giản hơn nhưng model sẽ không trả lời được câu hỏi về giờ nếu không gọi tool.
2. Dòng `[sent …]` chỉ gắn cho message user gõ, hay gắn cả message có `origin` như hook và continuation?
3. Có muốn theo dõi các nguồn làm vỡ cache khác (skill giữa turn, memory, microcompact) trong một spec tiếp theo không? Hiện chúng chỉ chiếm khoảng 3% prefix bị mất trong các cặp cùng phút.
