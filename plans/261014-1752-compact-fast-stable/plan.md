# Compact nhanh và ổn định — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. TDD bắt buộc: viết test, chạy thấy đỏ đúng lý do, rồi mới viết code.

**Goal:** Mọi compaction có turn hoàn tất sạch đi đường 1 request; đường 1 request không fail vì summary dài; fold còn lại chạy song song, có tiến độ và số liệu đo.

**Architecture:** Thêm `reconstruct` dựng snapshot từ log bằng chính pipeline assembly (server tách hàm assemble thuần khỏi interceptor `agent/context`). Generator dùng chung bước nén bản nháp với fold. Fold chunk song song + 1 request gộp. `compaction/job` mang thêm `progress` và tổng `requests/usage`.

**Tech Stack:** TypeScript (Node 24), vitest, React (web/), pnpm.

**Spec:** `plans/261014-1752-compact-fast-stable/spec.md`

## Global Constraints
- Dùng pnpm. Chạy test liên quan trước; sau mỗi task chạy `pnpm run typecheck`. Task đụng `web/` chạy thêm `pnpm run build:web`.
- Không gọi model thật; không sửa `~/.dnt-harness/data`; không restart/deploy; không push.
- Không đổi `automaticCompactionPressure` (0.85) hay bật precompute.
- Giữ: PreCompact chạy đúng 1 lần trước model; Stop → `409 {cancelled:true}`; adoption kiểm identity; `assessProjection` không được nới.
- `MAX_COMPACTION_SUMMARY_CHARS` = 24 000; bản nháp tối đa 96 000; mục tiêu nén 12 000 rồi 8 000; `MAX_INPUT_CHARS` fold = 200 000; đồng thời fold tối đa 4.
- Commit trên branch `feat/compact-fast-stable` (worktree `.worktrees/compact-fast-stable`), message kiểu conventional (`feat(compaction): …`, `test(...)`).
- Flaky có sẵn, không phải lỗi task: `server-g1 > steer`, `path-scope-guard`, `server-g4`, `project-git-sync`, `server-g2`, `server-g5 MCP schema`.

## Review Focus
1. Reconstruct sau một turn bị Stop: cutoff phải là turn `completed` trước đó, turn bị Stop giữ nguyên văn sau checkpoint.
2. Reconstruct không được để lại dấu vết (manifest, body, meter, capture) — đây là request không gửi đi.
3. Câu trả lời cuối không bị lặp hai lần trong request tóm tắt.
4. Fold song song: hủy giữa chừng phải dừng mọi chunk; thứ tự bản tóm tắt khi gộp phải đúng thứ tự nguồn.
5. Event `compaction/job` cũ (không có `progress/requests/usage`) vẫn render được.

---

### Task 1: Generator — nén bản nháp dài thay vì fail (dùng chung với fold)

**Files:**
- Create: `src/web/compaction-condense.ts`
- Modify: `src/web/compaction-generator.ts`, `src/web/llm-summarizer.ts`
- Test: `tests/web/compaction-generator.spec.ts` (đã có — thêm case), `tests/web/llm-summarizer.spec.ts` hoặc spec summarizer hiện có (tìm bằng Grep `createCompactionSummarizer` trong `tests/`)

**Interfaces:**
- Produces: `condenseDraft(draft: string, options: { stream: StreamFn; pair?: { providerName: string; model: string }; signal: AbortSignal; recordUsage?: (u: TokenUsage) => void }): Promise<string>` — gửi tối đa 2 request ĐỘC LẬP (chỉ 1 user message chứa bản nháp, không prefix hội thoại), mục tiêu 12 000 rồi 8 000 ký tự, kết quả ≤ 24 000, bắt buộc 1 completion `stop`, không tool; lỗi nếu sau 2 lần vẫn > 24 000. Prompt nén = prompt `repair` hiện có trong `llm-summarizer.ts` (chuyển nguyên văn sang đây).
- `llm-summarizer.ts` dùng `condenseDraft` thay cho vòng `attempt 1..2` hiện tại (hành vi không đổi: nháp ≤ 96 000, rồi nén).

