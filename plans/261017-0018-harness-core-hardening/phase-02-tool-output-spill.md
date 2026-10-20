---
phase: 2
title: "Tool-output spill + retention + đọc lại (HC-1)"
status: pending
priority: P1
effort: "~7h"
dependencies: [1]
---

# Phase 2 — Tool-output spill + retention + đọc lại (HC-1)

Spec nguồn: `plans/261016-spec-harness-core-hardening.md` §2 (§2.1 thiết kế · §2.2 config ·
§2.3 file map · §2.4 acceptance 10 mục · §2.5 test · §2.6 rủi ro).

## Goal

Output vượt `toolOutputLimit` không còn mất. Pipeline `postExecute` là **chủ sở hữu duy nhất** của
cửa sổ model-visible: **head + marker + tail** (bảo toàn suffix `[exit code: N]`,
`[terminated…]`, marker capture); phần đầy đủ ghi ra `<hostStorageRoot>/tool-output/<sessionId>/`
(retention 7 ngày, sweep cơ hội); model `read` lại được trong **session mình** (carve-out
read-only, session khác deny), `write`/`edit` vẫn deny.

## Nguyên tắc (không được vi phạm)

- **Mọi đường production qua `postExecute`** (`tools/service.ts:392` — kể cả `prepared.execute()`
  của agent `agent.ts:999` và web `server.ts:2061`); tool trả **full capture**.
- Under-cap ⇒ **byte-identical**, không tạo file (kể cả khi spill bật).
- Ghi file lỗi ⇒ cắt **không path**, call vẫn `ok`. Ghi **đồng bộ** (marker không trỏ file chưa
  tồn tại). Ghi **nguyên trạng** output — không thêm trần ghi ("full output saved" phải luôn đúng).
- Waterfall `tools/post-execute` chạy **trước** spill (hook thấy full text; file lưu bản **final**
  sau hook — redaction cũng áp cho file).

## Steps

1. **`src/harness/tools/output-store.ts` (mới)** — hàm thuần + I/O:
   - `windowOutput(output, limit, spillPath?)`: `len ≤ limit` ⇒ nguyên văn; quá ⇒
     `${head}\n… [truncated N chars]\n${tail}` với `TAIL = min(SPILL_TAIL_CHARS, ⌊limit/2⌋)`,
     `head = limit − TAIL`, `N = len − limit` (**đếm cả suffix**); khi có path chèn
     `; full output saved to ${path}` trong ngoặc marker. Marker là **dòng riêng** (regex UI hiện
     có yêu cầu `(?=\n|$)`).
   - `spillOutput(exec, ...)`: mkdir recursive `tool-output/<exec.sessionId>/`, utf8, tên
     `<timestamp>-<tool-name-sanitized>-<rand6>.txt`, trả path — lỗi (EACCES/ENOSPC/…) trả `undefined`.
   - `sweepToolOutputDir(dir, retentionMs, now)`: duyệt `dir/*/` (1 cấp session) + file lẫn ở gốc,
     xoá file cũ hơn retention, ENOENT-safe, **không bao giờ ném**.
   - Hằng `SPILL_TAIL_CHARS = 2_000`.
2. **`src/harness/limits.ts`** — 3 field cạnh `toolOutputLimit` (`:42-43`) + defaults (`:90-117`):
   `toolOutputSpill: true`, `toolOutputRetentionMs: 604_800_000`, `toolOutputCaptureLimit: 1_048_576`;
   registration: `toolOutputSpill` → `BOOLEAN_LIMITS` (`:119`), 2 số → `INTEGER_LIMITS` (`:120-123`).
   Comment cross-ref: `1_048_576` trùng số với frame cap MCP (`src/harness/mcp/limits.ts:7`) — **khác khái niệm**,
   đừng gộp hằng.
3. **`src/harness/tools/types.ts`** — `toolOutputCaptureLimit?: number` cạnh `outputLimit`
   (`:74-75`), kèm doc-comment một dòng.
