# Providers Runtime · Mock Removal · Per-session Folder — Spec + Plan

> Kế thừa workflow của đợt redesign (spec → plan → implement từng commit trên main).
> Quyết định từ người dùng: (1) quản lý provider runtime như ảnh tham chiếu,
> (2) xoá sạch mock, vitest dùng fake OpenAI server, (3) folder là thuộc tính
> **của từng session**, không còn global-only.

## A. Mục tiêu

1. **Multi-provider OpenAI completions**: registry provider theo tên chạy runtime — thêm/xoá/sửa qua REST + UI Settings giống ảnh tham chiếu (Base URL, API key, danh sách model sync bằng `GET {base}/models`, Test connection). DeepSeek trở thành một entry mặc định seed từ `DEEPSEEK_API_KEY`.
2. **Bỏ mock hoàn toàn**: xoá `mock.ts`, fallback, flag `--mock`, cảnh báo key; bin lỗi rõ khi không có provider nào khả dụng. Vitest dựng **fake OpenAI-compat server** localhost để giữ tính xác định.
3. **Folder theo session**: mỗi session có workspace riêng (fallback = default server root); tools đọc động qua `agentScope`; chọn folder cho session hiện tại ngay ở TopBar chip (không đụng session khác).

## B. Non-goals

Không triển khai: Git branch chip (cần git API — vẫn là slot sau), streaming từ nhiều provider song song, mã hoá API key lúc nghỉ (lưu plain trong config file được gitignore ở home), vision/media tools.

## C. Kiến trúc

### C.1 Provider tổng quát hoá (src/harness/llm)

Đổi tên lớp trong `deepseek.ts` → file mới `openai.ts`, xuất `OpenAiCompletionsProvider implements LlmProvider` với constructor `{ baseUrl, apiKey, name, models, defaultModel }`. Wire format giữ nguyên (đã là chuẩn OpenAI: `chat/completions` SSE, `tool_calls` fragments, `reasoning_content` → thinking delta). Alias `DeepSeekProvider` giữ lại làm hàm tạo thuận tiện trỏ api.deepseek.com để các caller cũ không vỡ.

`createWebServer` đăng ký **mọi provider enabled** vào `LlmService` (giữ disposer theo id để unregister khi xoá/tắt), rồi `llm.use(state.activeProvider)`. Handler `agent/request` stamp `{ ...request, model: state.model }` như cũ — đổi model là đủ vì mỗi step đã đi qua đúng provider active.

### C.2 Provider store (src/web/provider-store.ts)

Module thuần chức năng, dễ unit-test:

```ts
interface ProviderConfig {
  readonly id: string          // slug từ name (dùng trên đường dẫn REST)
  readonly name: string        // nhãn hiển thị
  readonly baseUrl: string     // vd https://api.deepseek.com
  readonly apiKey: string
  readonly models: readonly string[]
  readonly defaultModel: string | undefined
  readonly enabled: boolean
}
loadProviders(file): ProviderConfig[]         // file thiếu/hỏng → []
saveProviders(file, list): Promise<void>      // mkdir -p cha, atomic-ish write
maskKey(key): string                          // '••••' + 4 ký tự cuối
```

Vị trí file mặc định: `<homedir>/.dnt-harness/providers.json` (gitignore ngoài repo tự nhiên). `WebServerOptions.configFile` ghi đè — vitest dùng tmpdir.

Seed lần đầu: nếu file chưa tồn tại mà `DEEPSEEK_API_KEY` có giá trị → tạo entry `deepseek` (baseUrl mặc định api.deepseek.com, models cứng như cũ) rồi save.

### C.3 REST surface (src/web/server.ts)

| Route | Hành vi |
|---|---|
| `GET /api/meta` | mở rộng: `{ provider, model, models, folder (default), providers: [{id,name,enabled,keyMasked,models}], hasDefaultFolderRoot }` |
| `PUT /api/model` | nhận `{ provider?, model? }` — chọn provider (nếu khác hiện tại gọi `llm.use` bằng id) + model hợp lệ trong provider đó; chuỗi model trần (không kèm provider)仍 áp dụng lên provider active (back-compat client cũ) |
| `GET /api/providers` | danh sách đã mask key |
| `POST /api/providers` | tạo mới: validate `name` non-empty unique-slug, `baseUrl` http(s), `apiKey` non-empty; `models` tùy chọn |
| `PATCH /api/providers/:id` | sửa từng trường; đổi khóa duy nhất qua kiểm tra trùng id |
| `DELETE /api/providers/:id` | xoá; nếu là provider active → chuyển active sang entry đầu còn lại (400 nếu rỗng hoàn toàn) |
| `POST /api/providers/:id/test` | POST completions ping (`max_tokens:1`, messages 1 câu) → `{ok:true}` hoặc `{ok:false,error}` (không throw) |
| `POST /api/providers/:id/sync` | `GET {baseUrl}/models` Authorization Bearer → chấp nhận `{data:[{id}]}` lẫn mảng trần → lưu `models`, trả về |
| `GET /api/sessions` | thêm `folder` per-item (string \|\| null = kế thừa default) |
| `POST /api/sessions` | nhận `{folder?}` tùy chọn (validate như dưới) |
| `PUT /api/sessions/:id/folder` | đặt/xoá (`{path: ''}` = reset kế thừa) folder của session; validate tồn tại + là thư mục |

