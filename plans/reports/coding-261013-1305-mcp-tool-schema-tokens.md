# Report: ước lượng token schema MCP trong Settings → Servers

Date: 2026-10-13 · Branch: main · Request: "Làm thêm đi" (thêm ước lượng context MCP ngay ở card server, như đã đề xuất ở lượt trước)

## Outcome

Done. GET `/api/workspaces/:wid/mcp` giờ trả `toolSchemaTokens` cho mỗi server đang ready và có tool; card server trong Settings hiển thị `~N tok/request` cạnh dòng "all exposed"/allowlist. Con số là chars/4 — đúng thước đo `schemaCost` mà context builder tính vào `breakdown.mcpTools`, nên khớp với segment "MCP tools" của context meter.

## Changes

- `src/web/server.ts`
  - Module-level `mcpModelSchema` + `mcpSchemaTokenEstimate` (trước `handleApi`): dựng lại đúng schema model nhận (cùng wording `[MCP:server] …` với nơi đăng ký tool, lọc tên provider từ chối và allowlist), rồi `schemaCost` (chars/4) lên descriptors của server.
  - Route GET list MCP: thêm `...(toolSchemaTokens > 0 ? { toolSchemaTokens } : {})` khi `server.enabled && client.state === 'ready'`; import thêm `schemaCost` từ `../harness/context/budget.ts`.
- `web/lib/types.ts`: `McpServerRow.toolSchemaTokens?: number`.
- `web/components/settings/McpPanel.tsx` (`DiscoveredTools`): thêm span `· ~N tok/request` với tooltip giải thích chars/4 và quy chiếu sang context meter; chỉ hiện khi `> 0`.
- `docs/web.md`: mô tả `toolSchemaTokens` ở hàng route `…/:wid/mcp`.
- Tests: `tests/web/mcp-production-stack.spec.ts` (poll sau enable, assert `toolSchemaTokens > 0`), `web/components/settings/settings-panels.spec.tsx` (fixture thêm `toolSchemaTokens: 1234`, assert `~1,234 tok/request`).

## Verification

- `pnpm vitest run tests/web/mcp-production-stack.spec.ts web/components/settings/settings-panels.spec.tsx` — pass (2 + 45 tests).
- `pnpm vitest run tests/web/server-g3.spec.ts tests/web/mcp-desired-state.spec.ts tests/web/mcp-integration-review.spec.ts` — 43 pass.
- Debug script tsx với fixture stdio thật: 4 tool → `toolSchemaTokens: 149` (đã xóa script sau khi dùng).
- `pnpm run typecheck` — pass. `pnpm run build:web` — pass.
- `pnpm test` (full): 3360 pass, 2 fail thuộc `tests/web/server-g1.spec.ts` (test steer "…'cancelled', 'completed'"); chạy lại riêng file này 18/18 pass — flake đã ghi nhận từ core review 2026-10-08 (fail dưới tải full-suite, pass độc lập), không liên quan thay đổi.

## Lưu ý

- Server disabled / connecting / failed không có trường này (đóng góp 0 token vì không chạy); tool bị allowlist ẩn và tên provider từ chối đã bị trừ khỏi ước lượng.
- Con số chỉ thay đổi khi client re-list tools (reconnect, health-check reconcile); một server vừa ready trong vòng 100ms đầu có thể chưa có trường — UI tự ẩn đến lần refresh sau.

## Unresolved questions

- Không có.