4. **`src/harness/tools/service.ts`**:
   - `buildExecution` (`:440-458`): set `toolOutputCaptureLimit` từ limits (theo pattern
     `outputLimit` `:455`; mở rộng cast `limits` tại `:440`).
   - `postExecute` (`:465-471`): sau waterfall → **resolve limits qua `resolveLimits(ctx.get('limits'))`**
     (`limits.ts:127`; tiền lệ `agent.ts:1062`) — không cast partial (host/test provide thiếu field sẽ
     tắt spill im lặng) → nếu quá `outputLimit` + `toolOutputSpill === true` +
     `exec.hostStorageRoot !== undefined` + `exec.sessionId !== undefined` ⇒ spill, lấy path → trả
     `{ ...result, output: windowOutput(output, limit, path) }`; mọi trường hợp over-cap khác ⇒
     window không path. Sweep cơ hội trong cùng call khi lần sweep trước > 1h (`lastSweepAt` của
     instance) + method public `sweepToolOutputs()` cho test/host. Spill **không bao giờ** làm hỏng
     call.
5. **`src/capabilities/fs/tools.ts`** — Read: reserve chỗ cho footer trong budget —
   `const budget = Math.max(64, limitOf(exec) − READ_FOOTER_RESERVE)` (`READ_FOOTER_RESERVE = 256`)
   để output ≤ `outputLimit` kể cả footer phân trang (`:205-206`) + footer UTF-8 (`:208`) — như
   `searchOutput` đã reserve (`search.ts:309-311`). Không có reserve, **mọi** Read bị cắt budget
   vượt trần chỉ vì footer → marker + spill vô nghĩa mỗi lần. Curation khác giữ nguyên. Biên nhỏ:
   `limitOf < ~320` có thể vượt nhẹ (≤ ~200) do floor `Math.max(64, …)` — chấp nhận, vận hành ≥ ~1000.
6. **`src/capabilities/shell/bash.ts`**:
   - `:245-250`: bỏ `const limit` + slice/`body`; `return` trực tiếp `${output}${dropped}${suffix}`.
   - `:178-183` (`formatOutput`, background result): bỏ `limit` + slice, trả `result.output` +
     capture marker.
   - `:279`: `captureCap = (exec.toolOutputCaptureLimit ?? DEFAULT_TOOL_OUTPUT_CAPTURE_LIMIT) +
     CAPTURE_SLACK` — default 1 048 576 (`OUTPUT_CAP` `:24` hết chỗ dùng khi bỏ slice → xoá;
     hằng default đặt export ở `limits.ts` hoặc tại chỗ); giữ `CAPTURE_SLACK = 4_000` (`:26`).
7. **`src/capabilities/shell/background-tools.ts`** — bỏ `limit`/`body` slice (`:46-47`):
   `return `[status: ${status}]\n${read.output}${truncated}``; `OUTPUT_CAP` (`:11`) hết chỗ dùng → xoá.
8. **`src/web/server.ts`** — (a) bỏ cắt inline MCP (`:3213-3215`): `const text = dispatched.output`;
   `resultHash: auditHash(text)` giờ hash **full** text (`:3223`) — chủ ý, đã rà không consumer xác
   minh; event `mcp/call` giữ nguyên schema. (b) `:1312`: `new ProcessRegistry(processEvents,
   { ringChars: limits.toolOutputCaptureLimit })` (+ `src/bins/headless.ts:309` với limits headless)
   — không plumb, capture production chặn cứng 64_000 (`registry.ts:73`), trần 1MB thành no-op cho
   bash; RAM worst case ≈ host 24 proc × ringChars.
9. **`src/capabilities/fs/grants.ts`** — carve-out **hai phần, phạm vi theo session**, theo nguyên
   mẫu `memoryStorageCarveout` (`:167-177`):
   - **Grant**: `grantedRoots()` (`:153-154`, widen Pick thêm `hostStorageRoot`/`deniedRoots`/
     `sessionId`) trả thêm synthetic root `{ path: <hostStorageRoot>/tool-output/<sessionId>,
     access: 'read' }` khi `hostStorageRoot` được set, là một denied root, và `sessionId` có.
     Không có phần này, target vẫn `out-of-grant` → mỗi lần đọc bị hỏi approval hoặc từ chối ngay
     (`grants.ts:289-306`; gate `path-scope-guard.ts:106-116` dùng chung `classifyTarget` → tự
     khớp; `assertSameGrantOnDisk` `:212-226` + search base `search.ts:160` khớp sẵn nhờ dùng
     chung `grantedRoots()`).
   - **Miễn deny**: `classifyTarget` (`:199`) + filter trong `resolveInGrants` (`:262`) bỏ qua
     denied root khi `intent === 'read'` và target trong dir **của session mình** — write **luôn
     deny** (không miễn). Dùng **một helper chung** `toolOutputCarveout(exec, denied, abs, intent)`
     cho cả ba vị từ để không lệch.
   - **Cross-session**: spill session khác rơi về app-storage deny (**hard**, không ask); fallback
     `currentGrant()` (không `sessionId`) → không carve-out (fail-closed); thiếu `sessionId` ⇒
     không spill.
   - **Restore**: `web/compaction-restoration.ts:171` (Pick `exec`) + caller `server.ts:1821` — thêm
     `sessionId` để restore đọc spill của chính session sau compaction (không thì section "denied").
