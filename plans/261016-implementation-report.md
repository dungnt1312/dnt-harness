# Báo cáo triển khai — spec `261016-spec-provider-resilience-cli.md`

Nhánh: `fix/effort-vocabulary-and-prompt-discipline` · Ngày: 2026-10-16 · **cập nhật 2026-10-17**: vá live §4.6 (danh tính tool-call `id:null`), thêm §4.7 (relay 400 + excerpt), §4.8 (nghiệm thu app thật), §4.9 (curl 253 case), §4.10 (đối chiếu opencode).
Trạng thái: **đã code hết SR-1/0/4/5/6/3/7 (SR-7 dạng tuỳ chọn, default không đổi) + SR-2**, kèm test cho từng mục.

---

## 1. Tóm tắt theo hạng mục

| # | Hạng mục | Trạng thái | Nơi sửa |
|---|---|---|---|
| 1 | **SR-1 §3.2** chấp nhận header tool-call gửi lại (chưa có args) | xong | `src/harness/llm/openai.ts` |
| 2 | **SR-1 §3.3** `wire.toolCallIdReuse: 'tolerate' \| 'expect'` | xong | `src/harness/llm/openai.ts` |
| 3 | **SR-2** CLI `--model/--provider/--thinking` (+`--config`) | xong | `src/bins/headless.ts` |
| 4 | **SR-0** lớp compatibility per-provider + `detect*` | xong | `src/harness/llm/openai.ts` |
| 5 | **SR-4** `maxTokensField` | xong | `src/harness/llm/openai.ts` |
| 6 | **SR-5** `providerOptions` whitelist | xong | `src/harness/llm/openai.ts`, `src/harness/llm/types.ts` |
| 7 | **SR-6** `prompt_cache_key` + session affinity | xong | `openai.ts`, `types.ts`, `src/bins/headless.ts`, `src/web/server.ts` |
| 8 | **SR-3** trần bước mỗi turn | xong | `src/harness/limits.ts`, `src/harness/agent/agent.ts` |
| 9 | **SR-7** `headerTimeoutMs` tách khỏi cụm stream-timeout | xong (tuỳ chọn) | `src/harness/llm/openai.ts` |

Không nằm trong phạm vi (đúng như spec §10): sampling (`temperature`/`top_p`/penalties/`seed`),
cache breakpoint `cache_control`, retry có giới hạn cho lỗi lắp ghép (§3.4).

---

## 2. Chi tiết thay đổi

### 2.1 SR-1 — lỗi lắp ghép tool-call (`openai.ts`)

Luật mới khi một `index` nhận `id` khác với id đã có:

- **chưa tích luỹ tham số** (`slot.argsString === ''`) → **header cuối thắng**, ghi đè `id`, không ném.
  An toàn vì batch chỉ được `yield` sau `validateCompletion`; slot chưa ra khỏi provider.
- **đã có tham số** → vẫn ném `invalid_tool_input` `conflicting tool ID` (bất biến giữ nguyên).
- `wire.toolCallIdReuse: 'expect'` → nhánh thứ hai cũng được tha: **giữ** `name`/`argsString`
  đã tích luỹ, chỉ thay `id` (đúng ngữ nghĩa "tái lập header" của spec §3.3).
- **Danh tính vô hiệu** (`id` `null`/rỗng/whitespace, `function.name` rỗng/null) → coi như fragment
  *không mang danh tính*: giữ nguyên phần đã có, không ném, không tính counter (spec §3.7, bổ sung
  sau bằng chứng live — gateway thật lặp header với `id:null`,`name:""` ở mọi fragment tiếp nối).
- `id` không phải string (number/object) → `invalid_tool_input` `invalid tool ID` **không echo giá
  trị**; call không bao giờ có id → fail ở `validateToolBatch` (`invalid or duplicate tool identity`).
- **Counter chuẩn đoán**: `toolCallIdReissueCount()` đếm số lần luật "id dùng được ghi đè" được áp
  (process-wide).

### 2.2 SR-0 — lớp compatibility (`openai.ts`)

`OpenAiCompletionsOptions` thêm, tất cả **tuỳ chọn, `undefined` = hành vi cũ**:

```ts
readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
readonly supportsPromptCacheKey?: boolean
readonly supportsStore?: boolean
readonly supportsUsageInStreaming?: boolean
readonly headerTimeoutMs?: number
readonly wire?: { readonly toolCallIdReuse?: 'tolerate' | 'expect' }
```

