# Workspace Sources — thiết kế chuẩn hóa folder layer

## 1. Mục tiêu và phạm vi

Người dùng yêu cầu chuẩn hóa folder layer ở cấp workspace: Skills đã có bật/tắt nguồn, Agents và Hooks chưa có, cấu hình đang rải rác. Hướng đã trình bày và được người dùng đồng ý là một trang `Settings → Workspace → Sources`, điều khiển riêng theo loại tài nguyên.

Phạm vi: Skills, Agents, Hooks và Commands, bao gồm nguồn tài nguyên do plugin cung cấp. Không thay đổi discovery Instructions, rules/imports, cấu hình cài đặt hoặc enable Plugins, MCP, Memory hay Modes. Không sửa format tài nguyên Claude Code, không cấp thêm quyền filesystem hoặc tool.

## 2. Hiện trạng đã kiểm tra

- `src/harness/skills/layers.ts`: SkillRule gồm id, kind project/workspace/absolute, path tùy loại và enabled. Các rule có thứ tự; mặc định `.claude/skills`, `.agents/skills`, workspace và user khi host cung cấp nguồn user.
- `src/harness/skills/service.ts`: cấu hình nằm tại `<workspace>/skills/sources.json`; workspace resources là layer có thể ghi trong Settings.
- `src/web/server.ts`: skillLayers ghép nguồn rule cùng plugin và bundled; source API riêng tại `/skills/sources`.
- `src/harness/agents/definition-service.ts`: Agents dùng các layer bundled/user/plugin/workspace/project, không có rule editor tương đương Skills.
- `src/harness/hooks/settings.ts`: Hooks đọc user/workspace/project/local settings và plugin hooks. Hooks merge, không shadow theo tên. Có `disableAllHooks` và trạng thái từng hook; chưa có công tắc layer.
- `src/harness/commands/service.ts`: Commands ghép bundled/user/plugin/workspace/project; project discovery có ancestor walk.
- `web/components/settings/SkillsPanel.tsx`: Source folders là tab riêng bên trong Skills.

## 3. Cấu hình chung và tương thích

Tạo một store cấu hình nguồn tại `<workspace>/resource-sources.json`, có version và hash để chống ghi đè cấu hình đã thay đổi. Đây là sidecar của harness, không thêm khóa riêng vào file Claude.

Document version 1 có hai phần:

- `skills.rules`: giữ nguyên biểu diễn SkillRule, thứ tự, id, path và enabled hiện có.
- `enabled`: trạng thái theo loại tài nguyên và layer. Skills có plugin/bundled switches; Agents và Commands có bundled/user/plugin/workspace/project; Hooks có user/plugin/workspace/project/local. Những layer không áp dụng không được đưa vào schema.

Các nguồn Skills do rule quản lý không có công tắc trùng trong enabled. Không tạo thêm thứ tự precedence cho Agents/Commands hoặc rule đường dẫn tùy ý cho các subsystem mới. Các nguồn cố định của chúng giữ nguyên discovery, chỉ thêm bật/tắt. UI dùng cùng khái niệm nguồn nhưng không ép các parser hoặc resolver thành một thuật toán.

Nếu chưa có document chung, materialize defaults và nhập cấu hình Skills cũ nếu có. Lần lưu đầu ghi nguyên tử document chung; giữ nguyên file Skills cũ để không mất dữ liệu. Sau khi document chung tồn tại, không đọc lại file cũ làm nguồn sự thật. Endpoint `/skills/sources` trở thành adapter đọc/ghi phần skills.rules của store chung, giữ response hiện tại; cập nhật theo lock của workspace để không ghi mất phần loại khác. UI mới dùng API chung với expectedHash.

File chung bị lỗi hoặc version không hỗ trợ phải trả lỗi rõ trong Settings; runtime không âm thầm bật lại tất cả nguồn đã tắt. Giữ snapshot hợp lệ cuối cùng trong process; cold start không có snapshot hợp lệ thì từ chối discovery các nguồn cấu hình được và báo diagnostic. File chưa tồn tại là trạng thái default hợp lệ, khác file lỗi.

## 4. UI và API

Thêm `Sources` trong nhóm Workspace của Settings. Trang có bốn nhóm Skills, Agents, Hooks, Commands. Mỗi dòng hiển thị tên layer/nguồn, đường dẫn hoặc template có thể hiểu được, bật/tắt và trạng thái áp dụng. Project rules áp dụng cho các project trong workspace; hiển thị đường dẫn đã resolve theo project khi cần. Nguồn host không cung cấp được ghi rõ là unavailable, không cho UI tự tạo quyền đọc user folder.

Skills giữ khả năng thêm/xóa/sắp xếp các rule và validation đường dẫn hiện có, chuyển editor từ Skills sang Sources. Trong Skills thay tab Source folders bằng liên kết đến Sources, không duy trì editor độc lập. Agents/Hooks/Commands có liên kết tương tự ở nơi phù hợp.

