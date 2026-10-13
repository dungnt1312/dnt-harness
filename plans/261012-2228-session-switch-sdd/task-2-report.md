# Task 2 — Báo cáo: củng cố handoff cache khi chuyển session

## Nguyên nhân
Inactive a–d + active e, chọn a: render đầu vẽ cache a. Cleanup của effect e chèn e vào cache (đã đủ 4) rồi evict mục cũ nhất là a, trước khi effect mới của a kịp `cache.get(a)` → UI trống và reload đầy đủ.

## Sửa (`web/hooks/useSessionStream.ts`)
- Thêm `committedScope` ref, cập nhật bằng `useLayoutEffect` (chạy trong commit, trước passive cleanup của scope cũ). Không mutate khi render nên an toàn với concurrent render bị bỏ và StrictMode.
- Trong cleanup, mục của scope vừa commit được coi là "handoff": không tính vào giới hạn đếm/trọng lượng và không bị evict. Effect mới của scope đó claim và xoá nó khỏi cache ngay sau.
- Giới hạn cho các mục inactive vẫn là ≤4 mục và ≤16 MB (hằng `MAX_CACHE_ENTRIES`, `MAX_CACHE_WEIGHT`); thứ tự LRU giữ nguyên.
- Không đổi `docs/web.md` vì hợp đồng ("tối đa bốn hội thoại xem gần đây") vẫn đúng với mục inactive.

## Test (`web/hooks/useSessionStream.switch.spec.tsx`)
- Probe ghi thêm `events`, hỗ trợ chế độ StrictMode.
- Mới: chọn a khi a–d inactive + e active, ở cả plain và StrictMode. Mọi render của a đều có nội dung/events `a`, không có approval/question, cursor resume = 10; sau đó giới hạn đếm vẫn đúng (b bị evict, e còn).
- Mới: thinking fold qua cache roundtrip + resume có seq cũ/trùng (4,5 bị bỏ, 6,7 gộp thành `xyz`), cursor nén (frame id 5 > seq cuối 2), replay rỗng giữ nguyên tham chiếu `events` và cursor tăng lên 9.
- Mới: snapshot thay thế reset fold thinking cũ (assert `events`) và cursor về 1.
- Bổ sung assert `events` vào test snapshot-replacement sẵn có.
- Test eviction count cũ đổi sang a–f: theo ngữ nghĩa mới, khi active e thì a–d vẫn còn nên cần session thứ 6 để a bị evict.
- Kiểm chứng: tạm vô hiệu `handoff` → 2 test mới (plain/StrictMode) fail; khôi phục → pass.

## Lệnh và kết quả
- `pnpm exec vitest run web/hooks/useSessionStream.switch.spec.tsx` → 11/11 pass.
- `pnpm exec vitest run web/hooks web/lib tests/web/sse-resume.spec.ts web/components/chat/transcript-window.spec.tsx` → 48 file, 516 test pass.
- `pnpm run typecheck` → exit 0.
- Chưa chạy: toàn bộ `pnpm test`, `build:web`.

## Không làm / còn lại
- Budget hot-path (`JSON.stringify(batch)` mỗi frame): không đổi. Chưa có đo đạc xác nhận lãng phí, và bộ ước lượng thay thế (ví dụ đếm độ dài chuỗi) có nguy cơ làm yếu ngân sách an toàn. Có thể làm riêng nếu có profile.
- `onerror` CLOSED/auth và `JSON.parse` không catch: có sẵn từ trước, ngoài phạm vi, không sửa.
- Chưa test thủ công với concurrent transition thật; lập luận an toàn dựa trên việc không mutate khi render.
- Compactor không sửa: test cho thấy nó xử lý đúng ranh giới thinking/duplicate với cursor nén.