10. **`web/lib/tool-facts.ts`** — nới `TRUNCATION` (`:88`) + `BASH_CUT` (`:250`):
    `truncated \d+ chars(?:; full output saved to [^\n]+)?` — **`[^\n]+`** (không phải `[^\]]+`:
    path Windows có thể chứa `]` → vỡ lookahead `(?=\n|$)`); marker head+tail vẫn thỏa `(?:^|\n)` +
    `(?=\n|$)`.
11. **Tests**:
    - **Mới** `tests/harness/tool-output-spill.spec.ts`: unit `windowOutput` (under/over, N đếm cả
      suffix, 2 biến thể marker, `limit` nhỏ) + ca pipeline (fake tool qua `ToolsService` + tmp
      host storage + `exec.sessionId`: file spill đầy đủ **nguyên trạng**, read-back qua `fsTools`
      (**in-grant** — assert cấp `classifyTarget`/guard, không assert "không ask" qua
      `fsTools.execute` trực tiếp; path trong dir **của chính session**), write deny, **session
      khác → deny (không đọc được spill của session kia)**, spill off / thiếu hostStorageRoot /
      thiếu sessionId, ghi lỗi vẫn ok, sweep duyệt subdir) + ca MCP-style (fake tool, không dựng
      server thật).
    - **Registry `ringChars`**: giữ ca hiện có `tests/harness/processes/registry.spec.ts:119-128`
      (`ringChars: 100` — cắt đúng + `outputTruncated`); chỉ chạy lại, không viết ca mới.
    - Ca **Read reserve**: Read file > budget → output ≤ `outputLimit`, không marker/spill.
    - Ca carve-out theo mẫu `tests/harness/file-memory.spec.ts:89`: read trong tool-output session
      mình → in-grant; write → deny; symlink trong tool-output trỏ ra ngoài → bị chặn.
    - `tests/web/tool-facts.spec.ts`: +1 ca marker **có path** → digest vẫn `· truncated`.
    - Cập nhật 3 ca theo spec §2.5 (test gọi tool trực tiếp **không còn marker**):
      `tests/harness/processes/review-regressions.spec.ts:11-14` (bỏ `truncated 10 chars`; assert
      full capture + `[exit code: 0]`; đổi tên ca), `:37-43` (bỏ `truncated` + `not.toContain`; giữ
      `terminated by stop` + full), `tests/capabilities/bash.spec.ts:215-220` (đổi
      `outputLimit: 2_000` → `toolOutputCaptureLimit: 2_000`; nới trần assert `< 6_500`; giữ
      `match(/truncated/)`).

## Acceptance

Chốt theo spec §2.4 (10 mục): under-cap byte-identical · over-cap head+marker+tail mọi nhánh ·
spill file **nguyên trạng** + read được trong **session mình** (in-grant; session khác → deny) +
write deny · ghi lỗi vẫn ok (không path) · spill off/thiếu hostStorageRoot/sessionId vẫn head+tail
không path · bash giữ `[exit code: N]`/`[terminated…]`/marker capture ở tail · sweep an toàn (đa
subdir) · symlink trong tool-output bị chặn · MCP đi đủ đường (resultHash full) · UI digest nhận
marker có path. Thêm so với spec: registry `ringChars` plumb (capture production thật) + Read
reserve footer (Read không tự vượt trần).

## Verify

```
npx vitest run tests/harness/tool-output-spill.spec.ts tests/harness/processes/review-regressions.spec.ts tests/harness/processes/bash-background.spec.ts tests/capabilities/bash.spec.ts tests/capabilities/fs-tools.spec.ts tests/web/tool-facts.spec.ts
npm run typecheck
```

Grep hậu kiểm: không còn slice theo `outputLimit` trong `src/capabilities/shell/*`; magic `60_000`
ở nhánh MCP `server.ts` đã xoá; `new ProcessRegistry(` tại 2 host đều truyền `ringChars`.

## Khi xong

Ghi mục HC-1 vào `plans/261016-implementation-report.md`.