**Hành vi generator mới (`generateCompaction`):**
- Attempt 1: chấp nhận text tới 96 000 ký tự (không còn đánh dấu overflow ở 24 000). Nếu > 96 000 → lỗi `compaction draft exceeds 96000 characters`.
- Nếu `finishReason === 'length'` ở attempt 1: re-ask 1 lần như hiện tại (cùng prefix, `HARD CONSTRAINT`), đọc tối đa 24 000.
- Nếu text ≤ 24 000 → xong. Nếu > 24 000 → `condenseDraft(text, { stream, pair: { providerName: snapshot.request.providerName, model: snapshot.request.model }, … })`.
- Deadline chung bao tất cả; usage mọi request đều được `recordUsage`.
- Hiện `runAttempt` throw khi `finishReason !== 'stop'` — đổi để trả về `{ finish: 'length' }` cho trường hợp length thay vì throw.

**Tests (viết trước, thấy đỏ):**
- generator: model trả 30 000 ký tự + stop → có đúng 2 request (handoff + 1 nén); request nén chỉ có 1 message user, chứa bản nháp, không chứa `[compaction-handoff]`; summary cuối là output nén.
- generator: nén lần 1 vẫn 20 000 (> 12 000 mục tiêu nhưng ≤ 24 000) → chấp nhận, 2 request tổng.
- generator: nén 2 lần đều > 24 000 → lỗi, không checkpoint (qua host test hiện có hoặc generator).
- generator: attempt 1 `finishReason: 'length'` → re-ask cùng prefix có `HARD CONSTRAINT`.
- generator: 100 000 ký tự → lỗi 96000.
- summarizer fold: test hiện có vẫn xanh (hành vi giữ nguyên).
- Sửa test cũ `records the usage of an attempt whose answer was rejected` trong `tests/web/compaction-host.spec.ts` nếu cần cho đúng hành vi mới (24 001 ký tự giờ được nén, không còn bị từ chối) — giữ ý: usage của mọi attempt được ghi.

**Commit:** `feat(compaction): condense an oversized handoff draft instead of failing`

---

### Task 2: Reconstruct snapshot từ committed log

**Files:**
- Modify: `src/web/server.ts` (tách assembly; nối `reconstruct`), `src/web/compaction-host.ts` (`reconstruct` thành async), `src/web/compaction-capture.ts` (nếu cần cho `reconstructSnapshot`)
- Test: `tests/web/server-compaction-effective.spec.ts`, `tests/web/compaction-host.spec.ts`

**Interfaces:**
- `HostDeps.reconstruct: () => Promise<EffectiveCompactionSnapshot | undefined>` (đổi từ sync). Host chỉ gọi nó khi exact không dùng được (`chooseCompactionSource` được gọi lại với `reconstructed` sau khi exact bị loại — hoặc host tự kiểm exact trước; giữ `chooseCompactionSource` thuần).
- Trong `server.ts`: tách thân interceptor `agent/context` thành hàm `assembleRequest(input: { scope: AgentScope; events: readonly SessionEvent[]; toolSchemas: readonly ToolSchema[]; signal?: AbortSignal; sideEffects: boolean })` trả `{ assembled, request }`. Interceptor gọi với `sideEffects: true` (giữ nguyên mọi side effect hiện có: lastManifests, manifestTurns, completedRequests/pendingCompactionPrefixes, sessionUsage, context/body, context/manifest, captures.arm). Reconstruct gọi với `sideEffects: false` — không side effect nào.
- Tool schemas cho reconstruct: lấy từ `kernel.ctx.get('tools')?.schemas()` (cùng nguồn `agent.ts:660`).
- Cutoff: turn mới nhất sau checkpoint đứng có `turn/end.reason === 'completed'`, không `step/abandoned`/`execution/uncertain` bên trong, assistant cuối không tool call. Events đưa vào builder = `committedEvents.filter(e => e.seq <= cutoff)`. Bỏ message cuối (câu trả lời cuối) khỏi `request.messages` và khỏi `projection.sources` trước khi gọi `reconstructSnapshot` (nó tự thêm lại). Identity = `compactionIdentity(entry, requestPrefixHash(request))`.
- Mọi lỗi trong reconstruct (ContextBudgetError, projection không hợp lệ) → `undefined` (fold), không throw.

