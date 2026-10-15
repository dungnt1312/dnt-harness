# Spec: Đếm context theo cách ZCode (provider usage là số chính)

- Ngày: 2026-10-15 20:00 +07:00. Base: `main` @ `8be50fd`.
- User duyệt hướng: "Làm tính context giống zcode đi" (20:00), sau báo cáo `plans/reports/research-261015-1955-zcode-context-counting.md`.
- Spec này **sửa đổi** `plans/261014-1328-context-accounting/spec.md`: bỏ non-goal "giữ estimator chars/4" ở §2, và nới invariant §4.3 ("Reported count không thay budget.usedTokens/breakdown") như ở §3 dưới đây. Các invariant khác giữ nguyên.

## 1. Vấn đề

Ước tính chars/4 thấp hơn provider ~1.78× ở phiên thật (`session-mv963felwbc8zp`). Builder dùng ước tính này cho trim, microcompact, áp lực auto-compact (0.85) và meter. Hệ quả: meter nhảy 360k (est) ↔ 645k (reported); auto-compact 85% ước tính ≈ 150% thực tế, nên provider từ chối trước khi compact chạy.

## 2. Cách ZCode làm (nguồn `/tmp/zcode-research`, commit `aac4755`)

- Số chính = usage provider của request gần nhất + ước tính phần message mới (`runtime/methods/compact.ts:316`). Không có usage → ước tính toàn bộ.
- Auto-compact dùng số này, kèm nguồn `provider_usage|estimate` (`compact/policy.ts:103`).
- Ước tính: `ceil((cjk*2 + other) / 3)` với `cjk` = ký tự `[一-鿿]` (`context/utils.ts:12`).

## 3. Thiết kế cho dnt-harness

### 3.1 Estimator (`src/harness/context/budget.ts`)
`estimateTokens(text) = ceil((cjk*2 + (len - cjk)) / 3)`, `cjk` = số ký tự khớp `/[\u4e00-\u9fff]/g`. Áp cho mọi chỗ gọi hiện có. Thêm hằng `TOKEN_ESTIMATOR = 'c3'` và ghi vào mọi manifest mới ở `budget.estimator`.

### 3.2 Calibration (pure, `src/harness/context/calibration.ts`)
```ts
export interface ContextCalibration { readonly contextId: string; readonly reportedInputTokens: number; readonly estimatedTokens: number }
export function latestCalibration(events: readonly SessionEvent[], target: { readonly model?: string; readonly provider?: string }): ContextCalibration | undefined
```
Quét log từ cuối về đầu:
- Gặp `compaction/end` thành công (không `error`, `summary` khác rỗng, `contextEffect !== 'unchanged'`) trước khi tìm được attempt → trả `undefined` (sau compact không dùng usage cũ, giữ invariant §4.4 spec cũ).
- Attempt hợp lệ: event `model/attempt|execution/uncertain|execution/reconciled`, `fact.state !== 'start'`, `isValidContextId(fact.contextId)`, `isValidTokenUsage(fact.usage)`, `usage.inputTokens > 0`.
- Ghép với `context/manifest` cùng `contextId` trong log. Bỏ qua (tiếp tục quét) nếu không có manifest, `manifest.budget.estimator !== TOKEN_ESTIMATOR`, hoặc `manifest.budget.usedTokens < MIN_CALIBRATION_BASE_TOKENS` (1 000). Nếu model/provider của manifest khác `target` (khi cả hai có giá trị) thì **dừng và trả `undefined`**: đổi model thì measurement gần nhất không còn áp được, không lùi về measurement cũ hơn.
- Kết quả: `{ contextId, reportedInputTokens: usage.inputTokens, estimatedTokens: manifest.budget.usedTokens }`.

**Ruling 2026-10-15 20:40 (sau review Opus, C1/I1/I2):** dùng **tỉ lệ**, không dùng offset tuyệt đối. `ratio = clamp(reported / estimatedTokens, 1, 3)` (cận dưới 1 sau re-review N1: calibration chỉ siết, không nới — report thấp hơn ước tính là đo không chuyển được: ảnh tính phẳng 1 200, gateway bỏ cached khỏi prompt_tokens). Lý do: sai số chars/N tỉ lệ với nội dung (phiên thật ~1.78×). Offset tuyệt đối lấy từ một request đã bị trim làm microcompact bật/tắt xen kẽ giữa các step, cộng dồn với squeeze thành `ContextBudgetError` chắc chắn, và phạt nhầm request nhỏ hơn base. Với tỉ lệ, `estimate_now × ratio` vẫn bằng `base + delta×ratio` khi chỉ có message mới (gần với ZCode `base + delta`), còn khi trim hay squeeze thì mọi thứ co giãn cùng nhau. Cái giá nếu sai: phần delta mới bị nhân ratio thay vì ước tính thuần, tức là dè dặt hơn ZCode một chút.

