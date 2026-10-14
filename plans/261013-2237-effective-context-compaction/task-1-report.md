# Task 1 report — Typed projection và source policy

Trạng thái: **DONE_WITH_CONCERNS** (concerns ở cuối). Không commit, không subagent, không gọi live/paid.
Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/effective-context-compaction`.

## Ghi chú về công cụ
- `codebase-retrieval` không có trong bộ tool của worker này → ghi nhận, dùng Read/Grep/Glob có phạm vi hẹp (builder.ts, events.ts, compaction.ts, tests liên quan, spec §4–5).

## File thay đổi
| File | Thay đổi |
|---|---|
| `src/harness/context/compaction-projection.ts` (mới) | Types `ProjectionLoss`, `CompactionProjection`, `Eligibility`; `assessProjection`; `compactionSeedHash`; `COMPACTION_POLICY_VERSION`; `isReproducibleReadTool`; `isSuccessfulToolResult`. |
| `src/harness/context/builder.ts` | `AssembledContext.compactionProjection`; gắn `sources` tại lúc dựng `messages` (index thực); emit typed losses ở microclear (2 chỗ), catalog/skills/memory drop, parent-context drop, turn-drop; `microcompactToolResults` nhận `resultBySeq`, trả `losses`; helper `clearLossOf`, `turnIdsBySeq`, `asPlainText`. Chuỗi `omissions` giữ nguyên (UI). |
| `tests/harness/compaction-projection.spec.ts` (mới) | 26 test cho `assessProjection`. |
| `tests/harness/g3-microcompact.spec.ts` | +5 test builder projection (mở rộng, không sửa assertion cũ). |
`session/events.ts`, `src/index.ts`: **không đổi** (không cần).

## API
```ts
assessProjection(events, cutoff, projection): { ok: true } | { ok: false; reason: string }
compactionSeedHash(summary): string   // sha256(summary) == manifest.history.checkpointHash
```
Reason codes: `invalid-projection`, `history-not-compact`, `cutoff-not-completed`, `seed-mismatch`, `missing-prior-seed`, `invalid-sources`, `uncovered-history-dropped`, `unsafe-tool-result-clear`, `unknown`, `uncovered-history`, `unresolved-tool-call`, `indeterminate-tool-result`.

Thứ tự kiểm tra: shape/version/history mode → cutoff là completed boundary → seed phải đúng bằng canonical checkpoint của prefix (không có checkpoint mà claim seed ⇒ `seed-mismatch`; có checkpoint mà thiếu seed ⇒ `missing-prior-seed`) → sources hợp lệ (tăng dần, tồn tại, đúng turnId, không vượt cutoff; source ≤ coversSeq chỉ được là user message hoặc final answer — bounded retention) → từng loss (loại lạ/forged ⇒ `unknown`; `uncovered-history-dropped` ⇒ refuse đúng assert fixture của brief) → mọi content event (`user/message`, `assistant/message`, `tool/result`) sau seed phải được đại diện → call/result ghép đôi, không indeterminate. Event metadata-only bị bỏ qua.

## Source policy (clear)
- `tool-result-cleared` chỉ verified khi: policyVersion 1; seq/callId khớp `tool/result` có thật và nằm trong sources; `ok === true`, không `recovery`, `outcome` rỗng/`success` (dùng metadata event, không suy từ nội dung message); có assistant message sau result (đã được đọc); tool **effective** (durable `tool/call` theo index, như `projectMessages`) ∈ {Read, Glob, Grep}.
- Bash, BashOutput, Write, Edit, `mcp__*`, Agent, Skill, AskUserQuestion, TodoWrite… không bao giờ là clear an toàn. Builder vẫn clear Bash/MCP… để fit budget (hành vi cũ giữ nguyên) nhưng emit `{kind:'unknown'}` → compact bị refuse. Unread batch vốn không bị clear (giữ logic cũ) và verifier cũng refuse.
- regenerable-section chỉ nhận source `skill-catalog`, `skill:<name>`, `memory:<id>` + hash không rỗng; parent-context drop ⇒ `unknown`.
- Turn-drop: chỉ emit `uncovered-history-dropped` khi vượt `coversSeq`; drop phần covered chỉ là bớt bounded retention (seed còn nguyên) → không loss.
- Clear của message đã bị turn-drop loại khỏi projection (đã có drop loss).

## TDD / lệnh / kết quả
- RED (builder.ts về HEAD, tạm bỏ file projection): `compaction-projection.spec.ts` fail load module; 4+ test projection trong `g3-microcompact.spec.ts` fail (`compactionProjection` undefined). Sau đó khôi phục (cmp xác nhận file giống bản GREEN).
  Lần chạy đầu GREEN còn 2 fail do expectation test/`fromSeq` sai: sửa `fromSeq` của turn-drop (dùng ranh giới turn thực, không `dated[historyStart].seq`), và sửa expectation test retained (retention gồm cả final answer của turn covered — hành vi cũ).
- GREEN: `pnpm exec vitest run tests/harness/compaction-projection.spec.ts tests/harness/g3-microcompact.spec.ts tests/harness/g3-context.spec.ts` → 3 files, **68 passed** (26 + 13 + 29).
- `pnpm exec vitest run tests/harness/compaction-reliability.spec.ts tests/harness/compaction-context-reliability.spec.ts tests/harness/g3-compaction.spec.ts` → 68 passed (không regress).
- `pnpm exec vitest run tests/harness` → **89 files, 1291 tests passed**.
- `pnpm run typecheck` (tsc node + web) → exit 0, không lỗi.
- Không chạy: `pnpm test` toàn repo ngoài `tests/harness`, `build:web` (không đụng web).

## Self-review
- Đọc lại diff builder: không đổi ngữ nghĩa messages/omissions/budget; chỉ thêm tính toán projection (O(events) thêm Map). `microcompactToolResults` signature đổi (private, 2 call-site đã cập nhật).
- Không parse `manifest.omissions` ở bất kỳ policy nào.
- `sources.messageIndex` là index thực trong `messages` cuối cùng (sau khi các block lower-trust/section vào) — có test.

## Concerns / quyết định cần flag
1. **Hạn chế microcompact**: Bash/BashOutput/Write/Edit/MCP vẫn bị clear để fit budget (giữ hành vi cũ + test cũ), nhưng giờ làm projection ineligible (`unknown`). Đây là cách nhỏ nhất đúng spec §4.3; nếu muốn thì sau này có thể đổi để không clear các tool đó trước khi eligibility cần.
2. `Glob`/`Grep` coi là reproducible read (không side-effect), kết quả có thể đổi nếu FS đổi; spec cho phép "reproducible", policy v1 chấp nhận. Có thể thu hẹp thành chỉ Read nếu reviewer muốn.
3. Final answer của turn cutoff không có trong request cuối ⇒ `assessProjection` trả `uncovered-history` cho request chưa promote (đúng ruling; Task 3 phải thêm source final answer khi promote).
4. Retained-message source ≤ coversSeq chỉ chấp nhận user/final-answer; retained bị truncate (`truncateToTokens`) vẫn map về seq gốc (bounded retention được spec cho phép).
5. `compactionSeedHash` được tạo trong module projection (builder import) và chưa export qua `src/index.ts` (không yêu cầu; Task sau tự export nếu cần).
6. Seed trong projection chỉ có khi builder chấp nhận checkpoint (`validCompactionCoverage`); checkpoint không hợp lệ ⇒ không seed ⇒ `assessProjection` trả `missing-prior-seed`/uncovered (fail-closed).
