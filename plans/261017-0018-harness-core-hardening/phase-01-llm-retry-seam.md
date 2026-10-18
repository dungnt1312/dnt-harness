---
phase: 1
title: "Retry seam: event `llm/retry` (HC-2)"
status: pending
priority: P2
effort: "~3h"
dependencies: []
---

# Phase 1 — Retry seam: event `llm/retry` (HC-2)

Spec nguồn: `plans/261016-spec-harness-core-hardening.md` §3 (§3.1 thiết kế · §3.2 acceptance · §3.3 test).

## Goal

Mỗi lần retry/re-ask sắp chờ backoff, harness phát `llm/retry` (serial) cho host/listener: quan sát
được, veto được (`{retry:false}` → ném lỗi gốc), đổi delay được (`{delayMs}` → clamp như
`retryAfterMs`). Không listener → hành vi y hệt trước.

## Steps

1. **`src/harness/llm/service.ts`** — khai báo event mới trong `declare module 'dnt-harness'` cạnh
   `'llm/stream'` (`:16-19`), đúng payload §3.1:
   `{ sessionId, turnId, stepId, kind: 'retry'|'reask', attempt, nextAttempt, reason, message,
   transient, retryAfterMs?, provider?, model? }`
   → `Promise<{ retry?: false; delayMs?: number } | undefined>`.
2. **`src/harness/agent/agent.ts`** — helper private (vd `emitRetry(...)`) bọc
   `this.ctx.serial('llm/retry', payload)` trong `try/catch`; lỗi listener ⇒ retry **mặc định** vẫn
   xảy ra (chú ý: `ctx.serial` không nuốt lỗi và **dừng chuỗi** tại chỗ ném — khác `undefined`;
   `kernel/events.ts:171-177`).
   - `attempt = owner.attempts` (`request-lifecycle.ts:92`, counter công khai, tăng qua `consume()`);
     `nextAttempt = attempts + 1` cho **cả hai kind** — counter thuộc owner (`agent.ts:711`, một
     owner cho cả `step()`) và **không** reset khi reask đổi step; khớp `model/attempt` facts.
   - `reason`/`message`/`transient`/`retryAfterMs` lấy từ `ProviderError`; `provider`/`model` lấy
     từ `request` nếu có (nguồn như `agent.ts:880`).
   - Bail note (`kernel/events.ts:165-177`): chỉ `undefined`/`null`/`false` mới nhường listener sau;
     object bất kỳ (kể cả `{}`) là **quyết định cuối** — `{}` = hành vi cũ nhưng chặn chuỗi.
3. **Điểm phát — reask** (`agent.ts:848-857`, kind `'reask'`): phát ngay trước `owner.backoff`
   (`:856`); payload dùng step id của step **vừa bỏ** — capture biến trước `stepId = newStepId()`
   (`:852`). **Chỉ phát khi còn attempt kế** (`owner.attempts < owner.policy.maxAttempts` — hết
   budget thì vòng sau `consume()` ném `request-lifecycle.ts:104`: không retry, không event; spec
   §3.2.6). Veto ⇒ `assertLive()` rồi `throw error` (mẫu `:856`); `{delayMs}` (check `!== undefined`
   — `0` hợp lệ) ⇒ `owner.backoff(signal, delayMs)` trong cùng `try/catch` + `assertLive`.
4. **Điểm phát — transient retry** (`agent.ts:861-867`, kind `'retry'`): phát ngay trước
   `owner.backoff` (`:867`), sau khi đã qua `canRetry`/squeeze/`!transient` — tức chỉ khi retry
   **sẽ** xảy ra. Cùng xử lý veto/delay.
5. **(Tuỳ chọn, tách PR được)** cùng seam cho compaction stream host (`src/web/server.ts:1698`,
   `retryingCompactionStream` — **không phải** preview; preview không backoff) — cùng payload
   shape; mặc định hoãn.

Không đổi: trần 4 attempt (`request-lifecycle.ts:96-98`), clamp `[0, 30_000]` (`:121`), jitter
schedule, đường squeeze `contextExceeded` (không chờ backoff → không phát event).

## Tests

`tests/harness/agent-loop.spec.ts` (+7 ca — harness `flaky` + fake timers sẵn có, xem `:381-424`;
subscribe bằng `kernel.ctx.on('llm/retry', ...)`):

1. **payload (retry)**: 1 event / 1 lần chờ; `attempt`/`nextAttempt = attempts + 1`/`kind`/`reason` đúng.
2. **payload (reask)**: provider "yield 1 delta rồi throw transient" (mẫu `:460-467`) → `kind:
   'reask'`, `stepId` = step **bị bỏ**, `attempt`/`nextAttempt` khớp facts (counter owner không
   reset). Bắt buộc: `flaky` fail **trước** yield nên không chạm nhánh reask.
3. **veto** `{retry:false}` → không backoff, lỗi nổi lên như cũ (qua `assertLive()`).
4. **delay** `{delayMs: X}` kể cả `X = 0` (`!== undefined`) → chờ đúng `min(30_000, max(0, X))`, không jitter.
5. **không-phát-khi-không-retry**: lỗi không transient → 0 event; **hết budget** → 0 event kể cả
   nhánh reask ở attempt cuối (gate `owner.attempts < owner.policy.maxAttempts`).
6. **không listener** → 0 event, hành vi y hệt cũ.
7. **listener ném** → chuỗi dừng (listener sau không chạy) nhưng retry mặc định vẫn xảy ra.

## Verify

```
npx vitest run tests/harness/agent-loop.spec.ts tests/harness/llm.spec.ts tests/harness/request-lifecycle.spec.ts
npm run typecheck
```

## Khi xong

Ghi mục HC-2 vào `plans/261016-implementation-report.md`.