### 3.3 Builder (`buildContext`, không áp cho `buildContextPreview`)
- Input mới `calibration?: ContextCalibration`. Preview luôn bỏ qua nó.
- `ratio = calibration ? calibrationRatio(calibration) : 1`.
- Mọi phép so với budget dùng `ceil(used × ratio)`: ngưỡng microcompact (`> available * MICROCOMPACT_PRESSURE`), mọi bước `used > available`, và `ContextBudgetError(ceil(used × ratio), available)`. Thứ tự trim không đổi.
- `usedTokens`, `preTrimTokens`, `breakdown` vẫn là ước tính thuần (breakdown cộng bằng usedTokens, validator giữ nguyên).
- Manifest thêm:
```ts
budget.estimator: 'c3'
budget.measured: {
  readonly source: 'provider_usage' | 'estimate'
  readonly tokens: number         // ceil(usedTokens × ratio): số dự kiến gửi đi
  readonly preTrimTokens: number  // ceil(preTrimTokens × ratio): dùng cho áp lực compact
  readonly baseContextId?: string // khi source = provider_usage
  readonly ratio?: number         // khi source = provider_usage
}
```
Không có calibration: `source: 'estimate'`, `tokens = usedTokens`, `preTrimTokens = preTrimTokens`.

### 3.4 Host (`src/web/server.ts`)
- `assembleRequest`: khi không phải preview, truyền `calibration: latestCalibration(events, { model: effective.model, provider: effective.provider })`.
- Helper dùng chung, browser-safe, đặt trong `calibration.ts`: `pressureTokensOf(budget) = budget.measured?.preTrimTokens ?? budget.preTrimTokens ?? budget.usedTokens`. Dùng cho precompute (`startCandidate`, ~dòng 1896). Ngưỡng 0.85 giữ nguyên.
- Auto-compact cuối turn (`agent/turn-settled`): nếu request cuối của turn đã có usage riêng (calibration mới nhất có `contextId` trùng manifest), dùng `ceil(preTrimTokens × ratio của chính nó)`; nếu không thì `pressureTokensOf`.
- `measureCheckpoint` `tokensBefore`: `reported ?? before.budget.measured?.tokens ?? before.budget.usedTokens`; basis giữ nguyên quy tắc hiện có (`reported` chỉ khi có usage thật).

### 3.5 Web meter
- `web/lib/types.ts`: thêm `estimator?` và `measured?` vào `ContextManifestView.budget`.
- `contextFill`: `used = usage.last.inputTokens ?? budget.measured.tokens ?? budget.usedTokens`. Thêm `basis: 'reported' | 'calibrated' | 'estimated'` (`calibrated` khi chưa có usage và `measured.source === 'provider_usage'`). Giữ `estimated` = `basis !== 'reported'` cho tương thích.
- `policyPressure` dùng `pressureTokensOf`.
- `ContextMeter`/`ContextPanel`/`MessageParts`: nhãn "Last request" hiển thị `reported` / `reported + new (est)` / `estimated`. Mọi text "chars/4" đổi thành "chars/3" (cả `McpPanel`, `SystemPromptsPanel`).

## 4. Acceptance criteria

- AC-1: `estimateTokens('abc')=1`, `('abcd')=2`, `('中文')=2` (=ceil(4/3)), chuỗi rỗng = 0.
- AC-2: `latestCalibration` trả attempt mới nhất hợp lệ; bỏ qua attempt không usage, `inputTokens=0`, không có manifest, estimator khác, model khác; trả `undefined` khi có compaction thành công sau attempt cuối.
- AC-3: Log mô phỏng tỉ lệ 1.78 (manifest usedTokens 100 000, reported 178 000) → request kế tiếp có `measured.source='provider_usage'`, `measured.tokens = ceil(usedTokens_new × 1.78)`, `measured.ratio = 1.78`.
- AC-4: Ratio đẩy `ceil(used × ratio)` vượt `available` thì builder trim (microcompact/drop) dù ước tính thuần còn dưới; `ContextBudgetError` báo số đã calibrate. Microcompact giữ ổn định giữa các step; squeeze level 3 vẫn build được.
- AC-5: Auto-compact chạy khi `measured.preTrimTokens / availableTokens >= 0.85` dù ước tính thuần < 0.85; không chạy khi measured < ngưỡng.
- AC-6: `buildContextPreview` luôn `measured.source='estimate'`, kể cả khi được truyền calibration.
- AC-7: Meter: chưa có usage + có calibration → hiển thị `measured.tokens`, basis `calibrated`; có usage → `reported`. Không có cả hai → `estimated`.
- AC-8: Manifest legacy (không `measured`/`estimator`) vẫn đọc được: pressure và meter rơi về hành vi cũ.
- AC-9: `pnpm run typecheck`, test bị ảnh hưởng, `pnpm test`, `pnpm run build:web` pass (trừ flaky đã biết).

## 5. Non-goals
Không thêm tokenizer/dependency; không đổi thứ tự trim, retention, `automaticCompactionPressure` (0.85), `MICROCOMPACT_PRESSURE`, squeeze factors; không reactive compact; không sửa log cũ; không gọi provider trả phí.

## 6. Rủi ro
- chars/3 làm phiên chưa có usage trim/compact sớm hơn ~33% so với trước: chấp nhận, gần thực tế hơn.
- Offset âm (estimator đếm dư) làm builder nới hơn ước tính: đúng theo số provider; squeeze vẫn là lưới an toàn.
- Usage từ gateway sai → offset sai đến request kế tiếp. Chấp nhận như ZCode.
