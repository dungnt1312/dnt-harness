# Spec đề xuất — Runtime & provider hardening sau review branch

- Ngày: **2026-10-17** · Trạng thái: **ĐỀ XUẤT — chưa triển khai**.
- Baseline dnt: `07a68dd336b67069ab182ba64a4c83cc08ac5b21`, branch `main`, trước `origin/main` 20 commit tại thời điểm viết.
- Baseline đối chiếu: `C:\laragon\www\opencode`, **V2 2.0.31**, commit `ed772f5009755b5262805a7ba07e66e1417f140a`; không dùng kết quả benchmark CLI V1 1.2.24 làm bằng chứng hành vi V2.
- Mục tiêu: sửa các lỗi đã xác nhận ở runtime, protocol và tooling; học ranh giới dữ liệu/lifecycle của OpenCode, không port cả framework.
- Đây là tài liệu thiết kế để duyệt. Không cấp quyền sửa source, thay cấu hình người dùng, commit, push hoặc release.

## 1. Kết luận và phạm vi

**Giữ Bun và cấu trúc harness hiện tại. Chưa release trước khi đóng các blocker runtime/data safety.**

| ID | Hạng mục | Ưu tiên | Điều kiện release | Phụ thuộc |
|---|---|---|---|---|
| RH-1 | Transport thực thi outbound policy trên Bun/Node | P1 | Bắt buộc | — |
| RH-2 | Benchmark không reset/restore repo thật | P1 | Bắt buộc với tooling được phát hành/chia sẻ | — |
| RH-3 | PTY teardown đúng shell/process lifecycle | P1 | Bắt buộc cho terminal POSIX | — |
| PH-1 | Shared effective model, settings và budget | P2 | Bắt buộc cho parity CLI/web | — |
| PH-2 | Output-cap policy: catalog/override/unknown | P2 | Bắt buộc | PH-1 |
| PH-3 | Phân biệt output-limit và shared-context overflow | P2 | Bắt buộc | Test cùng PH-2 |
| PH-4 | Reasoning round-trip cho DeepSeek-compatible | P1 | Bắt buộc cho native DeepSeek thinking + tools | PH-1 cho profile/provenance |
| QH-1 | Runtime/version gates và kiểm chứng production | P1 | Bắt buộc | Theo từng hạng mục |
| QH-2 | Cache metrics, prompt discipline, docs | P2/P3 | Metrics bắt buộc trước công bố benchmark | PH-1/PH-2 |

### 1.1 Ngoài phạm vi

- Không thay kernel bằng Effect, không chuyển session sang database, không rewrite thành OpenCode client-server.
- Không thêm native Anthropic/Responses/Gemini protocol; chỉ hoàn thiện OpenAI-compatible seam đang có.
- Không tự đồng bộ toàn bộ models.dev; catalog curated nhỏ và override đủ cho đợt này.
- Không thêm retry stack, automatic cap negotiation hoặc học limit từ mọi thông báo lỗi.
- Không triển khai HC-1 spill, HC-2 retry hooks, HC-3 whenIdle, HC-4 resource permissions trong spec cũ.
- Không thay đổi semantics single-writer, uncertainty, approval, tool-batch validation hay boot recovery đã cải thiện.
- Không gộp lại fix PM2 absolute Bun path vừa có trong `07a68dd`; chỉ thêm smoke test bảo vệ.

### 1.2 Quan hệ với tài liệu cũ

- `261016-spec-provider-resilience-cli.md` là lịch sử SR, không phải bằng chứng rằng mọi mục trong đó vẫn tồn tại ở HEAD.
- Bản này ưu tiên hơn nội dung SR cũ **chỉ** về output-cap defaults, reasoning replay và parity CLI/web.
- `261016-spec-harness-core-hardening.md` và plan `261017-0018-harness-core-hardening/` giữ nguyên, không tự cập nhật trạng thái của công việc chưa làm.
- File untracked/plan của người dùng không được xóa hoặc ghi đè.

## 2. Bằng chứng và phần học từ OpenCode

Các dòng tham chiếu là mốc baseline, có thể dịch khi triển khai; tìm theo symbol trước khi sửa.

