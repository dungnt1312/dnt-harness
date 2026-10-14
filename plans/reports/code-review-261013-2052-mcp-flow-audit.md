# Rà soát luồng MCP — 2026-10-13

Phạm vi: `src/harness/mcp/*`, phần wiring MCP trong `src/web/server.ts`, `src/web/mcp-oauth-connect.ts`, `web/components/settings/McpPanel.tsx`.
Cách làm: 3 reviewer premium chạy song song (transport/client, host lifecycle, OAuth + UI), sau đó lead tự kiểm chứng lại các phát hiện chính.
Chỉ review, chưa sửa code. Reviewer chỉ đọc code; chưa chạy test.

Ký hiệu: ✅ lead đã tự kiểm chứng trên code/bằng lệnh · ◐ chỉ reviewer đọc code, lead chưa đối chiếu lại.

## P0

1. ✅ **Server kẹt "connecting" vĩnh viễn sau fence** — `server.ts:2225-2227`, `:2422`, `:2632`.
   `fenceWorkspace` thêm mọi key đang connect vào `mcpCancelled`. Key chỉ được xóa ở enable/reconnect (`:5610`), OAuth complete (`:5351`) và secret rotate (`:5732`). Mọi save, đổi secret, `observeConfig` hay `disableMcpForTurn` xảy ra đúng lúc một turn đang connect sẽ làm server đó bị từ chối im lặng ở mọi turn sau (`connection is cancelled`, lỗi bị nuốt ở `:2632`, không ghi failure). UI hiện `connecting` mãi.
   Sửa: fence chỉ dựa vào generation (đã có `generationAtStart`); `mcpCancelled` chỉ dành cho disable/delete/close.

## P1

2. ◐ **Descriptor cũ còn sống sau fence/lỗi connect** — `server.ts:2223-2239`, `:2468-2474`. Fence ngắt client nhưng không xóa `mcpDescriptors`; connect lỗi cũng không xóa. Model vẫn thấy tool của server đã chết, mỗi lần gọi tốn một connect timeout. `reconcileMcpTools` ném giữa vòng lặp để lại một nửa danh sách tool.
3. ✅ **Status "connecting" thay vì "failed"** — `server.ts:5463`. Lỗi của Enable/Reconnect/OAuth complete không ghi vào `mcpConnectFailures`; GET mặc định `connecting` khi không có client. Sau mỗi save, fence xóa client + failure của cả workspace nên mọi server hiện `connecting` tới turn sau.
4. ◐ **Route `reconnect` bật được server disabled mà không pin executable** — `server.ts:5589-5600`. Dùng `withServerEnabled` thay vì `withServerActivated`; stdio chỉ kiểm tra pin khi đã có pin (`client.ts:204`). UI đã khóa nút Reconnect khi disabled (`McpPanel.tsx:626`), nên chỉ khai thác được qua API.
5. ✅ **SSRF qua IPv6 IPv4-mapped** — `outbound-policy.ts:84`, `:99-104`. `new URL('https://[::ffff:10.0.0.1]/')` chuẩn hóa thành `[::ffff:a00:1]` (đã chạy bằng node), regex chỉ nhận dạng dotted nên không unwrap; `prohibitedV6` không chặn `::ffff:`. Đây là lỗi riêng, khác lỗi DNS-rebinding đã biết.
6. ◐ **Token resolution không có timeout/abort** — `client.ts:515` nằm trước `AbortSignal.any` ở `:538`; một `tokenSource` treo làm tool call/health check treo vô hạn.
7. ◐ **Breaker recovery sống lại sau `disconnect()`** — `client.ts:915`, `:1075-1085`. Catch của recovery gọi `openBreaker` → lên lịch recovery mới, không kiểm tra `retired`; client đã bỏ vẫn chạy timer mãi.
8. ◐ **Recovery timer giết transport vừa được caller khôi phục** — `client.ts:907-909`. `recordSuccess` không hủy timer; timer stop vô điều kiện transport hiện tại, call đang chạy thành `possibly_dispatched`.
9. ◐ **Helper process mồ côi khi process cha đã exit** — `client.ts:412-415` return trước `killOwnedProcessTree` (`:420`).
10. ✅ **OAuth: refresh đè lên `auth_required` của insufficient_scope** — `oauth.ts:102-112` vs `:308-312`. `markScopeRequired` chỉ qua `serializeWrite`, không qua `withServerLock` và không tăng fence generation; refresh đang chạy ghi tiếp `active`, UI lại báo Connected.
11. ◐ **OAuth: Connect URL mới / completion cũ gắn grant sai URL** — `mcp-oauth-connect.ts:144`, `server.ts:5334`. `beginConnect` ghi record URL mới trước khi đăng nhập xong; completion không đối chiếu config hiện tại.
12. ✅ **DELETE không revoke phía provider** — `server.ts:5505`. Gọi `oauth.revoke(wsId, serverName)` không truyền `revocationEndpoint` → `remote: 'unavailable'` (`oauth.ts:331`), rồi xóa record nên không còn cách revoke. Route `/oauth/revoke` thì có truyền.
13. ✅ **Plugin sync bật lại server plugin user đã Disable / kẹt sau khi gỡ-thêm plugin** — `server.ts:2156-2161`, `:2176`. Điều kiện bỏ qua yêu cầu `existing.enabled`, nên server disabled bị `withServerActivated` lại; gỡ plugin gọi `cancelMcpConnection` (set `mcpCancelled`), thêm lại không xóa key → kẹt như P0.

