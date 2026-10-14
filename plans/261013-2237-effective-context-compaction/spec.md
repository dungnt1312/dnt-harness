# Spec đề xuất: Effective-context compaction và guarded precompute

**Status:** Approved — user duyệt lúc 22:43 +07:00 ngày 2026-10-13. **Ngày:** 2026-10-13, Asia/Saigon.
**Phạm vi:** kiến trúc compact cho dnt-harness; không phải implementation plan và không cho phép triển khai.

## 1. Outcome và brief

User muốn compact nhanh và hiệu quả hơn hiện tại; đã yêu cầu review và research ZCode, Claude Code, Codex rồi viết spec đề xuất. Log nghiên cứu có các lần compact 436–768 giây với 7–9 request usage-bearing nối tiếp. Chưa có benchmark latency sau thay đổi.

Đề xuất: compact context hiệu lực đã được xác nhận, giữ structured messages và prefix ổn định, tạo một handoff summary trong trường hợp bình thường. Thêm speculative precompute để giảm thời gian chờ khi cần compact; candidate phải qua validation và được áp dụng bằng checkpoint durable ở boundary an toàn.

Giả định để duyệt: ưu tiên trạng thái đủ chính xác để tiếp tục công việc, không bắt summarizer đọc mọi output tool cũ đã được clear theo policy. Log gốc vẫn giữ nguyên cho audit/recovery. Không chấp nhận âm thầm mất user intent, constraint, việc chưa xong hoặc turn chưa được covered bởi checkpoint.

## 2. Những gì research chứng minh

- ZCode gửi active runtime history với prompt cuối; không fold transcript gốc thành chuỗi chunk. Có giảm source khi overflow, là trade-off mất coverage.
- Claude Code 2.1.293 local có cache-sharing fork, restoration, nhiều summary prompt và guarded precompute; rollout flag chưa được xác minh.
- Codex main `f6aca7d` có structured local/native compact và async candidate; async under development, mặc định tắt, default arm threshold 65% full window.
- Cả ba không chứng minh provider/gateway của mình hỗ trợ cache/native compaction, cũng không đảm bảo latency cụ thể.

Research references nằm ở `plans/reports/research-261013-{2127,2134,2143,2227}-*.md`.

## 3. Phương án và quyết định đề xuất

| Phương án | Lợi ích | Hạn chế | Đề xuất |
|---|---|---|---|
| Tăng chunk / đổi model | Ít thay đổi | Vẫn đọc lại raw output, fold nhiều lần, cache yếu | Không làm giải pháp chính |
| Effective structured summary + guarded precompute | Portable, tránh refold, giảm blocking, giữ safety | Cần projection provenance, restart recovery và adoption contract | Chọn |
| Native compact API làm mặc định | Tận dụng trạng thái native | Provider-specific, opaque state, gateway chưa kiểm chứng | Adapter tùy chọn sau, không prerequisite |

Không thêm UI/model picker riêng, không đổi model compact tự động và không sửa workflow ngoài compact.

## 4. Contract nguồn compact

### 4.1 Effective projection

Context builder cung cấp projection có provenance riêng, không suy policy bằng cách parse chuỗi `manifest.omissions`.

Mỗi message history mang source sequence/turn identity; section ngoài history mang source kind/hash. Projection ghi rõ:
- checkpoint seed đang dùng và hash của seed;
- những turn chưa covered được đại diện trong projection;
- tool-result clear: call ID, source seq, policy version, loại clear;
- turn/message thiếu do budget/window/mode, tách biệt với regenerated section omission;
- unresolved call/result hoặc source không recover được.

Có thể compact trên placeholder output tool đã clear nếu user message, assistant content và effective call identity/args vẫn giữ đủ theo source policy. Không clear thêm ngay trước summary nếu khiến prefix khác với snapshot đã dùng; nếu phải sửa projection để fit, dùng nhánh reconstructed được gắn nhãn cache-unverified.

### 4.2 Eligibility