| Vấn đề | Bằng chứng dnt | OpenCode local / bài học |
|---|---|---|
| Bun bỏ qua dispatcher | Probe Bun 1.4.3 vẫn tới server khi `dispatcher.dispatch()` lẽ ra ném; Node 22 chặn | MCP `core/src/mcp/oauth.ts:38–52` dùng native fetch; **không có DNS-pinning tương đương được xác nhận**. Không học bằng cách bỏ policy |
| Mất staging | `compare-opencode-dnt.mjs:170–195` backup working bytes rồi `git reset -q`; staged-only draft bị thay bằng HEAD, violations rỗng | `core/src/snapshot.ts:90–103`, `core/src/git.ts:326–345,956–1005`: repository/index snapshot riêng |
| PTY kill không đóng | `web/terminals.ts:189–212` gọi built-in subprocess kill mặc định TERM, không close PTY; Bash `-i` bỏ qua TERM | `core/src/pty/pty.bun.ts` dùng `bun-pty@0.4.11`; dependency kill và close handle. Không phải built-in Bun PTY |
| Mất reasoning | `agent.ts:762–770` chỉ giữ thinking trong chunks; `openai.ts:63–84` không serialize reasoning | `core/src/session/runner/to-llm-message.ts:153–183`, `ai/src/protocols/openai-chat.ts:436–498,570–575`: giữ reasoning và compatibility profile |
| Cap 32k không hợp model | `gpt-4-turbo` unknown output → 32000 dù vendor max 4096 | OpenCode **cũng fallback 32k** (`model-request.ts:48–98`), nhưng catalog bundled ghi đúng model/snapshot và có override. Unknown vẫn có rủi ro |
| False negative overflow | Window 8192, input 8000, output1024: exclusion trả false; origin/main trả true | `ai/src/provider-error.ts:16–68,235–256`: code + positive context phrases, exclusion hẹp; runner recover có giới hạn |
| CLI bỏ override | CLI thật cấu hình context32768 nhưng manifest256000; output4096 vẫn áp đúng | CLI gọi chung session server; `model-resolver.ts:396–405` mang `selected.limit` tới runner |
| Cache metrics sai | `m('cachedTokens')` luôn là array nên `?? m('cachedInputTokens')` không chạy | Adapter normalize một schema; `core/src/session/usage.ts:11–18,45–54` mới aggregate |

**Giới hạn bằng chứng:** chưa live-test native DeepSeek hoặc Bun PTY POSIX trong môi trường Windows; gateway giả chỉ chứng minh request thiếu reasoning. Full suite dnt chưa xanh; không quy mọi failure cho branch khi chưa đối chiếu baseline tương đương.

## 3. Các quyết định đề xuất

1. **Giữ threat model outbound hiện tại.** Private-IP blocking là invariant, không phải permission UX.
2. **Policy-owned HTTP dùng explicit Undici transport**, không kỳ vọng Bun native fetch hiểu dispatcher.
3. **Benchmark không auto-rollback repo người dùng.** Giảm chức năng nguy hiểm thay vì viết backup/index manager mới.
4. **Giữ built-in Bun PTY trước mắt**, sửa lifecycle nhỏ và kiểm chứng thật. Chỉ chuyển sang bun-pty nếu spike teardown không đạt contract; dependency mới phải được duyệt riêng.
5. **Một effective model resolver cho CLI/web**, giữ orchestration riêng ở hai host.
6. **Unknown output mặc định omit cap**, khôi phục hành vi tương thích origin/main; optional `fallbackMaxOutputTokens` mới cho operator muốn 32000.
7. **Reasoning là protocol transcript**, không hòa vào answer text, không gửi chéo endpoint tùy tiện, không giả định dữ liệu cũ đầy đủ.
8. **Pin runtime kiểm chứng Bun 1.4.3**, khai báo minimum cùng mốc cho release này; không chỉ nâng tới 1.3.5 dựa trên sự tồn tại của API.

## 4. RH-1 — Transport và outbound security

### 4.1 Thiết kế

- Thêm module nội bộ `src/harness/mcp/outbound-http.ts`, tận dụng `outbound-policy.ts` thay vì viết lại IP/DNS rules.
- Transport mặc định import `fetch` từ **Undici đã có trong dependencies** và gắn dispatcher do policy chọn cho URL đã validate.
- Một helper sở hữu policy envelope: validate URL → chọn dispatcher → gửi `redirect: manual` → trả response để caller đọc bounded/stream.
- Không fallback về native fetch khi Undici lỗi hoặc policy từ chối. Policy failure deterministic, không retry như network transient.
- Không dùng `fetchImpl === fetch` làm điều kiện bảo vệ. Dependency injection là **transport test seam**, không phải cờ bỏ policy ngầm.
- Giữ response/body/headers theo Web API subset thực sự dùng; xử lý khác biệt type của Undici cục bộ, không `as unknown as typeof fetch` toàn hệ thống.
- Giữ AbortSignal caller và timeout hiện có; combine signals, không thay caller signal bằng timeout. Headers tới không được tháo relay abort của body stream. Cancel/dispose response body ở mọi nhánh redirect, non-OK và đọc quá bound, không chỉ nhánh thành công.
- Không tạo Agent mới mỗi request. Dispatcher/pool có owner và close lifecycle rõ; shutdown không đóng pool của host khác đang dùng.

### 4.2 Call sites và ngoại lệ