`compatibility ?? detect(name, baseUrl)`; body lắp từ giá trị đã resolve một lần, không rải
magic value trong `stream()`. Detect (export để test):

- `detectMaxTokensField` — DeepSeek/Moonshot/Together/ZAI/Nvidia/Cerebras/Chutes/Cloudflare
  (theo tên **hoặc** host) → `max_tokens`; OpenAI-native (`name === 'openai'` hoặc
  `baseUrl` chứa `api.openai.com`) → `max_completion_tokens`; **không nhận diện → `max_tokens`**
  (khác opencode có chủ ý — gateway tên tuỳ ý của dnt không được đổi wire).
- `detectSupportsStore` — chỉ OpenAI-native nhận `store: false`; mọi endpoint khác **không gửi**
  field này.

### 2.3 SR-4 — `maxTokensField`

Chỉ đổi **tên field**; vẫn dùng nguyên `outputTokenCap()` (override > catalog > request > ceiling).
Không có cap → không gửi field nào.

### 2.4 SR-5 — `providerOptions`

`ModelRequest.providerOptions` (host-stamped). Adapter lower **whitelist**:

| field | điều kiện |
|---|---|
| `toolChoice` `'auto'\|'none'\|'required'` | chỉ khi request có tools |
| `toolChoice` `{ name }` | → `{ type: 'function', function: { name } }`, chỉ khi có tools |
| `parallelToolCalls` | boolean |
| `responseFormat` `'text'\|'json_object'` | → `{ type: … }` |
| `responseFormat` object | passthrough (cho `json_schema`) |
| `stop` | mảng string, bỏ phần tử rỗng |

Mọi key khác **bị bỏ** (không forward) — một field lạ làm gateway khó tính trả 400 cả request.

### 2.5 SR-6 — affinity + prompt cache key

- `ModelRequest.sessionAffinity` (host-only, không bao giờ serialize thành chính nó).
- Header `x-session-affinity` gửi **bất cứ khi nào host stamp** (kể cả provider không khai hỗ trợ).
- Body `prompt_cache_key` **mặc định OFF**, chỉ gửi khi `supportsPromptCacheKey === true`; cắt 64 ký tự.
- Nơi stamp: headless (`sessionAffinity: session.id`) và web host (`scope.sessionId`, chỉ request
  thật sự dispatch — không stamp cho preview/reconstruction).

### 2.6 SR-3 — trần bước mỗi turn

- `HarnessLimits.maxStepsPerTurn` (default **48**), hợp lệ trong `INTEGER_LIMITS` +
  `ZERO_CAPABLE_LIMITS` (`0` = không giới hạn = hành vi cũ).
- Vòng lặp turn đếm **bước gọi model thật**; bước do host chèn (notice trần, notice cắt output,
  báo cáo việc đã giao) **không** tính.
- Chạm trần khi vẫn còn tool call → chèn `STEP_LIMIT_NOTICE` (`origin: 'context'`) **đúng một lần**
  để model tự chốt; còn gọi tool tiếp → `turn/end` reason **`limit`** (không phải reason mới),
  `run()` **dừng run** (mặc định an toàn), câu trả lời một phần được giữ.

### 2.7 SR-2 — chọn model/provider ở CLI (`headless.ts`)

- Cờ mới: `--provider <id>`, `--model <id>` (chấp nhận cả `--model <provider>/<model>`, chỉ tách
  khi phần đầu khớp một provider id trong store), `--thinking <off|minimal|low|medium|high|xhigh|max>`,
  và `--config <file>` để trỏ sang store khác (mặc định `resolveAppHome()/providers.json`, khớp web host).
- Nguồn hiệu lực: **(1) cờ → (2) defaults trong `providers.json` (`repairDefaults`) → (3) provider
  legacy `DEEPSEEK_API_KEY`**.
- Đăng ký provider theo store: dựng `OpenAiCompletionsProvider` cho từng entry `enabled`
  (kèm `maxOutputTokenOverrides`) — giống web host; `DeepSeekProvider` chỉ đăng ký khi không có
  entry `deepseek` trong store.
- Resolve **một bộ** `{provider, model, thinkingLevel}` rồi dùng cho **mọi chỗ** trong listener
  `agent/context` (`latestCalibration`, `buildContext`, budget, `next(...)`) ⇒ hết cảnh
  `model: undefined` rơi về `models[0]`.
