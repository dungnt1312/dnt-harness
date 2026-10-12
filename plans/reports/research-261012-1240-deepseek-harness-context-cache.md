# Research: deepseek-harness (DSH) dựng context và tối ưu cache như nào

Ngày 2026-10-12. Source: `github.com/deepseek-ai/deepseek-harness` @ `d7432673` (2026-10-09), clone vào `/tmp/dsh-verify`. Đường dẫn bên dưới tương đối với `packages/`.

## Kết luận

DSH thiết kế toàn bộ context quanh một nguyên tắc: **mọi thứ thay đổi đều được append vào history, không bao giờ render lại ở đầu request**. Mỗi package có hẳn một mục "KV Cache effect" trong README mô tả nó ảnh hưởng prefix ra sao. Đây là điểm khác biệt lớn nhất so với dnt-harness, nơi instructions, skill catalog, skill body và memory được render lại ở đầu request mỗi step.

## Các kỹ thuật, có bằng chứng trong source

| Kỹ thuật | DSH làm gì | Bằng chứng |
|---|---|---|
| System prompt chỉ chứa phần tĩnh | Các section tĩnh ghép theo `order`; dữ liệu động ("contexts") đi riêng thành user-role snapshot trong history | `core/system-prompt/README.md:100`, `:154` |
| Đổi system prompt không phá cache | Nếu provider hỗ trợ `systemPromptUpdate: 'in-history'`, prompt mới được append sau history đã cache thay vì sửa node đầu | `core/agent-loop/src/runtime-context.ts:62-107` |
| Thời gian | Plugin opt-in. Inject một **user message bền vững vào log** ở pre-step, tối đa mỗi **10 phút** (`refreshIntervalMs` 600 000), kèm thời gian đã trôi qua từ message trước | `context/time-context/src/index.ts:59`, `:185-222`, README `:125-127` |
| AGENTS.md / CLAUDE.md | Append **một lần** thành baseline user message. Khi Read/Write/Edit chạm thư mục sâu hơn hoặc file đổi, append bản thay thế/thông báo xoá ở cuối. Trần `maxBytes` 65 536 | `context/agent-instructions/README.md:12`, `:156-160`; `src/index.ts:76` |
| Skill catalog | Catalog ban đầu là message bền vững; thay đổi được append sau. Skill body vào context dưới dạng **tool result** | `skill/tool-skill/README.md:124`, `:135-137` |
| Summarizer dùng cache | Gửi lại **đúng system, tools và message list** của request trước, thêm chỉ thị compaction làm user message cuối. Chỉ phần chỉ thị là token mới | `compaction/compaction-basic/src/summarizer.ts:25-31`, `:72-78`, `:142-151` |
| Ngưỡng compaction | `floor(min(W×0.8, W − O − 65 536))`; giữ nguyên văn 16% gần nhất của `W − O` | `compaction/compaction-basic/README.md:62-73` |
| Cắt tool output lớn | Chỉ khi đã tới ngưỡng compaction: output > 8 192 ký tự còn 4 096 đầu + 1 024 cuối. Bản cắt được **ghi bền vào log**, nên request sau giống nhau | `compaction/compaction-tool-result-pruner/README.md:12`, `:48`, `:82`, `:122-124` |
| Output quá lớn khi chạy tool | Lưu toàn bộ vào file riêng, model nhận preview đầu/cuối và đường dẫn để Read/Grep | `spill/spill-policy/README.md:52-57` |
| Ước lượng token | chars/4 cộng overhead cấu trúc, nhưng **neo vào usage của provider** khi request giống envelope trước | `llm/token-meter/README.md:45`, `:82`, `:140-155` |

## So với dnt-harness, đo trên dữ liệu thật

Em so hash các section trong `context/manifest` của 20 448 cặp request liên tiếp (400 session gần nhất):

| Section đứng trước history bị đổi | Số cặp | Ghi chú |
|---|---|---|
| `system` | 2 569 (12,6%) | Phần lớn do dòng `Today: … HH:MM` |
| `skill` | 312 | Load skill giữa turn, body chèn **trước history** |
| `memory` | 60 | Sửa `MEMORY.md` |
| `skill-catalog` | 21 | |
| `compaction` | 5 | |
| tool list | 1 | Tools ổn định |

Về thời gian: DSH khác cách em đề xuất trong spec `261012-1228`. Họ không gắn giờ vào từng user message mà inject một message thời gian riêng, tối đa 10 phút một lần, và chỉ khi bật plugin. Cả hai cách đều append-only. Cách gắn `[sent …]` vào projection đơn giản hơn với dnt-harness vì không cần event mới.

## Kỹ thuật nên áp dụng, xếp theo tác động đo được

Lượng token phải đọc lại (ước lượng chars/4) được tính bằng phần request nằm sau section đầu tiên bị đổi, cộng trên 20 867 request:

| # | Kỹ thuật | Token phải đọc lại hiện nay | Trạng thái |
|---|---|---|---|
| 1 | Bỏ giờ khỏi system prefix | ≈ 272M (2 582 lần đổi) | Spec `261012-1228` |
| 2 | Skill body thành tool result tại vị trí load | ≈ 30M (246 lần đổi) | Spec `261012-1240` |
| 3 | Summarizer dùng lại prefix của request thật | Không đo được từ manifest; mỗi lần compact hiện gửi lại toàn bộ transcript dưới dạng text không cache được | Spec `261012-1240` |
| 4 | Memory và skill catalog đổi thì append ở cuối | ≈ 4,7M (43 lần đổi) | Không làm: lợi ích nhỏ so với độ phức tạp |
| 5 | Microcompact ổn định hơn | 0: microcompact chưa kích hoạt lần nào trong 20 865 request | Không làm |

Kỹ thuật 1–4 đã kiểm chứng trong source DSH. Tác động ở dnt-harness là ước lượng từ manifest, chưa đo sau khi sửa.

## Không tìm thấy / không xác minh

- Không có số đo cache hit công khai của DSH. Các mục "KV Cache effect" là mô tả thiết kế, chính README ghi rằng tỉ lệ hit không được bảo đảm.
- Không xác minh cách DSH xử lý `reasoning_content` của turn trước ngoài README adapter (`llm/llm-deepseek/README.md:190-194` nói chỉ block được giữ lại mới vào input sau).