- MCP POST + SSE GET (`mcp/client.ts`), OAuth metadata/token/refresh/revoke (`oauth-discovery.ts`, `oauth.ts`), foreign image/media download (`tools/image-tools.ts`).
- MCP/OAuth vẫn từ chối redirect; foreign media tối đa số hop hiện có, validate/pin **từng hop**, cancel body trung gian.
- Local fixture chỉ cho loopback theo profile đã có; không mở private network bằng một boolean global mới.
- Configured image-provider origin giữ ngoại lệ local hiện có; foreign origin không nhận credential. Không mở rộng ngoại lệ sang URL chỉ giống tên host.
- Không áp public-only policy lên mọi LLM endpoint: gateway private do operator cấu hình vẫn phải hoạt động như trước.

### 4.3 Tiêu chí nghiệm thu

- **RH1-A:** cùng fixture chạy bằng Node và Bun: dispatcher từ chối → zero HTTP request tới destination, không chỉ assert option tồn tại.
- **RH1-B:** DNS hostname public-looking resolve private bị chặn tại kết nối; IPv4/IPv6/mapped/NAT64, mixed answers và kết nối mới sau DNS đổi có test.
- **RH1-C:** literal prohibited URL bị chặn trước network; explicit local loopback profile vẫn hoạt động.
- **RH1-D:** redirect tới private không được gửi; header credential không rò sang foreign origin.
- **RH1-E:** abort trước headers, trong body/SSE và timeout đều settle transport theo ownership contract; không retry khi cleanup chưa xác nhận.
- **RH1-F:** tests không phụ thuộc DNS Internet, không sửa hosts/config hệ thống, không tắt TLS verification toàn process. Dùng resolver/connector fixture scoped để đo actual dispatch.
- **RH1-G:** public HTTPS MCP, OAuth refresh/revoke và media bytes có integration smoke dưới Bun.

## 5. RH-2 — Benchmark repo safety

### 5.1 Thiết kế tối thiểu

- Xóa chức năng unconditional reset và auto-restore của `verifyRepo()`; không thay bằng lệnh destructive khác.
- Chế độ `--repo` chỉ chấp nhận target disposable được caller chỉ định; nếu là checkout thường thì từ chối chạy agent với hướng dẫn tạo worktree/copy.
- Disposable marker do script sở hữu phải được tạo **khi script tạo thư mục**, không tự ghi marker lên repo có sẵn để hợp thức hóa.
- Cung cấp đường đơn giản `--repo-copy <source>`: copy committed tree sang run dir riêng, áp patch tracked và copy untracked regular files theo danh sách Git. Không checkout/add/reset vào source. Không sao chép secret/ignored files mặc định.
- Copy độc lập chỉ bảo vệ khỏi reset/restore của rig và nhiễm chéo contestant; **không là sandbox filesystem** chống agent cùng tài khoản truy cập source bằng absolute path. Muốn isolation đối kháng phải dùng container/VM/quyền OS, ngoài scope này.
- Không shared index, object alternates hoặc writable hardlinks với source; không kế thừa hooks/config có side effect. Git inspection dùng read-only/no-optional-locks và không refresh index source.
- Ignored files không copy mặc định. Tracked file thuộc sensitive-path policy thì abort và báo path (không in nội dung), cho người dùng chuẩn bị fixture đã sanitized; không tự bỏ file rồi tuyên bố baseline byte-equivalent. Không hứa tự phát hiện được mọi secret trong code.
- Freeze một baseline rồi tạo **repository độc lập cho mỗi contestant/run**; không dùng chung một copy để agent trước làm nhiễm agent sau. Tái tạo HEAD, index patch và working patch thành từng lớp, không flatten staged/unstaged. Linked worktree dùng chung Git metadata nên không được gọi là sandbox; ưu tiên copied Git state riêng.
- Nếu copy trạng thái mixed staged+unstaged chưa implement đầy đủ, từ chối với lỗi rõ; không tuyên bố bản sao tương đương. Không chạy LLM trước khi verify bản sao. Source đổi trong lúc freeze thì abort, không tự repair.
- Trên target disposable: hash trước/sau, phát hiện added/modified/deleted/rename; drift = failed run, **giữ nguyên artifact để điều tra**, không auto-restore.
- Symlink/submodule/unmerged repo không được copy một phần rồi tiếp tục: hỗ trợ có test hoặc từ chối rõ. Metadata/report nằm ngoài source.

### 5.2 Tiêu chí nghiệm thu

- **RH2-A:** trước/sau run: source HEAD, raw index bytes, staged diff, working diff và nội dung untracked không thay đổi.
- **RH2-B:** fixture `HEAD=A, index=B, worktree=C` giữ B và C nguyên vẹn, kể cả agent exit/error/timeout.
- **RH2-C:** staged rename/delete/add, filename có space và Git-valid ký tự đặc biệt không bị bỏ sót.
- **RH2-D:** agent sửa target disposable → report drift + nonzero exit; artifact còn lại, source không bị tác động.
- **RH2-E:** không dùng marker do attacker/repo content tự tạo làm bằng chứng duy nhất để cho phép thao tác destructive. Thực tế không cần destructive restore ở bất kỳ mode nào.