- `--thinking` được validate bằng `expressibleThinkingLevel` **trước khi** chạm wire: level sai
  hoặc model không diễn đạt được → thoát code 1 kèm thông báo; level từ store thì degrade im lặng
  (đúng như web host).
- Validate/khai báo store chạy **trước khi** lấy `DataHomeLock` ⇒ thoát sớm không giữ data home.
- Cảnh báo rõ khi không có provider/model: `no provider configured (…) and no DEEPSEEK_API_KEY …`,
  `no provider selected …`, `no model selected for provider 'X' …`.

### 2.8 SR-7 — `headerTimeoutMs`

Opt-in, **default `undefined` = không đổi hành vi**. Khi bật: mỗi attempt vật lý có deadline riêng;
hết hạn → `ProviderError` reason `first_progress_timeout`, phase `headers`, `transient: true`
(retryable). Abort của người gọi vẫn được phân loại `cancelled`, không lẫn với deadline.

---

## 3. Test đã thêm

| File | Nội dung |
|---|---|
| `tests/harness/llm-openai.spec.ts` | +16 ca: detect field/store; field theo provider; override thắng detect; body "y hệt lịch sử" cho endpoint lạ; `store`/`stream_options` gate; header deadline (+ ca caller-stop vẫn là `cancelled`); providerOptions (lower/named choice/không tools/bỏ field lạ); affinity header + gate `prompt_cache_key` + ổn định & cắt 64; SR-1 (tha/ném/`expect`; placeholder rỗng chờ id thật; id không phải string ném không echo); HTTP error kèm excerpt JSON có giới hạn (3 ca: có excerpt, cắt 200, fallback `message` + chặn JSON khổng lồ). |
| `tests/harness/stream-completion.spec.ts` | +5 ca: header gửi lại trước args ⇒ **một** batch với id cuối; header lặp `id:null`/`name:""` ⇒ tha và giữ id thật; danh tính đến sau placeholder rỗng; id không phải string vẫn ném; **batch song song** với fragment `id:null` xen kẽ + index lệch thứ tự ⇒ 2 call tách đúng. |
| `tests/harness/agent-loop.spec.ts` | +2 ca: runaway → `limit` (đúng 1 notice, `maxStepsPerTurn+1` model call, partial answer giữ, run dừng ⇒ không mở turn thứ hai); turn dưới trần & `0` giữ nguyên hành vi. |
| `tests/bins/headless.spec.ts` | +3 ca: `--provider/--model/--thinking` ra wire (`reasoning_effort`) + `controls` trong log + header affinity; không cờ → theo store defaults + sugar `provider/model`; `--thinking` sai/không hỗ trợ → exit 1, không mở session. 4 ca cũ thêm `--config` để cách ly khỏi store thật của máy. |
| `tests/harness/request-lifecycle.spec.ts` | +1 ca: `maxStepsPerTurn` default 48, `0` hợp lệ, fraction/âm/NaN → default. |

---

## 4. Kiểm chứng

### 4.1 Tĩnh
- `tsc --noEmit -p tsconfig.json` và `-p tsconfig.web.json`: **sạch** (chạy lại sau mọi lượt sửa).
- 5 spec trực tiếp của surface đã đổi — `llm-openai.spec.ts`, `stream-completion.spec.ts`,
  `request-lifecycle.spec.ts`, `agent-loop.spec.ts`, `headless.spec.ts` → **192/192 ca xanh**
  (exit 0), chạy **sau** khi vá §4.6, thêm ca batch song song, và thêm 3 ca excerpt HTTP error (§4.7).

### 4.2 Full suite — delta so baseline `main`
- **Lần chạy cuối cùng (cây đóng băng — sau vá §4.6 + 3 ca excerpt §4.7.1)**: `Test Files 23 failed |
  323 passed (346)`, `Tests 71 failed | 4495 passed | 29 skipped (4595)`, 164.5s. So cấu trúc với
  `main` (`ec98d06`): **cùng 23 file**; lệch duy nhất **+1 test** — `tests/web/project-git-hunks.spec.ts`
  fail 4 thay vì 3 (`marks a hunk partial when part of it is staged, then stages and unstages all of it`).
  Chạy riêng file này **3/3 lượt: 3 failed | 20 passed (23)** — đúng baseline `main`; test thứ 4 chỉ
  fail dưới tải full suite ⇒ **flake môi trường** (cùng họ git/CRLF của 3 test fail sẵn trong file).
  `background-tools` fail + `plugins` pass trở về đúng như `main` (lượt xoay vòng `plugins` trước đó
  đã tự hồi). Delta test **pass** so `main`: **+34** (4461 → 4495).
