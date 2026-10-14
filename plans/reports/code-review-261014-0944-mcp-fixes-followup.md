# Review lại các bản sửa MCP

Phạm vi: `7f81cfc`, `c707bdc`, `7614ab5`; chỉ đọc code, không sửa source. Hai reviewer premium review client/outbound và OAuth; lead review host/plugin và đối chiếu các phát hiện. Diff đang làm dở ở `server.ts` chỉ liên quan listing session, không thuộc MCP.

## Findings

### P1: OAuth transaction không gắn với vòng đời server

`src/harness/mcp/oauth-store.ts:122-125` xóa record/token nhưng giữ transaction. `src/web/server.ts:5428-5438` chỉ đối chiếu URL trước completion. Bắt đầu Connect, Delete, tạo lại cùng tên/URL, rồi complete transaction cũ vẫn được phép. Revoke cũng chưa vô hiệu hóa transaction bắt đầu trước nó. Cần server incarnation/epoch trong transaction và invalidation khi delete/revoke, kiểm tra tại điểm ghi grant. Inspection, chưa có end-to-end repro cho delete/recreate.

### P1: URL check trước exchange vẫn có TOCTOU

`src/harness/mcp/oauth.ts:222-234`: sau kiểm tra config ở route, complete chờ token endpoint rồi ghi token/record mà không kiểm tra server identity/config nữa. Đổi URL khi exchange đang chạy vẫn cho grant cũ được ghi sau thao tác đổi. URL guard hiện tại chỉ bảo vệ đường đi tuần tự. Cần phối hợp với config mutation/epoch tại publication, không giữ khóa xuyên network exchange. Inspection.

### P1: Record/token ghi riêng, thiếu record lại fail open

`src/harness/mcp/oauth.ts:232-233` ghi token trước rồi record; crash/lỗi ghi giữa hai file để token mới thiếu record. `src/web/mcp-oauth-connect.ts:199` trả true khi record không tồn tại. Cần publication nguyên tử hoặc grant mới fail closed khi metadata thiếu; ngoại lệ legacy phải có dấu hiệu rõ. Inspection.

### P1: Abort có thể gây unhandled rejection

`src/harness/mcp/client.ts:529,653-658`: token work được tạo trước khi kiểm tra aborted. Nếu token source abort đồng bộ rồi trả Promise reject, `untilAborted` return sớm mà không consume rejection của work. Reviewer chạy repro: có `unhandledRejection` dù callTool được catch. Có thể làm host process chết theo Node rejection policy. Cần nhận thunk hoặc luôn attach handler cho work.

### P1: Recovery vẫn có race làm mất transport

`src/harness/mcp/client.ts:937-940`: timer chuyển half-open, await stop; caller tạo transport mới trong khoảng await; timer gán `this.transport = undefined`, xóa reference transport mới rồi join connecting. Transport/session có thể bị bỏ rơi. Cần capture identity transport và một single-flight lifecycle transaction. Inspection, chưa chạy repro.

### P1: Outbound còn lọt IPv6 link-local và NAT64 loopback

`src/harness/mcp/outbound-policy.ts:46-50,68-70,137-140`: link-local là fe80::/10, không chỉ prefix text fe80; NAT64 embedded loopback không phải loopback trực tiếp của host nhưng nhận ngoại lệ HTTP local fixture. Reviewer chạy validator xác nhận `https://[fe90::1]/`, `https://[febf::1]/`, `http://[64:ff9b::7f00:1]/` được chấp nhận. Khả năng kết nối tùy routing. Cần kiểm tra CIDR đúng và tách direct-loopback khỏi embedded IPv4 checks.

### P1: Plugin gỡ rồi bật lại vẫn bị cancel marker chặn

`src/web/server.ts:2194,2201`: removal gọi cancelMcpConnection và set mcpCancelled. Sync add lại tại :2179 không clear marker. Sửa fence dùng generation không giải quyết marker do removal; nhận định trước rằng #13b hết lỗi nhờ #1 là sai. Cần activation của plugin clear marker theo identity/generation thích hợp. Inspection.

### P2: Plugin naming normalization gây collision mới

`src/harness/plugins/mcp.ts:18-21`, `src/web/server.ts:2142`: collapsing underscores/trimming làm docs và docs. cùng tên; wanted Map giữ draft cuối, không báo conflict. Lead chạy hàm thật bằng Node transform-types: cả hai ra plugin_x_docs; plugin a_/b và a/b cùng ra plugin_a_b. Cần encoding ổn định không mất thông tin hoặc từ chối collision và xác minh provenance plugin id trước overwrite.

### P2: Complete không kiểm tra transaction expiry

`src/harness/mcp/oauth.ts:214-242` không đối chiếu expiresAt. Deposit trước hạn rồi complete sau hạn vẫn được exchange (provider có thể tự hết hạn code nhưng host không đảm bảo TTL). Cần expiry tại complete và publication. Inspection.

### P2: Abort khi token pending vẫn gửi cancellation

`src/harness/mcp/client.ts:488-491`: listener notify vô điều kiện; notification lấy token lần nữa, không dùng caller abort. Reviewer chạy repro thấy receipt not_dispatched nhưng POST notifications/cancelled đã gửi. Không phải replay tool side effect, nhưng phát sinh network/OAuth refresh khi request chưa gửi. Cần chỉ cancel request đã dispatch.

### P2: Response cũ có thể hồi sinh trạng thái retired client

`src/harness/mcp/client.ts:1093-1098`: recordSuccess không kiểm tra retired/current transport. Reviewer deferred HTTP response rồi retire: state trở lại ready, available true. ensureConnected vẫn chặn retired nên chưa phải bypass dispatch mới; state/breaker bookkeeping sai. Cần identity/lifecycle check trước mutation.

## Kiểm chứng và khoảng trống test

Lead chạy 5 file regression/lifecycle/OAuth: **67/67 pass**. Reviewer client chạy **10/10 pass**; reviewer OAuth chạy **66/66 pass**. Đây là tập test chồng lắp, không cộng tổng.

Tests bỏ sót interleavings: abort token case abort ngay sau callTool trước khi token source entered; recovery case chỉ caller hoàn tất trước timer, không giữa await teardown; disconnect probe chỉ reject, không resolve muộn; plugin names chỉ assert hợp lệ, không assert unique.

Reviewer OAuth chạy typecheck gặp 6 lỗi ở phần worktree ngoài scope (RichInput/FileBrowser/file-tree.spec). Không dùng kết quả này để kết luận committed MCP có type error. Không chạy toàn bộ suite lần review này.

## Ưu tiên

1. OAuth transaction incarnation/invalidation và atomic grant publication.
2. Abort/unhandled rejection, recovery ownership, IPv6 outbound policy.
3. Plugin remove/re-add + naming collisions.
4. Expiry, state mutation và regression tests với barriers.

Không sửa code trong lượt review. Những tồn đọng cũ như DNS resolution SSRF, secretRevision hardcode, journal rotation và fence workspace-wide vẫn chưa được xử lý trong các commit này.