## 6. RH-3 — PTY lifecycle

### 6.1 Contract

- PTY owner quản lý **process + terminal handle + listeners + timers**, không chỉ record UI.
- Đường close phải idempotent cho remove, idle reap, natural exit và disposeAll.
- POSIX built-in adapter: đóng master PTY, gửi HUP theo semantics API đã verify; nếu process vẫn sống thì escalation KILL sau deadline ngắn (đề xuất 1 giây).
- Không dùng default TERM làm bằng chứng shell đã chết. Không `process.kill(-pid)` nếu chưa chứng minh PID là process-group do adapter sở hữu.
- Không kill PID đã exit/reaped; clear escalation khi exit. Tránh PID reuse: không giữ numeric PID rồi fire-and-forget sau khi ownership kết thúc.
- Explicit close phải ngừng input ngay; event terminal closed đúng một lần. Public operation phân biệt **logical closing** với **physical exit confirmed**: remove route chỉ báo hoàn tất kill sau khi await teardown; không publish success rồi ngầm giữ child sống. Timeout/error là teardown failure rõ, không giả exit0. Host shutdown phải await pending teardown trước khi báo hoàn tất; cập nhật callers nếu interface từ sync sang Promise. Tổng grace nằm trong host-exit budget của `src/bins/web.ts`.
- Natural exit phải đóng PTY và dispose listeners, không chỉ remove record. Windows node-pty behavior giữ nguyên trừ contract chung có test.
- Không cam kết dọn daemon cố ý detach; phải dọn shell, foreground job và background job thông thường cùng terminal.

### 6.2 Nghiệm thu và decision gate

- **RH3-A:** Linux Bun thật: `bash --noprofile --norc -i` + sleep foreground/background, và shell trap/ignore HUP; remove/reap/disposeAll khiến direct child/PTY cùng ordinary jobs dừng trong deadline, escalation được thực sự kiểm tra.
- **RH3-B:** natural exit, double kill, kill-racing-exit, lỗi signal/close không double event hoặc unhandled rejection.
- **RH3-C:** vòng create/close lặp lại không tăng FD/process/timer không giới hạn; UTF-8 split stream vẫn đúng.
- **RH3-D:** macOS shell zsh/Bash và Windows node-pty smoke input/output/resize/close bắt buộc trước khi phát hành với tuyên bố hỗ trợ các platform đó. Thiếu macOS evidence thì phase chưa đạt gate macOS; chỉ có thể phát hành phạm vi Windows/Linux sau khi duyệt rõ phạm vi và cập nhật support docs.
- **RH3-E:** mock adapter có thể test orchestration nhưng **không thay** actual POSIX integration test.
- Nếu built-in PTY không đạt RH3-A/C: dừng phase, đưa kết quả spike và so sánh bun-pty dependency; không phát hành một backend luôn báo available nhưng teardown không đạt.

## 7. PH-1 — Shared effective model resolution

### 7.1 Thiết kế

- Thêm helper thuần `src/harness/llm/effective-model.ts` nhận input typed, không import web server hoặc filesystem.
- Hai host load config theo cách hiện có, truyền normalized provider/model/settings/defaults/explicit selection vào resolver.
- Output duy nhất: selected provider/model, expressible thinking, effective context budget, output policy, compatibility và opaque route identity.
- API key không nằm trong resolved model object, manifest hay diagnostic. Route identity chỉ là fingerprint cấu hình route, không chứa URL query credential.
- Precedence: explicit request/session/CLI theo contract host hiện có → stored defaults → selected model settings → catalog → fallback đã công bố. Không vô tình đổi precedence của web.
- `contextTokens`, `maxOutputTokens`, thinking và vision override đi qua cùng input; CLI không bỏ context override nữa. Không gộp toàn bộ context assembly/web lifecycle.
- Provider model validation: advertised list không rỗng thì model phải có trong list, trừ gateway explicit unknown-model contract đã được tài liệu hóa; không tùy tiện khác nhau giữa host.
- Resolver trả facts/source (`override/catalog/family/fallback`), caller không đọc lại store để tự tính lần hai.

### 7.2 Tiêu chí nghiệm thu

- **PH1-A:** một store có custom model context32768/output4096 → CLI và web manifest cùng32768, wire cap4096.
- **PH1-B:** model trùng ID trên hai provider giữ override riêng; đổi defaults không sửa lựa chọn explicit đang có.
- **PH1-C:** thinking unsupported, disabled provider, missing/invalid flag có cùng validation chủ đích; không tạo session trước lỗi CLI selection.
- **PH1-D:** model hook/route change không tái sử dụng reasoning metadata của deployment cũ.

## 8. PH-2 — Output-cap policy

### 8.1 Resolution

