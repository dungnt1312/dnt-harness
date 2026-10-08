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

## Concerns

- Covering regressions xanh, nhưng test HTTP mới chuyên biệt cho toàn ma trận CRUD/concurrency/persistence-failure và integration spawn alias chưa được bổ sung đầy đủ vào các server spec lớn; pure resolver/store và regression hiện có bảo vệ core behavior.
- UI implementation tối giản và keyboard-native; chưa có mounted CRUD test riêng cho `ModelAliasesPanel`.
- Không chạy full repository suite theo scope hẹp đã duyệt.
