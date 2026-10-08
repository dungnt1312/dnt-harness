---
title: "Global subagent model aliases"
description: "Triển khai alias model toàn cục cho role và hai bề mặt spawn, với persistence nguyên tử, phân giải fail-closed và UI quản trị."
status: pending
priority: P1
effort: 14h
branch: feat/subagent-model-alias
tags: [sdd, subagents, models, settings, persistence]
created: 2026-10-08
---

# Kết quả cần đạt

Một operator có thể tạo alias toàn cục `{ name, provider, model, thinkingLevel }`, dùng tên thuần đó trong role hoặc từng lần spawn, và mọi spawn tương lai sẽ chụp concrete provider/model/thinking vào child session. Alias còn tồn tại nhưng hỏng phải chặn spawn; không match alias mới đi qua hành vi direct-model/Claude legacy hiện có. Phạm vi bám đúng spec đã duyệt tại `docs/superpowers/specs/2026-10-08-subagent-model-alias-design.md:6`–`115`.

## Luồng dữ liệu bắt buộc

1. **CRUD:** Form Model aliases → `web/lib/api.ts` → REST `/api/model-aliases` → transaction store dùng chung với provider/default → ghi atomic `providers.json` → sau commit mới publish alias runtime → response trả row đã validate.
2. **Phân giải spawn:** explicit `model` hoặc role `model` hoặc parent controls → trim → exact, case-sensitive alias lookup → validate provider/model/thinking hiện tại → tạo `ChildModel` concrete → `ChildExecutor` ghi snapshot `session/model`; nếu không có alias thì dùng resolver hiện hữu. Hai đầu vào hiện cùng đi qua `childModelFor`: Agent tool tại `src/web/agent-delegation.ts:385`–`404` và HTTP/manual tại `src/web/server.ts:4101`–`4118`.
3. **Catalog/display:** runtime alias snapshot → Agent tool description/catalog (authority chỉ để discover) và Settings/role/manual picker → lúc admission vẫn đọc store mới nhất. Role catalog hiện được project tại `src/web/server.ts:4036`–`4047`; UI hiện diễn giải model ở `web/components/settings/AgentsPanel.tsx:85`–`97`.
4. **Provider mutation:** xóa/tắt provider hoặc bỏ model vẫn commit provider change; alias được giữ nguyên và row chuyển sang invalid. Child đã spawn không đổi vì model đã được stamp vào log theo contract hiện tại `docs/harness.md:808`–`823`.

# ONE integrated SDD task — implement model aliases end-to-end

Không chia song song: một implementer sở hữu toàn bộ file dưới đây để tránh hai nhánh cùng sửa `src/web/server.ts`, `web/lib/api.ts`, hoặc shared contracts. Làm theo vòng SDD/TDD: thêm assertion đỏ theo từng lát cắt, implement tối thiểu cho xanh, chạy regression hẹp, rồi mới chuyển sang lát cắt kế tiếp.

## 1. Khóa contract bằng test đỏ

### Persistence và concurrency

- Mở rộng `tests/web/provider-store.spec.ts:22` để chứng minh config version hiện hành không có `aliases` load thành `[]`; alias hợp lệ round-trip; alias hỏng do provider/model thay đổi vẫn được giữ; provider/default writer giữ aliases và alias writer giữ providers/defaults.
- Mở rộng `tests/web/server-session-model.spec.ts:319`–`368` bằng CRUD HTTP và transaction assertions:
  - create/list/edit/rename/delete alias;
  - trim tên, exact case-sensitive match; reject empty, whitespace, colon, control, `@`, `inherit`, duplicate;
  - `PATCH`/`DELETE` mang `expectedRevision`; stale same-row mutation trả `409`;
  - hai edit đồng thời trên hai alias khác nhau đều còn trên disk;
  - provider/default mutation và alias mutation đồng thời không mất field;
  - injected persistence failure trả `500` và không đổi runtime/list response.

### Resolver và spawn admission

- Thêm pure resolver cases vào `tests/web/agent-model-alias.spec.ts` (file mới) quanh API hiện tại `resolveChildModel`/`describeRoleModel` ở `src/web/agent-delegation.ts:106`–`167`:
  - explicit alias > role alias > parent;
  - alias thắng bare model và `sonnet`/`opus`/`haiku`; `provider:model` bypass alias;
  - alias thinking explicit thay parent; `null` không mang parent thinking;
  - alias tồn tại nhưng provider disabled/missing, model removed, hoặc thinking không expressible ném lỗi có alias + target và không fallback;
  - no-match giữ direct-model ambiguity, parent inheritance và unresolved-role legacy;
  - xóa alias khiến tên cũ quay lại resolver legacy/direct.