**Tests (viết trước):**
- server: session tạo bởi server có `compactionEffectiveEnabled: false` (không snapshot), restart với effective bật → `/compact` trả `200`, `path: 'reconstructed'`, đúng 1 request có `[compaction-handoff]`, không request fold (`LEGACY_MARK`). Thay test hiện có "a session whose turns were never captured just compacts…" (đang kỳ vọng `recovery`) cho đúng hành vi mới; giữ một test fold riêng cho trường hợp reconstruct không được (vd mode history không phải `compact`, hoặc builder phải bỏ lịch sử chưa tóm tắt — dùng budget nhỏ qua `modelSettings.contextTokens` nếu khả thi, nếu không thì test ở tầng host với `reconstruct` trả undefined).
- server: turn 1 completed, turn 2 bị Stop (cancelled) → `/compact` đi `reconstructed`, `coversSeq` = turn/end của turn 1; request tóm tắt không chứa nội dung user của turn 2; request kế tiếp sau compact vẫn chứa turn 2 nguyên văn.
- server: reconstruct không để lại dấu vết: số event `context/manifest` và `context/body` trong log không đổi giữa trước và sau phần reconstruct (chỉ thêm compaction/job/start/end/restoration).
- server: request tóm tắt không có câu trả lời cuối hai lần (đếm message assistant có nội dung = answer).
- host: exact hợp lệ → `reconstruct` KHÔNG được gọi.
- Sửa test `after a restart with the sidecar GONE…` → giờ kỳ vọng `reconstructed` (1 request).

**Commit:** `feat(compaction): rebuild the summary request from the log when no snapshot was captured`

---

### Task 3: Fold song song + gộp

**Files:**
- Modify: `src/web/llm-summarizer.ts`, `src/harness/context/compaction.ts` (prompt chunk/gộp nếu cần, `SummarizerInput` thêm `onProgress?`)
- Test: spec summarizer hiện có (Grep `createCompactionSummarizer` trong `tests/`)

**Interfaces:**
- `SummarizerInput` thêm `onProgress?: (done: number, total: number) => void`.
- `createCompactionSummarizer(stream, pair, streamOptions)` với pair có model:
  - nguồn (sau neutralize) vừa 1 chunk → y như cũ (1 request + nén nếu > 24 000), `onProgress(1,1)` sau khi xong.
  - > 1 chunk: chia chunk như cũ (`chunkEnd`, capacity tính KHÔNG có `<earlier-summary>`), tóm tắt song song tối đa 4, prompt mỗi chunk = `COMPACT_SUMMARY_PROMPT` + dòng `This is part i of n of one conversation; summarize only this part.` + `<conversation>`; mỗi bản tóm tắt chunk ≤ 24 000 (nén bằng `condenseDraft` nếu dài); `onProgress(done, n)` mỗi khi 1 chunk xong.
  - Gộp: 1 request với `COMPACT_SUMMARY_PROMPT` + seed (nếu có, trong `<earlier-summary>`) + các bản tóm tắt theo thứ tự trong `<conversation>` có đánh dấu `[part i/n]`; kết quả ≤ 24 000 (nén nếu dài). Nếu input gộp > `MAX_INPUT_CHARS` → gộp theo nhóm liên tiếp vừa giới hạn, lặp tới khi còn 1.
  - Hủy: signal truyền cho mọi stream; chunk lỗi → reject toàn bộ (Promise.all), các stream còn lại bị abort qua AbortController chung.
