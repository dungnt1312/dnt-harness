# Spec (final) — Độ bền provider · lớp compatibility · chọn model ở CLI · trần bước

- Ngày: 2026-10-16 · Cập nhật 2026-10-17: §3.7 (luật danh tính vô hiệu, bằng chứng live) ·
  Trạng thái: **ĐÃ TRIỂN KHAI** — xem `plans/261016-implementation-report.md`
  (SR-1 §3.2/§3.3 + §3.7, SR-0, SR-2, SR-3, SR-4, SR-5, SR-6, SR-7 opt-in; §10 vẫn ngoài phạm vi)
- Thay thế bản nháp đầu: `plans/261016-spec-provider-resilience-cli.md` (nay đã gộp)
- Kiểm chứng bởi: `plans/261016-bench-report.md`, `plans/261016-branch-verify.md`,
  `plans/261016-opencode-wire-review.md`
- **Đã qua thẩm định độc lập** (subagent, 2026-10-16): 2 lỗi chặn + 4 lỗi nặng đã
  được sửa và áp vào bản này (xem ghi chú ở §2.3, §3.3, §3.5, §4.1.4, §5.1.4, §6, §8)
- Đối chiếu nguồn: `C:\laragon\www\opencode\packages\{ai,core}`, `dnt-harness\src\harness`
- Node: 22.20.0 (Laragon) · Model đo: `deepseek-v4.1-flash-free`

---

## 0. Tóm tắt điều hành

| ID | Hạng mục | Ưu tiên | Effort | Phụ thuộc |
|---|---|---|---|---|
| **SR-0** | Lớp **compatibility** per provider (+ per-model facts ở catalog) | P2 | M | — |
| **SR-1** | Chịu lỗi lắp ghép tool-call ("conflicting tool ID") | **P1** | S (ngay) / M (bền) | SR-0 cho phần bền |
| **SR-2** | `--model`/`--provider` cho CLI headless | **P1** | S | — |
| **SR-3** | Trần bước mỗi turn (`maxStepsPerTurn`) | P3 | S–M | — |
| **SR-4** | `maxTokensField` (`max_tokens` vs `max_completion_tokens`) | P2 | S | SR-0 |
| **SR-5** | `providerOptions` passthrough **có schema** | P2 | S–M | SR-0 |
| **SR-6** | `prompt_cache_key` + session affinity | P2 | S–M | SR-0 |
| **SR-7** | Tách `headerTimeout` khỏi cụm stream-timeout | P3 | S | — |

Nguyên tắc chung: **mọi hạng mục giữ nguyên hành vi mặc định** trừ khi được cấu
hình/bật; mọi field gửi ra wire đều **được gate per-model** để không 400 trên
provider khó tính.

---

## 1. Bằng chứng

### 1.1 SR-1 — lỗi lắp ghép stream
Trên ~45 lượt chạy agent thật qua gateway nội bộ, **~15% fail cả turn**:

```text
turn/error kind=provider  message="conflicting tool ID"
```

Phát sinh tại `src/harness/llm/openai.ts:341`:

```ts
if (typeof fragment.id !== 'string' || !fragment.id.trim() || (slot.id && slot.id !== fragment.id))
  throw protocolError('invalid_tool_input', 'conflicting tool ID')
```

Lượt lỗi điển hình: model stream 4 delta **thinking** rồi tới khung `tool_calls`;
gateway gửi lại id khác ở **cùng `index`**. opencode chịu được cùng endpoint
(0 lỗi / 18 lượt). Nghĩa là gateway không tuân hợp đồng wire, nhưng **bán kính nổ là cả
turn** ở phía dnt.

`protocolError()` đặt `transient: reason === 'incomplete_completion'` ⇒
`invalid_tool_input` không được retry; cổng retry `request-lifecycle.ts:111` còn
đòi `!committed`, mà `committed` bật `true` ngay khi có **bất kỳ** delta không rỗng
kể cả `thinking` (`:223`).

### 1.2 SR-2 — CLI headless không chọn được model
- `headless.ts:76-89` (`parseArgs`) chỉ có `--yolo --root --data-dir --message`.
- `headless.ts:233-237` chỉ đăng ký `DeepSeekProvider` (khi có `DEEPSEEK_API_KEY`),
  `models[0] = 'deepseek-chat'`.
