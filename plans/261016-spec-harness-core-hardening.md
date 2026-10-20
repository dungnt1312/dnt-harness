# Spec (đề xuất) — Core hardening: tool-output spill · retry seam · whenIdle · permission rules

- Ngày: 2026-10-16 · Trạng thái: **ĐỀ XUẤT — chưa triển khai** (v3.4, qua các vòng review phản biện + rà khi lên plan + 3 agent review độc lập + 1 vòng soi diff v3.3 2026-10-17)
- Bối cảnh: phần wire/provider đã xong (`plans/261016-spec-provider-resilience-cli.md`, SR-0…SR-7);
  bản này chỉ gồm các gap **core loop** còn lại sau review sâu (`plans/261016-gap-vs-opencode.md`).
- Đối chiếu nguồn: `C:\laragon\www\opencode\packages\{core,ai}` (v2, đã kiểm chứng file:line bên dưới).
- **v2 sửa 5 điểm sau review phản biện**: (1) HC-1 — định dạng over-cap đổi thành **head+marker+tail**
  để bảo toàn `[exit code: N]` (v1 cắt head-only sẽ nuốt mất suffix); (2) HC-1 — thu hẹp phạm vi:
  fs tools giữ ngân sách curation (nguồn đọc lại được, không phải ca mất dữ liệu); (3) HC-3 —
  **không đổi contract `run()`**, chỉ thêm `whenIdle()`; (4) HC-2 — ghi rõ bail/throw semantics của
  `ctx.serial`; (5) HC-4 — thêm `id` cho rule + chốt thứ tự persisted < configured.
- **v3 sửa tiếp sau vòng review 3**: (1) đưa **MCP tools** (`server.ts:3213-3215`) vào phạm vi HC-1
  — trước bị cắt `60_000` magic **trước** `postExecute` nên spill không bao giờ bắt được;
  (2) nới regex UI `tool-facts.ts:88,250` cho marker có path; (3) `{}` là **quyết định cuối**
  (bail semantics) + làm rõ `attempt`/`nextAttempt` cho reask; (4) làm rõ vị trí run-depth
  (guard sớm `:290-293`); (5) xác nhận mọi đường production đi qua `postExecute` (`service.ts:392`).
- **v3.1 (khi lên plan, `plans/261017-0018-harness-core-hardening/`)**: (1) §2.5 — test gọi
  `bashTool.execute` **trực tiếp** không qua `postExecute` nên nhận full capture, **không còn
  marker** (không phải chỉ đổi số N) → cập nhật assert theo hành vi mới, coverage định dạng
  chuyển về test pipeline; (2) §2.3 — `toolOutputCaptureLimit` phải plumb qua `exec`
  (`types.ts` + `buildExecution`) như `outputLimit`; (3) §3.3 — ca HC-2 đặt ở
  `tests/harness/agent-loop.spec.ts` (harness `flaky` + fake timers sẵn có), không phải
  `attempt-events.spec.ts` (file đó test reader log).
- **v3.2 (qua review plan)**: (1) §2.1.3 — carve-out phải đủ để read là **in-grant read-only**:
  miễn deny một mình **không đủ** (path vẫn `out-of-grant` → mỗi lần đọc bị hỏi approval hoặc bị
  từ chối ngay — `grants.ts:289-306`, gate `path-scope-guard.ts:106-116`); cách làm: `grantedRoots()`
  (`grants.ts:153-154`) thêm **synthetic granted root read-only** `<hostStorageRoot>/tool-output`
  (cùng guard với `memoryStorageCarveout`) + miễn deny tại `:199`/`:262` (chỉ `intent === 'read'`);
  (2) §2.1.2 — **bỏ trần ghi spill**: ghi nguyên trạng (bash tự chặn ≤ `captureLimit` +
  `CAPTURE_SLACK` + suffix nên file đầy đủ; trần ghi cũ làm marker "full output saved" thành sai
  khi file bị cắt).
- **v3.3 (qua 3 agent review độc lập)**: (1) §2.2/§2.3 — **plumb `ringChars`**: capture bash
  production thật là registry **64_000** (`registry.ts:73`; `server.ts:1312`/`headless.ts:309` không
  truyền limits) ⇒ trần `toolOutputCaptureLimit` là no-op nếu không sửa; (2) §2.1.2/§2.1.3 — spill
  dir + carve-out **theo `sessionId`** (đọc chéo session rơi về app-storage deny hard; thiếu
  session ⇒ không spill/carve-out — fail-closed); (3) §2.3 — **Read reserve footer** trong budget
  (`fs/tools.ts`, như `searchOutput` `:309-311`) — không thì mọi Read bị cắt budget vượt trần bởi
  footer → marker+spill vô nghĩa; (4) §3.1.2 — `nextAttempt = attempt + 1` cho **cả** retry/reask
  (counter owner không reset — `agent.ts:711`); veto qua `assertLive()`; `delayMs` check
  `!== undefined` (0 hợp lệ); listener ném **dừng chuỗi** (≠ `undefined`); (5) §3.3 — 5→7 ca (thêm
  reask yield-partial + không-listener); (6) nhãn `:1698` = compaction stream
  (`retryingCompactionStream`), không phải preview; (7) §2.3 — regex UI dùng `[^\n]+` (path chứa
  `]` không làm vỡ `[^\]]+`); (8) §2.6 — bổ sung rủi ro (PostToolUse ~2MB, surrogate pair, junction
  thư mục).