## P2

14. ✅ **Import ghi đè server đang chạy, giữ enabled, response báo sai** — `server.ts:5391-5403`, `config-v2.ts:64,72`. `upsertServer` bỏ `enabled` của body, nên `{...server, enabled:false}` vô hiệu; response vẫn `enabled: [], spawned:false`.
15. ◐ Fence quá rộng (cả workspace) cho thay đổi một server — `disableMcpForTurn :1451`, OAuth revoke `:5361`.
16. ◐ 409 giả ở Enable: `expectedGeneration` lấy trước `await resolveCanonicalExecutable` — `server.ts:5570-5583`.
17. ◐ `schema()` bỏ hậu tố "(interactive — always asks)" — `server.ts:2525` vs `:2516`.
18. ◐ Refresh `tools/list_changed` của client cũ ghi lại descriptor cho server đã xóa — cần guard `mcpClients.get(key) === client` trong `reconcileMcpTools`.
19. ◐ Tên server chứa `__` không bao giờ dùng được; va chạm `mcp__a___b` — `execution-authority.ts:87-89`.
20. ◐ `maxLifetimeMs` kill không sticky → vòng kill/spawn — `client.ts:346`.
21. ◐ Frame limit stdio tính trên buffer + chunk thay vì từng frame — `client.ts:229`.
22. ◐ `maxSchemaDepth` không áp dụng (`vettedTool` không có caller).
23. ◐ OAuth: thiếu client secret tạm thời → grant thành `auth_required` vĩnh viễn — `oauth.ts:298-306`.
24. ◐ UI: auto-complete callback lỗi làm mất nút Finish sign-in — `McpPanel.tsx:335`.
25. ◐ Discovery chỉ thử authorization server đầu tiên — `oauth-discovery.ts:257`.
26. Đã biết từ trước: journal rotation, audit fault file chung, `secretRevision: 1` hardcode, DNS rebinding, chỉ chấp nhận protocol `2025-06-18`.

## Đã kiểm tra và thấy đúng

Single-flight connect theo `(workspace, server)`; publication gate sau disable/delete; `serializeMcpMutation` + `writeDesiredState`; `journalFor` + `dispatchToolCall` (intent fsync trước khi gửi, không replay); `schema()` trả `undefined` thực sự ẩn tool; workspace isolation trong `execute`; PKCE/state; editor giữ `env`/`headers`; import để server mới ở disabled.

## Đề xuất thứ tự sửa