- Listener `agent/context` (`headless.ts:246-275`) **không stamp**
  `model`/`providerName` — chuyển tiếp `projected.*` vốn `undefined` cho session mới.
- ⇒ Request ra với `model: undefined` → provider rơi về `models[0]`. Web host đã có
  lời giải: `loadProviderStore` + `repairDefaults`/`preferredDefaults`
  (`src/web/provider-store.ts:83-99`).

### 1.3 SR-3 — không có trần bước
- Vòng lặp turn `for(;;)` (`agent.ts:458-502`) chỉ thoát khi model hết tool call.
- Chỉ có watchdog **thời gian** (`streamIdleMs`, `logicalRequestMs`), không trần
  **số bước**.
- Tiền lệ "recovery có giới hạn": `MAX_TRUNCATION_RECOVERIES = 2` +
  `TRUNCATION_NOTICE` (`agent.ts:50,57,479-488`).

### 1.4 SR-4 → SR-7 — wire-fields (đã đối chiếu chéo hai repo)
Xem `plans/261016-opencode-wire-review.md`. Tóm tắt điều đã kiểm chứng:

| Cơ chế opencode | Bằng chứng opencode | dnt hiện tại |
|---|---|---|
| `compatibility.maxTokensField` | `schema/options.ts:205,220`; `openai-chat.ts:820-821,845-847` | luôn `max_tokens` (`openai.ts:225`) |
| `detectMaxTokensField` theo provider/baseURL | `openai-chat.ts:683-715` | không có |
| `GenerationOptions` (sampling chung) | `schema/options.ts:115-124` | không có |
| `providerOptions` + `GENERATION_KEYS` split | `model-request.ts:275-301` | không có |
| `tool_choice` gate `hasActiveTools` | `openai-chat.ts:841` | không gửi |
| `parallel_tool_calls` | `open-responses.ts:811`; `mistral-chat.ts:426` | không gửi |
| `prompt_cache_key` (default **off**) | `openai-chat.ts:792-800`; `shared.ts:45-52` | không gửi |
| session affinity header | `model-request.ts:278-295` | không có |
| Cache breakpoint `auto` (cap 4) | `cache-policy.ts:17-24,173-185` | không gửi |
| `RESPECTS_INLINE_HINTS` (openai-chat **KHÔNG** nằm trong) | `cache-policy.ts:40-56,188-199` | — |
| `HttpOptions.headerTimeout` vs `chunkTimeout` | `schema/options.ts:72-79,58-62` | `streamFirstEventMs` gộp |

> **Đính chính quan trọng về cache:** với họ OpenAI, opencode **không gửi
> `cache_control`/breakpoint nào** (`selectPolicy` trả `NONE` cho route không nằm
> trong `RESPECTS_INLINE_HINTS`). Breakpoint "tool cuối / system đầu-cuối / đuôi
> hội thoại" chỉ dành cho Anthropic/Alibaba/Bedrock/OpenRouter. Vì dnt là adapter
> OpenAI-compatible, phần port được **chỉ là `prompt_cache_key` + header affinity**,
> không phải breakpoint.

---

## 2. SR-0 — Lớp compatibility per provider (+ per-model facts ở catalog)

> Đây là "bài học gốc": opencode không thêm field vào một adapter khổng lồ, nó mô tả
> **hợp đồng wire per model** bằng dữ liệu rồi mỗi protocol tự lower. dnt **đã có
> sẵn seam** — chỉ đang dùng ít.

### 2.1 Seam đã tồn tại
- **Per-provider**: `OpenAiCompletionsOptions` (`openai.ts:88-104`) đã có `name`,
  `baseUrl`, `maxRetries`, `retryBaseMs`, **`completionPolicy`**, **`maxOutputTokens`**.
  `completionPolicy: 'strict' | 'finish-eof'` **chính là tiền lệ** knob compatibility.
- **Per-model**: `model-catalog.ts` đã có `ModelMetadata { maxOutputTokens,
  contextTokens, vision }`, `ReasoningCapability { levels }`, `ModelInfo`; và
  `outputTokenCap()` (`openai.ts:112-121`) đã resolve cap theo
  catalog + override + request + ceiling.

