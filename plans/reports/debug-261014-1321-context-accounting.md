# Kiểm tra luồng tính context

Ngày: 2026-10-14. Source: `main`, HEAD `a41df5e`.
Phạm vi: kiểm tra, không sửa source, không restart server live, không gọi provider trả phí.

## Kết luận

Có lỗi thực sự bên cạnh những khác biệt có chủ ý giữa số ước lượng và số provider báo. Đáng ưu tiên nhất là phép đo sau compact dùng hai baseline khác nhau, có thể đưa đồng hồ về 0 dù context vẫn còn; usage thực và trạng thái đồng hồ sau compact không được phục hồi đúng sau host restart.

## Luồng hiện tại

1. `src/web/server.ts:3482` xác định context window từ override `modelSettings[model].contextTokens`, nếu không thì dùng model catalog.
2. `src/harness/context/budget.ts` ước lượng text bằng `ceil(chars/4)`, ảnh bằng 1.200 tokens/ảnh, schema bằng JSON. Input budget là window trừ 4.096 output reserve và 1.024 margin.
3. `builder.ts:663` lưu `preTrimTokens`, sau đó microcompact/drop optional sources/drop completed turns để fit budget. Manifest lưu `usedTokens` sau trim và breakdown các nguồn ước lượng.
4. `server.ts:3670–3713` cache và ghi durable manifest trước khi dispatch; xóa usage.last cũ.
5. `server.ts:3355` lấy usage từ stream vào map `sessionUsage`; API `/manifest` ghép usage với manifest.
6. `web/lib/format.ts:167` ưu tiên usage.last.inputTokens, fallback usedTokens; mẫu số là toàn window. App refetch khi context/manifest, step/end, step/abandoned, turn/end, compaction/end.
7. Auto compact dùng `preTrimTokens / availableTokens`, không dùng số provider báo hay tỷ lệ ring.
8. `measureCheckpoint` đổi manifest trong RAM sau compact; GET sau restart chỉ lấy manifest gần nhất trong log.

## Phát hiện

### F1 — Cao: compact trừ saving từ history chưa trim khỏi request đã trim

Vị trí: `src/web/server.ts:1517–1537`, `src/harness/context/builder.ts:1113`.

`tokensBefore` là provider input của request cuối hoặc usedTokens sau trim. Nhưng `was - now` do estimateConversationTokens tính là chênh lệch toàn history trước budget trim/microcompact. Với request đã bỏ history, phần saving có thể lớn hơn toàn baseline. `Math.max(0, ...)` chỉ che số âm, không sửa sai baseline.

Probe isolated với history dài 1.100.000 ký tự, usage scripted 120.000 input: preTrim=281.570, final assembly=6.204, compact tokensAfter=0; breakdown vẫn tổng 6.194. Request tiếp theo có estimate=6.715. Đây là số test tổng hợp, không phải đo session live.

Hướng xử lý: dựng/đo lại context sau checkpoint bằng cùng assembly pipeline và current sources; không trừ raw-history saving khỏi request đã trim. Provider-reported count phải giữ gắn với request thực sự đã được đo. Sau compact chỉ có estimate cho đến khi request mới báo usage.

### F2 — Cao: host restart mất reported usage và quay lại manifest trước compact

Vị trí: `src/web/server.ts:3308`, `7399–7431`, `1534`; `3713`.

sessionUsage chỉ trong RAM. Durable context/manifest là bản trước request nên không có usage. GET rehydrate manifest nhưng không rehydrate usage; cũng không áp dụng compaction/end mới hơn manifest để khôi phục meter sau compact.

Probe: live used=120.000 reported, sau restart used=6.560 estimated. Sau compact, live meter=120.087; restart trở lại estimate=6.572 của request trước compact. Không có message mới giữa hai phép đo.

Hướng xử lý: ghi durable request-scoped usage và context state sau compact, replay theo đúng thứ tự/identity. Không dùng usage của request cũ cho context đã compact.

### F3 — Vừa: cùng request, composer và Context/StepInspector dùng hai nguồn

Vị trí: `web/lib/project.ts:688–707`, `web/components/workbench/trajectory.ts:353–358`, `server.ts:3713` và `7426–7431`.

