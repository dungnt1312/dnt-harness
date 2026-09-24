---
title: "Per-session LLM model"
description: "Mỗi session có model riêng inside cùng workspace; đổi ở A không ảnh hưởng B"
status: completed
priority: P1
effort: "1d"
tags: [harness, web, llm]
created: 2026-09-18
---

# Per-session LLM model

## Outcome
Mỗi session chat có model/provider (và thinking level) riêng bên trong cùng workspace. Đổi model ở session A không làm ảnh hưởng session B. Session mới copy default của workspace lúc tạo, sau đó độc lập. Đổi model có hiệu lực ngay — turn đang chạy sẽ dùng model mới ở request kế tiếp trong cùng turn (không giật stream đang chạy).

## Decisions (user-accepted 2026-09-18)
- **Phạm vi:** per-session trong workspace (không giữ per-workspace chung).
- **Kế thừa:** copy default lúc tạo — session mới snapshot `workspace.model/provider/thinkingLevel` tại thời điểm `POST /sessions`; sau đó không theo workspace default nữa.
- **Khi đổi trong turn đang chạy:** áp dụng từ request kế tiếp trong cùng turn (resolve per `agent/request`, không cancel stream hiện tại). Nếu cần đổi ngay giữa stream, user stop rồi gửi lại — không thêm cancel/abort phức tạp.

## Verified constraints (read before planning)
- `WorkspaceControls` là `Map<WorkspaceId, {activeProvider, model, thinkingLevel, policy, modeId, ...}>` (`src/web/server.ts:222,338`). Toàn bộ resolve qua `controlsFor(wsId)` — không có `SessionId` key, không có `SessionEvent` cho model. `agent/request` (1206) và `agent/context` budget (1085) đều đọc `controlsFor(scope.workspaceId)`.
- `SessionEvent` chỉ có `session/title`, `session/project`, `session/child-meta` — chưa có `session/model` (`src/harness/session/events.ts`). `RequestControls` chỉ ghi audit trên `assistant/message` (post-facto).
- Routes: `PUT /api/workspaces/:wid/model`, `PUT .../thinking`, `GET .../meta` đều per-workspace; không có `.../sessions/:sid/model` (`src/web/server.ts` ~3078). Session sub-router chỉ có `events|messages|stop|manifest|compact`.
- Client: `WorkspaceMeta {provider, model, thinkingLevel}` per `activeWs` (`web/lib/types.ts:164`), `App.tsx` một `meta` cho `activeWs`, `selectModel` gọi `PUT /workspaces/:wid/model`. Không có `setSessionModel`/`SessionMeta` (`web/lib/api.ts:296`).
- Budget/context resolve per request từ `state.model/activeProvider` — đổi model phải recompute budget ngay.

## Constraints / non-goals
- Không đụng policy/mode scoping — chỉ tách model/provider/thinkingLevel.
- Bytes/attachments, MCP/hooks/secrets, compaction, queue/stop/approval giữ nguyên semantics.
- Không thêm editor/framework.
- Per-session model phải durable (survive restart) — không chỉ in-memory.
- Không widen `blockedTools` hay permission; `agent/pre-step` MCP connect giữ nguyên.

## Phases
| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 1 | Durable session model — `session/model` event, replay, fallback | done | — |
| 2 | Server resolution + per-session routes (model/thinking) | done | 1 |
| 3 | Web client — per-session model state, ModelMenu per-conversation, fallback UX | done | 2 |
| 4 | Docs, migration & verification | done | 3 |

Each phase must `typecheck` and keep its targeted suite green before the next starts.

## Acceptance criteria
- Hai session trong cùng workspace có thể chọn hai model khác nhau; đổi ở A không đổi B (verify bằng `GET .../sessions/:sid/meta` hoặc UI).
- Session mới copy workspace default tại lúc tạo; đổi workspace default sau đó không lan sang session cũ.
- Đổi model trong turn đang chạy: request kế tiếp trong cùng turn dùng model mới (log `assistant/message.controls` cho thấy model mới).
- Reload/restart không mất per-session model (durable event).
- `pnpm test` và `pnpm typecheck` pass.

## Verification
Recorded 2026-09-18 on the uncommitted working tree (branch `feat/warm-studio-workbench`, which also carries unrelated warm-studio changes):

- Targeted per-session suites — `tests/harness/session-model.spec.ts`, `tests/web/server-session-model.spec.ts`, `web/App.session-model.spec.ts`, `web/lib/session-model.spec.ts`, `web/components/composer/session-model-labels.spec.tsx`: 22/22 pass (`npx vitest run <files>`).
- `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.web.json`: pass.
- `ak plan validate ./plans/260918-1009-per-session-llm-model`: pass.
- Full `npx vitest run`: 547/548 pass. The single failure is `tests/capabilities/bash.spec.ts` ("timeout kills the whole tree" — Windows process-tree kill, a file this feature never touched), so the "`pnpm test` pass" acceptance item is not fully green on this machine.
- Not yet recorded: `pnpm test:browser`, and a manual two-session UI pass (create A/B, change model on A, restart). The server-side equivalents (isolation, creation snapshot, restart replay) are covered by `tests/web/server-session-model.spec.ts`.
