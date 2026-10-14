# Duration trên tool card (chỉ Trajectory)

## Outcome

Tool card trong view Trajectory giờ hiển thị duration của từng tool call, tính từ timestamp của `tool/call` và `tool/result` trong session log. Chat transcript giữ nguyên (không hiện duration) theo yêu cầu.

## Thay đổi

- `web/components/chat/MessageParts.tsx`
  - `RowSpec` thêm `duration?: string`; `RowLine` render span `font-mono text-xs text-fg-faint` với `aria-label="Call duration"`, đứng sau status.
  - Helper `callDuration(item)`: `formatElapsed(doneAt - ts)`, trả `undefined` khi call chưa settled, thiếu stamp, hoặc `doneAt < ts` — không bao giờ bịa duration.
  - `ToolCard` nhận prop opt-in `withDuration` (mặc định `false`); truyền vào `toolRowSpec` và các card đặc biệt (`GeneratedImageCard`, `GeneratedVideoCard`, `DescribeImageCard`).
- `web/components/workbench/TrajectoryPanel.tsx` — Duration lens (StepLog) và Calls lens truyền `withDuration`.
- `web/components/workbench/StepInspector.tsx` — Response tab truyền `withDuration`.

Không đổi backend, không thêm event: dữ liệu `ts`/`doneAt` đã có sẵn trên `ViewItem` từ log.

## Test (TDD)

- `web/components/ui/ui.spec.tsx` — ToolCard chỉ hiện duration khi `withDuration`, hiện đúng `2.4s`, không hiện khi pending.
- `web/components/workbench/trajectory-panel.spec.tsx` — panel Trajectory hiện `480ms` cho call 1_420 → 1_900.
- `web/components/workbench/step-inspector.spec.tsx` — Response tab của inspector hiện `480ms`.
- Cả 3 test đã xem fail (RED) trước khi implement, sau đó pass (GREEN): 27/27.

## Verification

- `pnpm vitest run` (3 spec affected): pass.
- `pnpm test`: 3593 pass, 4 fail — cả 4 thuộc `tests/harness/storage.spec.ts` về `lastUserActivityAt`, do các thay đổi chưa commit sẵn trong cây (`src/harness/session/service.ts`, `src/harness/storage/file-session-store.ts`, `tests/harness/storage.spec.ts`), không liên quan change này.
- `pnpm exec tsc --noEmit -p tsconfig.web.json`: pass (đã fix 3 lỗi TS2375 do `exactOptionalPropertyTypes` bằng pattern spread có điều kiện của repo).
- `pnpm run typecheck` (toàn repo): fail ở `tests/harness/storage.spec.ts` (4 lỗi TS2339 `lastUserActivityAt`) — lỗi có sẵn của cây, không thuộc change này.
- `pnpm run build:web`: pass.

## Unresolved questions

- Không có câu hỏi mở cho change này. Riêng cụm `lastUserActivityAt` (service/store/test sửa sẵn trong cây) đang đỏ typecheck và 4 test — cần một phiên xử lý riêng nếu muốn cây sạch.