```text
known = valid operator maxOutputTokens ?? exact/snapshot catalog output ?? verified family output
base  = known ?? configured fallbackMaxOutputTokens
cap   = min(base nếu có, request maxOutputTokens nếu có)
        nếu chỉ request có thì dùng request
        nếu cả hai không có thì undefined → omit field
cap   = apply global ceiling256000 nếu cap tồn tại
cap   = fit remaining-context ceiling nếu cap tồn tại
```

- Không tự tạo cap chỉ vì host biết remaining context. Unknown+không request+không fallback = omit, kể cả khi host luôn stamp assembly ceiling. Ceiling này không đồng nghĩa với explicit bounded-answer request.
- `fallbackMaxOutputTokens?: number` là per-provider opt-in, không ghi fallback32000 vào store cũ khi load/save.
- Operator override hợp lệ thắng catalog như contract hiện tại; không clamp ngược về catalog nếu operator cố ý cấu hình gateway alias.
- Explicit request chỉ hạ cap đã biết; với unknown và không base thì request là bounded intent của caller.
- **Chủ ý khác OpenCode:** remaining-window ceiling là upper bound khi cap đã tồn tại, không bị floor1024 nâng vượt. Nếu room dương <1024 thì cap không vượt room; nếu room không dương thì buildContext phải dùng recovery/budget failure hữu hạn trước network, không coi ceiling0 là unset. Không thay explicit request/operator cap nhỏ bằng1024.
- Giữ global ceiling256000 cho đợt này như product output budget (không gọi là vendor maximum); công khai việc model DeepSeek max393216 vẫn bị app giới hạn256000. Không thêm knob nâng ceiling toàn cục trong spec này.
- Exact model snapshot thắng family regex: `gpt-4o-2024-05-13` max4096 khác alias `gpt-4o` max16384. Bổ sung GPT-4 Turbo4096 và model cũ đang quảng bá; không gán toàn họ cùng limit nếu SKU khác.
- Giữ detection `max_tokens`/`max_completion_tokens`; undefined cap nghĩa là không có **cả hai** field, không serialize undefined/null.
- Cập nhật docs/public types/tests đang tuyên bố unknown luôn32000. Có migration note từ local0.3 behavior sang unknown-omit; không sửa config người dùng ngầm.

### 8.2 Tiêu chí nghiệm thu

- **PH2-A:** bảng exact/alias/prefixed snapshot → đúng limit; override thắng; invalid số bị reject/ignore nhất quán tại boundary.
- **PH2-B:** unknown default omit; opt-in fallback32000 gửi32000; explicit request8000 gửi8000 khi không base; ceiling không tự invent cap.
- **PH2-C:** GPT-4 Turbo default không còn gửi32000; fake endpoint giới hạn4096 hoàn thành thay vì400.
- **PH2-D:** ceiling <1024 và ceiling0, global max, field detection, compaction requested budget và truncation recovery có test riêng; không còn floor vượt upper bound.

## 9. PH-3 — Error classification, không bỏ mất recovery thật

- Tách internal classification `context_exceeded`, `output_limit_rejected`, `payload_too_large`, deterministic request khác; public reason mới chỉ thêm nếu consumers thực sự cần, không bắt buộc mở API lần này.
- Bằng chứng ưu tiên: provider structured code/param + thông báo context cụ thể + numeric diagnostics có format đã biết.
- `max_tokens is too large` **một mình** không đủ kết luận output-only; thông báo completion maximum độc lập mới là bằng chứng output rejection.
- Khi có genuine shared-window diagnostic (`input+completion > window`) thì context recovery hợp lệ, kể cả câu mở đầu nhắc `max_tokens`.
- Khi cả output cap độc lập cũng bất hợp lệ, không squeeze để né: report output-limit trước, vì giữ nguyên cap không thể sửa bằng trim history.
- Chỉ parse bounded known formats, không dự đoán limit từ số bất kỳ trong text; không tự cập nhật catalog từ lỗi.
- Không tái sử dụng reason `output_limit` hiện có: reason đó là wire/output-byte bound, khác API output-cap rejection. Nếu thêm public reason mới phải cập nhật `storage/events-jsonl.ts` attempt-fact validator và consumers. Gateway502 bọc pure output-cap rejection không được giữ `transient server_error` để retry cùng payload.
- Giữ status gates đã có: auth/quota/origin500 không bị biến thành context; relay502/503/504 chỉ theo positive context evidence.
- Recovery dùng LogicalRequest/squeeze budget hiện có, không thêm nested retry hoặc nâng attempts. Output-only rejection terminal và không mất history.

### Nghiệm thu