Giữ nguyên `PUT /api/folder` như "default workspace" (fallback), không còn ý nghĩa override toàn cục.

### C.4 Per-session folder resolution

Trong `createWebServer`: map `sessionFolders: Map<SessionId, string>`; handler chèn vào deps. Accessors đổi thành:

```ts
const activeFolder = (): string => {
  const scope = agentScope.getStore()
  if (scope !== undefined) {
    const own = sessionFolders.get(scope.sessionId)
    if (own !== undefined) return own
  }
  return state.folder
}
for (const tool of fsTools(activeFolder)) ...
bashTool({ cwd: activeFolder })
```

An toàn: mọi tool chỉ chạy bên trong một turn ⇒ luôn có scope; fail-closed về default đúng hành vi cũ.

### C.5 Bỏ mock

- Xoá `src/harness/llm/mock.ts`; bỏ export khỏi `src/index.ts`.
- `bins/web.ts`: bỏ `--mock`, nhánh fallback, cảnh báo; boot yêu cầu tồn tại ≥1 provider usable (env key seed hoặc configFile có entry enabled) else `process.exit(1)` với thông điệp chỉ rõ cách cấu hình (key env hoặc thêm qua Settings sau này… lưu ý Settings sống trong UI nên khi zero-provider vẫn phải boot server để client mở Settings — quyết định: **server vẫn boot**, trang web hiện trạng thái "no provider" và Settings cho thêm; nhưng mọi endpoint chat sẽ 400 'no provider'). Đổi đề tài: bin in ra cảnh báo lớn thay vì exit — thân thiện hơn với luồng "vừa cài xong chưa có key".
- `bins/headless.ts`: cùng bộ quy tắc; flag `--mock`xoá; không key → hướng dẫn cấu hình rồi exit(1) (headless không có UI để cấu hình).
- `tests/web/server.spec.ts`: thay `MockLlmProvider(steps)` bằng helper mới `tests/support/fake-openai.ts` — `node:http` server trả stream SSE đúng wire `chat/completions`, đẩy từng bước trong hàng đợi script (delta text hoặc tool_calls), cũng xử lý `/models` và ping. Provider test dùng `new OpenAiCompletionsProvider({ baseUrl: fake.url, apiKey: 'test', models:['test-model'] })`.

### C.6 Client

- `lib/types.ts`: `Meta` mới (`providers[]`, mask), `SessionListing.folder: string|null`; api thêm `listProviders/createProvider/updateProvider/deleteProvider/testProvider/syncProvider/setModelExt/updateSessionFolder/createSessionWithFolder`.
- **SettingsModal** (`components/settings/SettingsModal.tsx`): mở từ IconButton `sliders` trên TopBar (icon env-toggle chuyển thành `panelRight`). Layout hai cột như ảnh ref: trái danh sách provider (dot enabled, nút ＋ thêm, click chọn), phải form sửa (Name/BaseUrl/API key mask-eye/Models textarea + Sync) với nút Test connection · Save changes · Delete (ConfirmDialog reuse), badge Active trên provider đang dùng.
- TopBar: workspace chip giờ thể hiện **folder của session đang mở**; popover lưu qua `PUT /api/sessions/:id/folder`; khi không có session thì disable.
- Composer + EnvPanel model picker: options gộp theo provider — value `${provider}:${model}`, hiển thị `provider / model` split.
- Empty state: giữ như cũ (ảnh 2 là tham chiếu thẩm mỹ, các chip folder/branch của app kia chưa áp dụng vì branch là slot sau).

## D. Task kế hoạch (commit theo task)

1. **T1 LLM tổng quát**: `openai.ts` + giữ alias DeepSeek + unit test wire-format chung (dedent từ spec hiện có của deepseek nếu có; nếu không viết mới dòng stream giả cục bộ không cần mạng).
2. **T2 Store**: `provider-store.ts` + vitest CRUD/mask/seed-thiếu-file.
3. **T3 Server**: multi-provider wiring + REST bảng C.3 + folder per-session C.4; mở rộng server.spec dần theo từng endpoint.
4. **T4 Fake LLM + migrate test**: `fake-openai.ts`; thay toàn bộ Mock usage trong server.spec; thêm case sync/test connection và **isolation folder 2 session** (E2E thật: bắt model phát tool_call write/read qua fake, xác minh nội dung ghi vào đúng folder từng session).
5. **T5 Bins**: dọn mock khỏi web/headless, thông điệp cấu hình; smoke bin thủ công.
6. **T6 Client**: types/api + SettingsModal + TopBar remap icon + session-folder chip + grouped model select; build:web xanh; ui.spec cập nhật chỗ touch.
7. **T7 Docs**: docs/web.md (API mới, config file, hotkeys giữ nguyên), Ghi chú README nhẹ (env vars), đóng kế hoạch.

Mỗi task: chạy `npm run typecheck && npx vitest run tests/web web/components && npm run build:web` trước khi commit.
