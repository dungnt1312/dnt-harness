# MCP followup fixes

Đã xử lý 11 findings của `code-review-261014-0944-mcp-fixes-followup.md`, không commit. Giữ nguyên các thay đổi editor/session/UI ngoài scope.

## Thay đổi

- OAuth: durable server incarnation/epoch, vô hiệu hóa transaction trước Delete/Revoke/config change; kiểm tra config identity và TTL tại grant publication. Token cùng discovery record được publish trong một encrypted file bằng atomic rename. Grant managed mới thiếu record fail closed; fixture legacy được nhận diện riêng.
- Client: token abort dùng thunk và consume mọi rejection; chỉ gửi cancellation sau dispatch và dùng credential đã lấy. Recovery detach transport trước await, không xóa transport caller tạo; late success không sửa trạng thái client retired/noncurrent/dead.
- Outbound: kiểm tra link-local IPv6 fe80::/10 đúng CIDR; NAT64 embedded loopback không dùng ngoại lệ direct-loopback HTTP.
- Plugin: bỏ toàn bộ draft collision kèm diagnostics, chặn chuyển provenance owner giữa plugin; activation mới clear removal marker, nhánh user-disabled giữ nguyên.

## TDD và review

Workers xác nhận RED/GREEN với barriers cho token-enter/abort, recovery-stop/caller, retire/response, exchange/config mutation, first-Begin/Revoke, concurrent first incarnation. Parent xác nhận RED/GREEN cho plugin collision, provenance owner và remove/re-add.

Review độc lập cuối tìm thêm race khởi tạo incarnation chưa khóa với invalidate. Đã sửa cùng publication lock, tránh recursive lock bằng helper cho caller đã giữ lock; file temporary mỗi write riêng. Hai regression test mới RED trước sửa rồi GREEN. OAuth suites 93/93 pass.

## Verification cuối

- 29 file MCP/plugin: **299/299 pass**.
- `pnpm test`: **3628 pass, 3 fail, 2 skipped**, 299 file pass / 1 fail. Ba lỗi đều trong `web/hooks/useWorkbenchFiles.spec.ts`: asks before closing a tab with unsaved changes and keeps it when refused; closes and drops the draft when confirmed; closes a clean draft without asking. Nguyên nhân `closeFileWithDraft` không được export từ hook đang chỉnh ở task editor ngoài scope.
- Server typecheck `pnpm exec tsc --noEmit -p tsconfig.json`: pass (worker chạy sau epoch fix).
- `pnpm run typecheck`: còn TS2305 thiếu export closeFileWithDraft và TS7006 implicit any message ở `web/hooks/useWorkbenchFiles.spec.ts` (ngoài scope).
- `pnpm run build:web`: pass trước epoch-only followup.

## Giới hạn

Không coi toàn repo là xanh khi task editor còn test/type errors. DNS-resolution SSRF, journal rotation, secretRevision hardcode và workspace-wide secret fence là tồn đọng cũ ngoài 11 findings đợt này. Trực tiếp đổi file config ngoài đường mutation host vẫn là giới hạn của OAuth epoch; metadata/current config được kiểm tra tại publication nhưng chưa có durable identity cho mọi chỉnh sửa ngoài host.