- Mở rộng `tests/web/server-g4.spec.ts:280`–`330` và `tests/web/server-subagents.spec.ts:130`–`158`:
  - HTTP spawn và Agent-tool spawn dùng cùng alias target;
  - explicit spawn alias override role alias;
  - edit alias chỉ ảnh hưởng child sau, child trước giữ snapshot;
  - alias invalid trả `400`/tool failure trước `agent/child-spawn`, không tạo child;
  - tool catalog nêu alias hợp lệ kèm target/thinking và đánh dấu alias invalid unusable;
  - role catalog trả broken alias là blocking, không phải inheritance.

### Client/UI

- Mở rộng `web/components/settings/settings-panels.spec.tsx:235`–`308` và `web/components/settings/management.spec.tsx:13`–`41`:
  - Global nav có **Model aliases**;
  - list/create/edit/rename/delete, keyboard labels, inline validation, collision warning, broken mapping vẫn hiện và repair/delete được;
  - disabled provider không chọn được cho mapping mới;
  - đổi tab/đóng modal đi qua discard safeguard hiện hữu;
  - Agents picker lưu plain alias name và role detail phân biệt alias resolved/thinking với broken-blocking.
- Mở rộng `web/components/workbench/agent-runs.mounted.spec.tsx:29`–`119`:
  - manual spawn form chọn role, nhập brief, chọn inherit/alias/direct model và gọi `spawnChild` với plain alias;
  - invalid alias hiển thị unusable, không submit;
  - keyboard labels/focus và refresh list sau spawn.

## 2. Implement domain/store contract

### `src/web/provider-store.ts`

- Thêm:
  ```ts
  interface ModelAlias {
    readonly name: string
    readonly provider: string
    readonly model: string
    readonly thinkingLevel: ThinkingLevel | null
    readonly revision: number
  }
  interface ProviderStore {
    readonly version: 2
    readonly defaults: ModelDefaults
    readonly providers: readonly ProviderConfig[]
    readonly aliases: readonly ModelAlias[]
  }
  ```
- Giữ `version: 2` để đọc file hiện có không cần migration rewrite; `parseProviderStore` tại `src/web/provider-store.ts:81`–`103` mặc định aliases rỗng khi field vắng, chỉ drop row sai shape, nhưng không drop target đang unavailable.
- `saveProviders` tại `src/web/provider-store.ts:179`–`183` phải copy aliases hiện tại. Mọi call tạo store literal phải thêm `aliases`; grep lại toàn repo trước code review.
- Export validator tên thuần dùng chung server/UI semantics; target availability không thuộc parser vì provider thay đổi được phép làm alias broken.

### `src/web/server.ts`

- Load `let aliases = [...storedProviders.aliases]` cạnh provider state tại `src/web/server.ts:703`–`709`.
- Mở rộng `mutateProviderStore` tại `src/web/server.ts:2883`–`2924` để derive/persist/publish `{ providers, defaults, aliases }` trong cùng hàng đợi; disk commit vẫn precede publication. Không tạo transaction/lock thứ hai.
- Thêm REST contract:
  - `GET /api/model-aliases` → `ModelAliasRow[]` có target status (`valid | invalid`), message và collision warnings.
  - `POST /api/model-aliases` body `{ name, provider, model, thinkingLevel }`.
  - `PATCH /api/model-aliases/:name` body `{ expectedRevision, name?, provider?, model?, thinkingLevel? }`; rename add-new/remove-old trong một transaction.
  - `DELETE /api/model-aliases/:name` body `{ expectedRevision }`.
- Validate create/update bằng provider enabled + model acceptance hiện có (`validateProviderModel` đang được dùng ở `src/web/server.ts:906`–`911`) và `expressibleThinkingLevel` (`src/harness/llm/model-catalog.ts:333`–`345`); `null` luôn hợp lệ. Collision với advertised bare model/Claude alias chỉ trả warning.
- Provider DELETE/PATCH tại `src/web/server.ts:6200`–`6221` và `src/web/server.ts:7127`–`7154` giữ aliases, không rewrite target.

## 3. Implement resolver fail-closed và shared admission

### `src/web/agent-delegation.ts`

