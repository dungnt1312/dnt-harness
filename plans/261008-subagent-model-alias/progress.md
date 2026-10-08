# Progress — Global subagent model aliases

- **Plan:** `plans/261008-subagent-model-alias/plan.md`
- **Baseline snapshot:** `e4cb0b2` (`e4cb0b24677dcdf30da2d1809509a343eeb5b30e`)
- **Branch/worktree:** `feat/subagent-model-alias` tại `.worktrees/model-alias`
- **Trạng thái:** Plan hoàn tất; chưa implement, chưa commit.
- **Baseline verification:** user xác nhận `npm run typecheck` đã pass. Không chạy broad baseline suite theo yêu cầu.

## Preflight

| Check | Kết quả | Bằng chứng / ruling | Cost nếu sai |
|---|---|---|---|
| Spec đã được duyệt | PASS | `docs/superpowers/specs/2026-10-08-subagent-model-alias-design.md:6`–`19`, acceptance tại `:101`–`:115` | High: implement sai scope hoặc cần rework cross-layer |
| Worktree feature sạch | PASS | `git status --short` không có output; HEAD đúng `e4cb0b2` | High: có thể trộn thay đổi ngoài feature |
| Dirty root được bảo toàn | RULED | Dùng baseline snapshot `e4cb0b2`; không reset/copy/cherry-pick dirty root. Mọi review feature chỉ diff worktree so với baseline | High: mất hoặc quy nhầm thay đổi của user |
| Snapshot bị loại khỏi feature review | RULED | Reviewer dùng `git diff e4cb0b2 -- <feature files>` trong `.worktrees/model-alias`; không review dirty root/main | Medium: false findings và ownership sai |
| SDD/no more approval | RULED | User nói rõ “SDD/no more approval so proceed”; plan dùng một integrated SDD task, không thêm gate xin phép | Medium: chậm delivery và trái chỉ thị |
| Artifacts location | RULED | User yêu cầu dưới `plans`; đã tạo `plans/261008-subagent-model-alias/plan.md` và file này | Low: tooling/index có thể không tìm thấy |
| Implementer/reviewer | RULED | Một standard implementer sở hữu integrated task; sau test hẹp xanh, premium reviewer review spec + diff | Medium: review thiếu chiều sâu hoặc parallel edit conflict |
| Planner trước | NOTED | Planner trước bị cancel sau khoảng 15 phút, không có artifact; không có output để merge hoặc tin cậy | Low: lặp nghiên cứu; đã bounded bằng spec + code points |
| Baseline suite | SKIPPED BY REQUEST | Không chạy broad suite; chỉ ghi nhận typecheck user đã pass | Medium: flaky/pre-existing failure chỉ lộ ở regression sau implement |
| Delegation | SKIPPED BY REQUEST | Không delegate | None |
| `ak plan validate` | EXPECTED FAIL | CLI yêu cầu ít nhất một `phase-NN-*.md`; user yêu cầu đúng ONE integrated SDD task trong `plan.md`, nên không tạo phase artifact phụ chỉ để chiều validator | Low: plan không vào được phase-kanban CLI, nhưng artifact/handoff vẫn đầy đủ |

## Code facts đã xác minh

- Resolver precedence và legacy fallback hiện ở `src/web/agent-delegation.ts:106`–`126`; built-in Claude alias ở `:149`–`:167`; direct resolver ở `:169`–`:202`.
- Agent-tool spawn gọi shared `childModelFor` tại `src/web/agent-delegation.ts:385`–`404`; HTTP/manual spawn gọi cùng seam tại `src/web/server.ts:4101`–`4118`.
- Provider/default state load ở `src/web/server.ts:703`–`723`; serialized persistence-before-publication transaction ở `:2883`–`:2924`.
- ProviderStore v2 hiện chỉ có defaults/providers ở `src/web/provider-store.ts:32`–`36`; parser fallback ở `:66`–`:103`; atomic save ở `:150`–`:167`.
- Thinking capability validation seam là `expressibleThinkingLevel` tại `src/harness/llm/model-catalog.ts:333`–`345`.
- Role display hiện coi unresolved là inheritance tại `web/components/settings/AgentsPanel.tsx:85`–`97`; selector model hiện ở `:417`–`:428`.
- Settings global tabs hiện chỉ Providers/Usage tại `web/components/settings/SettingsModal.tsx:56`–`74`.
- Workbench Subagents hiện chỉ theo dõi run tại `web/components/workbench/AgentRunsPanel.tsx:11`–`15`, được mount qua `web/components/workbench/Workbench.tsx:231`–`239`; đây là chỗ nhỏ nhất để thêm manual spawn mà không tạo surface mới.