- **v3.4 (qua 1 vòng soi diff v3.3)**: (1) §3.1.2 — **gate phát event reask theo attempt budget**
  (`owner.attempts < owner.policy.maxAttempts`; hết attempt thì `consume()` ném ở vòng kế
  `request-lifecycle.ts:104` — không retry nên không phát; §3.2.6); (2) §2.3/§2.2 — spill đọc limits
  qua **`resolveLimits`** (không cast partial — host partial provide sẽ tắt spill im lặng); (3) §2.1.3
  — plumb **`sessionId`** cho `buildRestoration` (`compaction-restoration.ts:171`, caller
  `server.ts:1816-1821`) — restore đọc được spill của chính session sau compaction; (4) §2.4.1 —
  làm rõ "byte-identical" là **hợp đồng pipeline** (không cam kết cách chia trang của Read);
  (5) §2.5 — ca registry `ringChars` **đã có sẵn** (`registry.spec.ts:119-128`), chốt biên cực nhỏ
  của Read reserve; (6) §2.6 — panel process-detail trả tới `ringChars`; sửa câu hook PostToolUse
  (trước đây bash/MCP đã bị cắt ≤ ~60K).
- Nguyên tắc:
  - Mỗi mục **giữ nguyên hành vi mặc định hiện tại** trừ khi được cấu hình/bật, hoặc khi nằm trong
    đường gây **mất dữ liệu thật** (HC-1 — ngoại lệ duy nhất, và chỉ đổi ở đúng ca over-cap;
    xem §2.4).
  - Không đụng wire protocol (đã chốt ở spec SR); không đổi schema event cũ (chỉ **thêm** event).
  - Mỗi mục có tiêu chí chấp nhận + test cụ thể; mục nào cần chốt thiết kế trước thì ghi rõ.

---

## 0. Tóm tắt điều hành

| ID | Hạng mục | Ưu tiên | Effort | Phụ thuộc | Nguồn học (opencode) |
|---|---|---|---|---|---|
| **HC-1** | Tool output **spill ra file** + retention + đọc lại | **P1** | M | — | `core/tool-output.ts` |
| **HC-2** | Seam retry: event `llm/retry` (observability + veto/delay) | P2 | S | — | `runner/retry.ts` + `session.retry` hook |
| **HC-3** | `Agent.whenIdle()` — await hết busy period (kể cả successor), **không đổi `run()`** | P2 | S | — | `session/run-coordinator.ts` |
| **HC-4** | Permission rule theo **resource** + persisted always-allow | P3 | M–L | Chốt thiết kế §5.5 | `core/permission.ts`, `permission/saved.ts` |

---

## 1. Bằng chứng

### 1.1 HC-1 — output vượt ngưỡng bị **mất hẳn** (không có chỗ để đọc lại)

`toolOutputLimit` (60 000 ký tự, `limits.ts:43,102`) là cap **model-visible**. Không có nơi nào
lưu phần vượt; các call site tự cắt inline:

| Call site | Vị trí | Cách cắt hiện tại |
|---|---|---|
| Bash (foreground) | `src/capabilities/shell/bash.ts:245-250` | `slice(0, limit)` + `… [truncated N chars]` |
| Bash (capture) | `bash.ts:279-289` | `captureCap = outputLimit + CAPTURE_SLACK`, phần vượt bị bỏ ngay lúc capture |
| Bash (background result) | `bash.ts:178-183` (`formatOutput`) | `slice(0, limit)` + marker |
| `bashOutput` (đọc lại process) | `src/capabilities/shell/background-tools.ts:46` | `slice(0, limit)` + marker |
| **MCP tools** (JSON từ server ngoài) | `src/web/server.ts:3213-3215` | cắt `60_000` magic **ngay trong tool body** → `postExecute` chỉ thấy bản đã cắt ⇒ spill không bao giờ bắt được ca này |
| `read`/`grep`/`glob` (fs) | `src/capabilities/fs/tools.ts:56-59` (`limitOf`) | ngân sách **curation** (`OUTPUT_CAP = 60_000`, `:42`) — nguồn vẫn đọc lại được (offset/limit, grep lại) nên **không** phải ca mất dữ liệu; giữ nguyên |

Phạm vi HC-1 vì vậy là **stream kết quả ephemeral**: bash foreground/background, `bashOutput`,
**MCP tools**. fs tools và Agent report (`executor.ts:1571` — bản tổng hợp, nguồn đầy đủ là child
session) giữ nguyên. Tool tương lai trả về > cap mà không tự cắt vẫn được pipeline spill tự động.

Hệ quả: build log / test log dài bị cắt là **không thể xem lại** — model phải chạy lại lệnh.
opencode làm ngược: `ToolOutput.truncate` (`packages/core/src/tool-output.ts:67-118`) ghi **toàn bộ
output gốc** ra `<global data>/tool-output/tool_*`, trả về cửa sổ bounded + marker
`[showing lines 1-N of M; full output saved to <path>]` (`:90`) + `metadata.outputPath` (`:116`),
retention **7 ngày** (`:15`) và cleanup định kỳ mỗi giờ (`:129-138`). Pipeline gọi truncate cho
**mọi** tool result ngay trong step (`runner/step.ts:127`).

### 1.2 HC-2 — retry đang "âm thầm": có backoff nhưng không có seam quan sát/điều khiển

- Backoff đã có jitter + cap 30s: `request-lifecycle.ts:114-123`; `retryAfterMs` bị cap 30s ngay
  trong `ProviderError` (`llm/types.ts:39`); trần cứng 4 attempt (`request-lifecycle.ts:96-98`).
- Retry xảy ra ở `agent.ts:856` (re-ask sau khi bỏ step hỏng) và `agent.ts:867` (transient retry);
  compaction host cũng có một chỗ retry riêng (`retryingCompactionStream`, `web/server.ts:1698` —
  **không phải** preview). Không nơi nào phát event cho UI,
  không có hook veto/adjust.
- opencode: `runner/retry.ts:64-92` chạy policy qua `session.retry` **plugin hook** với
  `decision { retry, delay }` (veto được), publish `RetryScheduled` (`:104-110`), tách trần riêng
  cho timeout (`:60-62`).