- **PH3-A:** provider thực tế window8192/input8000/output1024 trong khi estimate đã cho phép request → reassemble hữu hạn và hoàn thành sau trim; test classifier độc lập không phụ thuộc host có gửi đúng tổ hợp này khi estimate hoàn toàn chính xác.
- **PH3-B:** model output max4096/request32000 → đúng một rejected request, không squeeze; thông báo actionable đã redact.
- **PH3-C:** một thông báo chứa cả output maximum độc lập và context overflow không tạo vòng retry vô ích.
- **PH3-D:** HTTP JSON, SSE error, relay status, localized/unknown wording, malformed body, quota/auth có table tests.
- **PH3-E:** hết squeeze/attempt → failure rõ; không thay log cũ, không thực thi tool từ stream chưa hoàn tất.

## 10. PH-4 — Reasoning round-trip và dữ liệu cũ

### 10.1 Model dữ liệu

- Thêm optional structured reasoning payload vào `assistant/message` và `ModelMessage` (tên cuối chốt khi implement): `{ text, complete, source }`.
- `source` ràng buộc provider ID, wire model ID và opaque route fingerprint từ effective model. Không chứa secret.
- Text reasoning tách khỏi `content`: final answer, child report, search titles và tool args không bị trộn thinking.
- Agent accumulate riêng **mỗi attempt**, reset cùng `full/calls`; chỉ publish assembled reasoning khi semantic completion hợp lệ. Abandoned/incomplete attempt chunks không được ghép vào thành công sau đó.
- `finish:length` không chứng minh reasoning hoàn chỉnh; không replay một payload partial như complete. Stream error/cancelled không nâng cấp chunks thành assistant/message hoàn chỉnh.
- Giữ WIRE_LIMITS outputBytes hiện có; tính cả reasoning vào input-budget estimate, calibration, compaction snapshot và prefix hash khi nó thực sự được replay.
- Không cần durable event loại mới nếu optional fields đủ. `assistant/chunk` vẫn phục vụ UI; duplicate text trong assembled message là trade-off giống content hiện tại, phải tính size bound.

### 10.2 Replay contract

- Compatibility có `reasoningField`/`requireReasoning` theo provider/model, `explicit override > detected DeepSeek native endpoint profile > generic default`. Chỉ model ID chứa `deepseek` không đủ để chứng minh relay nhận reasoning; relay phải khai profile rõ hoặc có route capability đã xác nhận. Profile là cấu hình typed được normalize tại provider-store boundary, không arbitrary body passthrough.
- Chỉ emit reasoning field cho endpoint yêu cầu/hỗ trợ; reserved keys (`role`, `content`, `tool_calls`,...) không được dùng làm reasoningField.
- Cùng compatible route/model: gửi đúng reasoning text. Proven complete response không có thinking có thể emit `""` nếu profile yêu cầu field; không dùng chuỗi rỗng thay dữ liệu đã bị mất.
- Route/model switch: không replay provider-bound payload mặc định. Không lén chuyển reasoning thành answer text cho model mới.
- Nếu target strict yêu cầu reasoning nhưng retained assistant history thiếu/partial/incompatible thì fail **trước network** với lỗi gợi ý tạo session mới hoặc explicit reset-context được người dùng xác nhận. Chỉ gợi ý compaction nếu đã có summarizer route tương thích và input projection được xác định rõ; strict summarizer cùng route không thể tự vượt missing-reasoning gate. Không tự xóa history để đạt wire shape.
- Chỉ cho metadata text-portable cross-route trong tương lai khi có evidence/profile cụ thể; ngoài scope đợt này.

### 10.3 Compatibility/migration

- Log cũ thiếu field vẫn đọc được; không rewrite `events.jsonl` hàng loạt, không suy diễn full reasoning từ mọi chunks ở runtime.
- Không backfill chunks của step bị abandoned, response length/error hoặc step ID mơ hồ. Backfill offline có thể là follow-up, không prerequisite.
- Compaction cũ giữ hash/digest validation cũ. Khi reasoning làm thay đổi covered-source digest/projection semantics thì bump policy/schema hoặc dùng versioned validator; không âm thầm làm sidecar cũ hợp lệ theo hash mới.
- Compaction summarizer không tự nhận reasoning chéo route; request summarization, finalAnswer snapshot, fork/resume và replay đều phải qua lineage gate.
- Không thêm reasoning vào public final-answer export mặc định. UI hiện có hiển thị thinking chunks giữ hành vi; audit các endpoint trả raw events/exports để không nhân rộng disclosure.
- Rollback binary cũ với log mới không được quảng cáo là an toàn nếu validator cũ không nhận field. Backup data trước staged rollout; rollback code trước khi có write mới hoặc dùng forward-reader tương thích.

### 10.4 Tiêu chí nghiệm thu