## Handoff

1. Standard implementer đọc toàn bộ `plan.md`, bắt đầu từ test đỏ và không sửa ngoài ownership list.
2. Giữ worktree sạch ngoài feature; tuyệt đối không thao tác dirty root.
3. Chạy đúng test commands hẹp trong plan; không chạy broad suite trừ khi premium reviewer yêu cầu vì một failure chưa phân loại được.
4. Premium reviewer đối chiếu từng acceptance criterion trong spec, kiểm diff từ `e4cb0b2`, và đặc biệt kiểm fail-closed/no-child, transaction race, snapshot isolation, keyboard/discard safeguards.

## Task 1 — implementation evidence (2026-10-08 Asia/Saigon)

- [x] Baseline hẹp trước edit: provider/delegation tests xanh (30 tests).
- [x] Store v2 đọc file cũ với `aliases: []`, round-trip alias, giữ broken target, writer cũ giữ aliases.
- [x] Resolver alias-first, exact/case-sensitive, fail-closed, marker error riêng, `null` thinking không kế thừa parent.
- [x] Transaction provider/default/alias dùng chung, persistence-before-publication; REST CRUD có per-row revision/409.
- [x] Agent tool catalog, role resolution, Agents picker, Global Model aliases CRUD và manual spawn form.
- [x] Typecheck, covering regressions và web build xanh.
- [x] Documentation child-model contract cập nhật.

Ruling: Planner ghi baseline typecheck do user xác nhận; thực tế controller đã chạy. Task này tự chạy lại `npm run typecheck` và chỉ claim kết quả hiện tại. Cost nếu sai: medium, có thể quy nguồn evidence sai nhưng không đổi behavior.

Ruling: Test hiện hữu “no delegation form” là contract cũ trái binding spec yêu cầu manual form; cập nhật assertion theo spec. Cost nếu sai: high, có thể phá quyết định sản phẩm cũ, nhưng spec dòng 83 và acceptance 9/11 là authority mới.

Ruling: Không thêm phase files/AK validation theo chỉ thị; giữ checklist evidence tại progress này. Cost nếu sai: low, plan tooling không theo dõi phase nhưng artifact delivery vẫn đầy đủ.

## Fix round 1/5 (2026-10-08 Asia/Saigon)

- [x] Findings 1–9 đều đã sửa và có regression tương ứng.
- [x] Ruling finding 6: chỉ relabel blank option thành `Use role default / conversation fallback`, giữ precedence hiện tại.
- [x] ABA: persisted monotonic `aliasGeneration`, sống qua restart và delete/recreate; không dùng `Date.now`.
- [x] POST validation chuyển vào serialized callback; provider mutation trước đó được quan sát đúng.
- [x] Store read chỉ swallow `ENOENT`; lỗi I/O khác chặn boot/mutation, parser schema cũ/malformed vẫn compatible như trước.
- [x] Manual catalog dùng root session project binding khi xem child.
- [x] UI thinking capability-based, provider empty catalog có concrete model input, Delete có discard guard.
- [x] Verification: typecheck PASS; focused 37 tests PASS; covering 169 tests PASS; web build PASS; diff check PASS.

Ruling/cost: persisted generation thêm optional-compatible field vào v2 envelope; parser file cũ suy ra từ max row revision. Nếu sai, stale revision có thể xóa row recreate (high), nên regression restart + stale delete khóa hành vi.

Ruling/cost: root project id lấy từ durable session listing của root, không từ project của child đang xem. Nếu sai, project role biến mất trên manual spawn (medium), nên mounted API URL assertion khóa query.

## Concerns

- Scope vẫn cross-layer và `src/web/server.ts` lớn; nguy cơ cao nhất là thêm alias state nhưng bỏ sót một store literal hoặc một provider/default mutation. Compile + provider transaction tests phải bắt buộc.
- Spec nói “manual subagent spawn form”, trong code hiện không có form; plan đặt form trong Workbench Subagents vì đây là surface owner rõ nhất. Không nên đặt vào Settings vì test/UX hiện khẳng định Settings không spawn.
- `thinkingLevel: null` cần được truyền như model default chứ không bị helper bỏ field rồi vô tình copy parent; pure resolver test phải khóa chi tiết này trước implementation.