### 2.2 Thiết kế
1. Mở rộng `OpenAiCompletionsOptions` (hoặc một `Compatibility` object lồng trong đó)
   với các field **tuỳ chọn**, mặc định `undefined = hành vi hiện tại`:
   ```ts
   readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
   readonly supportsPromptCacheKey?: boolean
   readonly supportsStore?: boolean
   readonly supportsUsageInStreaming?: boolean
   /** Kỳ vọng hợp đồng wire của provider; ngữ nghĩa ở SR-1 §3.3. */
   readonly wire?: {
     readonly toolCallIdReuse?: 'tolerate' | 'expect'
   }
   ```
2. Thêm `detect*` thuần theo `name` + `baseUrl` (không hardcode trong body), phản
   chiếu `openai-chat.ts:683-769` — **ưu tiên `compatibility ?? detect`**
   (`openai-chat.ts:820-827`).
3. Per-model facts (sampling support, refusal of `temperature`, sanitizer) đi vào
   `model-catalog.ts`, không vào adapter.

### 2.3 Tiêu chí chấp nhận (SR-0)
1. Với provider **không nhận diện được** và không khai gì, body ra **y hệt hiện
   tại** (không hồi quy byte) — xét **theo từng field**. Nghĩa là default khi không
   nhận diện = **hành vi hiện tại của dnt** (`max_tokens`, không `store`), **không**
   phải default của opencode. Đây là khác biệt có chủ ý: gateway nội bộ
   (`127.0.0.1:6536`, tên provider tự đặt như `cliproxy1`) không được đổi wire.
2. `compatibility` thắng `detect`; `detect` chỉ áp khi **nhận diện dương**.
3. Không có magic value rải rác trong `stream()`; body lắp từ object đã resolve.
4. Có test chốt hồi quy byte: provider tên lạ → body y hệt trước/sau khi ship SR-0.

---

## 3. SR-1 — Chịu lỗi lắp ghép tool-call

### 3.1 Mục tiêu
Khung `tool_calls` **gửi lại header** (id khác ở cùng `index` **khi chưa tích luỹ
tham số**) không được giết cả turn; mọi trường hợp khác vẫn fail nghiêm.

### 3.2 Phần ngay (P1) — Option B′: chấp nhận id gửi lại khi slot chưa có tham số
Tại `openai.ts:339-343`:

```ts
if (fragment.id !== undefined) {
  if (typeof fragment.id !== 'string' || !fragment.id.trim())
    throw protocolError('invalid_tool_input', 'invalid tool id')
  if (slot.id && slot.id !== fragment.id) {
    // Gateway re-sent the header with a fresh id before any arguments
    // accumulated: last header wins. Once arguments exist the batch would
    // merge two different calls, so that stays a hard failure.
    if (slot.argsString !== '') throw protocolError('invalid_tool_input', 'conflicting tool ID')
    slot.id = fragment.id
  } else {
    slot.id = fragment.id
  }
}
```

- **An toàn**: batch chỉ được `yield` ở `openai.ts:374`, sau `validateCompletion`
  (`:368`); `finishCalls(...)` gọi ở `:369` (định nghĩa `:454`) ⇒ slot chưa ra khỏi
  provider, ghi đè id trước khi có tham số không thể tạo call hỏng để thực thi.
- **Bảo toàn bất biến**: id đổi *sau* khi có tham số vẫn ném như cũ.
- Không đụng loop/log/UI. Kèm **counter chuẩn đoán** mỗi lần áp luật.

### 3.3 Phần bền (P2) — mô tả "hợp đồng wire" thành dữ liệu (dùng SR-0)
Thay vì tin tuyệt đối vào parser, khai kỳ vọng qua `wire` ở SR-0. Vì
`OpenAiCompletionsOptions` là **per-instance provider** (không có khoá theo model),
phạm vi của `wire` là **per-provider**; nếu sau này cần per-model thì đổi shape thành
`Record<model | '*', …>`. Bản này chốt per-provider cho gọn:

```ts
readonly wire?: {
  /** 'expect' = gateway có thể gửi lại header tool-call (id mới cùng index). */
  readonly toolCallIdReuse?: 'tolerate' | 'expect'
}
```

Ngữ nghĩa `'expect'` (phải định nghĩa rõ, không chỉ nói "reset slot"):
- id mới ở cùng index ⇒ coi là **tái lập header**: **giữ** `name` đã có nếu fragment
  không mang name, **giữ** `argsString` đã tích luỹ, chỉ thay `id`. Xoá args sẽ mất
  dữ liệu; nếu muốn "làm lại sạch" thì phải là biến thể riêng, không gộp vào đây.
- `'tolerate'` (**mặc định**) = luật B′ ở §3.2.

