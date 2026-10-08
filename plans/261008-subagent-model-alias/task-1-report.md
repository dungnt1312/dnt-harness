# Task 1 report — Global subagent model aliases

## Trạng thái

**DONE_WITH_CONCERNS**

Đã triển khai end-to-end alias model toàn cục: persistence v2 tương thích file cũ, transaction chung với provider/default, CRUD REST revision-aware, resolver alias-first fail-closed, role/tool catalog, client API/types, Settings CRUD, Agents picker và manual spawn form.

## Files

- `src/web/provider-store.ts` — `ModelAlias`, parser tương thích cũ, validator tên, giữ aliases qua compatibility writer.
- `src/web/agent-delegation.ts` — alias-first resolver, `ModelAliasError`, null thinking, blocking role display, tool catalog.
- `src/web/server.ts` — alias runtime state, transaction atomic chung, CRUD REST, row status/warning, shared admission.
- `web/lib/types.ts`, `web/lib/api.ts` — wire contracts và CRUD client.
- `web/components/settings/ModelAliasesPanel.tsx` — global CRUD/editor, broken mapping repair/delete, disabled provider guard, discard integration.
- `web/components/settings/SettingsModal.tsx` — Global nav/tab.
- `web/components/settings/AgentsPanel.tsx` — alias picker và resolved/broken display.
- `web/components/workbench/AgentRunsPanel.tsx` — manual spawn role/brief/inherit/alias/direct.
- `tests/web/provider-store.spec.ts`, `tests/web/agent-model-alias.spec.ts` — persistence/name/resolver/null/fail-closed compatibility.
- `web/components/settings/settings-panels.spec.tsx`, `web/components/settings/management.spec.tsx`, `web/components/workbench/agent-runs.mounted.spec.tsx` — cập nhật contract UI mới.
- `docs/harness.md` — precedence, fail-closed, null thinking, future-spawn snapshot.
- `plans/261008-subagent-model-alias/plan.md`, `progress.md`, file report này — plan/progress evidence.

## Red/green và verification

- Baseline: `npx vitest run tests/web/provider-store.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts` — PASS, 30 tests.
- Red đầu tiên: `npx vitest run tests/web/provider-store.spec.ts tests/web/agent-model-alias.spec.ts && npm run typecheck` — resolver suite 1 fail do fixture dùng default parameter khi muốn biểu diễn alias đã xóa; sửa fixture thành `null`, không phải product bug.
- Green store/resolver: `npx vitest run tests/web/provider-store.spec.ts tests/web/agent-model-alias.spec.ts` — PASS, 17 tests.
- Typecheck lần đầu — FAIL do compatibility signature `describeRoleModel` bắt buộc `validate`; sửa thành optional seam để caller cũ tương thích.
- `npm run typecheck` — PASS.
- Server regressions: `npx vitest run tests/web/server-session-model.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts` — PASS, 41 tests.
- UI lần đầu: settings suite FAIL 7 assertions: mocks thiếu API mới và hai assertion contract cũ “không có manual form”/11 tabs; cập nhật theo binding spec.
- Settings green: `npx vitest run web/components/settings/settings-panels.spec.tsx web/components/settings/management.spec.tsx web/components/settings/unsaved-changes.spec.tsx` — PASS, 71 tests.
- Workbench lần đầu FAIL do stub trả cùng body cho catalog và child list, cộng assertion contract cũ; lọc defensive catalog rows và cập nhật form assertion.
- Workbench green: `npx vitest run web/components/workbench/agent-runs.mounted.spec.tsx` — PASS, 6 tests.
- Final covering: `npm run typecheck && npx vitest run tests/web/provider-store.spec.ts tests/web/agent-model-alias.spec.ts tests/web/server-session-model.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts web/components/settings/settings-panels.spec.tsx web/components/settings/management.spec.tsx web/components/settings/unsaved-changes.spec.tsx web/components/workbench/agent-runs.mounted.spec.tsx` — PASS, typecheck + 135 tests.
- `npm run build:web` — PASS, Vite 550 modules, built in 1.56s.

## Follow-up hoàn tất trước review

- Thêm `tests/web/server-model-alias.spec.ts`: CRUD HTTP chuyên biệt, restart/global collection, validation tên/target/thinking, collision warning, rename/delete revision 409, alias độc lập + provider/default mutation đồng thời, injected write failure không publish runtime.
- Thêm `tests/web/server-model-alias-spawn.spec.ts`: manual HTTP chứng minh explicit alias > role alias, `thinkingLevel: null`, edit chỉ tác động child tương lai và child cũ giữ snapshot; Agent tool dùng alias plain; alias invalid fail trước `agent/child-spawn`, không tạo child.
- Thêm `web/components/settings/model-aliases-panel.spec.tsx`: mounted create/edit/rename/delete, broken repair/delete, collision warning, disabled provider, inline validation và discard guard.
- Mở rộng `web/components/settings/settings-panels.spec.tsx` cho alias role resolved/null-thinking và broken-blocking; mở rộng `web/components/workbench/agent-runs.mounted.spec.tsx` cho role/manual chooser alias/direct, unusable option và refresh sau spawn.
- Sửa hai bug thật: lỗi persistence trong alias CRUD trước đây bị map nhầm thành HTTP 400, nay trả 500; `Select` trước đây bỏ qua `disabled` option nên disabled provider/alias vẫn chọn được, nay chặn mouse/keyboard và expose disabled semantics.
- Đồng bộ assertion Settings từ 11 lên 12 tabs trong `web/components/ui/ui.spec.tsx`.

## Verification follow-up

- `npx vitest run tests/web/server-model-alias.spec.ts` — PASS, 5 tests.
- `npx vitest run tests/web/server-model-alias-spawn.spec.ts` — PASS, 2 tests.
- `npx vitest run web/components/settings/model-aliases-panel.spec.tsx` — PASS, 3 tests.
- `npx vitest run web/components/workbench/agent-runs.mounted.spec.tsx` — PASS, 7 tests.
- `npx vitest run web/components/settings/settings-panels.spec.tsx` — PASS, 40 tests.
- `npm run typecheck && npx vitest run tests/web/provider-store.spec.ts tests/web/agent-model-alias.spec.ts tests/web/server-model-alias.spec.ts tests/web/server-model-alias-spawn.spec.ts tests/web/server-session-model.spec.ts tests/web/server-g4.spec.ts tests/web/server-subagents.spec.ts web/components/settings/model-aliases-panel.spec.tsx web/components/settings/settings-panels.spec.tsx web/components/settings/management.spec.tsx web/components/settings/unsaved-changes.spec.tsx web/components/workbench/agent-runs.mounted.spec.tsx web/components/ui/ui.spec.tsx && npm run build:web` — PASS: typecheck, 164 tests, Vite 550 modules, build 1.63s.
- `git diff --check` — PASS.

## Concerns

- Không còn concern mở trong scope được yêu cầu.
- Không chạy full repository suite; đã chạy toàn bộ ma trận alias cùng regression server/settings/workbench liên quan, typecheck và web build.