- Mở rộng `ChildModelDeps` tại `src/web/agent-delegation.ts:76`–`84` với alias lookup/status callback; đổi `resolveModelReference` thành exported pure seam nếu test cần, nhưng chỉ giữ một implementation.
- Sau khi chọn reference theo precedence hiện tại `src/web/agent-delegation.ts:106`–`126`, exact alias lookup chạy trước Claude alias/direct resolver. Khi match:
  - validate concrete provider/model;
  - explicit thinking phải bằng `expressibleThinkingLevel(target, selected)`;
  - trả `ChildModel` với `thinkingLevel: null` được hiểu là model default, tuyệt đối không copy parent thinking.
- Dùng error subtype/marker riêng cho custom alias để catch legacy unresolved role ở `src/web/agent-delegation.ts:120`–`124` không nuốt lỗi alias. Alias error phải nêu alias và provider/model/thinking cụ thể.
- Mở rộng `describeRoleModel` nhưng giữ field cũ để compatibility:
  ```ts
  { resolved?: string; inherit: boolean; unresolved?: string;
    alias?: string; thinkingLevel?: ThinkingLevel | null;
    blocked?: boolean; error?: string }
  ```
- Mở rộng `DelegationDeps`/`agentTool` catalog tại `src/web/agent-delegation.ts:230`–`248`, `285`–`301`, `333`–`348`: plain alias hợp lệ được mô tả kèm target/thinking; invalid alias ghi unusable. Không cache alias authority; resolver admission luôn đọc current state.

### `src/web/server.ts`

- `childModelFor` tại `src/web/server.ts:894`–`913`, `roleModelOf` tại `src/web/server.ts:3022`–`3026`, Agent tool deps, và HandlerDeps tại `src/web/server.ts:3241`–`3249` cùng dùng một alias snapshot accessor.
- Giữ cả Agent-tool path (`src/web/agent-delegation.ts:385`–`404`) và manual HTTP path (`src/web/server.ts:4101`–`4118`) qua chính `childModelFor`; không duplicate resolver trong route/UI.
- Success đo được: alias-resolution failure xảy ra trước `ChildExecutor.spawn/spawnManual`, nên parent log không có `agent/child-spawn` và child session không tồn tại.

## 4. Implement client contracts và UI

### Shared client

- `web/lib/types.ts`: thêm `ModelAliasRow`, `ModelAliasInput`; mở rộng `AgentDefinitionRow.modelResolution` tại `web/lib/types.ts:448`–`467` đúng compatibility fields phía trên.
- `web/lib/api.ts`: thêm `listModelAliases`, `createModelAlias`, `updateModelAlias`, `deleteModelAlias`; giữ `spawnChild` parameter plain `model` tại `web/lib/api.ts:879`–`900` và sửa comment để chấp nhận alias/direct.

### Settings

- Tạo `web/components/settings/ModelAliasesPanel.tsx`: global list/editor, provider/model/thinking dependency, target preview, invalid repair/delete, collision and rename/delete consequence copy; dùng `UnsavedChangesContext` giống các panel hiện hữu.
- `web/components/settings/SettingsModal.tsx`: thêm `model-aliases` vào `SettingsTab`, TABS/TAB_GROUPS tại `web/components/settings/SettingsModal.tsx:56`–`74`, badge global tại `web/components/settings/SettingsModal.tsx:539`–`541`, và render panel tại `web/components/settings/SettingsModal.tsx:548`–`562`.
- `web/components/settings/AgentsPanel.tsx`: merge alias rows vào selector hiện tại `web/components/settings/AgentsPanel.tsx:417`–`428`; giữ plain name trong frontmatter. Sửa `modelText` tại `web/components/settings/AgentsPanel.tsx:85`–`97` để broken alias là blocking warning, không còn text “runs on conversation model”. Không sửa bundled/user/project role file tự động.

### Manual spawn

- `web/components/workbench/AgentRunsPanel.tsx`: thay contract “follow only” hiện tại `web/components/workbench/AgentRunsPanel.tsx:11`–`15` bằng form spawn gọn phía trên danh sách; fetch role catalog + model aliases, cho chọn inherit, alias hoặc direct `provider:model`, gọi `spawnChild`, rồi refresh. Form chỉ hiện khi có root session; child view vẫn trỏ root qua wiring sẵn có `web/components/workbench/Workbench.tsx:231`–`239`.
- Không thêm composer syntax hay mention parsing.

## 5. Documentation, compatibility và kiểm chứng

- Cập nhật `docs/harness.md:808`–`823`: precedence, alias-before-legacy, `null` thinking = model default, invalid alias fail-closed, future-spawn-only snapshot.
- Nếu API surface được tài liệu hóa ở web docs, cập nhật `docs/web.md` đúng các route mới; không đổi wire format cũ.

### Ma trận test/commands

