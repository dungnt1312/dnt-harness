# ZCode: permission mode và folder scope (so với dnt-harness)

Thời điểm: 2026-10-13 09:03 +07:00. Nguồn: clone `/tmp/zcode-research` (github.com/zai-org/ZCode), commit `aac4755` (2026-10-10). Phía dnt-harness đọc từ `src/harness/modes/bundled.ts`, `docs/harness.md`, `src/web/server.ts`.

## Kết luận

ZCode **không có folder scope cứng và không có OS sandbox cho Bash**. Họ chọn như vậy có chủ đích và ghi rõ trong code/doc. Độ an toàn của ZCode dựa vào ma trận mode, phân loại Bash read-only, và một mode `guarded` (gần như yolo nhưng các lệnh phá hủy phải được duyệt từng lần). So ra thì dnt-harness đang chặt hơn ZCode về scope; cả hai đều chưa có sandbox thật cho shell.

## 1. Mode của ZCode

`CliPermissionMode = "build" | "plan" | "edit" | "yolo" | "guarded"` (`packages/cli/src/cli-types.ts:122`). Trong contract còn có `auto` nhưng bị deny (`mode.auto.unimplemented`).

Thứ tự quyết định nằm trong `packages/core/src/permission/service.ts` (`checkPermission`, dòng 134–265):

| Mode | Hành vi |
|---|---|
| `build` (mặc định UI) | Tool read-only được allow. Risk `critical`/`high` phải ask. Tool có side effect (`sideEffectScope !== "none"`) phải ask. |
| `edit` | Giống `build`, nhưng tool `edit` có `sideEffectScope === "workspace"` được allow. |
| `plan` | Chỉ read-only, MCP non-destructive, và một vài session action. Mọi thứ khác bị deny. |
| `yolo` | Allow tất cả (`mode.yolo`), bỏ qua cả project rules. Ngoại lệ duy nhất là tool `alwaysAsk`. |
| `guarded` | Là yolo, nhưng Bash khớp danh sách lệnh nguy hiểm thì ask với `approvalMode: "user-once"`: không có nút "always allow" và hook không bỏ qua được. |

Một số điểm đáng chú ý:
- Chạy headless (`zcode -p`) mặc định là `yolo` (`packages/cli/src/run.ts:47`).
- Mode được lưu theo project trong SQLite (`saveProjectPermissionMode`, file `local-settings.ts`).
- Khi user bấm cấp "Full access" từ một approval, chỉ session hiện tại chuyển sang `yolo`. Lần cấp này có receipt durable và gom luôn các input đang chờ trong queue (`runtime/permission-full-access.ts`).
- Có project rules `allow/ask/deny` với cú pháp `Bash(git:*)` và wildcard. Ngoài ra có session rules và `allowedTools`/`disallowedTools`. Trong `yolo`, project rules **không** được xét (comment ở dòng 366 thừa nhận "yolo 目前先于 disallowedTools 放行").

### Menu mode trên UI

Desktop, mobile Composer và Automation/OffPeak dùng chung một danh mục mode, định nghĩa ở `packages/shared/src/zcode-agent-model-state.ts:19-40` (`ZCODE_AGENT_MODE_OPTIONS`). Nhãn lấy từ `packages/ui/src/i18n/locales/en-US.ts:6415-6425`.

| UI | Mode id | Hành vi thật |
|---|---|---|
| Plan mode | `plan` | Chỉ cho tool read-only, MCP non-destructive và một vài session action |
| Ask before changes | `build` | Tool read-only (kể cả Bash read-only) chạy luôn; tool có side effect phải hỏi |
| Autonomous mode | `guarded` | Giống `yolo`; chỉ Bash khớp danh sách lệnh phá hủy là phải hỏi, và hỏi từng lần |
| Full access | `yolo` | Cho chạy tất cả, trừ tool `alwaysAsk` |

`edit` ("Edit automatically") đã bị bỏ khỏi menu nhưng vẫn được nhận khi đọc lại session cũ (`ZCODE_AGENT_MODE_ID_SET`, dòng 42-45). Tên "Autonomous mode / Ask when there's risk" là quyết định trong `docs/dangerous-command-approval-v1-plan.md:34`; giá trị nội bộ vẫn là `guarded`.

## 2. Folder scope

`packages/core/src/tool/path-policy.ts:36-39`:

```ts
// Current release intentionally does not hard-block paths outside workspaceRoot.
// Cause: subagents may need to inspect user-requested sibling repos or external files
// before the filesystem permission adapter grows explicit ask/deny rules for them.
return resolvedPath;
```

Như vậy file tool của ZCode **không chặn gì** ở ngoài workspace. Path chỉ ảnh hưởng tới quyết định qua `sideEffectScope` và project rules. Cơ chế liên quan duy nhất là `bash-cwd-policy.ts`: nếu lệnh Bash `cd` ra ngoài workspace thì lần gọi sau shell cwd bị reset về workspace root, kèm thông báo `Shell cwd was reset to …`. Đây chỉ là chuyện tiện dụng, không phải lớp bảo vệ. Memory file có rule riêng (`memory-file-permission.ts`): Write/Edit vào memory root được nới quyền.