- **Lần chạy trước đó** (52 ca llm-openai — chưa có 3 ca excerpt): `70 failed | 4492 passed | 29 skipped
  (4591)` — **trùng khớp 100% với `main`**: cùng 23 file, cùng 70 test, **0 file lệch** (đối chiếu
  từng file — `parse-suite.mjs`, so theo tên file + số test fail mỗi file).
- Lần chạy giữa (trước vá §4.6): 24 file / 71 test = `main` + `tests/web/server-model-alias.spec.ts`
  (+1 test) — flake **có trước**: chạy riêng fail 1/3 lượt trên **cả `main` lẫn nhánh**
  (test giả định thứ tự hai request HTTP không bảo đảm, `validates create targets inside the
  serialized transaction`). Flake xoay vòng ⇒ lần cuối không xuất hiện; tổng chỉ số lần đó là
  71 = 70 + 1 flake, không phải hành vi mới của nhánh.
- Toàn bộ fail còn lại là lỗi môi trường Windows giống hệt hai cây (EPERM symlink, CRLF,
  mode bits, spawn git…) ⇒ **không regression**.

### 4.3 E2E tất định — `scripts/e2e/run-fake-e2e.mjs` (fake gateway × agent loop thật)
**40/40 PASS** — chạy lặp **2 lần liên tiếp đều xanh** — 8 scenario:

| # | Scenario | Khẳng định |
|---|---|---|
| 1 | `resend-before-args` | turn xong, tool chạy, không `conflicting tool ID`, request #2 mang **id cuối** (`call_b`); id cũ không bao giờ lên wire |
| 2 | `resend-after-args` | vẫn fail cứng `conflicting tool ID`, **không** tool nào chạy, đúng 1 request |
| 3 | `runaway` | đúng **48 bước thật + 1 bước notice = 49 request**, notice đúng 1 lần, `[turn hit a limit]`, câu trả lời một phần giữ nguyên |
| 4 | `flaky-then-ok` | retry sau HTTP 500 thành công; **affinity ổn định** (1 giá trị) qua retry |
| 5 | `null-id-continuation` | shape lỗi **live** (`id:null`, `type:null`, `name:""` ở fragment tiếp nối): turn xong, tool chạy, id thật của header lên wire |
| 6 | `multi-null-id` | 2 call **song song**, index đến **lệch thứ tự**, fragment tiếp nối xen kẽ đều kiểu `id:null`: cả 2 tool chạy, cả 2 id thật lên wire |
| 7 | `placeholder-then-id` | id rỗng đến trước (placeholder), danh tính thật đến sau: chỉ id thật lên wire |
| 8 | `http-400` | body 400 JSON có `error.message`: turn fail với message hiển thị **nguyên văn excerpt** của relay (`HTTP 400: unknown: injected relay rejection…`), **không retry** (đúng 1 request), không tool nào chạy, không crash |

### 4.4 E2E thật — `scripts/e2e/run-real-e2e.mjs` (proxy opencode `127.0.0.1:6536` + log-proxy)
22 khẳng định; **lượt nghiệm thu cuối (12 vòng R4, sau vá §4.6 + phân loại §4.7): 22/22 PASS,
`completed=12/12, rate-limited=0, upstream-flake=0`**:
- **Wire endpoint lạ** (R1): chỉ `max_tokens` khi có cap, **không** `store`, **không** `prompt_cache_key`,
  `stream_options.include_usage=true`, không field lạ — trong khi vẫn tool-using bình thường.
- **Affinity** (R1/R4): mọi request của một session cùng **một** giá trị `x-session-affinity` non-empty.
- **SR-2** (R1/R2/R3): level `medium` từ store lên wire (`reasoning_effort`), `--thinking max` lên wire,
  `--thinking nonsense` → **exit 1** + message + **không** tạo data dir (validate trước `DataHomeLock`).
- **R4 — lớp lỗi tool-ID (mục tiêu chính)**: tổng **sau** vá **40 lượt R4 + 21 lượt repro live**
  (đều session mới, tool-heavy), **0** lỗi `invalid tool ID`/`conflicting tool ID` — so với **1/25**
  lượt repro + **1/12** lượt R4 trước vá. Các batch sau khi quota hồi: 12 lượt (0 conflict;
  2 relay-400 tách riêng — §4.7), 16 lượt (0 conflict; 1 relay-400), và **12 lượt cuối: 12/12 ok**.
