---
phase: 3
title: "`Agent.whenIdle()` (HC-3)"
status: pending
priority: P2
effort: "~2h"
dependencies: [2]
---

# Phase 3 — `Agent.whenIdle()` (HC-3)

Spec nguồn: `plans/261016-spec-harness-core-hardening.md` §4 (§4.1 thiết kế · §4.2 acceptance 7 mục · §4.3 test).

## Goal

`Agent.whenIdle(): Promise<void>` — resolve khi hết **busy period hiện tại** (turn chain + successor
do recheck microtask `agent.ts:340-342`); resolve ngay (microtask) khi đang idle; **luôn resolve,
không bao giờ reject** (kể cả run ném / poison / admission đóng). **Không đổi contract `run()`** —
không call-site host nào phải sửa.

## Steps

1. **`src/harness/agent/agent.ts`** — thêm field `private runDepth = 0` +
   `private idleWaiters: Array<() => void> = []`; method `whenIdle()`: depth 0 → resolve ngay
   (microtask); ngược lại push waiter (settle khi depth về 0).
2. **Wrap `run()`** (`:289-343`):
   - Tăng `runDepth` **sau** các guard sớm (`:290-293` — admission/uncertain/busy đều không tăng).
   - Giảm trong `finally` bao trọn thân đến hết recheck (`:296-343` — mọi đường thoát kể cả throw
     từ `turn()`); khi depth về 0 ⇒ splice + resolve **toàn bộ** waiter.
   - Đệ quy `await this.run()` ở recheck giữ nguyên (successor nằm trong frame cha → `whenIdle()`
     đợi hết successor).
3. Giữ nguyên ngữ nghĩa: `stop()` → input còn lại **không** tự chạy; `steer()` → successor chạy
   ngay và `whenIdle()` đợi hết successor; trạng thái thật vẫn đọc qua `agent.status` /
   `session.poisoned`.

## Tests

**Mới** `tests/harness/agent-when-idle.spec.ts` (fake provider như `agent-loop.spec.ts`), 7 ca theo
spec §4.2:

1. Idle → resolve ngay (kể cả khi admission đóng — guard sớm `:290-293` không tăng depth).
2. Đang chạy → resolve sau khi turn chain + successor (nếu có) xong.
3. `stop()` khi đang chạy → resolve sau khi run dừng; input còn trong queue **vẫn còn**.
4. `steer()` → resolve sau khi successor (steered) hoàn tất.
5. Run ném → waiters resolve, không treo — **setup**: poison session (append sẽ ném ở `turn/start`
   `agent.ts:376`, **ngoài** `try` mở tại `:385` → `run()` reject); lỗi provider/stream thường chỉ
   trả `'failed'`, **không** reject (`agent.ts:549-577`) — đừng dựng ca sai cách.
6. Nhiều waiter → tất cả resolve.
7. `run()` giữ nguyên chữ ký + hành vi (kể cả trả về ngay khi busy).

## Verify

```
npx vitest run tests/harness/agent-when-idle.spec.ts tests/harness/agent-loop.spec.ts tests/harness/g1-lifecycle.spec.ts
npm run typecheck
```

## Khi xong

Ghi mục HC-3 vào `plans/261016-implementation-report.md`. (Follow-up ngoài scope: dùng `whenIdle()`
thay **branch-check** `agent.busy` ở `web/server.ts:1459, 9736-9750` — hai site là branch-check
(không phải poll chờ); await `whenIdle()` sẽ nối dispatch **sau** busy period (đổi hành vi) và latch
`'cancelling'` (`busy === true` nhưng depth 0) cần xử riêng.)