### 1.3 HC-3 — không có API "đợi session rảnh"; host phải polling `busy`

- `Agent.run()` trả về ngay khi đang chạy (`agent.ts:293` — `if (this.status !== 'idle') return`)
  ⇒ không ai `await` được một run đang in-flight, cũng không ai đợi được successor (recheck
  microtask ở `agent.ts:334-342`).
- Hệ quả thấy được: host phải polling `agent.busy` khắp nơi (vd `web/server.ts:1459, 9736-9750`),
  test phải tự poll.
- opencode: `run-coordinator.ts` — `run(key)` join vào execution đang chạy (`:124-134`),
  `awaitIdle` theo cả successor (`:171-176`), `wake` doorbell coalesce (`:136-145`).

### 1.4 HC-4 — permission là **tên tool**, chưa có resource + chưa persist "always"

- Hiện tại: `resolvePermission` (`src/harness/approval/resolution.ts:12-24`) — exact name →
  `mcp__server__*` → `*`; yolo override; out-of-grant path có session grant qua host
  (`ApprovedPathResolver`, `tools/service.ts:44-47`); Bash có blocklist riêng (guard store).
- opencode: `permission.evaluate(action, resource, ...rulesets)` **last-match-wins** với
  `Wildcard.match` trên cả action lẫn resource (`core/permission.ts:87-91`; comment
  "order is policy" ở `v1/config/permission.ts:8`); trả lời "always" được **lưu** thành rule theo
  project (`permission.ts:299-318`, `permission/saved.ts:22-33`).

---

## 2. HC-1 — Tool output spill + retention + đọc lại

### 2.1 Thiết kế

1. **Một chủ sở hữu duy nhất cho cửa sổ model-visible**: các tool tự-cắt (bash, `bashOutput`,
   MCP tại `server.ts:3213-3215`) trả về **full capture**; pipeline (`ToolsService.postExecute`,
   `tools/service.ts:465-471`) mới là nơi cắt cửa sổ + spill. (Mọi đường thực thi production đều
   qua `postExecute` — kể cả `prepared.execute()` của agent/web: `service.ts:392`.)
   - Capture của tool bị chặn bởi trần mới `toolOutputCaptureLimit` (§2.2) để không ăn RAM.
   - **Định dạng over-cap (mới — một format duy nhất cho mọi nhánh)**: giữ **đầu + đuôi**:
     ```
     <head: limit − TAIL ký tự đầu>
     … [truncated N chars]                                ← không spill / spill tắt / ghi lỗi
     … [truncated N chars; full output saved to <path>]   ← spill thành công
     <tail: TAIL ký tự cuối>
     ```
     Phân bổ (khi `len(output) > limit`): `TAIL = min(SPILL_TAIL_CHARS, ⌊limit / 2⌋)`,
     `head = limit − TAIL` ⇒ `head + tail = limit` (cửa sổ không phình so với trước). Marker là
     **dòng riêng** (`\n… [truncated …]\n`) — điều kiện để regex UI hiện có (`(?=\n|$)`) vẫn khớp.
     **Bắt buộc có tail**: suffix quan trọng nằm ở *cuối* output (`[exit code: N]`, marker capture
     `bash.ts:246`, kết luận test) — cắt head-only sẽ nuốt mất chúng. `SPILL_TAIL_CHARS = 2_000`
     là hằng module trong `tools/output-store.ts` (theo tiền lệ hằng số của opencode,
     `tool-output.ts:13-14`).
   - **N đếm trên toàn bộ text tool trả về** (kể cả suffix): `N = len(output) − limit`. Khác v1
     chút về con số với bash (trước đây suffix nằm ngoài vùng cắt nên không vào N) — đúng hơn về
     ngữ nghĩa "số ký tự bị bỏ". Với default 60 000, suffix ≈15–30 ký tự luôn nằm trọn trong tail
     2 000; chỉ cấu hình `limit` cực nhỏ (ca test) mới thấy suffix cụt — xem §2.5.
   - Marker **không-path giữ nguyên văn** `… [truncated N chars]` — assert dạng `/truncated/` giữ
     được; vị trí đổi (marker nằm giữa) và con số N của bash đổi (đếm cả suffix) — §2.5. Marker
     **có path** (spill) cần nới regex UI: `web/lib/tool-facts.ts:88,250` (§2.3).
   - Log/`tool/result` chỉ chứa cửa sổ bounded + marker (spill nằm trong postExecute, trước khi
     agent ghi log) — log không phình.
2. **Spill** trong `postExecute`, sau waterfall (hook thấy full text; artifact lưu bản **final**
   sau hook — đỏ/che secret cũng áp cho file):
   - Điều kiện spill: `toolOutputSpill === true` **và** output > `toolOutputLimit` **và**
     `exec.hostStorageRoot !== undefined` **và** `exec.sessionId !== undefined` (session-scoped).
   - File: `<hostStorageRoot>/tool-output/<sessionId>/<timestamp>-<tool-name-sanitized>-<rand6>.txt`
     (mkdir recursive, ghi utf8); ghi **nguyên trạng** output sau hook — **không** thêm trần ghi
     (marker "full output saved" phải luôn đúng). Trần thực tế phía tool: bash registry `ringChars`
     = `toolOutputCaptureLimit` (§2.2 — phải plumb), nhánh direct `+ CAPTURE_SLACK`; MCP ≤ ~2MB
     (`src/harness/mcp/limits.ts:7,9`).
   - Ghi file lỗi (EACCES/ENOSPC/…) → vẫn cắt theo định dạng over-cap **không kèm path**, call
     vẫn `ok`. Spill không bao giờ làm hỏng call.
   - Ghi file đồng bộ trong call path (không fire-and-forget) để marker không bao giờ trỏ file
     chưa tồn tại; ghi vài chục KB là chấp nhận được.