Composer/ContextPanel dùng API manifest có usage ghép từ RAM; marker trong chat và StepInspector dùng durable manifest chỉ có estimate. Không có update usage tương ứng trong projection hiện tại. Probe cùng request cho API=120.000 reported và durable manifest=6.560 estimated.

Hướng xử lý: dùng chung request identity và durable usage để các surface đọc cùng measurement; vẫn phân biệt history của từng request với current context sau compact.

### F4 — Vừa: nhiều usage events trong một stream bị cộng lặp cache totals

Vị trí: `src/web/server.ts:3353–3356`, `9902–9910`.

Mỗi usage event gọi recordUsage và cộng vào totals. Trong khi usageLog ở finally chỉ ghi report cuối. Nếu provider báo cumulative usage nhiều lần, average cache hit rate sai và khác Settings Usage.

Probe một stream báo lần lượt 100.000/50.000 và 120.000/110.000 input/cached. Meter tính 160.000/220.000=72,73%; report cuối đúng là 110.000/120.000=91,67%.

Hướng xử lý: cập nhật last khi nhận report, nhưng fold totals một lần theo report cuối hoặc thay contribution của cùng request. Regression cần kiểm tra cả /manifest lẫn /api/usage.

### F5 — Vừa, khi bật effective compaction: window resolver không đồng nhất

Vị trí: `src/web/server.ts:3487–3493` đối chiếu `1464`, `1573`, `1731`.

Builder đọc per-provider/model contextTokens override. Compaction host, candidate preflight/assessment gọi resolveContextLimit(model) trực tiếp, bỏ qua override. Có thể quyết định fit/refuse theo window khác request/UI.

Xác nhận bằng đọc các call sites; chưa chạy runtime repro cho override. Hai switch effective/precompute mặc định false (`src/harness/limits.ts:100–101`).

Hướng xử lý: dùng một resolver budget/window chung cho cùng effective provider/model pair.

## Khác biệt có chủ ý, không nên sửa bằng ép mọi số bằng nhau

- Trước usage: estimate chars/4; sau usage: provider count. Breakdown luôn là estimates, UI có ghi chú. Vì vậy tổng rows không nhất thiết bằng provider total.
- Ring là request input cuối / toàn model window, không phải toàn session log hay tổng token đã tiêu. Final answer chưa nằm trong input cho đến request tiếp theo.
- Auto compact/precompute dùng pre-trim estimate / usable input budget. Ring dùng post-trim/reported input / toàn window. Có thể ring còn thấp nhưng auto compact đã chạy; khác biệt này được tests chủ ý giữ. automaticCompactionPressure mặc định 0 (tắt).
- Sau đổi model/mode, meter vẫn mô tả request trước; window/budget được tính lại ở request kế tiếp.
- Post-compact breakdown invariant cũng hỏng khi baseline chuyển sang reported: probe total=120.087 nhưng breakdown sum=6.659. Không được gọi bản manifest sửa bằng phép trừ này là cùng một assembly estimate.

## Verification

- `pnpm exec vitest run web/components/composer/context-meter.spec.tsx web/lib/manifest-refresh.spec.ts tests/harness/g3-context.spec.ts tests/web/server-usage.spec.ts tests/web/server-compaction.spec.ts tests/web/server-g3.spec.ts --maxWorkers=1 --no-file-parallelism`: 6 files, 89 tests passed, exit 0.
- `pnpm exec tsx plans/reports/context-probe-261014-1321-accounting.ts`: exit 0; assertions xác nhận F1/F2/F4 và chênh API/durable của F3.
- Existing restart test dùng provider không report usage; existing compaction test provider không report usage; server-usage test chỉ kiểm tra Usage endpoint. Các assertion này không bắt những ca phát hiện ở trên.
- Không chạy full suite/typecheck/build vì không thay production code. Không tuyên bố đã sửa lỗi hoặc đã tái hiện chính session live của user.
- Giữ nguyên các thay đổi có sẵn trong `src/harness/plugins/manifest.ts` và `tests/harness/plugin-containment.spec.ts`.

## Câu hỏi còn mở

Chưa biết biểu hiện user gặp tập trung ở bước đang chạy, sau compact, sau restart, khi xem StepInspector, hay sau đổi model. Các lỗi trên đã có bằng chứng độc lập; cần một session/time hoặc screenshot nếu muốn gắn chính xác với biểu hiện live.