`GET /api/workspaces/:wid/sources` trả config, hash và mô tả nguồn do host resolve. `PUT` nhận config và expectedHash, kiểm tra workspace ownership, browser write principal và schema; trả 409 khi stale hash, 400 khi config sai. UI có Save/Cancel, dirty-state guard và Reload khi conflict. Không ghi config từng phần qua request thiếu hash của API chung.

Nguồn disabled vẫn được liệt kê trong Sources để bật lại; catalog chỉ chứa tài nguyên từ nguồn đang bật. Việc bật/tắt nguồn không sửa hoặc xóa file tài nguyên. Công tắc từng skill/hook và disableAllHooks vẫn độc lập, không bị reset.

## 5. Resolver và hiệu lực runtime

Store chung cung cấp typed policy snapshot theo workspace; từng subsystem lọc nguồn trước scan/resolve, dùng cùng policy cho Settings catalog, model catalog, slash menu, direct load, agent spawn và child skill preload. Không chỉ lọc kết quả UI.

- Skills: giữ thứ tự rule và cách ghép plugin/bundled hiện có. Tắt plugin Skills không disable plugin Agents/Hooks/Commands.
- Agents/Commands: bỏ layer disabled trước khi áp dụng shadowing; nguồn thấp hơn có thể trở thành winner. Giữ ancestor walk Commands hiện có.
- Hooks: loại nguồn disabled trước khi parse/merge; disableAllHooks ở nguồn disabled không vô hiệu hóa nguồn khác. disableAllHooks ở nguồn enabled giữ hành vi hiện tại. Trạng thái từng hook được giữ nguyên.
- Plugin resource switches không sửa enabledPlugins và không thay đổi plugin MCP.

Sau khi lưu thành công, request hoặc operation chưa bắt đầu tiếp theo dùng policy mới. Hook cache/snapshot được invalidated cho workspace bằng cơ chế hiện có. Catalog prefix snapshot được invalidated theo revision nguồn ở lần assembly tiếp theo để model và direct lookup không lệch nhau. Không mutate request đang stream, không dừng child đã spawn, không thu hồi nội dung skill đã đi vào transcript hoặc hash-pinned active skill trong turn hiện tại. Operation đã lấy snapshot được hoàn thành theo snapshot đó; operation mới đọc revision mới.

Nếu nguồn workspace bị tắt, vẫn cho authoring workspace resource nhưng trả cảnh báo rằng resource chưa được discover, tương tự warning Skills hiện tại. Không âm thầm bật nguồn khi save resource.

## 6. An toàn và giới hạn

Giữ nguyên validation SkillRule, chặn đường dẫn quá rộng và containment; absolute source roots vẫn được bảo vệ trong grant policy. Thay đổi nguồn không tạo filesystem grants. Không cho config mới truy cập nguồn user mà host chưa enable. Permission/mode/blockedTools vẫn có ưu tiên độc lập với resource policy.

Mutation cấu hình được serialize theo workspace, ghi nguyên tử và kiểm tra hash trong lock. Publish revision và invalidate cache chỉ sau khi write thành công. Save thất bại giữ policy cũ và dirty form. Workspace này không tác động workspace khác.

## 7. Kiểm thử và tiêu chí nghiệm thu

1. Migration giữ mọi rule Skills, thứ tự và switch cũ; adapter cũ và API chung không ghi mất phần cấu hình khác.
2. Default discovery của cả bốn subsystem không đổi trước khi người dùng tùy chỉnh.
3. Mỗi layer toggle tác động catalog lẫn direct execution/load; child preload và agent spawn không bypass nguồn disabled.
4. Tắt layer cao làm nguồn thấp hơn resolve đúng; Commands ancestor walk và plugin namespacing không đổi.
5. Hooks tắt theo layer không chạy, vẫn giữ per-hook state; disableAllHooks chỉ có hiệu lực từ nguồn enabled.
6. Workspace isolation, stale hash, malformed/versioned file, atomic write failure và concurrent adapter writes có regression tests.
7. Policy revision đổi cập nhật catalog/hook snapshot ở operation kế tiếp, không sửa request đang chạy hoặc child đang thực thi.
8. Sources UI có đủ bốn nhóm, dirty/save/error/conflict handling; editor Skills cũ được chuyển, không còn hai nguồn cấu hình độc lập.
9. Sources không đổi Instructions, enabledPlugins, plugin MCP, mode hoặc quyền filesystem.

Chạy affected unit/integration/UI tests trước; sau đó `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`. Báo riêng lỗi baseline và lỗi do thay đổi, không sửa các công việc không liên quan.

## 8. Ranh giới triển khai

Store/schema/policy là module nhỏ dùng chung; parser Skills/Agents/Hooks/Commands giữ riêng. `src/web/server.ts` chỉ wiring/API/invalidation cần thiết, không refactor toàn server. Cập nhật docs Skills, Claude format, web và agent-guide cho vị trí quản lý Sources mới.

Checkout đang có nhiều thay đổi của công việc khác trên `feat/subagent-mcp-inherit`; triển khai trong worktree riêng từ baseline đã thống nhất, không reset, stage hoặc commit các thay đổi đó. Không tự deploy hoặc restart host. Đặc tả này chưa phải bằng chứng tính năng đã được triển khai hay kiểm thử.