Snapshot eligible chỉ khi history mode là `compact`, có completed durable cutoff và nguồn đại diện đủ các turn từ seed+1 đến cutoff. Không có seed thì phải đại diện từ đầu conversation.

Cho phép omission có kiểu:
- clear tool result theo policy được khai báo;
- section dựng lại được (catalog, memory, instruction/skill section) với restoration contract rõ;
- raw user messages trong vùng seed đã được bounded retention; seed vẫn có mặt.

Không cho phép:
- drop completed turn chưa covered bởi seed;
- thiếu prior seed hoặc user message trong vùng delta;
- call/result bị split, kết quả chưa xác định, lỗi durability;
- history `none/recent` bị coi thành toàn history;
- media không inspect được nhưng summary lại tuyên bố đã biết nội dung.

Không dùng omission whitelist chung. Unknown category luôn ineligible.

### 4.3 Safety của output tool

Reuse cơ chế microcompact, nhưng marker phải là typed loss có thể kiểm chứng từ log. Result chưa được model đọc, approval/question, child deliverable, active task state và lỗi quan trọng không được clear để tạo eligibility. MCP output không được mặc định xem là tái tạo được chỉ vì tên bắt đầu `mcp__`; cần policy/metadata hoặc giữ nguyên. Không chạy lại side-effect tool để khôi phục output.

Đây là siết contract compact; các policy sửa request thường phải có regression tests riêng.

## 5. Snapshot và restart

`EffectiveCompactionSnapshot` (tên đề xuất) gồm schema/policy versions, session/cutoff/turn IDs, seed identity, canonical event-prefix digest, structured request, history/source mapping, typed losses, resolved provider/model/thinking/mode/tool/prefix identities, output final answer của completed turn và estimates/usage evidence.

Exact-prefix snapshot được capture sau host context/model middleware, trước provider dispatch, không rebuild từ raw transcript. Chỉ promote khi physical response có completion hợp lệ và covered turn/end đã durable; không promote partial, abandoned, uncertain hoặc request thuộc open turn. Snapshot của request cuối cộng completed assistant response mới đại diện đủ cutoff; bảo toàn cấu trúc và tool pairing.

Persist snapshot bằng atomic sidecar trong host session storage. Durable event mới `context/snapshot` chỉ tham chiếu ID/hash/cutoff/schema, không nhét bản request duplicate vào log mỗi token. Sidecar viết và sync trước reference; chỉ reference đã durable mới eligible sau restart. Sidecar là cache: mất/corrupt không phá conversation và không tự xác nhận coverage. Không lưu credential, auth token, AbortSignal, execution handle hoặc provider headers.

Digest dùng canonical serialization có version, không dựa raw JSONL line endings. Snapshot store giữ latest eligible + snapshot candidate còn sống, GC sau barrier/reference ownership; không tăng storage theo mọi model step. Bất kỳ legacy snapshot không có provenance đều phải rebuild/refuse.

Sau restart, kiểm chứng reference/cutoff/source digest/seed identities. Reconstruct effective projection từ committed log + durable sections + policy khi exact sidecar không có; reconstructed không được quảng bá là cache hit. Không cần file credential để reconstruct.

## 6. Summary request và output

Normal path: copy resolved structured request/prefix, append prompt summary cuối; preserve system/tools/message order và model/thinking selection. Tools chỉ giữ schema để cache; deny mọi tool execution. Request maintenance không đi lại context middleware của active task. Không gọi native compact beta mặc định.

Handoff prompt tập trung vào:
1. Intent/ràng buộc/permission scope của user; restrictions quan trọng giữ nguyên văn.
2. Quyết định và cách đã thử hoặc ruled out cùng lý do.
3. Current work: path/identifier, dirty state, latest verified outcome và unresolved errors.
4. Pending tasks/next step gắn với request gần nhất.
5. Reference khó khôi phục và pointer tới dữ liệu retrievable.

