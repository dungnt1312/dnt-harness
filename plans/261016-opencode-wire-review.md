# Review — bảng đối chiếu wire-fields `dnt-harness` vs `opencode`

- Ngày: 2026-10-16 · Người review: em
- Nguồn đối chiếu: `C:\laragon\www\opencode` (`packages/ai`, `packages/core`) và
  `C:\laragon\www\dnt-harness\src\harness\llm`
- Kết luận: bảng **đúng về bản chất ~90%**, pipeline mô tả chính xác, nhưng có
  **6 chi tiết cần chỉnh** và **1 thiếu sót quan trọng** làm lệch hướng khuyến nghị
  port sang dnt.

---

## 1. Đã kiểm chứng — đúng

| Claim | Bằng chứng |
|---|---|
| Pipeline `LLMRequest → applyCachePolicy → protocol.fromRequest → Route` | `cache-policy.ts:1-3,173-185` ("runs once at compile time, before the per-protocol body builder"); `openai-chat.ts:809-810` ("Endpoint, auth, framing… composed by `Route.make`") |
| `GenerationOptions` schema chung | `schema/options.ts:115-124` (`maxTokens, temperature, topP, topK, frequencyPenalty, presencePenalty, seed, stop`) |
| `LanguageModelCompatibility` | `schema/options.ts:213-238` (`maxTokensField:220, supportsStore:223, supportsUsageInStreaming:224, supportsStrictMode:225, supportsPromptCacheKey:229, reasoningField:217, cacheFormat:231, sanitizer:216, requireFinishReason:221`) |
| openai-chat lower sampling | `openai-chat.ts:848-853` (`temperature, top_p, frequency_penalty, presence_penalty, seed, stop`) |
| anthropic / gemini / cohere / bedrock | `anthropic-messages.ts:1079-1082`; `gemini.ts:456-462`; `cohere-chat.ts:215-222`; `bedrock-converse.ts:546-548,563` |
| `tool_choice` chỉ khi có tools active | `openai-chat.ts:346` (`matchToolChoice`) + `:841` (`hasActiveTools && request.toolChoice`) |
| `detectMaxTokensField` theo provider/baseURL | `openai-chat.ts:683-715`, áp `:820-821`, ghi body `:845-847` — danh sách DeepSeek/Moonshot/Together/ZAI/Nvidia/Cerebras/Chutes/Cloudflare **khớp từng mục** |
| `store` | `detectSupportsStore:717-757`; `store:false` mặc định `:795-799`; non-standard **bỏ hẳn** |
| `prompt_cache_key` | `openai-chat.ts:792-800` (chỉ khi `supportsPromptCacheKey`), `shared.ts:45-46,50` |
| Session affinity | `model-request.ts:278-295` (`x-session-affinity`/`X-Session-Id`/`x-opencode-session`); key suy từ affinity `:295` |
| `generation` vs `providerOptions` | `model-request.ts:275-301` chia theo `GENERATION_KEYS` |
| `OpenResponsesOptions` fields | `protocols/utils/open-responses-options.ts:54-69` (`store, metadata, safetyIdentifier, topLogprobs, reasoningEffort, reasoningSummary, include, textVerbosity, serviceTier, truncation, allowedTools, maxToolCalls, parallelToolCalls`) |
| `parallel_tool_calls` | `open-responses.ts:783` (gọi) / `:811` (định nghĩa) / `:806` (body); `mistral-chat.ts:426-427`; `alibaba-chat.ts:83-84` |
| `response_format` | `alibaba-chat.ts:65,88`; `meta-images.ts:45,86` |
| `stream_options.include_usage` | `openai-chat.ts:843`, gate `supportsUsageInStreaming` |

---

## 2. Sai lệch cần chỉnh

1. **`top_k` KHÔNG có trong openai-chat.** Khoảng `848-853` chỉ có
   `temperature, top_p, frequency_penalty, presence_penalty, seed, stop` — không
   `top_k`. OpenAI Chat không nhận `top_k`; `top_k` chỉ xuất hiện ở protocol có
   hỗ trợ: `anthropic-messages.ts:1081`, `gemini.ts:458`, `cohere-chat.ts:218`,
   `alibaba-chat.ts:87`. Schema chung *có* `topK` thì đúng, nhưng nó là
   per-protocol, không phải "có ở openai-chat".

2. **`reasoningField` ≠ reasoning effort.** Đây là hai thứ khác nhau bị ghép
   chung một dòng:
   - `compatibility.reasoningField` (`openai-chat.ts:811`, `options.ts:217`) =
     **tên field text reasoning trong message** (vd `reasoning_content`) — dùng
     khi lower `messages`, và có danh sách `RESERVED_REASONING_FIELDS`;
   - effort = `options.reasoningEffort` → `reasoning_effort` (`openai-chat.ts:801`),
     lấy từ provider options (không phải từ `compatibility`). Cờ compatibility
     liên quan effort là `supportsEffortUpdates` (`options.ts:237`).
   → Viết lại: *"effort là provider option; còn `reasoningField` là tên field
   reasoning trong transcript, mỗi thứ một việc."*