1. P0 #1 + #3 + #2 (cùng một cụm: cancel marker, failure bookkeeping, descriptor cleanup) — đây khả năng cao là nguồn "server lúc chạy lúc không" mà user thấy.
2. #5 SSRF, #12 revoke, #4 reconnect pin (bảo mật).
3. Cụm breaker/recovery trong `client.ts` (#7, #8, #6, #9).
4. Cụm OAuth (#10, #11) và phần P2 còn lại.

## Trạng thái xử lý (cập nhật 2026-10-13 23:45)

Đã sửa theo TDD (mỗi lỗi có test đỏ trước, rồi xanh). Test hồi quy mới: `tests/harness/mcp-client-fixes.spec.ts` (client), `tests/web/mcp-lifecycle-fixes.spec.ts` (host), cùng các case thêm vào `mcp-oauth.spec.ts`, `mcp-oauth-discovery.spec.ts`, `mcp-oauth-connect.spec.ts`, `mcp-oauth-panel.spec.tsx`.

| Mục | Kết quả | Ghi chú |
|---|---|---|
| #1 P0 | Đã sửa | `fenceWorkspace` chỉ dùng generation, không động tới `mcpCancelled`; pre-step không ghi lỗi cho connect bị fence |
| #2 | Đã sửa | Fence và catch của `ensureMcpServer` xóa descriptor; `reconcileMcpTools` validate cả danh sách trước khi ghi |
| #3 | Đã sửa | Lỗi Enable/Reconnect/OAuth complete được ghi; trạng thái `idle` mới cho server enabled mà chưa có kết nối |
| #4 | Đã sửa một phần | Reconnect refuse (409) stdio chưa có pin. Không refuse mọi server disabled: Reconnect trên server HTTP disabled vẫn bật nó (không có file thực thi để pin) |
| #5–#9, #20–#22 | Đã sửa | `client.ts`, `outbound-policy.ts` |
| #10, #23, #24, #25 | Đã sửa | OAuth + UI |
| #11 | Đã sửa | Cả phía OAuth (record chỉ lưu khi complete thành công) lẫn route (từ chối khi URL/server đổi) |
| #12 | Đã sửa | DELETE đọc `revocationEndpoint` trước khi xóa record |
| #13 | Đã sửa phần (a) | Server plugin user đã Disable giữ nguyên Disable. Phần (b) hết lỗi nhờ #1 |
| #14 | Đã sửa | Import từ chối (409) nếu trùng tên, không ghi gì |
| #15 | Đã sửa một phần | OAuth revoke không còn fence cả workspace. `disableMcpForTurn` và đổi secret vẫn fence cả workspace (chủ ý: cần cho an toàn) |
| #16 | Đã sửa | Enable so sánh config của chính server đó thay vì generation của workspace |
| #17, #18 | Đã sửa | Một hàm `mcpToolDescription`; `reconcileMcpTools` bỏ qua client cũ |
| #19 | Đã sửa | `validateNewServerName` áp cho tên mới ghi (save/import/plugin); config cũ vẫn đọc được |

Lỗi tìm thêm trong lúc sửa: `ensureMcpServer` trả client đang kết nối dở (đã publish trước `tools/list`), nên một lượt chat đến giữa chừng chạy khi tool chưa đăng ký. Đã sửa: join connect đang chạy.

## Câu hỏi còn mở

- Plugin sync (#13a) đã sửa theo hướng "Disable của user thắng". Nếu hợp đồng `enabledPlugins` muốn bật lại mỗi lần sync thì cần đổi lại.
- #15: đổi secret và `disableMcpForTurn` vẫn fence cả workspace. Muốn fence theo từng server thì cần thêm đường riêng cho `updateMcpSecrets`.
- `pnpm test` còn 4 test đỏ không thuộc phần MCP: 3 test UI settings (`management.spec.tsx`, `settings-panels.spec.tsx`, `ui.spec.tsx`) đỏ cả khi gỡ hết thay đổi MCP, do thay đổi chưa commit ở `SkillsPanel.tsx` / `SettingsModal.tsx`; `server-g1.spec.ts` và `project-git-sync.spec.ts` đỏ khi chạy cả bộ nhưng xanh khi chạy riêng (flaky khi tải cao).