Không yêu cầu mọi code snippet/tool output và không viết lại toàn bộ user history trong chín heading. Summary text có cap hiện tại 24k ký tự. Output token budget ban đầu đề xuất 8k, clamp theo model/output/window; hard character cap vẫn authoritative. Không tự tắt thinking hoặc switch model. Không chấp nhận `length`/missing completion/tool output. Oversize được re-ask tối đa một lần với prompt thu gọn, được ghi nhận là logical call thêm; không loop vô hạn.

Input fit phải reserve output và summary instruction, xét cả schema/system/seed. Provider-reported total input là baseline khi có; estimator hiện chars/4 phải gắn estimated và dùng safety margin 20% cho phần tăng chưa có usage. Không coi 200k ký tự là model window. Nếu provider vẫn overflow, không resend cùng input.

## 7. Fallback và legacy session

Thứ tự:
1. Exact eligible snapshot: prefix-preserving summary.
2. Durable reconstructed effective projection eligible: một structured request, cache chưa xác minh.
3. Không đủ coverage hoặc quá window: giữ nguyên context và báo lý do; không drop oldest uncovered turn để báo success.

Legacy session có nhiều turn đã bị request builder bỏ phải phục hồi source coverage trước. Nếu reconstructed source không fit, có thể dùng existing incremental raw fold **chỉ khi người dùng xác nhận slow recovery**; không tự rơi vào nó sau một lần compact nhanh thất bại. API/UI cần trả reason + estimated call count trước khi chạy slow recovery; đây là confirmation của operation khác, không âm thầm có thêm hàng loạt request. Automatic compact không chạy slow recovery.

No-model fallback chỉ thành công nếu exact bounded extractive source fit; giữ fail-before-start hiện có. Native API adapter chưa thuộc delivery bắt buộc của spec này.

## 8. Precompute: tạo trước, áp dụng sau

Config đề xuất `compactionPrecomputeEnabled` mặc định false trong rollout; `compactionPrecomputePressure` 0.65 trên usable request budget, không phải full model window. Blocking/automatic pressure reuse cấu hình hiện tại. Một candidate/job mỗi session; foreground requests ưu tiên admission. Precompute chỉ bắt đầu sau completed durable boundary khi snapshot eligible, có tăng source ngoài seed và budget có đủ headroom; không tạo job mỗi token.

Start tạo `jobId`, snapshot reference/cutoff, seed, model/provider generation, mode/grants/policy identities. Trong lúc generation, session vẫn nhận và chạy turn bình thường. Đây không phải reservation `runCompaction` hiện tại.

State: `idle → generating → ready → adopting → committed`; failure/stop/invalidation → discarded. Candidate không phải checkpoint và không được context builder sử dụng trước adoption.

Appends không invalid candidate nếu covered prefix bất biến và seed/config identities còn đúng. Turn mới nằm ngoài cutoff được giữ nguyên. New checkpoint, policy/model/provider config change, auth generation exposed by provider, grant shrink, source rewrite/rollback/session deletion/closing invalid candidate. Không đọc credential để tính identity.

Stop khi foreground đang chạy hủy foreground theo contract hiện tại; Stop khi explicit compact đang chờ/adopt hủy operation và candidate liên quan. Closing/deletion hủy precompute. Idle speculation không được tự phát sinh user turn hay hoạt động tool.

Job deadline đề xuất 180s cho toàn summary operation, retry tối đa hai physical attempts mỗi logical request, nằm trong cùng deadline. Tối đa một oversize re-ask cũng dùng deadline chung. Deadline áp dụng cả queue/transport/backoff; failure giữ context. Chưa phải SLO latency.

## 9. Adoption và lifecycle durable

Adoption chỉ ở completed exchange boundary, không giữa open turn. Acquire maintenance reservation ngắn, pause inbox drain, await source barrier và revalidate ngay trước append:
- candidate/source digest/cutoff hợp lệ;
- current canonical seed bằng captured seed;
- model/provider/config/mode/policy/grants tương thích;
- no uncertain execution;
- user/inbox events ngoài cutoff không bị mất;
- summary cap/completion hợp lệ;
- projected post-adoption context, gồm tail + retained user + restoration, fit budget và tạo gain.