Chạy theo thứ tự, không chạy broad suite cho đến khi các lát cắt hẹp xanh:

```bash
npx vitest run tests/web/provider-store.spec.ts tests/web/agent-model-alias.spec.ts
npx vitest run tests/web/server-session-model.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts
npx vitest run web/components/settings/settings-panels.spec.tsx web/components/settings/management.spec.tsx web/components/settings/unsaved-changes.spec.tsx
npx vitest run web/components/workbench/agent-runs.mounted.spec.tsx
npm run typecheck
npm run build:web
```

Reviewer premium sau đó chạy regression liên quan (không mặc định full suite):

```bash
npx vitest run tests/web/provider-store.spec.ts tests/web/server-session-model.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts tests/harness/g4-subagent-contract.spec.ts web/components/settings/settings-panels.spec.tsx web/components/settings/management.spec.tsx web/components/settings/unsaved-changes.spec.tsx web/components/workbench/agent-runs.mounted.spec.tsx
```

### Success criteria đo được

- Restart giữ alias và GET ở workspace khác trả cùng collection.
- Role alias và explicit alias tạo child có concrete pair/thinking đúng; child cũ không đổi sau edit.
- Bốn lỗi target (provider missing/disabled, model removed, thinking unsupported) đều không tạo child và không fallback.
- Direct `provider:model`, no-match legacy, collision và delete/rename semantics đúng spec.
- Concurrent independent edits không mất dữ liệu; stale same-row edit là `409`; failed write không publish.
- Alias form và manual spawn dùng được bằng keyboard, báo lỗi inline, và modal discard protection vẫn hoạt động.
- Các command trên xanh; baseline `npm run typecheck` đã được user xác nhận xanh trước plan.

## Dependency graph

1. Test contracts đỏ → 2. store/transaction → 3. resolver/shared admission → 4. REST/client/UI → 5. docs + regression.
2. UI không bắt đầu trước khi REST rows/errors ổn định; manual spawn không bắt đầu trước resolver shared; docs/reviewer không bắt đầu trước test hẹp xanh.

## Risk, mitigation, rollback

| Lát cắt | Rủi ro (khả năng × tác động) | Mitigation | Rollback độc lập |
|---|---|---|---|
| Store/transaction | Medium × High: provider write làm rơi aliases hoặc failed write leak runtime | Một transaction duy nhất, persistence-before-publication, concurrency/failure tests | Revert alias field/routes; file v2 cũ vẫn đọc được, field dư không ảnh hưởng binary cũ nếu parser bỏ qua |
| Resolver | Medium × High: legacy catch biến broken alias thành inherit | Error subtype riêng + pure resolver matrix + assert không có spawn event | Gỡ alias lookup; direct/legacy path giữ nguyên |
| REST/UI | Medium × Medium: stale editor ghi đè hoặc rename làm dangling roles | per-row revision/409, copy cảnh báo rename/delete, mutation từng alias | Gỡ tab/form/routes; stored aliases vẫn nguyên trên disk |
| Manual spawn | Low × High: HTTP và tool lệch authority | Cả hai bắt buộc gọi `childModelFor`; integration test hai surface | Gỡ form, Agent tool vẫn hoạt động |
| Docs/regression | Low × Medium: claim vượt behavior | Chỉ cập nhật sau assertions xanh, premium review theo spec | Revert docs riêng |

## Backwards compatibility và migration

- Không có migration command: providers.json v2 thiếu `aliases` → `[]`; provider/default/session/agent wire cũ giữ nguyên.
- Role frontmatter tiếp tục là string `model`; alias là plain name nên file hiện có không rewrite.
- Existing child/session snapshots không repoint; thay đổi chỉ tác động spawn sau.
- Xóa/rename không sửa reference; tên cũ quay về semantics direct/legacy như spec.
- Alias data được giữ khi provider bị xóa/tắt hoặc model bị bỏ để operator sửa lại.

## File ownership

Một integrated task, một implementer sở hữu toàn bộ: `src/web/provider-store.ts`, `src/web/agent-delegation.ts`, `src/web/server.ts`, `web/lib/types.ts`, `web/lib/api.ts`, `web/components/settings/ModelAliasesPanel.tsx`, `web/components/settings/SettingsModal.tsx`, `web/components/settings/AgentsPanel.tsx`, `web/components/workbench/AgentRunsPanel.tsx`, các test nêu trên, `docs/harness.md`, và chỉ khi route docs hiện có yêu cầu thì `docs/web.md`. Không giao song song file nào.

## Unresolved questions

Không có. Spec đã chốt và user yêu cầu SDD không thêm vòng approval.