- **R5 cap** (R5): model có cap trong catalog → `max_tokens=131072` đúng tên field; gateway trả 401 cho
  model đó (proxy không phục vụ) nhưng wire đã đúng.

### 4.5 A/B byte-compat SR-0 — `scripts/e2e/ab-wire-compat.mjs`
Old (`main` worktree, `DeepSeekProvider`) vs new (nhánh, store) cùng endpoint/model
(`deepseek-chat`), chạy song song qua cùng log-proxy — **7/7 PASS**:
key set body **giống hệt** (`messages,model,stream,stream_options,tools`), cùng trạng thái field cap
(đều vắng — model không có cap), không `store`/`prompt_cache_key` cả hai bên, `include_usage` giống,
model giống. Endpoint tên lạ giữ nguyên wire lịch sử như tuyên bố §2.3 spec.

### 4.6 Phát hiện live sau triển khai (đã vá trong lượt này)
- **Bằng chứng**: SSE thô của gateway bắt tại chỗ (25 lượt thật): header thật
  `{"id":"call_00_jep…"}`, mọi fragment tiếp nối lặp header với `{"id":null,"type":null,
  "function":{"name":"","arguments":"…"}}`. Code cũ coi đó là lỗi cứng → **chết cả turn**
  (`invalid tool ID`) — đúng lớp lỗi quan sát ~15% trong bench.
- **Vá**: `id` null/rỗng/whitespace và `name` rỗng/null = "fragment không mang danh tính"
  → giữ nguyên phần đã tích luỹ (đối chiếu opencode `tool-stream.ts`: `tool.id || undefined`,
  `current?.id ?? …`); id khác kiểu vẫn ném không echo; call không bao giờ có id vẫn fail ở
  `validateToolBatch` (bất biến định danh giữ nguyên). Chi tiết: spec §3.7.