Đây là cách opencode sống chung với nhiều gateway không chuẩn mà không hạ thấp kiểm
tra cho tất cả.

### 3.4 Phương án dự phòng (chưa chọn) — retry có giới hạn
Chỉ làm nếu telemetry chứng minh cần:
- Đánh dấu lỗi lắp ghép retryable **một lần** + nới cổng `request-lifecycle.ts:111`
  bằng cờ `committedVisible`, định nghĩa chính xác (không hiểu theo nghĩa đen):
  `committedVisible = (delta ≠ '' && !thinking) || (toolCalls && calls.length > 0)`.
  Cổng retry giữ nguyên phần còn lại — `retryable && transportSettled &&
  attempts < max` (`:111`) — cờ này chỉ **thay** điều kiện `!committed`.
- **Chi phí ẩn**: `assistant/chunk` được **append vào log ngay khi stream**
  (`agent.ts:766`) — chưa fsync từng record, chỉ barrier `durable()` mới flush cả lô
  (`src/harness/session/session.ts:44-45`) — gồm cả thinking ⇒ retry ghi thêm một bộ
  chunk cùng `stepId` → log/UI lặp trừ khi chunk mang `attemptId` và renderer khử
  trùng. Vì vậy hoãn.

### 3.5 Tiêu chí chấp nhận (SR-1)
1. `index 0` nhận `id=A` (không args) rồi `id=B`, **sau đó có fragment arguments**
   (vd `"{}"`) → **một** call, không ném.
   *Vì sao phải có args*: nếu stream kết thúc mà slot không có tham số nào,
   `finishCalls` gọi `parseArgs('')` → `JSON.parse('')` ném `invalid_tool_input …
   invalid tool arguments JSON` (`openai.ts:466-474`); patch §3.2 **không** cứu ca
   đó. Muốn hỗ trợ "tool call không tham số" thật thì phải định nghĩa ngữ nghĩa
   riêng (ngoài phạm vi bản này).
2. `id=A` **có args** rồi `id=B` → vẫn ném `invalid_tool_input` `conflicting tool ID`.
3. Lượt chạy thật lặp kịch bản "gửi lại header" hoàn tất turn thay vì `turn/error`.
4. Không đổi số bước/token ở ca không có glitch.

### 3.6 Test
- `tests/harness/llm-openai.spec.ts`: 2 ca (1) và (2) — ca (1) **kèm fragment arguments**.
- `tests/harness/stream-completion.spec.ts`: batch cuối chứa **một** call id cuối.
- (nếu làm 3.4) `tests/harness/request-lifecycle.spec.ts`: cổng `committedVisible`.

### 3.7 Bổ sung sau triển khai (bằng chứng live, 2026-10-17)

Lượt chạy thật qua proxy opencode (25 lượt, `deepseek-v4.1-flash-free`, script
`scripts/e2e/repro-toolid.mjs`) bắt được dạng glitch **khác giả thuyết §3.2**: các fragment
tiếp nối **lặp lại header với danh tính vô hiệu** (và biến thể bỏ hẳn field):

```json
{"index":0,"id":"call_00_jep…","type":"function","function":{"name":"Read","arguments":""}}
{"index":0,"id":null,"type":null,"function":{"name":"","arguments":"{"}}   ← fragment tiếp nối
```

`id:null` + `name:""` bị coi là lỗi cứng ⇒ chết cả turn (`invalid tool ID`) — chính là
lớp lỗi "conflicting tool ID" quan sát ~15% trong bench §1.1. Luật bổ sung (cùng tinh
thần "wire hygiene không giết turn"; đối chiếu opencode `tool-stream.ts` — `tool.id || undefined`,
`current?.id ?? …`):

- `id` là `null`/chuỗi rỗng/khoảng trắng → **fragment không mang id**: giữ nguyên `slot.id`,
  không tính vào counter re-issue.
- `id` không phải string (number/object) → vẫn `invalid_tool_input` `invalid tool ID`,
  không echo giá trị.
- Call **không bao giờ có id** → vẫn fail ở `validateToolBatch` (`invalid or duplicate tool
  identity`) — bất biến định danh giữ nguyên.
- `function.name` cùng luật: rỗng/null → bỏ qua, giữ name đã có; khác name giữ nguyên lỗi
  `conflicting tool name`.

