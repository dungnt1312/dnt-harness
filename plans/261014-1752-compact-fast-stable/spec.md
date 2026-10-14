# Spec — Compact nhanh và ổn định (2026-10-14)

User duyệt 17:56: "Okie làm theo đề xuất đi, làm theo SDD". Đề xuất gốc: lượt trả lời 17:52 trong session `session-mv6rl7tgfu510t`.

## 1. Vấn đề đã đo (log thật, không gọi model)

| Session | Đường | Thời gian | Kết quả |
|---|---|---|---|
| `mv6rl7…` 00:22 | fold | 506 s | fail: summary > 24 000 ký tự (trước bản sửa) |
| `mv6rl7…` 00:52 | fold | 1 011 s | ok |
| `mv6rl7…` 17:16 | 1 request (`exact`) | 46 s | ok, input 954k token |
| `mv7q27…` 17:16 | fold (`glm-5.3-flash`) | 1 009 s | ok, sau 3 lần bị hỏi xác nhận |

Kết luận: đường 1 request đủ nhanh; vấn đề là server rơi vào fold quá thường, và fold tuần tự rất chậm. Snapshot chỉ tạo khi turn kết thúc `completed`; một turn bị Stop (`reason: cancelled`), session cũ, mất sidecar, đổi mode/quyền đều đẩy sang fold. `reconstruct` hiện là `() => undefined` (`src/web/server.ts`).

## 2. Mục tiêu

1. Mọi compaction có ít nhất một turn `completed` sạch sau checkpoint đang đứng đi đường 1 request, kể cả session tạo trước bản này và turn cuối bị Stop.
2. Đường 1 request không fail chỉ vì summary dài.
3. Fold (chỉ còn là đường cuối) chạy song song, thời gian ≈ 2 request thay vì N.
4. UI thấy tiến độ fold (`chunk i/n`).
5. Mỗi compaction ghi lại số request và token để đánh giá được "nhanh và ổn định".

Ngoài phạm vi: bật precompute (chờ benchmark); benchmark model thật (cần user duyệt riêng); đổi ngưỡng auto-compact 0.85 (user đã loại); sửa chip tokensAfter (agent khác làm, F1).

## 3. Yêu cầu

### R1 — Reconstruct từ log
- Khi không có snapshot exact dùng được, host dựng snapshot `reconstructed` từ committed log bằng **chính** pipeline assembly của request thường (builder, mode, grants, skills, memory, attachments, budget của model hiện tại).
- Cutoff = turn mới nhất sau checkpoint đang đứng mà `turn/end.reason === 'completed'`, không có `step/abandoned`/`execution/uncertain`, và có assistant message cuối không có tool call. Các turn sau cutoff (vd turn bị Stop) giữ nguyên văn — adoption đã hỗ trợ cutoff cũ hơn turn mới nhất.
- Request được dựng từ các event `seq <= cutoff`. Câu trả lời cuối KHÔNG nằm hai lần: bỏ message cuối khỏi request/sources nếu nó là câu trả lời cuối; `reconstructSnapshot` thêm lại như `finalAnswer`.
- Fail-closed giữ nguyên: projection phải qua `assessProjection`; nếu builder phải bỏ lịch sử chưa được tóm tắt (`uncovered-history-dropped`) hoặc bất kỳ loss không hợp lệ → reconstruct trả `undefined` → fold. Không nới `assessProjection`.
- Reconstruct chỉ chạy khi exact không dùng được (lazy, async), không có side effect: không append `context/manifest`/`context/body`, không đổi `lastManifests`, không arm capture, không đổi meter.
- Kết quả `path: 'reconstructed'`, `compaction/job` ended ghi `path: 'reconstructed'`.

### R2 — Generator bền hơn
- Lần 1: nhận bản nháp hoàn chỉnh tới 96 000 ký tự (vẫn bắt buộc đúng 1 completion `stop`, không tool). Nếu ≤ 24 000 → xong.
- Nếu > 24 000: nén BẢN NHÁP bằng request độc lập nhỏ (không gửi lại prefix), mục tiêu 12 000 rồi 8 000; tối đa 2 request nén; kết quả cuối ≤ 24 000, không cắt ngang. Dùng chung logic/prompt nén với `llm-summarizer.ts` (DRY: tách hàm dùng chung).
- Nếu lần 1 kết thúc `length` (chạm max output): giữ hành vi re-ask hiện có (1 lần, cùng prefix, ràng buộc cứng).
- Deadline chung `compactionDeadlineMs` bao toàn bộ; mọi attempt ghi usage.
- Một lần thử lại cho lỗi provider tạm thời (transport/5xx/timeout có thể retry) xảy ra trước khi có output, chỉ khi `ctx.llm.stream` không tự retry cho request không có `requestOwner` (implementer phải xác minh và ghi vào report).

### R3 — Fold song song
- `createCompactionSummarizer` (pair có model): nếu nguồn vừa 1 chunk → giữ nguyên hành vi.
- Nếu > 1 chunk: tóm tắt từng chunk độc lập song song (giới hạn đồng thời 4), mỗi chunk dùng prompt có ghi "phần i/n của cùng một hội thoại"; rồi một request gộp (seed checkpoint nếu có + các bản tóm tắt theo thứ tự) thành summary cuối ≤ 24 000 (dùng lại bước nén của R2 nếu > 24 000).
- Nếu các bản tóm tắt cộng lại vượt `MAX_INPUT_CHARS` của request gộp: gộp theo nhóm, lặp lại tới khi còn một (thứ tự giữ nguyên).
- Hủy (signal) dừng mọi request đang chạy; một chunk lỗi làm cả compaction lỗi (không bỏ chunk).
- Không có model (extractive) giữ nguyên.

### R4 — Tiến độ fold
- `compaction/job` thêm trường tùy chọn `progress?: { done: number; total: number }` trên stage `generating`; fold báo sau mỗi chunk xong (và khi bắt đầu gộp: `done = total`).
- Event cũ không có `progress` vẫn đọc được. UI hàng compact hiện `Summarizing 3/5` khi có progress.

### R5 — Đo đạc
- `compaction/job` stage `ended` thêm tùy chọn `requests?: number`, `usage?: { input: number; cached: number; output: number }` = tổng mọi request model của job đó (generator, nén, fold, gộp).
- UI hàng compact đã kết thúc hiện số request (vd `3 requests`) khi có.

## 4. Ràng buộc chung
- pnpm; TDD (test đỏ trước); chạy test liên quan, rồi `pnpm test`, `pnpm run typecheck`, `pnpm run build:web` khi đụng web.
- Không đổi `automaticCompactionPressure`; precompute vẫn tắt; không gọi model thật; không sửa dữ liệu ở `~/.dnt-harness/data`; không restart/deploy server.
- Giữ nguyên các bảo đảm: PreCompact chạy đúng 1 lần trước model; Stop hủy và trả `409 {cancelled:true}`; adoption kiểm identity trước khi ghi; `recoverCanonicalCheckpoint` chỉ tin log.
- Flaky có sẵn (không phải lỗi của task): `server-g1 > steer`, `path-scope-guard`, `server-g4`, `project-git-sync`, `server-g2`, `server-g5 MCP schema`.