- **PH4-A:** real CLI/web + fake strict DeepSeek: thinking → parallel tools → request2 chứa reasoning thật, tool IDs/results đúng → final answer thành công.
- **PH4-B:** restart/fork/session replay cùng lineage vẫn chứa đúng reasoning; model/endpoint switch không rò payload.
- **PH4-C:** streamed reasoning split Unicode, empty thinking, no-tools assistant và nhiều turns đều giữ trật tự và budgets.
- **PH4-D:** abandoned retry không trộn reasoning; length/cancel/error không được replay như complete; không chạy tool từ partial batch.
- **PH4-E:** legacy log thiếu reasoning vẫn mở/list được; strict replay bị lỗi actionable trước network, generic/non-required profile không bị ép field.
- **PH4-F:** compaction mới round-trip được; snapshot cũ không hỏng âm thầm; cache/hash thay khi reasoning thay; estimate chứa reasoning.
- **PH4-G:** native DeepSeek live smoke opt-in trước khi tuyên bố provider thinking+tools được hỗ trợ; không nhúng key hoặc transcript nhạy cảm vào repo.

## 11. QH-1/QH-2 — Kiểm chứng, metrics và prompt

### 11.1 Runtime và tooling

- Khai báo/test Bun1.4.3 trong package/CI/docs; release runner không cài Bun latest không pin.
- Vitest/Vite hiện theo shebang có thể chạy Node. Chọn rõ: giữ **Node22.19+ hoặc Node24** cho dev verification, Bun1.4.3 cho production/runtime tests. Không gọi workflow là Bun-only nếu còn cần Node.
- Child test process resolve actual Bun executable (override test-scoped/BUN_BIN rồi lookup executable), không giả định npm-installed `bun.cmd` được spawn không shell trên Windows.
- Không dùng `bun test` để chạy Vitest suite. Tạo script runtime probes riêng chạy bằng executable Bun và suite Vitest hiện có chạy theo docs.
- Linux bắt buộc cho DNS policy + actual PTY; Windows bắt buộc launcher/PM2-path/headless; macOS PTY smoke bắt buộc nếu release tuyên bố hỗ trợ macOS, theo RH3-D.
- Không coi typecheck là security gate. Không cần đưa toàn bộ suite platform-sensitive vào release job ngay, nhưng affected deterministic/runtime gates phải chạy CI và bắt buộc trước publish.

### 11.2 Cache metrics và benchmark integrity

- Normalize metric từng run: `cachedTokens ?? cachedInputTokens` **trước** map/median; chỉ giá trị finite/nonnegative được chấp nhận. Giữ missing là undefined/unknown, phân biệt với measured zero; không dùng `?? 0` để tính median cache khi provider không báo usage.
- Totals input/output/cached không được cộng cache lần hai; label rõ provider input inclusive hay non-cached. Dnt inclusive input không được so trực tiếp với OpenCode non-cached input rồi kết luận overhead.
- Failed/timed-out runs vẫn nằm success denominator; exclusion khỏi latency median phải hiện validRuns và lý do. Không gọi mọi error là provider fault khi chưa phân loại.
- Verifier read task phải kiểm tra đúng câu trả lời mong đợi, không chỉ có một từ `no`/`round`; edit task kiểm tra pristine tests và process outcome. Giữ phạm vi fixture nhỏ, không công bố general quality advantage.
- Regression fixture cached=12345 phải ra median12345; absent usage phải là unknown/không đo được, không tự đổi thành0 trong báo cáo hiệu năng.

### 11.3 Prompt

- Thay cấm tuyệt đối đổi search pattern bằng: tránh lặp cùng giả thuyết/tham số khi không có thông tin mới; đổi giả thuyết có căn cứ được phép.
- Kiểm chứng lại khi code/data đổi, có lỗi hoặc concern chưa giải quyết; không blanket `verify once` cho cả task.
- Giữ scope/concise/language/tool selection hiện có. Không thêm trần bước hoặc limit tự động mới trong phase này.
- Test không chỉ match nguyên văn: thêm eval nhỏ gồm misspelled symbol, alias/path sai cần đổi search, và task không tồn tại cần dừng; đánh giá recall cùng tool count, không tối ưu riêng số tool.

## 12. File map dự kiến