Kết quả đo: trước vá **1/25** lượt chết vì `invalid tool ID` (thêm 1/12 ở vòng loop e2e).
Sau vá: **6/6** lượt live hoàn tất sạch rồi free-tier của proxy hết quota
(`FreeUsageLimitError` — mọi model free đều 429; model trả phí 401 `Missing API key`), nên
phần khẳng định nền dùng đường tất định: `scripts/e2e/run-fake-e2e.mjs` scenario 5 tái
hiện **đúng** chuỗi fragment đã bắt được (header id thật + tiếp nối `id:null`/`name:""`) qua
agent loop thật — turn hoàn tất, tool chạy, id thật của header đi tới request kế tiếp — cộng
5 ca unit mới ở `stream-completion.spec.ts`/`llm-openai.spec.ts` (gồm cả batch song song).

Sau khi quota hồi (cùng ngày): quét tiếp **40 lượt R4 + 21 lượt repro live** — **0** lỗi
tool-ID; lượt nghiệm thu cuối `run-real-e2e.mjs 12`: **22/22 PASS** (`completed=12/12`,
`upstream-flake=0`). Lớp nhiễu còn lại của relay (400 "Upstream request failed") được **phân
loại riêng, không retry** — đối chiếu opencode `classifyProviderFailure` (400 client-scoped →
`InvalidRequest`); số đo + đối chứng: report §4.7. Fake e2e tất định giờ **8 scenario /
40 khẳng định** (scenario 8 khóa đường lỗi 400: excerpt lên message, không retry).

---

## 4. SR-2 — Chọn model/provider ở CLI headless

### 4.1 Thiết kế
1. **Cờ mới** (`headless.ts:76`): `--model <id>`, `--provider <id>`, (tuỳ chọn)
   `--thinking <off|minimal|low|medium|high|xhigh|max>`; chấp nhận cả `provider/model`.
2. **Nguồn hiệu lực** theo thứ tự: (1) cờ; (2) `providers.json` defaults qua
   `loadProviderStore` + `repairDefaults` (`provider-store.ts:83-99`); (3) fallback
   cũ (`DeepSeekProvider` + `DEEPSEEK_API_KEY`).
3. **Đăng ký provider theo store** thay vì chỉ DeepSeek — dựng
   `OpenAiCompletionsProvider` cho từng provider `enabled`, phản chiếu web host;
   `configFile` mặc định khớp `src/bins/web.ts:91` (`path.join(appHome, 'providers.json')`) —
   *không phải* `src/web/web.ts` (không tồn tại).
4. **Resolve một bộ `{ provider, model, thinkingLevel }` rồi dùng cho MỌI chỗ** trong
   listener `agent/context` (`headless.ts:246-275`):
   ```ts
   return next({ ...projected, providerName, model, thinkingLevel, contextId,
     messages: assembled.messages, tools: schemas, outputCeilingTokens: assembled.maxOutputTokens })
   ```
   - `latestCalibration` (`:260`) và `buildContext` (`:263-264`) hiện đọc
     `projected.model`/`projected.providerName` → phải thay bằng bộ đã resolve; đừng
     chỉ sửa hai call được nêu tên.
   - **`thinkingLevel` phải stamp tường minh**: `projected` trong `step()` không mang
     `thinkingLevel`, mà adapter đọc `request.thinkingLevel` (`openai.ts:226`) ⇒ nếu
     không stamp, cờ `--thinking` **không có đường ra wire** và tiêu chí §4.2.4 không
     thể thoả.
   - Validate cờ bằng `expressibleThinkingLevel` (`model-catalog.ts:346`) trước khi
     stamp. Lưu ý: đó là gate **settings/alias**, *không phải* gate wire — nhánh wire
     do `applyThinkingOverride` (`model-catalog.ts:505-560`) tự kiểm danh sách level
     riêng; hai bên **phải đồng bộ** (branch hiện tại đã đồng bộ qua `EFFORT_6`).
5. **(Tuỳ chọn)** append `session/model` ở đầu session để ownership nằm trong log.

### 4.2 Tiêu chí chấp nhận
1. `--provider X --model Y` → body mang đúng `model` (bắt bằng provider giả).
2. Không cờ → đúng defaults `providers.json`.
3. Không cờ + không store → giữ hành vi cũ + **cảnh báo rõ** (thay vì im lặng `undefined`).
4. `--thinking` không được model hỗ trợ → từ chối qua `expressibleThinkingLevel`; và
   `thinkingLevel` đã stamp **phải xuất hiện trên wire** (`reasoning_effort`,
   `model-catalog.ts:510`) ở ca hợp lệ.

