---
title: "Harness core hardening — HC-1 · HC-2 · HC-3"
description: "Spill tool-output ra file + retention/đọc lại; retry seam `llm/retry`; `Agent.whenIdle()` — triển khai theo spec plans/261016-spec-harness-core-hardening.md v3.4 (HC-4 chờ chốt §5.5)."
status: pending
priority: P1
effort: "~12h"
branch: feat/harness-core-hardening
tags: [harness, tools, spill, retry, agent]
blockedBy: []
blocks: []
created: 2026-10-17
---

# Harness core hardening — kế hoạch triển khai

## Kết quả cần đạt

Ba hạng mục core loop còn lại sau đợt SR (`plans/261016-implementation-report.md`):

1. **HC-1 — spill tool-output**: output > `toolOutputLimit` không còn bị mất. Pipeline
   (`ToolsService.postExecute`) là **chủ sở hữu duy nhất** của cửa sổ model-visible (head + marker
   + tail — bảo toàn suffix `[exit code: N]`), phần đầy đủ ghi ra
   `<hostStorageRoot>/tool-output/<sessionId>/`, model đọc lại được qua fs tools (read-only
   carve-out **theo session**), retention 7 ngày + sweep cơ hội.
2. **HC-2 — retry seam**: event `llm/retry` phát đúng lúc trước mỗi lần chờ backoff; listener veto
   được (`{retry:false}` → ném lỗi gốc) hoặc đổi delay (`{delayMs}`); không listener = hành vi y cũ.
3. **HC-3 — `Agent.whenIdle()`**: await hết busy period (turn chain + successor), **không đổi**
   contract `run()` — không call-site nào phải sửa.

Spec nguồn: `plans/261016-spec-harness-core-hardening.md` (**v3.4**) — qua các vòng review phản
biện + rà khi lên plan + 3 agent review độc lập + 1 vòng soi diff v3.3; mọi file:line dưới đây đã
kiểm chứng tại 2026-10-17.

## Preflight (làm trước phase 1)

- Working tree đang có cụm **SR chưa commit** trên branch `fix/effort-vocabulary-and-prompt-discipline`
  (`src/harness/agent/agent.ts`, `limits.ts`, `llm/*`, `web/server.ts`, 5 file test…). Commit/PR cụm
  này trước để có baseline sạch — phase 1 và 3 đụng `agent.ts` nên cần base ổn định.
- Tách branch `feat/harness-core-hardening` từ baseline đã commit.

## Phases

| # | Phase | Nội dung | Status | Ước lượng | Phụ thuộc |
|---|-------|----------|--------|-----------|-----------|
| 1 | `phase-01-llm-retry-seam.md` | HC-2 — event `llm/retry` + veto/delay | pending | ~3h | — |
| 2 | `phase-02-tool-output-spill.md` | HC-1 — spill + retention + carve-out + MCP + UI regex | pending | ~7h | 1 (thứ tự) |
| 3 | `phase-03-when-idle.md` | HC-3 — `Agent.whenIdle()` | pending | ~2h | 2 (thứ tự) |

Thứ tự 1 → 2 → 3 theo spec §7: nhỏ/độc lập trước; HC-1 (giá trị cao nhất, cần review kỹ carve-out
grants) ở giữa; HC-3 chốt hạ. Các phase chỉ dùng chung `agent.ts` ở **vùng khác nhau** (phase 1:
backoff `:848-868`; phase 3: `run()` `:289-343`) — rebase an toàn.

## Định nghĩa "xong" (mỗi phase)

- Code + test của phase xanh; `npm run typecheck` (`tsc -p tsconfig.json` + `tsc -p tsconfig.web.json`) sạch.
- Không hồi quy: chạy danh sách test ghi trong phase file + `npm test` trước khi đóng phase.
- Ghi mục tương ứng (HC-x, file đổi, test mới, ngày) vào `plans/261016-implementation-report.md`.

## Ngoài phạm vi

- **HC-4** (permission rule theo resource + persisted always-allow) — chờ chốt 5 câu hỏi spec §5.5;
  sẽ có phase riêng sau.
- Retry seam cho compaction stream host (`web/server.ts:1698`, `retryingCompactionStream` — không
  phải preview) — tuỳ chọn trong phase 1, có thể tách PR sau.
- Follow-up dùng `whenIdle()` thay **branch-check** `agent.busy` ở host (`web/server.ts:1459,
  9736-9750`) — đổi hành vi dispatch (nối sau busy period) + latch `'cancelling'` cần xử riêng;
  ngoài scope, ghi chú khi HC-3 xong.

## Success criteria

- [ ] HC-2: 7 ca test mới xanh (gồm reask yield-partial + không-listener 0 event); không listener →
      attempts/delay **không đổi**.
- [ ] HC-1: `tool-output-spill.spec.ts` xanh; under-cap byte-identical; bash over-cap giữ
      `[exit code: N]` / `[terminated…]` ở tail; `read` đọc được file spill (session mình) nhưng
      `write` vào đó deny; session khác deny; registry `ringChars` plumb + Read reserve footer chốt.
- [ ] HC-3: 7 ca `agent-when-idle` xanh; không call-site nào của `run()` phải sửa.
- [ ] `npm run typecheck` + `npm test` sạch trên branch hoàn chỉnh.

## Notes

- Spec v3.2: sửa 3 điểm khi lên plan (test trực tiếp không qua pipeline mất marker hẳn; phải plumb
  `toolOutputCaptureLimit` qua `exec`; HC-2 test đặt ở `agent-loop.spec.ts`) + 2 điểm qua review
  plan (carve-out đủ — **synthetic read-only root**, miễn deny một mình không đủ; bỏ trần ghi
  spill — marker "full output saved" phải luôn đúng) — lịch sử ở đầu spec.
- Spec v3.3 (3 agent review độc lập): plumb `ringChars` (capture bash production thật = registry
  64K, không phải 1MB); spill dir + carve-out **theo session**; Read reserve footer; `nextAttempt`
  cho cả reask; veto qua `assertLive()`; `delayMs !== undefined`; 5→7 ca HC-2 (thêm reask +
  no-listener); nhãn `:1698` = compaction stream; regex UI `[^\n]+`; ghi chú rủi ro §2.6
  (PostToolUse ~2MB, surrogate pair, junction thư mục).
- Spec v3.4 (1 vòng soi diff v3.3): gate phát reask theo attempt budget (hết attempt → `consume()`
  ném, không phát event — §3.1.2/§3.2.6); spill resolve limits qua `resolveLimits` (partial provide
  không tắt im lặng); plumb `sessionId` cho `buildRestoration` (restore đọc spill của chính
  session); chốt wording byte-identical (pipeline) + biên Read reserve; panel process-detail tới
  ~1MB/proc.
- Backup spec v1: `C:\Users\devdu\AppData\Local\Temp\opencode\spec-v1-backup.md`.