- **Đo lại**: trước vá **1/25** lượt chết vì `invalid tool ID` (thêm 1/12 ở vòng R4); sau vá
  **6/6** lượt live hoàn tất sạch — rồi free-tier của proxy hết quota (`FreeUsageLimitError`,
  mọi model free đều 429; model trả phí 401 `Missing API key`). Nền tảng khẳng định dùng e2e
  tất định tái hiện **đúng** chuỗi fragment đã bắt được qua agent loop thật (§4.3 #5) + 5 ca unit
  mới của 2 spec liên quan. **Sau khi quota hồi (cùng ngày)**: quét tiếp **40 lượt R4 + 21 lượt
  repro live** — **0** lỗi tool-ID (chi tiết từng batch: §4.4).

### 4.7 Phát hiện live thứ hai — relay 400 "Upstream request failed" (phân loại; không phải lỗi wire của harness)

Trong các batch đo lại §4.4 xuất hiện thưa một lớp lỗi **khác** lớp tool-ID: request đầu của
một session đôi khi bị relay trả **HTTP 400**. Lần bắt được nguyên văn (sau khi có excerpt §4.7.1):

```json
{"error":{"message":"Upstream request failed: Invalid request parameters. Please check your input and try again."}}
```

- **Tần suất**: 3 lần trong **28 lượt R4** của hai batch đầu sau reset quota (2/12 rồi 1/16);
  batch 12 lượt cuối + 15 lượt repro sau đó: **0 lần**. Hai lần trước khi có excerpt chỉ hiện
  `provider HTTP 400: unknown`, nhưng cùng shape: chết ngay **attempt 1, bước 1** (request đầu
  của session), 400 nên không retry.
- **Không thể là hàm của request body**: request đầu các lượt R4 **giống hệt nhau** (cùng system
  prompt/tools/workspace; chỉ khác `x-session-affinity` ngẫu nhiên theo session) mà các lượt
  trước/sau đều thành công ⇒ phía relay/thượng nguồn không ổn định, không phải nội dung ta gửi.
- **Đối chứng**:
  - Probe raw gateway (`scripts/e2e/probe-gateway.mjs`, KHÔNG qua harness — body tối giản hợp lệ
    có `tools` + `reasoning_effort:medium` + `stream_options`): **24/24 = HTTP 200**.
  - Repro loop 15 lượt (harness đầy đủ, session mới mỗi lượt): **15/15 sạch**.
- **Đối chiếu opencode**: `classifyProviderFailure({ message: "Upstream request failed: …", status: 400 })`
  → `InvalidRequest` (400 client-scoped thắng văn bản retry) — opencode **cũng không retry** lớp
  lỗi này ⇒ harness giữ nguyên policy 400 = không retry, không thêm ngoại lệ theo chuỗi.
- **Phân loại trong driver**: vòng R4 tách `upstream-flake` (chỉ khớp đúng văn bản relay
  `Upstream request failed:`) khỏi `provider-failure`; đếm và **in rõ** (`upstream-flake=N/12`)
  nhưng không làm đỏ khẳng định "không lỗi wire"; mọi 400 khác vẫn tính fail cứng.

#### 4.7.1 `httpErrorExcerpt` — thân lỗi HTTP vào message (src/harness/llm/openai.ts)

Trước đây mọi 400 không rõ loại hiển thị trơ `provider HTTP 400: unknown` (message gốc bị bỏ).
Nay message mang **excerpt**:

- Chỉ nhận body **JSON hợp lệ** (≤8KB): lấy `error.message` / `error` (string) / `message`
  top-level qua `gatewayErrorText`, gộp whitespace, cắt **200 ký tự** + `…`; mọi thứ khác trả
  rỗng — HTML/blob/body khổng lồ **không** bị dán vào message (test cũ "caps an oversized error
  body" 50k ký tự vẫn xanh nguyên).
- Test: `llm-openai.spec.ts` **+3 ca** (excerpt đúng nguyên văn; cắt đúng 200; fallback
  `message` top-level + JSON khổng lồ bị chặn) ⇒ spec 55 ca; e2e tất định §4.3 scenario 8 khóa
  hành vi **qua CLI thật**: message đầy đủ, đúng 1 request (không retry), không tool nào chạy.

### 4.8 Nghiệm thu app thật (pm2 `:3082`) — rebuild + curl + 1 task thật

Chạy trên chính app đang phục vụ `http://127.0.0.1:3082` (pm2 app `dnt-harness`, chạy
`tsx src/bins/web.ts --port 3082 --root .`, provider thật `ocproxy` → `deepseek-v4.1-flash-free`):

- **Rebuild**: `npm run build:web` (vite 6.4.3) — **exit 0**, `666 modules transformed`,
  `built in 6.39s`; sinh lại toàn bộ `web-dist/`.
- **Restart + health**: `pm2 restart dnt-harness --update-env` → `GET /api/health` **200** sau ~0.5s;
  args giữ nguyên (`--port 3082 --root .`).
- **Curl API**: `GET /api/health` 200, `/api/meta` 200 (provider/model/projects đầy đủ),
  `/api/workspaces` 200, `/api/sessions` 200; `POST /api/workspaces/<ws>/projects` `{name,path}` → **201**;
  `POST /api/workspaces/<ws>/sessions` `{projectId}` → **201**; `POST …/sessions/<sid>/messages`
  `{content}` → **202** `{queued:false}`; `GET …/sessions/<sid>/events` → SSE (replay `kind:"snapshot"`
  + stream live).
- **Task thật** (session mới, project trỏ `…\Temp\opencode\dnt-task-demo`): *“viết `fizzbuzz.js`
  1..15 rồi chạy `node fizzbuzz.js`”* → **turn `completed`**, đúng 2 tool call:
  `Write fizzbuzz.js` → `ok:true` `"created fizzbuzz.js (6 lines)"`;
  `Bash node fizzbuzz.js` → `ok:true`, output `1 2 Fizz 4 Buzz … FizzBuzz` `[exit code: 0]`.
  Nghiệm thu độc lập ngoài app: chạy lại `node fizzbuzz.js` ra đúng dãy FizzBuzz.
- **Quan sát (ngoài phạm vi spec)**: session kiểu legacy `POST /api/sessions {folder}` khi app chạy
  chế độ project (không `projectId`) **không được cấp workspace root** → mọi tool root-aware bị
  `denied: no workspace root is granted for '<Tool>'` (khớp thiết kế: `effectiveGrants` trả `[]` khi
  `projectId === undefined`; binding `folder` là hành vi memory-mode/legacy cho test). Muốn chạy task
  thật phải tạo **project** — đã kiểm chứng chạy tốt qua curl.

### 4.9 Phủ curl toàn bộ HTTP API — `scripts/e2e/curl-api-suite.mjs` (**253 case**)

Yêu cầu "test hết các case theo curl": bộ suite riêng chạy trên app thật `:3082`, **mọi request qua
`curl.exe` thật** (`-X`, `--data-binary @file`, `-w '%{http_code}\t%{content_type}'`), chạy được lặp lại:

```
node scripts/e2e/curl-api-suite.mjs [baseUrl]     # ~2-4 phút, gồm 1 lượt model thật
```

**Phủ 20 nhóm** (happy + toàn bộ nhánh lỗi 400/404/405/409 + CAS):

- core: `health`, `auth/state|pair|pairing-code|logout` (auth tắt: pair 404, pairing-code 403), `meta`;
- workspaces CRUD (create/rename/archive/delete, xóa 409 khi còn dữ liệu/workspace cuối, 404 id lạ);
- ws settings: `meta`, mode GET/PUT (400/404), modes CRUD + duplicate + `enabled`, **CAS `expectedHash`** (thiếu/lệch → 409);
- agents/commands; skills (list/404, `files`, `file?path` + traversal 400, hidden toggle 400);
- plugins: marketplaces (409 khi memory-mode; ở host này 200) + plugins ws (id sai form → 400);
- MCP: list/404, register→GET→disable, `enable` id lạ 404, `test` binary thiếu → 500, oauth begin 404, delete 200→404;
- hooks GET + 405; secrets PUT/DELETE + 400 thiếu value + GET single 405;
- memory: create 201/dup 409, GET, PATCH thiếu hash 400 / stale 409 / đúng hash 200, DELETE 200→404, `memory-file` traversal 400;
- model toàn cục: `model-defaults` PUT net-zero 200 + 400, `model`, `thinking` (+restore null), 4 route cặp image/video/commit GET 200 + PUT 400, `usage`;
- `fs/dirs` (200/400), guard dangerous-commands (thiếu workspaceId 400, global GET/PUT, config sai 400);
- providers CRUD: create 201/id lạ 404/apiKey PATCH + key GET roundtrip, `models|test|sync` với baseUrl chết → 502, delete 200→404;
- model aliases CRUD: create 201/dup 409, **CAS `expectedRevision`** (thiếu 400, lệch 409, đúng 200), no-GET-route 404;
- projects: create 201/path rỗng-thiếu 400, order PUT (reversed→restored net-zero) + 400, retarget A→B→A, `gitTrusted` sai 400;
- files: create 201/dup 409/root + `.git` 400, đọc, save **CAS hash** (stale 409, đúng 200), rename, delete 200, đọc lại 400, traversal `..` 400, search, git status non-repo 200, media 404, git action lạ 404;
- terminals: list, 404 id lạ, create 201 + kill, input id lạ 404; attachments POST/GET roundtrip + 404; videos 404;
- sessions (project) đầy đủ vòng đời: create 201/projectId lạ 404, list, GET đơn 405, PATCH title (400 cho title rỗng không xảy ra — chấp nhận 200), model/mode GET/PUT + 400/404, manifest 204, context hash lạ 404, processes 404, grants GET/PUT + 400/404, steer idle 200, messages validation 400 + **gửi thật 202 → poll idle → snapshot SSE có `"reason":"completed"`**, events SSE, inputs 404, children reconcile/cancel 404, stop 202, compact, **delete project khi còn session 409**, delete session 200→404, delete project 200→404;
- legacy sessions: create folder 201/folder thiếu 400, list, GET 405, `folder` PUT + `/api/folder` → 404 (host project-mode, đúng §4.8), stop/events/messages/delete;
- automations: preview + 400, CRUD đầy đủ + 404; notify channels 404s; push key/test/subscriptions; approvals & questions 404; system-prompts.

**An toàn & net-zero**: backup `providers.json` trước; mọi mutation đều có cleanup (session, project, terminal,
automation, memory, secret, MCP row, mode copy, workspace, alias, provider); cuối suite tự so sánh file store.
Kết quả 3 lượt chạy: **run1 235/246** (11 fail do kỳ vọng sai — đã đối chiếu source và sửa: CAS mode save,
form id plugin, alias cần `thinkingLevel` tường minh), **run2 252/253**, **run3 `253/253, 0 failed`**.
`providers.json` sau mỗi lượt chỉ lệch bộ đếm CAS `aliasGeneration` (0→1, mọi create đều bump, không rollback
được) — đã khôi phục **byte-identical** về backup; suite bổ sung so sánh `ignoringGenerationCounters`.

**Phát hiện củng cố thiết kế** (không phải bug): mọi đường ghi đều CAS/validate chặt (mode/file/memory/alias);
route khớp nhưng thiếu method → 405, path chỉ có 1 method → catch-all 404; `POST /api/model-aliases` đòi
`thinkingLevel` gửi tường minh (`null` hợp lệ, thiếu → 400 — UI luôn gửi kèm); host project-mode vô hiệu
route legacy `folder` bằng 404 đúng chủ đích.

### 4.10 Đối chiếu A/B với opencode CLI — cùng prompt "review local change", cùng model

Yêu cầu "test thêm case so sánh cùng 1 prompt cùng 1 model giữa opencode và dnt-harness": dựng repo lab có
"local change" với **5 lỗi cài sẵn** (ground truth), chạy cùng prompt qua **opencode CLI v1.2.24** (bản
cài) và **headless CLI của harness**, cùng model `deepseek-v4.1-flash-free` trên **cùng endpoint gateway
`http://127.0.0.1:6536/v1`** (opencode trỏ vào gateway bằng `OPENCODE_CONFIG` tạm; harness qua provider
`ocproxy`). Script tái lập: `node scripts/e2e/compare-opencode-dnt.mjs [--rounds N]` — tự kiểm tra gateway,
dựng lab, chạy 2 bên, chấm recall 5 lỗi + metrics, ghi transcript, exit code theo pass/fail.

Kết quả **6 lượt** (2 thủ công + 4 scripted): recall **5/5 ở mọi lượt cho cả hai bên** (mỗi bên 30/30
lượt-điểm); thời gian tương đương (opencode TB ≈18.3s, dnt TB ≈21.3s; biên độ chồng nhau 14.4–28.4s);
tool calls TB ≈6.8 (oc) vs ≈7.0 (dnt); dnt nêu nhiều finding phụ hơn (TB ≈12.8 vs ≈10.5 — content-type,
timeout, base-URL, naming, thiếu test…, đều chính đáng, không false positive). Cả hai đều phát hiện file
**untracked**, không bên nào sửa file. Khác biệt còn lại là văn phong/severity (dnt luôn xếp floating
promise là High) và cách in output (opencode tách stdout/stderr; dnt in cả trace ra stdout — thiết kế
headless). Chi tiết, bảng số liệu và transcript tại `plans/261017-opencode-vs-dnt-review.md` +
`plans/261017-opencode-vs-dnt/`.

### 4.11 Đối chiếu A/B Case 2 — review nhánh thật (`fix/effort-vocabulary-and-prompt-discipline`)

Mở rộng A/B sang bài "review nhánh thật": cả hai harness review **cùng một bản đóng băng** của nhánh này
(worktree detached `c44486d` + patch phần tracked + 42 file untracked; `git status` parity 28=28), timeout
1500s/lượt. Kết quả (chi tiết: `plans/261017-opencode-vs-dnt-review.md` §6):

- **dnt**: 893.3s / 95 tool call / exit 0 / không sửa file — **24 finding** (High 4 / Medium 8 / Low 12;
  kiểm chứng code: 23 đúng, 1 sai). Lượt chạy **chạm trần `maxStepsPerTurn = 48` của chính nhánh này** →
  nhận notice, vẫn giao câu trả lời cuối hoàn chỉnh (turn/end `limit`); 3 finding High của nó nói về đúng
  hành vi `limit` đó (queued input đứng, automations ghi `'failed'`).
- **opencode lượt A (mặc định)**: 50.4s, **không có review** (exit 0) vì ask `external_directory`
  false-positive khi repo nằm dưới `%TEMP%` bị headless auto-reject → `RejectedError` kết thúc phiên.
- **opencode lượt B (mở quyền `external_directory/doom_loop` — đối xứng `--yolo`)**: 663.5s / 72 tool
  call / exit 0 / không sửa file — **16 finding** (High 2 / Medium 6 / Low 8), kiểm chứng 16/16 đúng;
  riêng opencode tìm được 2 bug thật (abort mid-stream khi `headerTimeoutMs` set — `openai.ts:401-404`;
  safety-net rename trong `compare-opencode-dnt.mjs:146`) và 1 thay đổi hành vi âm thầm (default DeepSeek
  `high`→`medium`). Hai bug trên script so sánh đã được fix trong script live (chưa commit).

Hai danh sách bổ trợ nhau (~10 lớp chung; opencode trội precision tầng transport, dnt phủ rộng
scripts/tests/docs). Transcript: `plans/261017-opencode-vs-dnt/case2-*.txt`.