### 4.3 Test
- `tests/bins/headless.spec.ts`: boot với provider giả, khẳng định `model`/`providerName`
  trên request + `context/manifest`.
- `tests/web/provider-store.spec.ts`: đường "đọc defaults".

---

## 5. SR-3 — Trần bước mỗi turn

### 5.1 Thiết kế
1. `HarnessLimits` (`limits.ts`) thêm:
   ```ts
   /** Số bước model tối đa cho một turn; 0 = không giới hạn (hành vi cũ). */
   readonly maxStepsPerTurn: number
   ```
   `DEFAULT_LIMITS.maxStepsPerTurn = 48`; thêm vào `INTEGER_LIMITS` +
   `ZERO_CAPABLE_LIMITS` (để `0` hợp lệ).
2. Trong vòng lặp (`agent.ts:458-502`), mô phỏng đúng khuôn mẫu truncation:
   `let steps = 0`; `steps += 1` sau mỗi step thành công; khi còn tool call **và**
   `steps >= maxStepsPerTurn` (>0): chèn `STEP_LIMIT_NOTICE` (`origin: 'context'`)
   **một lần** để model tự chốt; vượt tiếp thì `break`.
3. Thêm hằng `STEP_LIMIT_NOTICE` cạnh `TRUNCATION_NOTICE` (`agent.ts:57`).
4. **`'limit'` KHÔNG phải reason mới** — `TurnEndReason` đã có `'limit'` từ trước
   (`src/harness/session/events.ts:269`, giữ lại để log cũ đọc được) và headless đã
   in sẵn `[turn hit a limit]` (`headless.ts:130`). Việc thật phải làm là mở **3
   union** và chốt hành vi:
   - `recordTurnEnd` param (`agent.ts:581`);
   - `turn()` return type (`agent.ts:361`);
   - **`run()` (`agent.ts:304`)**: hiện coi mọi reason ∉ `{completed, rejected,
     empty}` là "stopped" ⇒ `'limit'` sẽ **dừng cả run**. Chốt: `'limit'` **dừng run**
     (mặc định an toàn) hay **tiếp turn kế tiếp** — nếu tiếp thì phải sửa `:304`.
   - Chốt **quy tắc đếm bước**: chỉ đếm **bước gọi model thật**; bước do host chèn
     (notice / truncation-recovery / continuation) **không** tính vào `steps`.
5. Đọc limit qua `ctx.get('limits')` — property `ctx.limits` **không tồn tại**
   (provide ở `headless.ts:167` / `server.ts:699`, đọc ở `agent.ts:1024`).

### 5.2 Tiêu chí chấp nhận
1. Provider giả luôn trả tool call → turn kết thúc sau `maxStepsPerTurn` **bước gọi
   model thật** (không tính bước notice), reason `'limit'`, không treo, và hành vi
   dừng/tiếp của `run()` đúng như đã chốt ở §5.1.4.
2. Notice chốt chèn đúng **một** lần; câu trả lời một phần được giữ.
3. `maxStepsPerTurn = 0` → hành vi y hệt hiện tại.
4. `turn/end 'limit'` được ghi vào log trước khi `run()` trả.

### 5.3 Test
- `tests/harness/agent-loop.spec.ts`: ca runaway + assert reason/`steps`.
- `tests/harness/agent-tools.spec.ts`: turn dưới trần không đổi.

---

## 6. SR-4 — `maxTokensField`

**Vấn đề**: `openai.ts:225` luôn gửi `max_tokens`. Với DeepSeek/gateway hiện tại
việc này **đúng**, nhưng `o*`/`gpt-5` (OpenAI thật) trả 400 `max_tokens is not
supported`. ⇒ bug **tiềm ẩn**, không phải đang cháy.

**Thiết kế**: thêm `maxTokensField` vào options (SR-0) + `detectMaxTokensField(name,
baseUrl)`. **Khác opencode một điểm có chủ ý** (`openai-chat.ts:714` trả
`max_completion_tokens` cho mọi provider lạ): bản port **chỉ đổi khi nhận diện
dương**, vì gateway của dnt hay được đặt tên tuỳ ý và thường chỉ nhận `max_tokens`.