## 3. Bash: sandbox và phân loại lệnh

- Bash input có field `dangerouslyDisableSandbox` và gửi `sandbox: { enabled: !dangerouslyDisableSandbox }` xuống `ExecutionPort` (`tool/handlers/bash.ts:474`). Tuy nhiên adapter (`packages/adapters/src/exec/`) **không đọc** field `sandbox`; grep `.sandbox` ra 0 kết quả. Comment ở `node-execution-adapter-run.ts:276` ghi "sandbox 撤除后", tức sandbox đã bị gỡ.
- `docs/automation-edit-status.md:421-440` nói rõ là không có OS sandbox, không có bwrap/Seatbelt, và không dùng regex trên chuỗi lệnh làm ranh giới bảo mật. Lý do họ đưa ra: "shell 的变量、cwd、脚本、符号链接…无法由关键词或正则可靠还原". Nếu sau này cần ranh giới cứng thì họ sẽ thiết kế một lớp cách ly cross-platform riêng.
- Lệnh read-only được nhận diện bằng parser AST (khoảng 20 file `bash-readonly-policy-*`, có tách riêng git/gh/flags). Lệnh read-only được allow ngay cả ở `build`.
- Danh sách nguy hiểm của `guarded` (`tool/handlers/guarded/command.ts`) phân tích AST và unwrap wrapper. Nó bắt `rm` đệ quy, `rm` nhiều target hoặc có glob, `dd`, `mount`, `mkfs*`, `rsync --delete`, `find -delete`, git destructive, và lệnh delete của Windows. Khi gặp interpreter (`bash -c`, `python`, `eval`…) hoặc từ động, kết quả là `unsupported` chứ không coi là an toàn.

## 4. So với dnt-harness

| Khía cạnh | ZCode | dnt-harness |
|---|---|---|
| Scope file tool | Không chặn ngoài workspace | Giới hạn trong các folder được grant, kiểm tra cả realpath. Ngoài grant thì ask, trừ khi mode có `outOfGrant: allow`. App storage và đường dẫn network/device luôn bị deny. |
| Full access | `yolo`, cấp theo session | `full-access` với `'*': 'allow'` và `outOfGrant: 'allow'` |
| Bash | Không sandbox. Read-only allow theo AST. `guarded` hỏi từng lần với lệnh phá hủy. | Không sandbox. Dangerous Commands guard dùng regex với 6 preset (FS/Network/Resource mặc định `deny`, Git/System/DB mặc định `ask`), và guard vẫn chạy ở Full access. |
| Lệnh read-only trong mode ask | Tự allow | Bash luôn `ask` (ở `ask-before-changes` và `edit-automatically`) |
| Rule theo lệnh | Project rules `Bash(git:*)`, session rules | Custom rule regex/substring theo workspace |

**Đính chính câu trả lời trước của tôi:** tôi đã nói "ghi file ngoài grant thì không có quyền". Ở mode Full access điều đó **sai**, vì `bundled.ts:101` đặt `outOfGrant: 'allow'`. Read/Write/Edit ra ngoài grant chạy luôn mà không hỏi; chỉ app storage, đường dẫn network/device và folder grant read-only là vẫn bị deny. Vậy trong mode hiện tại, scope folder chỉ ràng buộc ở mode khác. Ở Full access, cả file tool lẫn Bash đều không bị giới hạn bởi scope.

## 5. Đề xuất cho dnt-harness

1. **Đổi `outOfGrant` của Full access sang `ask`**, hoặc tạo thêm một mode kiểu `guarded`. Thay đổi nhỏ nhưng làm scope có hiệu lực lại với file tool. Đánh đổi là sẽ có thêm prompt khi cần đọc repo khác; có thể giảm bằng "Allow folder for this session", tính năng đã có sẵn.
2. **Học cách ZCode nhận diện Bash read-only bằng AST**, để mode `ask-before-changes` và `edit-automatically` không phải hỏi cho `ls`, `git status`, `rg`. Đây là cải thiện UX lớn nhất mà không làm giảm an toàn.
3. **Học cách xử lý `unsupported` của guard**: gặp interpreter, `$(...)` hay từ động thì ask chứ không cho qua. Như vậy vá được giới hạn mà `docs/harness.md` đang tự ghi nhận (regex bỏ sót `eval $(…base64 -d)` và heredoc).
4. **Không bắt chước** việc ZCode bỏ hẳn scope và việc `yolo` bỏ qua project deny. dnt-harness đang làm tốt hơn ở hai điểm này: deny luôn thắng, guard chạy ở mọi mode.
5. OS sandbox (Seatbelt/bwrap): ZCode đã thử rồi gỡ. Nếu dnt-harness muốn làm, nên coi đó là một thiết kế riêng có tính tới macOS/Linux/Windows, đúng như ZCode tự kết luận.

## Câu hỏi còn mở

- Vì sao ZCode gỡ sandbox (có thể do độ ổn định của capability probe hoặc do cross-platform) chỉ suy ra được từ comment; tôi chưa đọc git history.
- Tôi chưa kiểm tra xem các mode của ZCode desktop có khác CLI không. Tôi chỉ đọc `apps/zcode-cli`.