Mọi path dưới đây thuộc `C:\laragon\www\dnt-harness\`; chỉ sửa subset cần thiết khi phase được duyệt.

| Thao tác | File / vùng | Trách nhiệm |
|---|---|---|
| Add | `src/harness/mcp/outbound-http.ts` | Explicit policy-owned HTTP transport |
| Modify | `src/harness/mcp/{outbound-policy,client,oauth,oauth-discovery}.ts` | Policy plumbing, signal/pool lifecycle |
| Modify | `src/harness/tools/image-tools.ts` | Foreign-media transport, origin credential boundary |
| Modify | `scripts/e2e/compare-opencode-dnt.mjs` | Disposable target, no source reset/restore |
| Modify | `src/web/terminals.ts`, terminal server shutdown callers | Awaitable/idempotent teardown |
| Add | `src/harness/llm/effective-model.ts` | Pure shared resolver |
| Modify | `src/{bins/headless,web/server,web/provider-store}.ts` | Shared resolution, typed config fields |
| Modify | `src/harness/llm/{types,openai,model-catalog}.ts` | Output policy, reasoning wire contract, error classification |
| Modify | `src/harness/{agent/agent,session/events,context/builder}.ts` | Reasoning persistence/projection/accounting |
| Modify | `src/harness/context/compaction-*`, storage validators, fork/export consumers | Versioned snapshot/digest, lineage |
| Modify | `scripts/bench/{run-bench,harness-agent,opencode-run}.mjs/.mts` | Normalized/semantically comparable metrics |
| Modify | `package.json`, `bun.lock` nếu cần, `.github/workflows/release.yml`, `README.md`, `CLAUDE.md`, `docs/{guides,prompt-contract,web}.md` | Runtime gate, compatibility/migration docs |
| Add/Modify | `tests/harness/*outbound*`, `*llm*`, `*context*`, `*compaction*`, `*session*`, `tests/bins/headless.spec.ts`, `tests/web/{terminals,server-models}.spec.ts`, runtime/script tests mới | Acceptance matrix RH/PH/QH |

## 13. Thứ tự triển khai và release gates

| Phase | Nội dung | Phụ thuộc / gate |
|---|---|---|
| 0 | Reconfirm HEAD/user changes; chốt spec, baseline failure inventory và runtime matrix | Không ghi đè PM2/user work; không bắt đầu HC song song trên cùng file |
| 1 | RH-1 outbound + RH-2 repo safety + runtime tests cần thiết | Hai hạng mục độc lập; mỗi commit có test. Chưa publish |
| 2 | RH-3 PTY lifecycle | POSIX actual-process gates; decide built-in vs dependency nếu spike fail |
| 3 | PH-1 shared resolution + PH-2 cap + PH-3 classification | CLI/web parity và overflow end-to-end, không đổi retry ownership |
| 4 | PH-4 reasoning + versioned history/compaction tests | Chỉ tuyên bố native thinking+tools sau live smoke |
| 5 | QH-2 metrics/prompt/docs + QH-1 package/CI final gates | Build/typecheck/test evidence; audit release artifacts |

Mỗi phase là một PR/commit group có thể review độc lập; không tạo mega-refactor hoặc sửa test mong đợi chỉ để làm xanh.

### Definition of done

- [ ] RH1/RH2/RH3 acceptance tests qua đúng runtime/platform tương ứng.
- [ ] CLI/web selected pair, context/output overrides và thinking có parity test.
- [ ] Unknown-cap migration được mô tả; fixture model thấp không400 vì fallback tự áp.
- [ ] Output-only rejection không squeeze; genuine overflow recover có giới hạn.
- [ ] Reasoning replay sau tools/restart/fork và compaction không mất dữ liệu hoặc leak cross-route.
- [ ] `bun run typecheck`, `bun run build:web`, affected suites, fake E2E và runtime probes pass.
- [ ] Full suite chạy môi trường được hỗ trợ. Nếu baseline fail: liệt kê từng case + baseline/head evidence + owner; không tuyên bố all-green hoặc miễn lỗi mới bằng lý do platform chung chung.
- [ ] Windows packaged launcher/PM2 absolute Bun smoke; Linux clean install + terminal/MCP smoke; macOS gate có evidence. Nếu thiếu macOS evidence: chưa đạt release gate macOS; chỉ phát hành phạm vi Windows/Linux khi người dùng duyệt rõ thay đổi support scope, không miễn gate bằng footnote.
- [ ] Tag/publish không được chạy chỉ vì version đã bump; approval sau review runtime/security và migration.

## 14. Trade-off và câu hỏi cần duyệt

**Khuyến nghị duyệt mặc định các lựa chọn sau; nếu đổi thì cập nhật spec trước code:**

1. Giữ outbound public-only policy cùng local fixture exception; không lấy threat model thoáng hơn của OpenCode để bỏ bảo vệ.
2. Unknown output = omit; `fallbackMaxOutputTokens` opt-in. Nếu sản phẩm ưu tiên gateway đòi explicit cap, operator đặt fallback, không áp ngầm mọi model.
3. Legacy strict DeepSeek history thiếu reasoning = lỗi trước network, hướng dẫn session mới/explicit context reset. Compaction không phải đường cứu mặc định nếu summarizer cũng bị strict gate. Không fabricated empty replay hoặc auto-trim history.
4. Giữ built-in PTY nếu test thực tế đạt; đổi bun-pty chỉ sau decision gate có evidence.
5. Script comparison ưu tiên disposable copy; từ chối mixed state không thể clone đúng hơn là chạy trên source thật.

**Chưa kết luận:** thứ tự HUP/close tối ưu theo built-in PTY API và khả năng cleanup jobs trên Linux/macOS phải được spike xác nhận; khả năng bảo toàn reasoning trên native DeepSeek khi context đã compact cần live smoke. Đây là gate kỹ thuật hữu hạn, không lý do mở rộng scope sang rewrite harness.