3. **`top_logprobs` — hai vị trí, một schema một body.** `open-responses.ts:273`
   là **khai báo schema**; chỗ *gửi đi* là `:797`
   (`...(options.topLogprobs !== undefined ? { top_logprobs: … } : {})`).

4. **Đường dẫn `open-responses-options.ts` không đủ.** File đúng là
   `packages/ai/src/protocols/utils/open-responses-options.ts` (struct `Options`).
   Còn `packages/ai/src/providers/open-responses-options.ts` chỉ **re-export type**
   (`export * as OpenResponsesProviderOptions`). Ghi kèm `protocols/utils/` để
   khỏi tra nhầm.

5. **"~15 protocol" hơi thấp.** Các protocol sinh-text chính đã ≈18
   (`openai-chat`, `openai-compatible-chat`, `openai-responses`,
   `openai-compatible-responses`, `open-responses`, `anthropic-messages`,
   `gemini`, `bedrock-converse`, `cohere-chat`, `mistral-chat`, `zai-chat`,
   `zai-messages`, `alibaba-chat`, `alibaba-messages`, `meta-messages`,
   `meta-responses`, `xai-responses`, `venice-chat`), chưa kể biến thể gateway
   (`bedrock-mantle-messages`, `cloudflare-ai-gateway-messages`,
   `google-vertex-messages`, `minimax-messages`, `moonshot-messages`,
   `vercel-ai-gateway-messages`, `zai-coding-messages`) → **~20+**.
   Kèm một phân biệt chưa nêu: **protocol ≠ route**. Ví dụ `RESPECTS_INLINE_HINTS`
   liệt kê *route id* (`openrouter`, `digitalocean`, `bedrock-converse`…), còn
   lowering khoá theo *protocol*. Tầng policy khoá route, tầng body khoá protocol.

6. **`matchToolChoice` ở `openai-chat.ts:346`** (không phải 345). Nhỏ, nhưng để
   khỏi trượt khi tra.

---

## 3. Thiếu sót quan trọng (ảnh hưởng tới khuyến nghị)

### 3.1 Cache policy KHÔNG áp cho OpenAI chat — đây là điểm cần sửa nặng nhất
`cache-policy.ts:40-56` định nghĩa `RESPECTS_INLINE_HINTS` và **openai-chat không
nằm trong danh sách**; `selectPolicy` (`:188-199`) trả `NONE` cho mọi route không
thuộc set (khi không khai `cacheFormat`). Nghĩa là với họ OpenAI, opencode
**không gửi `cache_control`/breakpoint nào** — nó dựa vào *implicit* prefix cache
của nhà cung cấp, cộng `prompt_cache_key` và header affinity.

Hệ quả cho gợi ý #3: với dnt (adapter OpenAI-compatible thuần), thứ port được là
**`prompt_cache_key` + header session-affinity**, **không phải** breakpoint
"tool cuối / system đầu-cuối / đuôi hội thoại" (cái đó dành cho Anthropic/Alibaba/
Bedrock/OpenRouter). Viết lại gợi ý cho khỏi hiểu sai.