3. **Đọc lại**: carve-out read-only, **phạm vi theo session** — đúng
   `<hostStorageRoot>/tool-output/<sessionId>/**` trong `grants.ts` — **hai phần, đủ cả hai**:
   - **Grant**: `grantedRoots()` (`grants.ts:153-154`) trả thêm **synthetic read-only root**
     `{ path: <hostStorageRoot>/tool-output/<sessionId>, access: 'read' }` khi `hostStorageRoot`
     được set, là một denied root, và `exec.sessionId` có (cùng guard với `memoryStorageCarveout`
     `:167-177`). Không có grant này, target vẫn `out-of-grant` → mỗi lần đọc spill bị **hỏi
     approval** hoặc từ chối ngay (`grants.ts:289-306`) — miễn deny một mình là **không đủ**. Nhờ
     dùng chung `grantedRoots()`, gate (`path-scope-guard.ts:106`), disk assertion (`:212-226`) và
     search base (`search.ts:160`) khớp sẵn.
   - **Miễn deny**: `classifyTarget` (`:199`) + filter trong `resolveInGrants` (`:262`) bỏ qua
     denied-root khi `intent === 'read'` và target trong dir của **chính session**; write **luôn
     deny** (không miễn). Dùng **một helper chung** `toolOutputCarveout(exec, denied, abs, intent)`
     cho cả ba vị từ để không lệch.
   - Chỉ áp khi `samePath(denied, hostStorageRoot)` — không mở bất kỳ phần nào khác của data home.
   - **Cross-session**: spill của session khác nằm ngoài synthetic root → rơi về app-storage deny
     (**hard**, không ask). Fallback `currentGrant()` (không `sessionId`) → không carve-out
     (fail-closed); thiếu `sessionId` ⇒ không spill.
   - **Restore sau compaction**: `buildRestoration` nhận `exec` không `sessionId`
     (`web/compaction-restoration.ts:171`) → thêm `sessionId` vào Pick, truyền từ caller
     (`server.ts:1816-1821`) để restore đọc được file spill **của chính session** (không thì mục
     restore "denied — not restored"); các đường restore khác không đổi.
4. **Retention + sweep**: `toolOutputRetentionMs` (mặc định 7 ngày). Sweep cơ hội trong service:
   khi spill, nếu lần sweep trước > 1 giờ thì xoá file trong `tool-output` cũ hơn retention
   (bounded, lỗi bỏ qua); thêm `ToolsService.sweepToolOutputs()` cho test/host. Không thêm timer mới.
5. **Biết trước (chấp nhận)**: đọc lại một file spill > cap sẽ tạo file spill *mới* (chain hiếm,
   bounded bởi capture limit, retention dọn) — không dedupe ở v1.

### 2.2 Config (`limits.ts`)

```ts
/** Spill output vượt cap ra <hostStorageRoot>/tool-output để model đọc lại. */
readonly toolOutputSpill: boolean           // default true
/** Thời gian giữ file spill (mặc định 7 ngày). */
readonly toolOutputRetentionMs: number      // default 604_800_000
/** Trần capture phía tool (chặn firehose; cửa sổ hiển thị vẫn do outputLimit cắt). */
readonly toolOutputCaptureLimit: number     // default 1_048_576 (chars)
```

Đăng ký: `toolOutputSpill` vào `BOOLEAN_LIMITS`; hai số vào `INTEGER_LIMITS`
(`limits.ts:119-124`). `MAX_TIMER_MS` (2^31−1, `processes/shutdown.ts:11`) chấp nhận 7 ngày.

**Plumb capture (bắt buộc)**: `new ProcessRegistry(processEvents, { ringChars:
toolOutputCaptureLimit })` tại `web/server.ts:1312` + `bins/headless.ts:309` — không có nó, mọi
bash chạy qua registry (cả hai host) bị chặn cứng 64_000 (`registry.ts:73`) và trần 1MB thành
no-op. RAM worst case ≈ 24 proc × ringChars (~24MB).

### 2.3 Thay đổi theo file

| File | Việc |
|---|---|
| `src/harness/tools/output-store.ts` **(mới)** | Hàm thuần + I/O: `spillOutput(exec, call, output)` → `{ output, path? }` (cắt head+tail + marker; path = `tool-output/<exec.sessionId>/`); `sweep(dir, retentionMs, now)` duyệt cả subdir session; hằng `SPILL_TAIL_CHARS = 2_000` |
| `src/harness/tools/service.ts` | `postExecute` gọi spill sau waterfall; đọc limits qua **`resolveLimits(ctx.get('limits'))`** (`limits.ts:127`; tiền lệ `agent.ts:1062`) — không cast partial, host/test provide partial vẫn áp default (spill bật) |
| `src/capabilities/shell/bash.ts` | Bỏ `slice(outputLimit)`: `:245-250`, `:178-183` (`formatOutput`); `captureCap` dùng `toolOutputCaptureLimit` (`:279`) |
| `src/capabilities/shell/background-tools.ts` | Bỏ `slice` tại `:46`, trả full capture |
| `src/harness/tools/types.ts` + `service.ts` | `ToolExecution` thêm `toolOutputCaptureLimit?: number` (cạnh `outputLimit`, `types.ts:74-75`); `buildExecution` set từ limits (`service.ts:455`, mở rộng cast `:440`) — bash đọc `exec.toolOutputCaptureLimit ?? default` |
| `src/web/server.ts` | Bỏ cắt inline MCP `:3213-3215`; `resultHash` (`:3223`) hash trên **full** text (trước: bản cắt 60 000; không có consumer xác minh, chỉ audit/emit) |
| `src/web/server.ts` + `src/bins/headless.ts` | `new ProcessRegistry(processEvents, { ringChars: toolOutputCaptureLimit })` (`:1312` / `:309`) — capture production thật (§2.2) |
| `web/lib/tool-facts.ts` | Nới `TRUNCATION` (`:88`) và `BASH_CUT` (`:250`) nhận marker có path (`truncated N chars; full output saved to <path>]`) |
| `src/capabilities/fs/tools.ts` | **Đổi tối thiểu ở Read**: dành reserve ~256 ký tự cho footer trong budget (`:187`, footer `:205-208`) để output ≤ `outputLimit` — như `searchOutput` đã reserve (`search.ts:309-311`); không thì mọi Read cắt budget vượt trần bởi footer → marker + spill vô nghĩa. Curation khác giữ nguyên |
| `src/capabilities/fs/grants.ts` | `grantedRoots()` (`:153-154`) thêm synthetic read-only root `<hostStorageRoot>/tool-output/<sessionId>` (khi hostStorageRoot là denied root + có session); miễn deny tại `:199`/`:262` (chỉ `intent === 'read'`, chỉ trong dir session mình, một helper chung) — write vẫn deny |
| `src/harness/limits.ts` | 3 field mới + registration |