```text
detectMaxTokensField(name, baseUrl):
  - nhận diện DeepSeek/Moonshot/Together/ZAI/Nvidia/Cerebras/Chutes/Cloudflare
      → 'max_tokens'                       (giống openai-chat.ts:683-715)
  - nhận diện OpenAI-native (name 'openai' hoặc baseUrl 'api.openai.com')
      → 'max_completion_tokens'
  - KHÔNG nhận diện được
      → 'max_tokens'                        ← giữ nguyên hành vi hiện tại của dnt
```

Chỉ đổi **tên field**, tái dùng nguyên `outputTokenCap()` (`openai.ts:112-121`).

**Tiêu chí**: (1) provider DeepSeek → `max_tokens`; (2) provider OpenAI-native →
`max_completion_tokens`; (3) provider tên lạ (`cliproxy1`) → **`max_tokens`** như cũ;
(4) `compatibility.maxTokensField` thắng `detect`; (5) không có maxTokens → không gửi
field.
**Test**: `tests/harness/llm-openai.spec.ts` (assert key trên body theo provider).

---

## 7. SR-5 — `providerOptions` passthrough có schema

**Vấn đề**: dnt không gửi `tool_choice`, `parallel_tool_calls`, `response_format`,
`temperature`…; muốn thêm phải sửa adapter mỗi lần.

**Thiết kế**:
1. Thêm vào `ModelRequest` (`types.ts`) một `providerOptions` (host-stamped, never
   serialized blindly).
2. Adapter lower **một whitelist** field của chat-completions:
   `tool_choice` (chỉ khi `tools` active — `openai-chat.ts:841`),
   `parallel_tool_calls`, `response_format`, `stop`. (Sampling — gồm `seed` — để
   nguyên ở §10, chưa mở.)
3. `tool_choice` hỗ trợ `auto|none|required|{function}` qua `matchToolChoice`-style.
4. **KHÔNG** nhận field ngoài whitelist (tránh 400).
5. Nguồn giá trị: mode/agent config (như opencode lấy từ agent config →
   `generation`/`providerOptions`, `model-request.ts:275-301`).

**Tiêu chí**: (1) không cấu hình → body y hệt hiện tại; (2) `tool_choice` chỉ xuất
hiện khi có tools; (3) field lạ bị từ chối/log; (4) mọi field được gate per-model.
**Test**: `tests/harness/llm-openai.spec.ts` cho từng field + ca "tools rỗng ⇒ không
gửi `tool_choice`".

---

## 8. SR-6 — `prompt_cache_key` + session affinity

**Vấn đề**: dnt đã **đọc** cache-hit usage (`openai.ts:439-445`) nhưng chưa **yêu
cầu** cache; thiếu affinity khiến mỗi request có thể rơi vào máy chủ khác nhau.

**Thiết kế**:
1. **Plumbing trước** — hiện `ModelRequest` (`types.ts`) **không có** trường nào mang
   session-id/affinity (`contextId` đổi mỗi lần assembly ⇒ không dùng được), và
   headers trong adapter là tĩnh. Phải chốt trước khi code:
   - thêm field host-only vào `ModelRequest`, vd `readonly sessionAffinity?: string`
     (hoặc tái dùng `providerOptions` của SR-5);
   - nêu **nơi stamp**: web host (`server.ts`, chỗ dựng `ModelRequest`) và headless
     (listener `agent/context`).
2. Sinh **affinity id ổn định theo session** (id session bền vững; ổn định qua mọi
   request/retry/assembly trong cùng phiên). Tiền đề bắt buộc (`model-request.ts:278`).
3. Gửi header `x-session-affinity` (và biến thể) như `model-request.ts:282-292`.
4. Body `prompt_cache_key` **mặc định OFF**, chỉ gửi khi provider khai
   `supportsPromptCacheKey` (`openai-chat.ts:789-793`, `shared.ts:45-52`) — vì
   provider khó tính 400 với field lạ.
5. **Không** gửi breakpoint (`cache_control`) — xem đính chính §1.4; đó là việc của
   Anthropic/Alibaba, không phải OpenAI.

**Tiêu chí**: (1) key ổn định trong một phiên *kể cả qua retry/assembly lại*; (2) không
gửi khi provider không khai hỗ trợ; (3) không hồi quy khi provider bỏ qua field; (4) có
số đo cache-hit trước/sau trên gateway thật.
**Test**: `tests/harness/llm-openai.spec.ts` (header + gate), + ca affinity ổn định.