Candidate có cutoff cũ vẫn được áp dụng khi các turn sau đã đóng; checkpoint `coversSeq` chỉ là cutoff đó. Không advance tới newest boundary nếu summary chưa cover. Mọi event/message seq > cutoff giữ nguyên trong context.

Với foreground compact không có reusable candidate, acquire maintenance reservation và chạy PreCompact trước capture/generation như hiện tại; giữ reservation tới commit/failure. Với candidate precompute, PreCompact chạy khi bắt đầu adoption; speculation không chạy hook external. Mỗi giao dịch chỉ chạy PreCompact một lần. Hook block hủy operation; instruction mới hoặc source rewrite làm candidate incompatible, phải generate lại dưới reservation với constraints mới hoặc báo refusal, không áp candidate cũ. Không ghi `compaction/start` tới khi source/hook preflight đã qua. PostCompact/SessionStart-compact theo support hiện tại sau commit, không tuyên bố hook feature chưa có đã tồn tại.

Giữ `compaction/start/end` là lifecycle của **adoption**, không của background generation. Bổ sung job telemetry riêng để UI không hiện spinner compact suốt thời gian speculation. Transaction ownership bổ sung captured cutoff và adoption identity; canonical recovery phải cho phép turn/end sau cutoff nhưng trước adoption start, đồng thời vẫn từ chối turn/start xen trong giao dịch adoption. Không chỉ xóa blanket check trong `recoverCanonicalCheckpoint`.

Success append vẫn là irreversible commit; await durability trước acknowledge. Cache write sau commit chỉ là derived. Failure trước success không install; lỗi sau success durability không được rollback bằng cancel. Crash ở mọi stage phải giữ đủ committed original events để recover.

Manual operation: reuse ready valid candidate trước; nếu candidate pending, wait tối đa 15s rồi hủy/quiesce job trước foreground generation. Không chạy hai physical summary operations trùng ownership. Nếu provider transport chưa settled thì fail/hold theo existing uncertain contract, không giả định abort giải phóng slot. Automatic gate có cooldown: tối đa một failed speculation cho cùng snapshot+identity; source mới hoặc user manual mới cho phép thử lại.

Gain: candidate chỉ eligible để adoption nếu tiết kiệm ít nhất 256 estimated tokens và toàn context sau restore fit. Nếu tail đã refill không fit thì discard/regenerate từ snapshot mới; không commit xong mới phát hiện phải compact lại.

## 10. Context sau compact và restoration

Reuse bounded user-message retention `compactionRetainTokens = 20k` hiện tại, summary cùng latest covered final answer theo existing contract. Không khôi phục raw N turns. Tail ngoài cutoff không tính vào covered retention và không được truncate chỉ để adopt candidate.

Builder dựng lại durable instruction/catalog/memory theo mode/snapshot policy hiện có. Restore bổ sung có bounds:
- tối đa 5 file đọc/sửa gần đây, 5k estimated token/file, tổng 20k;
- quá file cap: path reference, không content;
- không auto-read ngoài current grants, symlink/realpath vẫn qua policy;
- reading là host maintenance read, không reset model-side Read/Edit freshness authorization; agent phải Read trước Edit theo existing observation contract;
- file missing/changed ghi reference/status, không gọi stale content là current;
- invoked skills: 5k/skill, 25k tổng; dropped/truncated có typed provenance;
- accepted plan pointer/content nếu có durable source và còn grants;
- running agent/process/question state từ registry/log, không spawn/rerun;
- tổng restoration cap 25k estimated tokens, ưu tiên constraints/plan/current runtime state rồi skills rồi files.

Nếu fixed required state không fit cap/window thì refuse adoption, không mất constraints. File contents có thể thay bởi reference; summary không phải authority cấp permission mới. Session event/schema phải ghi nhận model-visible restoration theo invariant reconstructability, không chỉ inject text ngoài log.

## 11. Metrics, UI và chi phí

Ghi tách generationMs, blockingWaitMs, adoptionMs, queueMs, firstProgressMs, retry/backoff, path exact/reconstructed/recovery, source size/loss counts, input/cached/output tokens, re-ask, seed/cutoff, candidate reused/discarded reason, total context before/after including restoration.

