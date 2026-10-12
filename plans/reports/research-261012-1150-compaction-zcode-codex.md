# Research: ZCode và Codex xử lý history sau compact như nào

Ngày 2026-10-12. Source: `github.com/zai-org/ZCode` @ `aac4755` (2026-10-10), `github.com/openai/codex` (clone mới cùng ngày). Đường dẫn ZCode tương đối với `apps/zcode-cli/packages/core/src/`, đường dẫn Codex tương đối với `codex-rs/`.

## Kết luận

Cả hai **không giữ lại turn thô** như dnt-harness. Phần raw được giữ thì hoặc rất hẹp, hoặc bị chặn bởi trần token, và không bao giờ giữ nguyên tool output cũ:

| | dnt-harness hiện tại | ZCode | Codex (local) |
|---|---|---|---|
| Raw giữ lại sau compact | 4 **turn** gần nhất trong vùng covered, nguyên vẹn (assistant + tool call + tool result), **không trần token** | Manual: **không giữ gì**. Auto/reactive: **1 round** (= 1 assistant message + tool results của nó), không phải 1 turn | **Chỉ user message**, newest-first, trần **20k token**; message ở biên bị cắt cho vừa |
| Assistant/tool output cũ | Giữ trong tail | Bỏ (trừ round cuối khi auto) | Bỏ hết |
| Re-hydrate sau compact | Không | Tối đa 5 file đã Read gần nhất (≤5k token/file, tổng ≤50k; file lớn chỉ để lại note "dùng Read"), plan file đã duyệt, agent listing | Initial context (env, instructions) dựng lại từ trạng thái hiện tại |
| Summary nằm ở | system message wrapped `<compacted-history>` | user message: "This session is being continued from a previous conversation…" | user message có `SUMMARY_PREFIX` ("Another language model started to solve this problem…") |
| Summarizer nhận gì | Transcript **làm phẳng thành text** gửi trong 1 user message, chia chunk 200k ký tự, fold tuần tự | **Message list gốc** + prompt ở cuối (cache-friendly) | Message list gốc + prompt ở cuối |
| Summarizer quá context | Chunk + fold tuần tự (chậm: 313s) | Bỏ round cũ nhất (dựa vào token gap trong lỗi "N tokens > M"), tối đa 3 lần | `history.remove_first_item()` rồi retry (giữ prefix cache) |
| Incremental | Seed từ checkpoint, chỉ fold delta | Summary cũ là 1 message trong history và được tóm tắt lại cùng | Summary cũ bị loại khỏi danh sách user message được giữ; summary mới thay thế |
| Kiểm tra lợi ích | Không (còn báo số âm) | Skip khi `hasEnoughRuntimeEntriesToCompact` = false ("Context is up to date; no compression needed"); tính `truePostCompactTokenCount`, cờ `willRetriggerNextTurn` | Không có min-gain; dựa vào việc thiết kế luôn nhỏ (≤20k + summary) |
| Circuit breaker | Không | 3 lần auto fail liên tiếp | Có giới hạn retry/step |

## ZCode chi tiết

- **Chọn phần giữ lại** — `runtime/helpers/compact-selection.ts:30-57`. Body được nhóm bằng `groupByAssistantStartedRounds` (`compact/rounds.ts:1-35`): mỗi assistant message mở một nhóm mới, nên 1 nhóm = 1 bước model + tool results đi kèm. `shouldPreserveRecent = trigger === Auto || Reactive` (`:225`). Nếu bật thì giữ 1 nhóm, còn **manual thì giữ 0**.
- **Mở rộng phần giữ** chỉ xảy ra khi request summarizer bị "prompt too long": chuyển thêm nhóm gần nhất sang phần giữ, để bớt input cho summarizer (`:59-139`).
- **Context sau compact** — `runtime/helpers/compact.ts:72-88`: `[context prefix (system/skills listing), summary (user), preservedEntries, postCompactReminders]`.
- **Re-hydrate file** — `runtime/helpers/compact-post-reminders.ts:8-51`: `maxFiles 5`, `maxFileApproxTokens 5_000`, `maxTotalApproxTokens 50_000`. Bỏ qua file đã có trong phần giữ.
- **Prompt** — `compact/prompt.ts:14-109`: 9 mục (Primary Request, Key Concepts, Files and Code, Errors and fixes, Problem Solving, **All user messages**, Pending Tasks, **Current Work**, Next Step kèm trích nguyên văn). Có preamble cấm tool, và `<analysis>` bị strip khỏi kết quả (`:119-131`). Output tối đa `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` (`compact/policy.ts:11`).
- **Skip / đo lường** — `runtime/methods/compact-active.ts:220-241` skip có event `Skipped`. `:553-581` tính `truePostCompactTokenCount` và `willRetriggerNextTurn`.
- **Auto** — retry `AUTO_COMPACT_MAX_ATTEMPTS = 3` (`compact-active.ts:73`). Circuit breaker `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`compact/policy.ts:14,138`). Ngưỡng = window − output reserve − buffer 13k.

## Codex chi tiết

- **Dựng history mới** — `core/src/compact.rs:677-770`, `build_compacted_history_with_limit`: đi newest-first qua user message. Message vừa thì giữ nguyên văn. Message đầu tiên không vừa thì `truncate_text` vào phần còn lại, đánh dấu incomplete rồi dừng. Media bị bỏ khi cắt. Summary đặt cuối.
- **Trần** — `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` (`compact.rs:63`).
- **Chỉ giữ user message** — `TurnItem::UserMessage`, và loại summary cũ (`compact.rs:567-603`).
- **Remote v2** (OpenAI Responses) — giữ user/hook message, agent message ≤10k, tổng ≤64k (`compact_remote_v2.rs:78-79,548-722`). Summary là item mã hoá.
- **Dựng lại initial context** — chèn trước user message thật cuối cùng (`compact.rs:605-675`).
- **Summarizer quá context** — bỏ item cũ nhất và retry (`compact.rs:338-350`).
- **Prompt** — `prompts/templates/compact/prompt.md`: "CONTEXT CHECKPOINT COMPACTION… handoff summary for another LLM", gồm 4 ý: progress/decisions, constraints/preferences, next steps, critical data.
- **Ngưỡng auto** — min(cấu hình, 90% window) (`protocol/src/openai_models.rs:529-540`). Có pre-turn, mid-turn và post-turn (`core/src/session/turn.rs`).

## Ý nghĩa cho dnt-harness

1. **Bỏ tail N turn thô.** Kích thước sau compact phải bị chặn theo thiết kế (summary + phần giữ ≤ trần cố định), chứ không phải dựa vào preflight để phát hiện lỗ.
2. Phần giữ thô hợp lý nhất là **user message nguyên văn có trần token** (Codex). Ý định và ràng buộc của user không bị summarizer làm méo; assistant/tool output thì để summary gánh. Có thể kết hợp với ZCode: giữ thêm **1 round cuối** khi compact tự động giữa chừng, để model tiếp tục được ngay.
3. **Re-hydrate file đã Read** (ZCode) có giá trị với coding agent nhưng là phần riêng, có thể làm sau.
4. **Gửi summarizer message list gốc** thay vì transcript làm phẳng + fold chunk tuần tự. Cách này giữ được prompt cache và nhanh hơn rất nhiều (313s hiện tại phần lớn do fold tuần tự trên flash model). Đây là thay đổi lớn hơn, nên tách thành phase riêng.
5. Prompt 9 mục của ZCode, có mục "All user messages" và "Current Work", là mẫu tốt hơn prompt hiện tại.
