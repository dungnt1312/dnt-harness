# Spec: MCP cho subagent (inherit kiểu Claude/ZCode)

Ngày: 2026-10-13 · Trạng thái: chờ duyệt · Branch: main

## Mục tiêu

Subagent dùng được MCP mà parent đang thấy, không cần model nhớ `grantTools`.
Hành vi theo Claude Code / ZCode: role inherit-all tự có MCP; role khai `tools`
cụ thể chỉ có MCP mà nó liệt kê; bundled `explorer` không có MCP, muốn có thì
override agent file (ví dụ `tools: Read, Glob, Grep, mcp__codebase-retrieval__*`).

Không đổi: mode exposure (`none | read-safe | all`), host `blockedTools`,
server enabled + `allowedTools`, approval policy của root, ceiling pin lúc
spawn, one-level delegation.

## Hiện trạng (cần đổi)

- `src/harness/agents/executor.ts:799` — `mcp__*` chỉ vào ceiling khi grant
  nêu đích danh.
- `executor.ts:177` `roleCandidates` — role inherit chỉ thêm MCP có trong grant.
- `src/web/execution-authority.ts:131` — chặn MCP theo **tên** `explorer`, nên
  override `explorer.md` cũng bị chặn.
- `src/harness/agents/definition-service.ts:86` — `mcpServers` bị bỏ qua (warning).
- `src/web/agent-delegation.ts:458` — grant MCP không có trong role bị "dropped
  note" im lặng.

## Quy tắc mới

`toolCeiling = admission(roleCandidates expanded) ∩ grantFilter − disallowedTools`

### Role candidates

| Role | Built-in | MCP |
|---|---|---|
| `tools` omitted hoặc `*` (`inheritsTools`) | như hiện tại | selector `*`: mọi MCP tool live của workspace; nếu có `mcpServers: [a,b]` thì chỉ `mcp__a__*`, `mcp__b__*` |
| `tools` cụ thể | như hiện tại | các `mcp__s__t` và `mcp__s__*` được liệt kê |
| bundled `explorer` (source `bundled`) | `Read, Glob, Grep` | không có |

Override `explorer` (source khác `bundled`) là role bình thường.

### grantTools (chỉ thu hẹp)

- Grant có ít nhất một tên `mcp__*`: giữ đúng các MCP tool khớp grant (exact
  hoặc `mcp__s__*`).
- Grant không có tên MCP nào: MCP giữ nguyên theo role (grant chỉ thu hẹp built-in).
- Built-in: như hiện tại (`grant.includes`).
- Grant không bao giờ mở MCP mà role không có (bundled `worker`/`reviewer`/
  `verifier` không tự có MCP).

### disallowedTools

Chấp nhận exact `mcp__s__t`, `mcp__s__*` và `mcp__*` (tắt toàn bộ MCP).

## Luồng dữ liệu

1. `parseAgentDefinition` giữ selector `mcp__s__*` trong `tools`/`disallowedTools`
   (đã giữ nguyên chuỗi `mcp__…` hôm nay), parse `mcpServers` (list string),
   chuyển `mcpServers` sang `ENFORCED_KEYS`. Thêm field `mcpServers?: string[]`
   vào `AgentDefinition`; `serializeAgentDefinition` round-trip.
2. `roleCandidates(definition)` trả built-in + MCP entries (exact và selector).
   Inherit role thêm `mcp__*` (hoặc `mcp__<server>__*` theo `mcpServers`).
   Bundled explorer không thêm gì.
3. `SpawnAdmissionResolver` input thêm `definitionSource`. Host
   (`server.ts` → `executionAuthority.admissionCeiling`) mở rộng selector thành
   tên cụ thể từ `mcpDescriptors` của workspace (đã lọc provider-valid +
   `allowedTools`), rồi lọc bằng `isToolExposed` như hiện tại.
4. Executor áp grantFilter + `disallowedTools` lên danh sách đã mở rộng, pin
   vào `childOf.toolCeiling`. Bỏ điều kiện `executor.ts:799`.
5. MCP server connect sau lúc spawn: child không thấy (giống ZCode startup snapshot).

## Explorer check

`exposureRefusal` (`execution-authority.ts:131`) đổi thành chặn khi
`childOf.definition === 'explorer' && childOf.definitionSource === 'bundled'`.
`ExposureScope.childOf` thêm `definitionSource?`; `agentScope.childOf` đã có
field này nên live gate nhận được trực tiếp. Bundled explorer cũng không có
MCP trong candidates nên đây là lớp phòng thủ thứ hai.

## Fail-fast

Chỉ áp cho **tên MCP cụ thể trong `grantTools`** (yêu cầu tường minh của lần
spawn này): tên nào không có trong ceiling thì spawn ném `SpawnError('mcp', …)`
liệt kê các tên đó và nguyên nhân khả dĩ (role không có, mode không expose,
server/allowlist loại). MCP do role tự khai (`tools`, `mcpServers`, selector)
bị mode thu hẹp im lặng như built-in (ví dụ `Write` trong Plan) — nếu không,
role có MCP sẽ không spawn được trong Plan. `SpawnError.code` thêm `'mcp'`,
HTTP 400.

(Sửa khi lập plan: bản đầu định fail-fast cả tool do role khai và kèm lý do
`exposureRefusal`; bỏ vì chặn spawn role trong Plan và executor không có
authority để lấy lý do.)

`agent-delegation.ts`: bỏ nhánh "dropped" cho tên MCP (giờ là fail-fast hoặc
hợp lệ); giữ dropped cho built-in. Cập nhật mô tả `grantTools`.

## Tests

`tests/web/permission-hardening.spec.ts` (real host admission):
- inherit role, full-access, không grant → có `mcp__fixture__query`, gọi được.
- inherit role, grant chỉ `['Read']` → vẫn có MCP.
- inherit role, grant `['Read','mcp__fixture__other']` → chỉ còn tool được grant.
- Plan root → MCP không read-safe bị loại; widening root sau spawn không mở lại.
- bundled explorer + grant MCP → không có MCP (`Explorer exposes zero MCP tools`).
- explorer override (workspace source) với `tools: Read, mcp__fixture__*` → có MCP.
- role `tools` cụ thể nêu `mcp__fixture__missing` → `SpawnError('mcp')`.
- `disallowedTools: mcp__*` → không có MCP.

`tests/harness/g4-agents.spec.ts` / `g4-subagent-contract.spec.ts`:
- parse `mcpServers`, selector trong `tools`, round-trip serialize.
- `roleCandidates` cho inherit / explicit / bundled explorer.

Cập nhật các test hiện đang assert "MCP requires explicit grant".

## Docs

- `docs/capabilities.md`: thay đoạn "MCP always requires an explicit spawn
  grant" bằng quy tắc mới; ghi cách override explorer.
- Comment `executor.ts:791-793`, `scope.ts:44`, `definition-service.ts:43-45`.

## Ngoài phạm vi

- Cờ `readOnly` theo server cho bundled explorer (để sau nếu cần).
- Child thấy MCP server connect sau spawn.
- UI Settings → Agents cho `mcpServers` (chỉ round-trip file).

## Câu hỏi mở

Không có.