Usage record của speculation vẫn tính kể cả discard; retry failed usage chỉ ghi khi provider thực sự report, unknown không thành zero. UI explicit compact hiện preparing/generating/applying, actual elapsed; ready candidate có thể apply ngắn. Không hiện model đang Working chỉ vì idle speculation.

Không suy zero retry từ usage records thành công; `model/attempt` là nguồn physical timing. Không hứa cache hit nếu provider không report. Không expose snapshot raw content qua unprotected API.

## 12. Acceptance và verification

Functional:
- Normal eligible compact một logical summary call, trừ bounded retry/re-ask; không raw transcript chunk fold tự động.
- Exact structured prefix match được test cả system/tools/thinking/message order; request không execute tool.
- Typed tool clears eligible, unknown omission/uncovered dropped turn ineligible.
- Candidate cutoff cũ + later completed turns: canonical checkpoint recover được, tail nguyên vẹn.
- Concurrent input/stop/model/grant/hook/seed changes không sai ownership, không double commit.
- Missing/corrupt snapshot và restart từng crash point fail safe/reconstruct; legacy checkpoint còn đọc được.
- Retained user constraints, pending task, verified outcomes, unresolved errors, next step không biến thành completed fact không có evidence.
- Post-restore tokens fit và gain ≥256; no-op không append lifecycle/LLM call.

Test matrix: seed/no-seed; Unicode/media; grouped tools/parallel tool results; errors/side effects/MCP policy; loss categories; malformed completion/overflow; abort/uncertain transport; sidecar corruption/digest/version; crash before/after reference and commit; tail growth/rollback; hooks; read grants/file mutation; provider model window/cache reported/unreported.

Performance evaluation on fixed representative fixtures and same provider/model/settings:
- compare baseline fold with exact/reconstructed one-call on warm/cold/resumed sessions;
- target ≥70% reduction median foreground generation wall-clock for fixtures previously requiring ≥7 calls;
- target ready-candidate blocking p95 ≤5s excluding separately measured user hooks/slow storage;
- report output/total token cost, candidate waste and quality scores together, not spinner latency alone;
- thresholds là mục tiêu nghiệm thu cần đo, không claim đã đạt. Provider capacity variance ghi rõ; không gọi test pass nếu quality regressions.

Affected tests first, `pnpm test`, `pnpm run typecheck`, `pnpm run build:web` nếu UI affected. Controlled live benchmark cần user approval cho provider spend; unit/fault tests dùng test doubles đúng existing test conventions.

## 13. Delivery boundaries và rollback

Đây là một spec tổng thể với dependencies, chưa là plan:
1. Typed projection + durable snapshot + portable foreground compact + coverage/recovery.
2. Bounded restoration + true context measurement + metrics/UI.
3. Guarded precompute + adoption concurrency + fault recovery.

Foreground effective mode và precompute bật độc lập qua versioned config. Rollout precompute mặc định off tới khi fault tests/live evidence pass. Rollback không đọc snapshot schema mới bằng parser cũ và không revive discarded content; giữ canonical summary text format tương thích. Existing raw fold tồn tại cho explicit recovery, không default normal path. Không migrate/delete log hay checkpoint cũ.

Không commit spec hoặc source trên branch đang có nhiều thay đổi không liên quan trừ khi user yêu cầu. Không native API adapter, không tự deploy/restart.

## 14. Quyết định cần anh duyệt

1. Chấp nhận compact trên effective context có typed tool-result loss, thay vì mandatory archival full-source coverage.
2. Slow raw fold chỉ là recovery được xác nhận riêng, không automatic fallback.
3. Scope gồm restoration và precompute; native compact API tách sau.
4. Các default đề xuất: arm 65% usable budget, 180s deadline, 8k output tokens, wait candidate 15s và restoration caps; có thể hiệu chỉnh theo benchmark trước rollout.

Duyệt spec chỉ cho phép viết implementation plan; chưa cho phép thực thi plan.