- Không model: không đổi.

**Tests (viết trước):**
- 3 chunk → 3 request chunk chạy đồng thời (stream giả giữ cả 3 cho tới khi đủ 3 đã bắt đầu) + 1 request gộp; request gộp chứa 3 bản tóm tắt đúng thứ tự `[part 1/3]…[part 3/3]`.
- giới hạn đồng thời: 6 chunk → không bao giờ quá 4 request chunk đang mở.
- seed có → request gộp chứa seed trong `<earlier-summary>`; chunk requests KHÔNG chứa seed.
- 1 chunk → đúng 1 request, không có request gộp (giữ hành vi cũ).
- abort giữa chừng → mọi stream đang mở nhận abort, summarizer reject.
- một chunk lỗi → reject, không request gộp.
- `onProgress` gọi `(1,3),(2,3),(3,3)` (thứ tự hoàn thành) và cuối cùng không vượt total.

**Commit:** `perf(compaction): fold transcript chunks in parallel and merge once`

---

### Task 4: Tiến độ + đo đạc trong `compaction/job` và UI

**Files:**
- Modify: `src/harness/session/events.ts` (type `compaction/job`), `src/web/server.ts` (`appendJob`, đếm request/usage, nối `onProgress` vào `legacyBody`/`compactSession`), `src/harness/context/compaction.ts` (`compactSession` chuyển `onProgress` cho summarizer), `web/lib/project.ts`, `web/components/chat/MessageParts.tsx`
- Test: `tests/web/server-compaction-effective.spec.ts` hoặc `tests/web/server-compaction.spec.ts`, `web/lib/project-compaction.spec.ts`, `web/lib/product-ui.spec.tsx`

**Interfaces:**
- `compaction/job` thêm tùy chọn: `progress?: { done: number; total: number }` (stage `generating`), `requests?: number`, `usage?: { input: number; cached: number; output: number }` (stage `ended`).
- Server: mỗi job đếm mọi request model mà compaction gửi (generator, nén, fold, gộp) qua chỗ đang ghi usage (`recordUsage` của host và summarizer của legacy) — dùng một bộ đếm theo job; ghi vào `ended` (kể cả `failed`/`cancelled` khi đã có request).
- Fold: `onProgress(done,total)` → `appendJob({ stage: 'generating', progress })` (legacy path hiện không báo `generating` — báo khi chunk đầu bắt đầu với `{done:0,total}`).
- Projector `web/lib/project.ts`: mang `progress`, `requests` vào item compaction. `CompactionMarker`: running + progress → `Summarizing 3/5`; kết thúc + requests → fact `3 requests` (1 → `1 request`).

**Tests (viết trước):**
- server (scripted provider, fold nhiều chunk): log có `compaction/job` generating với progress tăng dần tới `total`; `ended` có `requests` = số request provider nhận, `usage` = tổng usage scripted.
- server effective 1 request: `ended.requests === 1`.
- projector: event có/không có progress/requests đều project đúng; event cũ không có trường mới không lỗi.
- UI: `Summarizing 2/4` khi running có progress; `3 requests` khi ended có requests.

**Commit:** `feat(compaction): report fold progress and per-job request/usage totals`

---

### Task 5: Docs + kiểm tra cuối

**Files:**
- Modify: `docs/harness.md` (mục "Effective compaction": reconstruct, nén bản nháp, fold song song, progress/requests/usage)
- Test: không có test mới; chạy `pnpm test`, `pnpm run typecheck`, `pnpm run build:web`

**Interfaces:** none.

**Steps:**
- Cập nhật docs đúng hành vi đã làm ở Task 1–4 (không mô tả cái chưa làm).
- Chạy đủ 3 lệnh, ghi kết quả (số pass/fail, tên test fail) vào report.

**Commit:** `docs(compaction): reconstruct, condensed handoff, parallel fold and job totals`