### 3.2 `HttpOptions` tách `headerTimeout` khỏi `chunkTimeout`
`schema/options.ts:72-79` có **ba** timeout riêng: `timeout`, `headerTimeout`
(đợi headers), `chunkTimeout` (đợi giữa các chunk), và `DEFAULT_CHUNK_TIMEOUT_MS =
900_000` kèm ghi chú đúng về DeepSeek ("can stream nothing for minutes while they
reason", `:58-62`). dnt hiện có `streamFirstEventMs`/`streamIdleMs`/`logicalRequestMs`
nhưng theo em nhớ thì **không tách header-timeout** — đây là thứ nên học khi port,
hơn cả mấy field sampling.

### 3.3 Compatibility còn nhiều cờ "hợp đồng wire" chưa liệt kê
Ngoài danh sách trong bảng, `LanguageModelCompatibility` còn: `requireFinishReason`,
`requireAssistantAfterTool`, `requireReasoning`, `sanitizer` (gemini/moonshot),
`zaiToolStream`, `requireSignature`, `supportsThinkingBlockBinding`,
`supportsEffortUpdates`. Đây **chính là lớp liên quan trực tiếp tới bug SR-1**
(`conflicting tool ID`) của dnt: opencode thể hiện "kỳ vọng hợp đồng wire per model"
thành dữ liệu, còn dnt hardcode giả định trong adapter.

### 3.4 Có một hook chèn giữa request và route
`model-request.ts:304-313`: `hooks.trigger("session","model.request", …)` có thể
**ghi đè `baseURL`/headers per-request** trước khi gọi. dnt không có hook ở tầng
request (chỉ có `agent/context`) → mất escape hatch đổi endpoint/headers theo
phiên.

### 3.5 Không chỉ `providers.json` — còn `SessionAffinity`
`model-request.ts:278` lấy affinity từ session; dnt **chưa có khái niệm
session-affinity**. Muốn port `prompt_cache_key` phải sinh một id ổn định theo
session trước (nếu không key đổi mỗi request thì cache vô dụng).

---

## 4. Đánh giá lại 4 gợi ý (kèm cảnh báo)

1. **`maxTokensField` — đúng là bug, nhưng là bug *tiềm ẩn*.** Với cấu hình hiện
   tại (DeepSeek/gateway nội bộ) `max_tokens` **đang đúng**; nó chỉ vỡ khi trỏ
   OpenAI thật (`o*`/`gpt-5` trả 400 `max_tokens is not supported`). Ngoài ra dnt
   đã có sẵn `outputTokenCap()` (`openai.ts:112-121`) — resolution cap theo
   catalog + override + request + ceiling — nên **chỉ cần thêm việc chọn *tên
   field***, không viết lại. Ưu tiên: trung bình, rẻ.
2. **`providerOptions` passthrough — giá trị cao nhất về khả chuyển.** Vì dnt là
   OpenAI-compatible-only, `tool_choice`/`parallel_tool_calls`/`response_format`
   đều là field của chat-completions → port rẻ, rủi ro thấp. **Nhưng** phải là
   *passthrough có schema*, không phải "nhận mọi thứ".
3. **`prompt_cache_key` + affinity — giá trị cao, hợp với dnt** (dnt đã tối ưu
   prefix stability trong `context/environment.ts`). Sửa lại đúng cơ chế: **key +
   header, không breakpoint** (§3.1), và cần sinh affinity trước (§3.5).
   Lưu ý: DeepSeek tự cache prefix *không cần key*, nên giá trị thật phụ thuộc
   gateway đích.
4. **Sampling qua mode/agent config — CẢNH BÁO, đừng thêm thẳng vào body.** Nếu
   dnt cứ chèn `temperature`/`top_p` vô điều kiện thì sẽ **vỡ** `o*`/`gpt-5`
   (các model này 400 khi `temperature ≠ 1`, cấm `top_p`). opencode không gửi bừa:
   nó để sampling trong `generation` (mặc định rỗng) và mỗi protocol lower ra field
   nó hỗ trợ. ⇒ Sampling chỉ nên expose khi **được gate per-model** — tức là lại
   quay về cơ chế `compatibility`. Đây là lý do gợi ý #4 yếu hơn #1–#3.

---

## 5. Bài học gốc (meta-lesson) — dnt **đã có sẵn seam**

Điểm quan trọng nhất: dnt **không cần dựng lại lớp compatibility từ số 0**. Nó đã
có đúng chỗ cắm:

- `OpenAiCompletionsOptions` (`openai.ts:88-104`) đã là **per-provider options**:
  `name`, `baseUrl`, `maxRetries`, `retryBaseMs`, **`completionPolicy`**,
  **`maxOutputTokens`** — tức "knob compatibility per provider" đã tồn tại, chỉ
  đang dùng ít.
- `model-catalog.ts` đã là **per-model facts**: `maxOutputTokens`, `reasoning`
  (`ReasoningCapability.levels`), `contextTokens`, `vision` — tương ứng
  `compatibility` + `capabilities` của opencode.

⇒ Việc cần làm **không phải** "thêm tính năng", mà **đổ thêm field vào hai seam đã
có**:

| opencode | dnt hiện có | Nên thêm |
|---|---|---|
| `compatibility.maxTokensField` | `model-catalog` maxOutputTokens; `outputTokenCap()` | tên field + `detect` theo `name`/`baseUrl` |
| `GenerationOptions` | *(không có)* | `generation` defaults trong provider options, lower có gate |
| `providerOptions` | *(không có)* | passthrough có schema, chỉ field chat-completions |
| `defaults.providerOptions` / route allowlist | `completionPolicy` | dùng `completionPolicy` như tiền lệ |
| `CachePolicy` (`auto`) | không | **chỉ** `prompt_cache_key` + affinity (không breakpoint) |
| `HttpOptions.headerTimeout` | `streamFirstEventMs` gộp | tách header-timeout khỏi chunk/idle |

---

## 6. Thứ tự port đề xuất (đã chỉnh)

1. **`maxTokensField` trong `OpenAiCompletionsOptions` + `detect*` theo `name`/`baseUrl`** (rẻ, rõ, có test được).
2. **`providerOptions` passthrough có schema** cho `tool_choice`, `parallel_tool_calls`, `response_format` (không đụng sampling).
3. **`prompt_cache_key` + session-affinity id** (chỉ key + header; bỏ breakpoint).
4. **Tách `headerTimeout`** khỏi cụm stream timeout hiện có.
5. Sampling — **hoãn**, chỉ làm khi có gate per-model.

Liên quan: bug SR-1 trong `plans/261016-spec-provider-resilience-cli.md` nên được
nối vào §3.3 ở trên (compatibility = "hợp đồng wire per model") chứ không chỉ là
"retry/tolerant parse".