### 2.4 Tiêu chí chấp nhận

1. Output ≤ `toolOutputLimit` → **byte-identical**, không tạo file (kể cả khi spill bật) — "byte-identical"
   là hợp đồng **pipeline** cho output tool trả về; không phải cam kết Read giữ nguyên cách chia trang
   (Read ≤ limit nhờ reserve §2.3).
2. **Over-cap — định dạng đổi có chủ ý** (mọi nhánh): head + marker + tail theo §2.1.
   Khi spill bật + có `hostStorageRoot` + `sessionId`: file chứa **toàn bộ** text tool trả về
   (nguyên trạng, không trần ghi); marker kèm path tuyệt đối; `read` đọc được path đó (trong
   **session của mình** — session khác → app-storage **deny**, không ask); `write`/`edit` vào đó
   vẫn **deny**.
3. Ghi file lỗi → cùng định dạng over-cap **không kèm path**, call vẫn `ok`.
4. `toolOutputSpill=false` / không `hostStorageRoot` / không `sessionId` → **không ghi file**; over-cap vẫn
   dùng định dạng head+tail (không path); under-cap y nguyên byte.
5. **Bash over-cap: `[exit code: N]` / `[terminated…]` vẫn hiện ở tail** (và marker capture
   `bash.ts:246` cũng còn) — ca chốt riêng, không nhánh nào được nuốt suffix. (Ngoại lệ: `limit`
   cực nhỏ kiểu ca test `limit: 10` → tail chỉ 5 ký tự, suffix có thể cụt — §2.5.)
6. Sweep xoá file cũ hơn retention, giữ file mới, không bao giờ ném (guard `lastSweepAt`,
   unlink ENOENT bỏ qua — an toàn khi nhiều spill chạy song song).
7. Bash firehose: capture production dừng ở `toolOutputCaptureLimit` (registry `ringChars` — §2.2),
   nhánh direct `+ CAPTURE_SLACK`; marker capture giữ nguyên; test firehose cũ vẫn xanh.
8. Symlink/junction **bên trong** `tool-output` trỏ ra ngoài → read bị từ chối (realpath check;
   thay chính thư mục tool-output bằng junction: ngoài phạm vi v1 — cùng lớp `memoryStorageCarveout`).
9. **MCP**: output > cap đi đủ đường window+spill như mọi tool; `mcp/call.resultHash` phản ánh
   full text; không thêm event/trường mới.
10. **UI transcript**: digest vẫn nhận `truncated` cho cả marker có path (tool-facts regex mới) —
    `tests/web/tool-facts.spec.ts` thêm ca.

### 2.5 Test

- Mới: `tests/harness/tool-output-spill.spec.ts` — tương ứng §2.4 (dùng fake tool + tmp host
  storage; ca read-back chạy qua `fsTools`; ca MCP dùng fake tool, không dựng server thật).
- Thêm: `tests/web/tool-facts.spec.ts` +1 ca marker có-path (`truncated N chars; full output saved
  to …`) → digest vẫn `· truncated`.