---

## 9. SR-7 — Tách `headerTimeout` khỏi cụm stream-timeout

**Vấn đề**: dnt gộp "đợi headers" và "đợi chunk kế tiếp" trong `streamFirstEventMs`/
`streamIdleMs`. opencode tách ba lớp (`schema/options.ts:72-79`) với
`DEFAULT_CHUNK_TIMEOUT_MS = 900_000` kèm ghi chú đúng về DeepSeek ("stream nothing
for minutes while they reason", `:58-62`).

**Thiết kế**: thêm `streamHeaderTimeoutMs` tách khỏi `streamIdleMs`; giữ mặc định
tương đương để không hồi quy; cho phép cấu hình riêng khi gateway "im lặng tới khi
reason xong".

**Ưu tiên thấp** vì `streamFirstEventMs` hiện đã *xấp xỉ* header-timeout; chỉ đáng
làm khi gặp ca stream chậm thật.
**Test**: `tests/harness/request-lifecycle.spec.ts` (giữ nguyên hiện có + 1 ca mới).

---

## 10. Ngoài phạm vi

- **Sampling (`temperature`/`top_p`/`top_k`/penalties/`seed`) — HOÃN.** *(Đã bỏ `seed`
  khỏi whitelist SR-5 để nhất quán.)* Chỉ làm **sau SR-0** vì phải gate per-model: `o*`/`gpt-5` 400 khi `temperature ≠ 1` hoặc có
  `top_p`. Gửi vô điều kiện sẽ **vỡ** các model này. opencode không gửi bừa — nó để
  sampling trong `generation` (mặc định rỗng) và mỗi protocol lower ra field hỗ trợ.
- Prompt-cache **breakpoint** (`cache_control` `auto`, cap 4) — không áp cho OpenAI.
- Provider breadth/OAuth/models.dev, SDK typed, plugin runtime (Phase 10) — xem
  `plans/261016-gap-vs-opencode.md`.
- Snapshot/undo, worktree core, WebFetch/WebSearch.
- Retry có giới hạn cho lỗi lắp ghép (SR-1 §3.4).

---

## 11. Thứ tự thực hiện & ước lượng

| Bước | Hạng mục | Lý do thứ tự |
|---|---|---|
| 1 | **SR-1 §3.2** (Option B′) | S, rủi ro thấp nhất, trị đúng 15% lỗi turn (§3.3 gộp vào bước 3 — SR-0) |
| 2 | **SR-2** | S, gỡ footgun script, mở đường tự động hoá/CI |
| 3 | **SR-0** | nền tảng cho SR-1 bền + SR-4/5/6 |
| 4 | **SR-4** | S, trị bug tiềm ẩn, tận dụng `outputTokenCap()` |
| 5 | **SR-5** | S–M, khả chuyển cao nhất |
| 6 | **SR-6** | S–M, hợp prefix-stability, cần affinity trước |
| 7 | **SR-3** | S–M, sau khi benchmark sạch (không còn nhiễu gateway) |
| 8 | **SR-7** | P3, chỉ khi gặp ca thật |

---

## 12. Phụ lục — tái lập số liệu

```sh
# Node 22 (Laragon) + endpoint OpenAI-compatible
export BENCH_BASE_URL=http://127.0.0.1:6536/v1
export BENCH_MODEL=deepseek-v4.1-flash-free
node scripts/bench/run-bench.mjs --reps 3      # đối đầu opencode
node scripts/bench/ab-prompt.mjs --reps 6      # A/B prompt main vs branch

# E2E tất định (fake gateway, không cần mạng)
node scripts/e2e/run-fake-e2e.mjs              # 8 scenario / 40 khẳng định
# E2E thật (cần proxy 127.0.0.1:6536)
node scripts/e2e/run-real-e2e.mjs 12           # R1–R5 + 12 vòng R4 (wire + thinking + cap + loop)
node scripts/e2e/repro-toolid.mjs 15           # vòng săn lỗi tool-ID (SSE + request body capture)
node scripts/e2e/probe-gateway.mjs 24          # probe đối chứng: đo flake nền của relay (không harness)
```

Chi tiết bộ đo: `scripts/bench/README.md`. Số liệu: `plans/261016-bench-report.md`.
Đối chiếu wire-fields + ref đã kiểm chứng: `plans/261016-opencode-wire-review.md`.