- **Lưu ý then chốt**: test gọi `bashTool.execute` **trực tiếp** không đi qua `postExecute` ⇒ nhận
  full capture, **không còn marker**. Cập nhật:
  - `tests/harness/processes/review-regressions.spec.ts:11-14` — bỏ assert `truncated 10 chars`;
    đổi sang full capture + `[exit code: 0]`, đổi tên ca cho đúng hợp đồng mới ("tool trả full;
    cửa sổ là việc của pipeline").
  - `tests/harness/processes/review-regressions.spec.ts:37-43` — bỏ assert `truncated` và
    `not.toContain(full)`; giữ `terminated by stop` + full capture.
  - `tests/capabilities/bash.spec.ts:215-220` — đổi `outputLimit: 2_000` → `toolOutputCaptureLimit:
    2_000`; nới trần assert khớp capture 2 000 + `CAPTURE_SLACK` 4 000 + marker (vd `< 6_500`);
    giữ `match(/truncated/)` (marker `output truncated during capture`).
- **Vẫn xanh** (đã đối chiếu): test under-cap (`tests/harness/processes/bash-background.spec.ts:48`, …)
  — byte-identical. Định dạng head+tail chốt bằng unit test `windowOutput` + ca pipeline trong
  `tool-output-spill.spec.ts`.
- Marker không-path giữ nguyên văn (`… [truncated N chars]`) — assert theo mẫu `/truncated/` không
  đổi; con số N cụ thể đổi ở bash (2 ca trên).
- Read reserve footer (§2.3): ca "Read file > budget → output ≤ `outputLimit`, không marker/spill";
  vận hành `toolOutputLimit` thực tế ≥ ~1000 — dưới ~320 có thể vượt nhẹ (≤ ~200) do floor/lineCap,
  chấp nhận.
- Registry `ringChars`: giữ ca hiện có `tests/harness/processes/registry.spec.ts:119-128`
  (`ringChars: 100`) — không cần ca mới; chỉ chạy lại.
- Không cần sửa: `tests/harness/guard-*` (deny giữ nguyên).

### 2.6 Rủi ro & giảm thiểu

- **Rò rỉ qua carve-out**: chỉ read-only, chỉ đúng dir **của session mình**, có realpath check;
  write vẫn deny như mọi path trong data home; spill session khác → hard deny. Thay **chính thư mục**
  `tool-output` bằng junction: ngoài threat model (model không ghi được vào host storage — cùng lớp
  `memoryStorageCarveout`).
- **Tăng dung lượng đĩa**: retention 7 ngày + sweep; spill ghi **nguyên trạng** (marker trung thực).
  Trần thực tế: bash registry = `toolOutputCaptureLimit` (sau plumb §2.2), MCP ≤ ~2MB (`src/harness/mcp/limits.ts:7,9` —
  ~1MB/frame, ~2MB/SSE); hạ bằng limit/retention. Hook PostToolUse nay nhận `tool_response` tới
  ~2MB (`server.ts:2312-2340`) — trước đây tool đã tự cắt ≤ ~60K nên hook nhận bấy nhiêu, nay tới
  trần capture; chấp nhận. Panel process-detail (`server.ts:5583-5588`, workbench) cũng trả tới
  `ringChars` (~1MB/proc) — chấp nhận, hạ chung bằng `toolOutputCaptureLimit`.
- **Đổi mặc định (spill bật)**: cố ý — đây là mục chữa mất dữ liệu; có opt-out
  `toolOutputSpill=false`.
- **Thứ tự hook**: hook thấy full text (trước spill) — ghi vào docs của `tools/post-execute`.
- **Đổi định dạng over-cap**: thay đổi quan sát được (thêm tail, marker chuyển vào giữa) kể cả
  khi spill off — chấp nhận có chủ ý để bảo toàn suffix; test cập nhật theo §2.5.
- **Đọc file spill rồi spill tiếp** (§2.1.5): chain hiếm, bounded, retention dọn — chấp nhận.
- **`resultHash` của MCP đổi input** (full text thay vì bản cắt 60 000): audit đầy đủ hơn; đã rà
  không có consumer xác minh hash (chỉ emit vào `mcp/call` + type hiển thị web).
- **Cắt theo UTF-16 code unit**: window có thể chẻ đôi surrogate pair ở mép cắt — chỉ mỹ quan;
  file spill nguyên vẹn.

---

## 3. HC-2 — Retry seam: event `llm/retry`

### 3.1 Thiết kế

1. **Event mới** (khai báo cạnh `llm/stream`, `src/harness/llm/service.ts:16`):

   ```ts
   'llm/retry'(payload: {
     readonly sessionId: SessionId
     readonly turnId: TurnId
     readonly stepId: StepId
     readonly kind: 'retry' | 'reask'      // retry=transient; reask=bỏ step hỏng, step id mới
     readonly attempt: number              // lượt vật lý vừa hỏng
     readonly nextAttempt: number
     readonly reason: string               // ProviderError['reason']
     readonly message: string
     readonly transient: boolean
     readonly retryAfterMs?: number
     readonly provider?: string
     readonly model?: string
   }): Promise<{ readonly retry?: false; readonly delayMs?: number } | undefined>
   ```

2. **Semantics**: phát **serial** ngay trước khi chờ backoff, chỉ khi retry/re-ask **sẽ** xảy ra:
   nhánh retry sau `owner.canRetry` (`request-lifecycle.ts:110-112` — đã gồm `attempts < maxAttempts`);
   nhánh reask sau `discardBudget` **và còn attempt kế** (`owner.attempts < owner.policy.maxAttempts`,
   `:92-93`) — không thì vòng kế ném ở `consume()` (`:104`), không phát event; §3.2.6.
   - `undefined` → hành vi cũ **và nhường listener sau**; object bất kỳ (kể cả `{}`) là **quyết
     định cuối** của chuỗi (bail semantics) → `{}` = hành vi cũ nhưng chặn listener sau.
   - `{ retry: false }` → không retry; **`assertLive()` rồi ném lỗi gốc** (turn/error như cũ;
     Stop race thắng — như mẫu `:856`/`:867`).
   - `{ delayMs }` → truyền làm tham số `retryAfterMs` của `owner.backoff` (đường deterministic,
     clamp `[0, 30_000]` — đúng như retry-after hiện có, không jitter; check `delayMs !== undefined`
     — `0` là giá trị hợp lệ).
   - `ctx.serial` (`kernel/events.ts:171-177`) **không** nuốt lỗi listener và **dừng chuỗi** tại
     listener ném (listener sau không chạy — khác `undefined`): điểm phát bọc `try/catch` để retry
     mặc định vẫn xảy ra.
   - `attempt`/`nextAttempt` khớp `model/attempt` facts cho **cả hai kind**: `nextAttempt =
     attempt + 1` — counter thuộc `owner` (`agent.ts:711`, một owner cho cả `step()`) **không** reset
     khi reask đổi step; `kind` + `stepId` phân biệt ngữ nghĩa (reask: `stepId` = step vừa bỏ).
3. **Điểm phát**: `agent.ts:856` (kind `reask`), `agent.ts:867` (kind `retry`); cùng seam cho
   compaction stream host (`web/server.ts:1698`, `retryingCompactionStream` — không phải preview)
   là tuỳ chọn, cùng payload shape.
4. Không đổi: ngân sách attempt (≤ 4), cap retry-after 30s, schedule backoff.
5. Đường squeeze (`contextExceeded`) **không chờ backoff** nên không phát event — giữ nguyên.

### 3.2 Tiêu chí chấp nhận

1. Không listener → **0 event** + số attempt/khoảng delay **giống hệt trước** (so khoảng jitter).
2. `{ retry: false }` → không backoff, lỗi nổi lên như cũ.
3. `{ delayMs: X }` → chờ đúng `min(30_000, max(0, X))`, không jitter.
4. Listener ném → chuỗi dừng tại đó (listener sau không chạy — khác `undefined`, `events.ts:172-174`)
   nhưng retry mặc định vẫn xảy ra.
5. Event phát **đúng một lần** cho mỗi lần chờ; `attempt`/`nextAttempt`/`reason` khớp
   `model/attempt` facts trong log.
6. Retry **không** xảy ra (hết attempt / lỗi không transient) → **không** phát event.

### 3.3 Test

- `tests/harness/agent-loop.spec.ts` (+7 ca, harness `flaky` + fake timers sẵn có: payload retry ·
  payload **reask** (provider yield-partial rồi throw transient — mẫu `:460-467`; bắt buộc vì
  `flaky` fail **trước** yield nên không chạm nhánh reask) · veto · delay kể cả `X=0` ·
  không-phát-khi-không-retry (kể cả reask attempt-cuối — gate §3.1.2) · không-listener (0 event) ·
  listener ném).

---

## 4. HC-3 — `Agent.whenIdle()`

### 4.1 Thiết kế

1. Thêm `Agent.whenIdle(): Promise<void>` — resolve khi **hết busy period hiện tại**, kể cả
   successor do input đến trong microtask gap (`agent.ts:334-342`); resolve ngay (microtask) nếu
   đang idle.
2. **Không đổi contract của `run()`** (v1 định đổi thành join — đã bỏ): `run()` vẫn trả về ngay
   khi đang chạy như `agent.ts:293`. `whenIdle()` là API mới duy nhất — **không call-site host nào
   phải sửa**.
   - Cơ chế: đếm **run-depth** quanh thân `run()` — tăng sau các guard sớm (`agent.ts:290-293`:
     admission/uncertain/busy đều không tăng), giảm trong `finally` bao trọn thân `:296-343` kể cả
     khối recheck `:340-342`; waiter settle khi depth về 0.
   - Đệ quy `await this.run()` giữ nguyên — không cần refactor vòng lặp nội bộ.
3. Waiter luôn **resolve**, không reject (kể cả run ném / poison / admission đóng); trạng thái
   thật vẫn đọc qua `agent.status`/`session.poisoned` như hiện có.
4. Ngữ nghĩa giữ nguyên: `stop()` → input còn lại **không** tự chạy; `steer()` → successor chạy
   ngay và `whenIdle()` đợi hết successor.
5. (Tương lai, ngoài scope): join trên chính `run()` nếu host cần — khi đó mới phải gộp busy
   period thành một promise.

### 4.2 Tiêu chí chấp nhận

1. Idle → `whenIdle()` resolve ngay.
2. Đang chạy → resolve sau khi turn chain + successor (nếu có) xong.
3. `stop()` khi đang chạy → resolve sau khi run dừng; input còn trong queue **vẫn còn**.
4. `steer()` → `whenIdle()` resolve sau khi successor (steered) hoàn tất.
5. Run ném (storage/provider) → waiters resolve, không treo.
6. Nhiều waiter → tất cả resolve.
7. `run()` giữ **nguyên** chữ ký + hành vi (kể cả trả về ngay khi busy) — không call-site nào sửa.

### 4.3 Test

- Mới: `tests/harness/agent-when-idle.spec.ts` (7 ca trên, fake provider như `agent-loop.spec.ts`).
- Tùy chọn follow-up (ngoài scope bản này): thay **branch-check** `busy` ở `web/server.ts:1459,
  9736-9750` bằng `whenIdle()` — đổi hành vi dispatch (nối **sau** busy period) + latch `'cancelling'`
  (`busy === true` nhưng depth 0) cần xử riêng khi làm.

---

## 5. HC-4 — Permission rule theo resource + persisted always-allow

> Mục này **cần chốt §5.5 trước khi code**; thiết kế dưới là sketch đã cân nhắc tương thích.

### 5.1 Shape

```ts
export interface PermissionRule {
  readonly id?: string         // host cấp khi persist — đủ để remove(id); rule từ config không cần
  readonly tool: string        // tên canonical, 'mcp__server__*', hoặc '*'
  readonly pattern?: string    // resource pattern kiểu '*'; chỉ áp cho tool có resource
  readonly mode: ApprovalMode  // 'allow' | 'ask' | 'deny'
}
```

- `PolicySource` mở rộng: `readonly PermissionRule[] | Record<string, ApprovalMode> | (() => …)`.
- **Record shorthand giữ nguyên tương thích**: expand nội bộ thành mảng theo thứ tự
  `['*', 'mcp__server__*'…, exact…]` để last-match-wins tái lập đúng precedence cũ
  (exact > server wildcard > global star).
- Resource extraction thuần per-tool (registry nhỏ cạnh `resolution.ts`):
  fs tools → `args.path` (đúng như gate hiện tại dùng, `tools/service.ts:319`); Bash →
  `args.command`; ApplyPatch cần map riêng nếu muốn áp rule theo path; không nhận diện → rule có
  `pattern` **không** áp.
- Pattern: **một wildcard `*`** trên chuỗi đã chuẩn hoá (path: resolve + case-fold trên win32;
  command: nguyên văn — **không** shell-parse ở v1, ghi rõ giới hạn vào docs).

### 5.2 Resolution (một hàm thuần, dùng chung initial/pending/final-gate)

`resolvePermission(policy, tool, { call? })`:
1. Lọc rule khớp `tool` (exact/mcp-wildcard/`*` — như cũ).
2. Rule **có** `pattern` chỉ khớp khi resource trích được và pattern khớp.
3. Rule khớp **cuối cùng** thắng; không rule nào → `defaultMode` (như cũ).
4. `yolo` và blocklist Bash giữ nguyên ngữ nghĩa (yolo không nâng `deny`).
5. **Thứ tự hiệu lực = `[...persisted, ...configured]`** — rule **configured thắng persisted**
   (last-match-wins): "Always allow" ghi lúc runtime **không** vượt được `deny` viết trong config;
   thêm/xoá persisted rule phải bump revision (§5.3).

### 5.3 Persisted "always allow"

- Seam host-provided trên approval policy (giống `ApprovedPathResolver`):
  `load(): Promise<PermissionRule[]>`, `add(rule)`, `remove(id)` — host (web) lưu **per workspace**
  (file trong app storage như store guard hiện có).
- UI trả lời approval thêm lựa chọn **"Always allow (workspace này)"** → ghi rule
  (`tool` + `pattern` = resource của call vừa bị hỏi).
- Mọi thay đổi rule gọi `tools.bumpPolicyRevision()` (`tools/service.ts:142-144`) — revision đã
  được ghi vào `tool/call` và final-gate dùng lại cùng resolver.

### 5.4 Tiêu chí chấp nhận

1. Bảng regression: policy dạng Record cũ → kết quả **y hệt** với mọi tổ hợp name/wildcard.
2. Rule `{ tool: 'Write', pattern: '<ws>/**', mode: 'allow' }`: chỉ cho Write trong workspace,
   Read/Write ngoài vẫn theo default; rule không pattern áp toàn tool.
3. Last-match-wins theo thứ tự mảng; `deny` luôn thắng `yolo`.
4. Persisted allow **không** vượt config deny (thứ tự `[...persisted, ...configured]`, §5.2.5).
5. Rule persist qua restart; thêm/xoá rule bump revision (assert trên `tool/call.policyRevision`).
6. Final-gate từ chối đúng khi rule bị xoá giữa chừng (đã có cơ chế — chỉ cần coverage).

### 5.5 Câu hỏi mở (chốt trước khi code)

1. Pattern syntax: tự viết `*`-only hay dùng glob đầy đủ? (đề xuất: `*`-only, đỡ phụ thuộc).
2. Nơi persist: workspace settings JSON, session store, hay file riêng `permissions.json`?
3. Resource cho MCP tools: name-level là đủ hay cần arg nào?
4. Bash command pattern: chấp nhận rủi ro "prefix match" (vd `git *` khớp `git push --force`)?
   Hoặc bắt buộc pattern toàn chuỗi? (đề xuất: toàn chuỗi + cảnh báo trong UI).
5. UI copy + thứ tự hiển thị rule.

---

## 6. Ngoài phạm vi (giữ nguyên trạng thái)

- **Native provider compaction** (`route/client.ts#canCompact` của opencode) — chỉ khi target hỗ trợ.
- **Instruction epoch baseline** — dnt đã cache-aware ở mức nền (`context/environment.ts:1-14`,
  `[sent …]` bất biến); chưa cần.
- **Run-coordinator đầy đủ** (doorbell/claim/interrupt-awaitSettlement) — bản này chỉ lấy
  semantics quan sát được (HC-3).
- Sampling fields, cache breakpoint `cache_control` — vẫn theo `261016-spec-provider-resilience-cli.md` §10.
- Provider breadth/OAuth/models.dev, SDK/protocol typing, snapshots/undo, worktrees,
  WebFetch/WebSearch, managed org policy — theo `261016-gap-vs-opencode.md` §11.
- Tăng ngân sách retry (>4), nới cap retry-after (>30s), jitter schedule khác.

---

## 7. Thứ tự thực hiện & ước lượng

| Bước | Hạng mục | Lý do thứ tự |
|---|---|---|
| 1 | **HC-2** (S) | Nhỏ, độc lập, mở đường quan sát retry cho mọi thứ sau |
| 2 | **HC-1** (M) | Giá trị cao nhất (chữa mất dữ liệu); cần review kỹ carve-out grants |
| 3 | **HC-3** (S) | Nhỏ, độc lập; giảm polling ở host sau này |
| 4 | **HC-4** (M–L) | Chỉ code sau khi chốt §5.5 |

Định nghĩa "xong" cho mỗi mục: code + test mục §tương ứng + `tsc --noEmit` cả hai tsconfig +
không hồi quy bộ test hiện có + ghi chú triển khai vào `plans/261016-implementation-report.md`
(mục mới).

---

## 8. Phụ lục — đối chiếu opencode (đã kiểm chứng)

| Cơ chế opencode | Ref (opencode v2) | dnt hiện tại | HC xử lý |
|---|---|---|---|
| Tool output spill + retention + cleanup | `core/tool-output.ts:13-16,67-118,129-138` | cắt inline, mất phần vượt | HC-1 |
| Wiring spill vào mọi tool result | `runner/step.ts:127` | không có | HC-1 |
| Retry schedule + plugin veto + RetryScheduled | `runner/retry.ts:45-56,64-92,104-110` | backoff có, không event/hook | HC-2 |
| Timeout retry tách trần | `runner/retry.ts:60-62` | chung trần 4 attempt (giữ nguyên) | Non-goal |
| run/awaitIdle/wake (join + successor) | `run-coordinator.ts:124-145,171-176` | polling `busy` | HC-3 |
| `evaluate` last-match-wins + Wildcard resource | `core/permission.ts:87-91`, `v1/config/permission.ts:8` | name-level, precedence cố định | HC-4 |
| "always" → lưu rule per project | `core/permission.ts:299-318`, `permission/saved.ts:22-33` | chỉ session grant cho path | HC-4 |
